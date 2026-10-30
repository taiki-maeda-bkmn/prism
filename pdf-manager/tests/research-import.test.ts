import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { LibraryStore, MAX_PDF_BYTES, type ArxivImportMetadata, type LibraryWriteIO } from '../src/main/library';
import { PDFLibraryService } from '../src/main/library-service';

const pdf = Buffer.from('%PDF-1.7\n1 0 obj\n<< /Type /Catalog >>\nendobj\n%%EOF\n');
const metadata: ArxivImportMetadata = { arxivId: '2601.01234v2', title: '市場と執行の研究', tags: ['Rates', 'Execution'] };
const forbiddenDownload = async (): Promise<Uint8Array> => { throw new Error('An existing source must not download again.'); };

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

async function fixture(t: TestContext, io: Partial<LibraryWriteIO> = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'prism-research-library-'));
  const root = path.join(directory, 'library');
  const owners: PDFLibraryService[] = [];
  t.after(async () => {
    await Promise.all(owners.map(owner => owner.close()));
    await fs.rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });
  const service = () => {
    const owner = new PDFLibraryService(root, io);
    owners.push(owner);
    return owner;
  };
  const catalog = path.join(root, 'catalog.json');
  const managed = (id: string) => path.join(root, 'documents', `${id}.pdf`);
  return { directory, root, catalog, managed, service };
}

test('opening a legacy catalogue leaves its bytes and documents untouched', async t => {
  const f = await fixture(t);
  const source = path.join(f.directory, 'Local source.pdf');
  await fs.writeFile(source, pdf);
  const store = await LibraryStore.open(f.root);
  const original = (await store.import([source])).library.documents[0];
  const bytes = await fs.readFile(f.catalog);
  const owner = f.service();
  assert.deepEqual((await owner.load()).documents, [original]);
  assert.equal(Object.hasOwn(original, 'arxivId'), false);
  assert.deepEqual(await fs.readFile(f.catalog), bytes);
  assert.deepEqual(Buffer.from(await owner.read(original.id)), pdf);
});

test('arXiv provenance and metadata survive normal updates, reopen, and the shared standalone store', async t => {
  const f = await fixture(t);
  const owner = f.service();
  const result = await owner.importArxiv(metadata, async () => pdf);
  assert.equal(result.duplicate, false);
  assert.equal(result.warning, undefined);
  assert.equal(result.document.arxivId, metadata.arxivId);
  assert.equal(result.document.filename, 'arxiv-2601.01234v2.pdf');
  assert.equal(result.document.title, metadata.title);
  assert.deepEqual(result.document.tags, metadata.tags);
  result.document.tags.push('Caller mutation');
  const updated = await owner.update(result.document.id, { title: 'My own title', tags: ['Personal'], favorite: true, pageCount: 10, lastPage: 7 });
  assert.equal(updated.arxivId, metadata.arxivId);
  await owner.close();
  const standaloneStore = await LibraryStore.open(f.root);
  assert.deepEqual((await standaloneStore.load()).documents, [updated]);
  const reopened = f.service();
  assert.deepEqual((await reopened.load()).documents, [updated]);
  assert.deepEqual(Buffer.from(await reopened.read(updated.id)), pdf);
  await assert.rejects(reopened.update(updated.id, { arxivId: '2601.99999' }), /Unsupported/);
});

test('base-ID reuse skips downloads and preserves the saved version, personal metadata and reading position', async t => {
  const f = await fixture(t);
  const owner = f.service();
  const original = (await owner.importArxiv(metadata, async () => pdf)).document;
  const edited = await owner.update(original.id, { title: 'Custom title', tags: ['My topic', 'RATES'], favorite: true, pageCount: 15, lastPage: 9 });
  const duplicate = await owner.importArxiv({ ...metadata, arxivId: '2601.01234v3', title: 'A later title' }, forbiddenDownload);
  assert.equal(duplicate.duplicate, true);
  assert.equal(duplicate.document.id, edited.id);
  assert.equal(duplicate.document.arxivId, '2601.01234v2');
  assert.equal(duplicate.document.title, edited.title);
  assert.equal(duplicate.document.favorite, true);
  assert.equal(duplicate.document.lastPage, 9);
  assert.equal(duplicate.document.pageCount, 15);
  assert.equal(duplicate.document.lastOpenedAt, edited.lastOpenedAt);
  assert.deepEqual(duplicate.document.tags, ['My topic', 'RATES', 'Execution']);
  assert.match(duplicate.warning!, /saved PDF for arXiv 2601\.01234v2/);
  assert.deepEqual(await fs.readFile(f.managed(edited.id)), pdf);
  await owner.close();
  const before = await fs.readFile(f.catalog);
  const same = await f.service().importArxiv(metadata, forbiddenDownload);
  assert.equal(same.document.id, edited.id);
  assert.equal(same.warning, undefined);
  assert.deepEqual(await fs.readFile(f.catalog), before, 'An unchanged duplicate does not rewrite the catalogue.');
});

test('hash deduplication connects a local PDF without replacing its title or a different saved source', async t => {
  const f = await fixture(t);
  const source = path.join(f.directory, 'Personal filename.pdf');
  await fs.writeFile(source, pdf);
  const owner = f.service();
  const local = (await owner.import([source])).library.documents[0];
  await owner.update(local.id, { title: 'Personal name', tags: ['Personal'], favorite: true, pageCount: 6, lastPage: 4 });
  const connected = await owner.importArxiv(metadata, async () => pdf);
  assert.equal(connected.duplicate, true);
  assert.equal(connected.document.id, local.id);
  assert.equal(connected.document.filename, 'Personal filename.pdf');
  assert.equal(connected.document.title, 'Personal name');
  assert.equal(connected.document.lastPage, 4);
  assert.equal(connected.document.favorite, true);
  assert.equal(connected.document.arxivId, metadata.arxivId);
  const other = await owner.importArxiv({ ...metadata, arxivId: '2601.54321v1' }, async () => pdf);
  assert.equal(other.document.id, local.id);
  assert.equal(other.document.arxivId, metadata.arxivId);
  assert.match(other.warning!, /source and contents were preserved/);
  assert.equal((await owner.load()).documents.length, 1);
  assert.deepEqual(await fs.readdir(path.join(f.root, 'documents')), [`${local.id}.pdf`]);
});

test('source topics are bounded and merged after existing tags with explicit overflow feedback', async t => {
  const f = await fixture(t);
  const owner = f.service();
  const tags = Array.from({ length: 14 }, (_, i) => `Topic ${i}`);
  const first = await owner.importArxiv({ ...metadata, title: 'A'.repeat(300), tags: [...tags, 'topic 0', 'x'.repeat(100)] }, async () => pdf);
  assert.equal(first.document.title.length, 200);
  assert.deepEqual(first.document.tags, tags.slice(0, 12));
  assert.match(first.warning!, /first 12 tags/);
  const previous = await fs.readFile(f.catalog);
  const repeated = await owner.importArxiv({ ...metadata, tags: ['New topic'] }, forbiddenDownload);
  assert.deepEqual(repeated.document.tags, first.document.tags);
  assert.match(repeated.warning!, /first 12 tags/);
  assert.deepEqual(await fs.readFile(f.catalog), previous);
  const separate = await owner.importArxiv({ ...metadata, arxivId: 'hep-th/9901001v1', tags: ['Long ' + 't'.repeat(90), 'Long ' + 't'.repeat(90)] }, async () => Buffer.concat([pdf, Buffer.from('%other')]));
  assert.equal(separate.document.filename, 'arxiv-hep-th-9901001v1.pdf');
  assert.deepEqual(separate.document.tags, [('Long ' + 't'.repeat(90)).slice(0, 40)]);
});

test('invalid sources and invalid downloads never publish a managed PDF or catalogue', async t => {
  const f = await fixture(t);
  const owner = f.service();
  for (const input of [
    { ...metadata, arxivId: '../../secret' }, { ...metadata, arxivId: 'https://arxiv.org/pdf/2601.01234' },
    { ...metadata, arxivId: '2600.01234' }, { ...metadata, title: '' },
    { ...metadata, title: 'Bad\ntitle' }, { ...metadata, tags: ['Bad\ntag'] }, { ...metadata, tags: [''] },
    { ...metadata, tags: Array.from({ length: 31 }, () => 'Topic') },
  ]) await assert.rejects(owner.importArxiv(input, async () => { assert.fail('Invalid metadata reached downloader'); }));
  for (const bytes of [new Uint8Array(0), Buffer.from('not a PDF at all'), new Uint8Array(MAX_PDF_BYTES + 1)]) {
    await assert.rejects(owner.importArxiv(metadata, async () => bytes), /PDF/);
  }
  assert.deepEqual((await owner.load()).documents, []);
  assert.deepEqual(await fs.readdir(path.join(f.root, 'documents')), []);
  await assert.rejects(fs.stat(f.catalog), { code: 'ENOENT' });
});

test('missing or changed saved source copies block duplicate imports before downloading', async t => {
  const f = await fixture(t);
  const owner = f.service();
  const original = (await owner.importArxiv(metadata, async () => pdf)).document;
  const before = await fs.readFile(f.catalog);
  await fs.writeFile(f.managed(original.id), Buffer.concat([pdf, Buffer.from('Changed outside Prism')]));
  await assert.rejects(owner.importArxiv(metadata, forbiddenDownload), /existing library copy is missing or changed/);
  await fs.unlink(f.managed(original.id));
  await assert.rejects(owner.importArxiv(metadata, forbiddenDownload), /existing library copy is missing or changed/);
  assert.deepEqual(await fs.readFile(f.catalog), before);
  await owner.remove(original.id);
  const replacement = await owner.importArxiv(metadata, async () => pdf);
  assert.notEqual(replacement.document.id, original.id);
});

test('download failures retry without files, and external catalogue edits during download remain untouched', async t => {
  const f = await fixture(t);
  const owner = f.service();
  await assert.rejects(owner.importArxiv(metadata, async () => { throw new Error('Network unavailable'); }), /Network unavailable/);
  assert.deepEqual(await fs.readdir(path.join(f.root, 'documents')), []);
  const external = JSON.stringify({ version: 1, documents: [] });
  await assert.rejects(owner.importArxiv(metadata, async () => {
    await fs.writeFile(f.catalog, external);
    return pdf;
  }), /catalog changed outside/);
  assert.equal(await fs.readFile(f.catalog, 'utf8'), external);
  assert.deepEqual(await fs.readdir(path.join(f.root, 'documents')), []);
  await owner.close();
  assert.equal((await f.service().importArxiv(metadata, async () => pdf)).duplicate, false);
});

test('failed PDF writes and catalogue publication leave existing documents intact and remove owned partial copies', async t => {
  const f = await fixture(t);
  const owner = f.service();
  const original = (await owner.importArxiv(metadata, async () => pdf)).document;
  // Use the shared store directly to inject publication failures after closing
  // the owning service, without bypassing a live library owner.
  await owner.close();
  const before = await fs.readFile(f.catalog);
  for (const phase of ['pdf', 'catalog'] as const) {
    const store = await LibraryStore.open(f.root, {
      createFile: async filename => {
        const handle = await fs.open(filename, 'wx+', 0o600);
        if (phase === 'pdf' && filename.endsWith('.pdf')) handle.writeFile = async data => {
          assert.ok(Buffer.isBuffer(data));
          await handle.write(data.subarray(0, 12));
          throw new Error('Injected PDF write failure');
        };
        return handle;
      },
      rename: async (source, destination) => {
        if (phase === 'catalog') throw new Error('Injected catalog publication failure');
        await fs.rename(source, destination);
      },
    });
    await assert.rejects(store.importArxiv({ ...metadata, arxivId: '2601.54321' }, async () => Buffer.concat([pdf, Buffer.from('%new')])), /Injected/);
    assert.deepEqual(await fs.readFile(f.catalog), before);
    assert.deepEqual(await fs.readFile(f.managed(original.id)), pdf);
    assert.deepEqual(await fs.readdir(path.join(f.root, 'documents')), [`${original.id}.pdf`]);
  }
});

test('close retains ownership through an admitted download and queued duplicate import', async t => {
  const f = await fixture(t);
  const owner = f.service();
  const entered = deferred(); const release = deferred();
  let downloads = 0;
  const first = owner.importArxiv(metadata, async () => { downloads++; entered.resolve(); await release.promise; return pdf; });
  let second: ReturnType<PDFLibraryService['importArxiv']> | undefined;
  let closing: Promise<void> | undefined;
  try {
    await entered.promise;
    second = owner.importArxiv({ ...metadata, arxivId: '2601.01234v3' }, async () => { downloads++; return pdf; });
    let closed = false;
    closing = owner.close().then(() => { closed = true; });
    await assert.rejects(owner.importArxiv(metadata, forbiddenDownload), /closing/);
    const contender = f.service();
    await assert.rejects(contender.load(), /already open/);
    assert.equal(closed, false);
    release.resolve();
    const [imported, duplicate] = await Promise.all([first, second]);
    await closing;
    assert.equal(downloads, 1);
    assert.equal(duplicate.document.id, imported.document.id);
    assert.equal(duplicate.document.arxivId, metadata.arxivId);
    assert.equal((await contender.load()).documents.length, 1);
  } finally {
    release.resolve();
    await Promise.allSettled([first, second, closing].filter(item => item !== undefined));
  }
});

test('catalogue provenance rejects malformed, noncanonical and duplicate source identities without rewriting', async t => {
  const f = await fixture(t);
  const owner = f.service();
  const first = (await owner.importArxiv(metadata, async () => pdf)).document;
  const second = (await owner.importArxiv({ ...metadata, arxivId: '2601.54321' }, async () => Buffer.concat([pdf, Buffer.from('%second')]))).document;
  await owner.close();
  for (const value of [null, 123, '', '../../file', 'https://arxiv.org/abs/2601.01234', '2601.01234v0', ' 2601.01234', '2601.01234V2']) {
    const raw = JSON.stringify({ version: 1, documents: [{ ...first, arxivId: value }] });
    await fs.writeFile(f.catalog, raw);
    await assert.rejects(LibraryStore.open(f.root), /damaged or unsupported/);
    assert.equal(await fs.readFile(f.catalog, 'utf8'), raw);
  }
  const duplicates = JSON.stringify({ version: 1, documents: [first, { ...second, arxivId: '2601.01234v3' }] });
  await fs.writeFile(f.catalog, duplicates);
  await assert.rejects(LibraryStore.open(f.root), /damaged or unsupported/);
  assert.equal(await fs.readFile(f.catalog, 'utf8'), duplicates);
});
