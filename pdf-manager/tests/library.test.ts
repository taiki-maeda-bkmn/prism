import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { LibraryStore, MAX_PDF_BYTES, type LibraryWriteIO } from '../src/main/library';

const pdf = Buffer.from('%PDF-1.7\n1 0 obj\n<< /Type /Catalog >>\nendobj\n%%EOF\n');

async function fixture(t: TestContext, writeIO: Partial<LibraryWriteIO> = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'prism-pdf-library-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const root = path.join(directory, 'library');
  const source = path.join(directory, 'My document.pdf');
  await fs.writeFile(source, pdf);
  return { directory, root, source, store: await LibraryStore.open(root, writeIO) };
}

function failPartialWrite(kind: 'pdf' | 'catalog'): Partial<LibraryWriteIO> {
  return {
    createFile: async filename => {
      const handle = await fs.open(filename, 'wx+', 0o600);
      if (filename.endsWith('.pdf') === (kind === 'pdf')) {
        handle.writeFile = async data => {
          assert.ok(Buffer.isBuffer(data));
          await handle.write(data.subarray(0, 13), 0, Math.min(13, data.length), 0);
          throw new Error('Injected disk-full write failure');
        };
      }
      return handle;
    },
  };
}

test('imports an independent PDF copy and restores its metadata after restart', async t => {
  const { root, source, store } = await fixture(t);
  const result = await store.import([source]);
  assert.deepEqual(result.errors, []);
  assert.equal(result.importedIds.length, 1);
  const document = result.library.documents[0];
  assert.equal(document.title, 'My document');
  assert.equal(document.filename, 'My document.pdf');
  assert.equal(document.size, pdf.length);
  assert.equal(document.sha256, createHash('sha256').update(pdf).digest('hex'));
  await fs.writeFile(source, 'The original has changed independently.');
  const reopened = await LibraryStore.open(root);
  assert.deepEqual((await reopened.load()).documents, [document]);
  assert.deepEqual(Buffer.from(await reopened.read(document.id)), pdf);
  assert.equal((await (await LibraryStore.open(root)).load()).documents[0].lastOpenedAt, null);
  assert.equal((await reopened.update(document.id, { pageCount: 1 })).lastOpenedAt, null);
  assert.ok((await reopened.update(document.id, { lastPage: 1 })).lastOpenedAt);
  assert.ok((await (await LibraryStore.open(root)).load()).documents[0].lastOpenedAt);
  assert.equal(await fs.readFile(source, 'utf8'), 'The original has changed independently.');
});

test('deduplicates identical bytes across filenames and restarts', async t => {
  const { directory, root, source, store } = await fixture(t);
  const duplicate = path.join(directory, 'Other name.PDF');
  await fs.writeFile(duplicate, pdf);
  const first = await store.import([source, duplicate]);
  assert.equal(first.importedIds.length, 1);
  assert.equal(first.duplicateCount, 1);
  const second = await (await LibraryStore.open(root)).import([duplicate]);
  assert.equal(second.duplicateCount, 1);
  assert.equal(second.library.documents.length, 1);
  assert.equal((await fs.readdir(path.join(root, 'documents'))).length, 1);
});

test('validates and persists editable metadata while protecting storage identifiers', async t => {
  const { root, source, store } = await fixture(t);
  const id = (await store.import([source])).importedIds[0];
  const updated = await store.update(id, { title: '  Annual report  ', tags: [' Reports ', 'reports', 'Finance', ''], favorite: true, pageCount: 12, lastPage: 7 });
  assert.equal(updated.title, 'Annual report');
  assert.deepEqual(updated.tags, ['Reports', 'Finance']);
  assert.equal(updated.favorite, true);
  assert.equal(updated.lastPage, 7);
  assert.deepEqual((await (await LibraryStore.open(root)).load()).documents, [updated]);
  for (const patch of [{ id: 'changed' }, { title: '' }, { tags: ['x'.repeat(41)] }, { favorite: 'yes' }, { lastPage: 13 }, { pageCount: 0 }, { lastPage: NaN }]) {
    await assert.rejects(store.update(id, patch));
  }
  const clamped = await store.update(id, { pageCount: 3 });
  assert.equal(clamped.lastPage, 3);
  const snapshot = await store.load();
  snapshot.documents[0].tags.push('Accidental mutation');
  assert.deepEqual((await store.load()).documents[0].tags, ['Reports', 'Finance']);
});

test('tag uniqueness and catalog validity remain stable across English and Turkish locales', async t => {
  const originalLowerCase = String.prototype.toLocaleLowerCase;
  let defaultLocale = 'en-US';
  // Change only the default-locale behavior, as moving this catalog between
  // operating systems would, while keeping real Intl casing rules in use.
  t.mock.method(String.prototype, 'toLocaleLowerCase', function (this: string, locales?: string | string[]) {
    return originalLowerCase.call(this, locales ?? defaultLocale);
  });
  const { root, source, store } = await fixture(t);
  const id = (await store.import([source])).importedIds[0];
  await store.update(id, { tags: ['I', 'ı'] });
  assert.equal('I'.toLocaleLowerCase(), 'i');
  defaultLocale = 'tr';
  assert.equal('I'.toLocaleLowerCase(), 'ı');
  const turkish = await LibraryStore.open(root);
  assert.deepEqual((await turkish.load()).documents[0].tags, ['I', 'ı']);
  assert.deepEqual((await turkish.update(id, { tags: ['I', 'ı', 'i'] })).tags, ['I', 'ı']);
  defaultLocale = 'en-US';
  const english = await LibraryStore.open(root);
  assert.deepEqual((await english.load()).documents[0].tags, ['I', 'ı']);
});

test('rejects unknown IDs and path traversal for all document operations', async t => {
  const { store } = await fixture(t);
  for (const id of ['../outside.pdf', '/tmp/secret', '00000000-0000-4000-8000-000000000000', null]) {
    await assert.rejects(store.read(id), /Unknown PDF/);
    await assert.rejects(store.update(id, { title: 'Changed' }), /Unknown PDF/);
    await assert.rejects(store.remove(id), /Unknown PDF/);
    await assert.rejects(store.withDocumentPath(id, () => assert.fail('Unknown document reached shell action.')), /Unknown PDF/);
  }
});

test('rejects oversized, non-PDF, and directory imports without adding catalog entries', async t => {
  const { directory, root, store } = await fixture(t);
  const oversized = path.join(directory, 'Oversized.pdf');
  const handle = await fs.open(oversized, 'wx');
  await handle.truncate(MAX_PDF_BYTES + 1);
  await handle.close();
  const invalid = path.join(directory, 'Invalid.pdf');
  await fs.writeFile(invalid, 'This is not a PDF document.');
  const wrongExtension = path.join(directory, 'Not a PDF.txt');
  await fs.writeFile(wrongExtension, pdf);
  const folder = path.join(directory, 'Folder.pdf');
  await fs.mkdir(folder);
  const result = await store.import([oversized, invalid, wrongExtension, folder]);
  assert.equal(result.errors.length, 4);
  assert.match(result.errors[0], /100 MB limit/);
  assert.deepEqual(result.importedIds, []);
  assert.deepEqual(result.library.documents, []);
  assert.deepEqual(await fs.readdir(path.join(root, 'documents')), []);
  await assert.rejects(store.import(Array.from({ length: 101 }, () => invalid)), /100 PDF/);
});

test('removing a catalog entry preserves the original and managed PDF', async t => {
  const { root, source, store } = await fixture(t);
  const id = (await store.import([source])).importedIds[0];
  const removed = await store.remove(id);
  assert.deepEqual(removed.documents, []);
  assert.deepEqual(removed.warnings, []);
  assert.deepEqual(await fs.readFile(source), pdf);
  assert.deepEqual(await fs.readFile(path.join(root, 'documents', id + '.pdf')), pdf);
  assert.deepEqual((await (await LibraryStore.open(root)).load()).documents, []);
  assert.equal((await store.import([source])).importedIds.length, 1);
});

test('does not overwrite a corrupt or unsupported catalog', async t => {
  const { root } = await fixture(t);
  for (const content of ['{broken', JSON.stringify({ version: 2, documents: [] }), JSON.stringify({ version: 1, documents: [{ id: '../escape' }] })]) {
    await fs.writeFile(path.join(root, 'catalog.json'), content);
    await assert.rejects(LibraryStore.open(root), /damaged or unsupported/);
    assert.equal(await fs.readFile(path.join(root, 'catalog.json'), 'utf8'), content);
  }
});

test('detects external catalog edits before metadata can overwrite them', async t => {
  const { root, source, store } = await fixture(t);
  const id = (await store.import([source])).importedIds[0];
  const catalog = path.join(root, 'catalog.json');
  const external = '{"version":1,"documents":[]}\n';
  await fs.writeFile(catalog, external);
  await assert.rejects(store.update(id, { favorite: true }), /catalog changed outside/);
  assert.equal(await fs.readFile(catalog, 'utf8'), external);
  assert.deepEqual((await (await LibraryStore.open(root)).load()).documents, []);
});

test('detects changed and missing managed copies without modifying them', async t => {
  const { root, source, store } = await fixture(t);
  const id = (await store.import([source])).importedIds[0];
  const managed = path.join(root, 'documents', id + '.pdf');
  const changed = Buffer.from(pdf);
  changed[10] ^= 1;
  await fs.writeFile(managed, changed);
  await assert.rejects(store.read(id), /managed PDF changed/);
  await assert.rejects(store.withDocumentPath(id, () => assert.fail('Changed file reached shell.')), /managed PDF changed/);
  assert.deepEqual(await fs.readFile(managed), changed);
  await fs.unlink(managed);
  assert.match((await store.load()).warnings.join(' '), /unavailable/);
  await assert.rejects(store.read(id), { code: 'ENOENT' });
  const retry = await store.import([source]);
  assert.equal(retry.duplicateCount, 0);
  assert.match(retry.errors.join(' '), /Remove its library entry/);
  assert.deepEqual(await fs.readFile(source), pdf);
});

test('does not follow imported symlinks or replaced managed directories', async t => {
  const { directory, root, source, store } = await fixture(t);
  const link = path.join(directory, 'Linked.pdf');
  try { await fs.symlink(source, link); }
  catch (error) {
    if (process.platform === 'win32' && ['EPERM', 'EACCES'].includes((error as NodeJS.ErrnoException).code || '')) { t.skip('Creating Windows symbolic links needs an enabled developer mode or privilege.'); return; }
    throw error;
  }
  assert.equal((await store.import([link])).errors.length, 1);
  const id = (await store.import([source])).importedIds[0];
  await fs.rename(path.join(root, 'documents'), path.join(root, 'original-documents'));
  await fs.mkdir(path.join(root, 'documents'));
  await assert.rejects(store.read(id), /library folder changed/);
  await assert.rejects(store.update(id, { favorite: true }), /library folder changed/);
  assert.deepEqual(await fs.readdir(path.join(root, 'documents')), []);
});

test('serializes concurrent imports and metadata changes without dropping entries', async t => {
  const { directory, source, store } = await fixture(t);
  const second = path.join(directory, 'Second.pdf');
  await fs.writeFile(second, Buffer.concat([pdf, Buffer.from('%different')]));
  const imports = await Promise.all([store.import([source]), store.import([second]), store.import([source])]);
  assert.equal(imports.reduce((count, result) => count + result.importedIds.length, 0), 2);
  assert.equal(imports.reduce((count, result) => count + result.duplicateCount, 0), 1);
  const documents = (await store.load()).documents;
  await Promise.all(documents.map(document => store.update(document.id, { favorite: true })));
  assert.ok((await store.load()).documents.every(document => document.favorite));
});

test('cleans partial managed copies after disk-write failures without consuming space on retry', async t => {
  const { root, source, store } = await fixture(t, failPartialWrite('pdf'));
  for (let attempt = 0; attempt < 3; attempt++) {
    const result = await store.import([source]);
    assert.match(result.errors.join(' '), /disk-full write failure/);
    assert.deepEqual(result.importedIds, []);
    assert.deepEqual(result.library.documents, []);
    assert.deepEqual(await fs.readdir(path.join(root, 'documents')), []);
    assert.deepEqual(await fs.readdir(root), ['documents']);
  }
  assert.deepEqual(await fs.readFile(source), pdf);
});

test('cleans failed catalog writes and their unpublished managed copies', async t => {
  const { root, source, store } = await fixture(t, failPartialWrite('catalog'));
  const result = await store.import([source]);
  assert.match(result.errors.join(' '), /disk-full write failure/);
  assert.deepEqual(result.importedIds, []);
  assert.deepEqual(await fs.readdir(path.join(root, 'documents')), []);
  assert.deepEqual(await fs.readdir(root), ['documents']);
  assert.deepEqual(await fs.readFile(source), pdf);
});

test('cleans failed catalog publication while preserving an existing library and its files', async t => {
  const { directory, root, source, store } = await fixture(t);
  const existing = (await store.import([source])).library.documents[0];
  const previousCatalog = await fs.readFile(path.join(root, 'catalog.json'));
  const nextSource = path.join(directory, 'Next.pdf');
  await fs.writeFile(nextSource, Buffer.concat([pdf, Buffer.from('%next')]));
  const failing = await LibraryStore.open(root, { rename: async () => { throw new Error('Injected catalog rename failure'); } });
  const result = await failing.import([nextSource]);
  assert.match(result.errors.join(' '), /catalog rename failure/);
  assert.deepEqual(result.library.documents, [existing]);
  assert.deepEqual(await fs.readFile(path.join(root, 'catalog.json')), previousCatalog);
  assert.deepEqual(await fs.readdir(path.join(root, 'documents')), [existing.id + '.pdf']);
  assert.deepEqual((await fs.readdir(root)).sort(), ['catalog.json', 'documents']);
  assert.deepEqual(await fs.readFile(source), pdf);
});

test('cleans an unpublished import after an unrelated external catalog edit', async t => {
  let rootPath = '';
  const external = '{"version":1,"documents":[]}\n';
  const { root, source, store } = await fixture(t, {
    createFile: async filename => {
      const handle = await fs.open(filename, 'wx+', 0o600);
      if (filename.endsWith('.pdf')) {
        const sync = handle.sync.bind(handle);
        handle.sync = async () => { await sync(); await fs.writeFile(path.join(rootPath, 'catalog.json'), external); };
      }
      return handle;
    },
  });
  rootPath = root;
  const result = await store.import([source]);
  assert.match(result.errors.join(' '), /catalog changed outside/);
  assert.deepEqual(await fs.readdir(path.join(root, 'documents')), []);
  assert.equal(await fs.readFile(path.join(root, 'catalog.json'), 'utf8'), external);
});

test('preserves an externally replaced managed path when catalog publication fails', async t => {
  let managed = '';
  let moved = '';
  const replacement = Buffer.from('An external replacement must survive.');
  const { root, source, store } = await fixture(t, {
    createFile: async filename => {
      const handle = await fs.open(filename, 'wx+', 0o600);
      if (filename.endsWith('.pdf')) managed = filename;
      return handle;
    },
    rename: async () => {
      moved = managed + '.moved';
      await fs.rename(managed, moved);
      await fs.writeFile(managed, replacement);
      throw new Error('Injected publication failure after replacement');
    },
  });
  const result = await store.import([source]);
  assert.match(result.errors.join(' '), /retained for recovery/);
  assert.deepEqual(result.library.documents, []);
  assert.deepEqual(await fs.readFile(managed), replacement);
  assert.deepEqual(await fs.readFile(moved), pdf);
  assert.deepEqual(await fs.readdir(root), ['documents']);
});

test('preserves external in-place edits to an unpublished managed file', async t => {
  let managed = '';
  const replacement = Buffer.from('%PDF-1.7\nExternal edits');
  const { source, store } = await fixture(t, {
    createFile: async filename => {
      const handle = await fs.open(filename, 'wx+', 0o600);
      if (filename.endsWith('.pdf')) managed = filename;
      return handle;
    },
    rename: async () => {
      await fs.writeFile(managed, replacement);
      throw new Error('Injected publication failure after an in-place edit');
    },
  });
  const result = await store.import([source]);
  assert.match(result.errors.join(' '), /retained for recovery/);
  assert.deepEqual(await fs.readFile(managed), replacement);
  assert.deepEqual(result.importedIds, []);
});

test('retains an imported PDF when a failed publication already wrote its catalog reference', async t => {
  const { root, source, store } = await fixture(t, {
    rename: async (from, to) => {
      await fs.rename(from, to);
      throw new Error('Injected uncertain rename result');
    },
  });
  const result = await store.import([source]);
  assert.match(result.errors.join(' '), /uncertain rename result/);
  assert.match(result.errors.join(' '), /retained for recovery/);
  const reopened = await LibraryStore.open(root);
  const [document] = (await reopened.load()).documents;
  assert.ok(document);
  assert.deepEqual(Buffer.from(await reopened.read(document.id)), pdf);
  assert.deepEqual((await fs.readdir(root)).sort(), ['catalog.json', 'documents']);
});

test('never rolls back a committed import because closing its handles reports an error', async t => {
  const { root, source, store } = await fixture(t, {
    createFile: async filename => {
      const handle = await fs.open(filename, 'wx+', 0o600);
      const close = handle.close.bind(handle);
      handle.close = async () => { await close(); throw new Error('Injected post-close failure'); };
      return handle;
    },
  });
  const result = await store.import([source]);
  assert.deepEqual(result.errors, []);
  assert.equal(result.importedIds.length, 1);
  const reopened = await LibraryStore.open(root);
  assert.deepEqual(Buffer.from(await reopened.read(result.importedIds[0])), pdf);
  assert.deepEqual(await fs.readdir(path.join(root, 'documents')), [result.importedIds[0] + '.pdf']);
});
