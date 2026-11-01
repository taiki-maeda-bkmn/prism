import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { LibraryStore, MAX_FOLDERS, type LibraryWriteIO } from '../src/main/library';
import { PDFLibraryService } from '../src/main/library-service';
import type { PDFDocument } from '../src/shared/types';

const pdf = Buffer.from('%PDF-1.7\n1 0 obj\n<< /Type /Catalog >>\nendobj\n%%EOF\n');
const anotherPDF = Buffer.concat([pdf, Buffer.from('\n% Another paper\n')]);

async function fixture(t: TestContext, writeIO: Partial<LibraryWriteIO> = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'prism-pdf-folders-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const root = path.join(directory, 'library');
  const source = path.join(directory, 'Research.pdf');
  await fs.writeFile(source, pdf);
  const store = await LibraryStore.open(root, writeIO);
  const catalog = path.join(root, 'catalog.json');
  return { root, source, store, catalog };
}

function withoutAssignment(document: PDFDocument) {
  const { folderId: _folderId, updatedAt: _updatedAt, ...retained } = document;
  return retained;
}

test('loading and ordinary edits retain v1; first folder atomically upgrades without altering PDFs', async t => {
  const { root, source, store, catalog } = await fixture(t);
  assert.deepEqual(await store.load(), { documents: [], folders: [], warnings: [] });
  await assert.rejects(fs.stat(catalog), { code: 'ENOENT' });
  const original = (await store.import([source])).library.documents[0];
  const oldBytes = await fs.readFile(catalog);
  const reopened = await LibraryStore.open(root);
  assert.deepEqual((await reopened.load()).folders, []);
  assert.deepEqual(await fs.readFile(catalog), oldBytes);
  const edited = await reopened.update(original.id, { favorite: true, tags: ['金融'], lastPage: 3, pageCount: 10 });
  assert.equal(JSON.parse(await fs.readFile(catalog, 'utf8')).version, 1);
  assert.equal(Object.hasOwn(JSON.parse(await fs.readFile(catalog, 'utf8')), 'folders'), false);
  const created = await reopened.createFolder('  Execution参考資料  ');
  assert.deepEqual(created.documents, [edited]);
  assert.equal(created.folders[0].name, 'Execution参考資料');
  assert.equal(JSON.parse(await fs.readFile(catalog, 'utf8')).version, 2);
  assert.deepEqual(Buffer.from(await reopened.read(edited.id)), pdf);
  assert.deepEqual(await (await LibraryStore.open(root)).load(), created);
  created.folders[0].name = 'Unexpected mutation';
  assert.equal((await reopened.load()).folders[0].name, 'Execution参考資料');
});

test('folder names normalize NFC and whitespace while rejecting invalid names and locale-dependent duplicates', async t => {
  const { root, store, catalog } = await fixture(t);
  const originalLowerCase = String.prototype.toLocaleLowerCase;
  t.mock.method(String.prototype, 'toLocaleLowerCase', function (this: string) {
    return originalLowerCase.call(this, 'tr');
  });
  const folder = (await store.createFolder('  Cafe\u0301  ')).folders[0];
  assert.equal(folder.name, 'Café');
  for (const invalid of ['', ' ', '.', '..', '/', 'a/b', 'a\\b', '\nname', 'name\t', 'a\u0000b', '\u007fname', 'a'.repeat(81), null, 7, {}]) {
    await assert.rejects(store.createFolder(invalid), /folder name/);
  }
  await assert.rejects(store.createFolder('cafe\u0301'), /already exists/);
  await store.createFolder('I');
  await assert.rejects(store.createFolder('i'), /already exists/);
  await store.createFolder('ı');
  const before = await fs.readFile(catalog);
  await assert.rejects(store.renameFolder(folder.id, 'i'), /already exists/);
  await assert.rejects(store.renameFolder(randomUUID(), 'Other'), /Unknown PDF folder/);
  assert.deepEqual(await fs.readFile(catalog), before);
  assert.deepEqual((await (await LibraryStore.open(root)).load()).folders.map(item => item.name), ['Café', 'I', 'ı']);
});

test('folder rename keeps identity and membership; identical rename and repeated moves do not rewrite the catalog', async t => {
  const { root, source, store, catalog } = await fixture(t);
  const document = (await store.import([source])).library.documents[0];
  const folder = (await store.createFolder('Research')).folders[0];
  const moved = await store.update(document.id, { folderId: folder.id });
  const before = await fs.readFile(catalog);
  const beforeStat = await fs.stat(catalog);
  assert.deepEqual(await store.update(document.id, { folderId: folder.id }), moved);
  await store.renameFolder(folder.id, ' Research ');
  assert.deepEqual(await fs.readFile(catalog), before);
  assert.equal((await fs.stat(catalog)).ino, beforeStat.ino);
  const renamed = await store.renameFolder(folder.id, 'RESEARCH');
  assert.deepEqual(renamed.folders, [{ id: folder.id, name: 'RESEARCH' }]);
  assert.deepEqual(renamed.documents, [moved]);
  assert.deepEqual(await (await LibraryStore.open(root)).load(), renamed);
});

test('moving and unfiling preserve saved metadata, source identity, managed path and bytes', async t => {
  const { root, store, catalog } = await fixture(t);
  const imported = await store.importArxiv({ arxivId: '2501.12345v1', title: 'Saved title', tags: ['金融'] }, async () => pdf);
  const saved = await store.update(imported.document.id, { favorite: true, pageCount: 12, lastPage: 8 });
  const first = (await store.createFolder('Execution参考資料')).folders[0];
  const second = (await store.createFolder('Archive')).folders[1];
  for (const folderId of [first.id, second.id, null]) {
    const moved = await store.update(saved.id, { folderId });
    assert.deepEqual(withoutAssignment(moved), withoutAssignment(saved));
    assert.equal(moved.folderId ?? null, folderId);
    assert.equal(Object.hasOwn(moved, 'folderId'), folderId !== null);
    assert.deepEqual(await fs.readFile(path.join(root, 'documents', `${saved.id}.pdf`)), pdf);
    assert.deepEqual((await (await LibraryStore.open(root)).load()).documents, [moved]);
  }
  const before = await fs.readFile(catalog);
  const beforeStat = await fs.stat(catalog);
  await store.update(saved.id, { folderId: null });
  assert.deepEqual(await fs.readFile(catalog), before);
  assert.equal((await fs.stat(catalog)).ino, beforeStat.ino);
  for (const folderId of [randomUUID(), '../folder', undefined, 12, '']) {
    await assert.rejects(store.update(saved.id, { folderId }), /Unknown PDF folder/);
  }
  assert.deepEqual(await fs.readFile(catalog), before);
  const combined = await store.update(saved.id, { folderId: first.id, title: 'New title', tags: ['Rates'], favorite: false });
  assert.equal(combined.folderId, first.id);
  assert.equal(combined.title, 'New title');
  assert.equal(combined.lastOpenedAt, saved.lastOpenedAt);
  assert.deepEqual(combined.tags, ['Rates']);
});

test('unfiled v1 document accepts a no-op and rejects nonexistent assignments without migrating', async t => {
  const { source, store, catalog } = await fixture(t);
  const document = (await store.import([source])).library.documents[0];
  const before = await fs.readFile(catalog);
  assert.deepEqual(await store.update(document.id, { folderId: null }), document);
  await assert.rejects(store.update(document.id, { folderId: randomUUID() }), /Unknown PDF folder/);
  assert.deepEqual(await fs.readFile(catalog), before);
  assert.equal(JSON.parse(before.toString()).version, 1);
});

test('removing a populated folder unfiles only its PDFs, preserves bytes, and retains v2 after last removal', async t => {
  const { root, source, store, catalog } = await fixture(t);
  const firstDoc = (await store.import([source])).library.documents[0];
  const secondDoc = (await store.importDownloaded({ filename: 'Second.pdf', bytes: anotherPDF })).document;
  const first = (await store.createFolder('First')).folders[0];
  const second = (await store.createFolder('Second')).folders[1];
  const firstMoved = await store.update(firstDoc.id, { folderId: first.id, favorite: true, lastPage: 3, pageCount: 5 });
  const secondMoved = await store.update(secondDoc.id, { folderId: second.id, tags: ['Rates'] });
  const removed = await store.removeFolder(first.id);
  assert.deepEqual(removed.folders, [second]);
  assert.equal(Object.hasOwn(removed.documents[0], 'folderId'), false);
  assert.deepEqual(withoutAssignment(removed.documents[0]), withoutAssignment(firstMoved));
  assert.deepEqual(removed.documents[1], secondMoved);
  assert.deepEqual(Buffer.from(await store.read(firstDoc.id)), pdf);
  assert.deepEqual(Buffer.from(await store.read(secondDoc.id)), anotherPDF);
  await assert.rejects(store.removeFolder(first.id), /Unknown PDF folder/);
  await store.removeFolder(second.id);
  const last = JSON.parse(await fs.readFile(catalog, 'utf8'));
  assert.equal(last.version, 2);
  assert.deepEqual(last.folders, []);
  assert.ok(last.documents.every((document: PDFDocument) => !Object.hasOwn(document, 'folderId')));
  assert.deepEqual(await (await LibraryStore.open(root)).load(), await store.load());
});

test('new local/download/arXiv imports are unfiled while duplicates and document removal retain folders', async t => {
  const { root, source, store } = await fixture(t);
  const folder = (await store.createFolder('Library')).folders[0];
  const local = await store.import([source]);
  const original = local.library.documents[0];
  assert.equal(original.folderId, undefined);
  assert.deepEqual(local.library.folders, [folder]);
  await store.update(original.id, { folderId: folder.id });
  const duplicateLocal = await store.import([source]);
  assert.equal(duplicateLocal.duplicateCount, 1);
  assert.equal(duplicateLocal.library.documents[0].folderId, folder.id);
  const duplicateDownload = await store.importDownloaded({ filename: 'Other.pdf', bytes: pdf });
  assert.equal(duplicateDownload.duplicate, true);
  assert.equal(duplicateDownload.document.folderId, folder.id);
  const duplicateArxiv = await store.importArxiv({ arxivId: '2501.12345v1', title: 'Paper', tags: ['Rates'] }, async () => pdf);
  assert.equal(duplicateArxiv.duplicate, true);
  assert.equal(duplicateArxiv.document.folderId, folder.id);
  const repeatArxiv = await store.importArxiv({ arxivId: '2501.12345v2', title: 'Paper', tags: [] }, async () => { throw new Error('Should not download twice'); });
  assert.equal(repeatArxiv.document.folderId, folder.id);
  const downloaded = await store.importDownloaded({ filename: 'Second.pdf', bytes: anotherPDF });
  assert.equal(downloaded.document.folderId, undefined);
  const arxiv = await store.importArxiv({ arxivId: '2501.12346', title: 'Third', tags: [] }, async () => Buffer.concat([pdf, Buffer.from('% third')]));
  assert.equal(arxiv.document.folderId, undefined);
  const removed = await store.remove(downloaded.document.id);
  assert.deepEqual(removed.folders, [folder]);
  assert.equal(removed.documents[0].folderId, folder.id);
  assert.deepEqual(await (await LibraryStore.open(root)).load(), removed);
});

test('rejects damaged folder catalogs and memberships without changing their bytes', async t => {
  const { root, source, store, catalog } = await fixture(t);
  const document = (await store.import([source])).library.documents[0];
  const folder = { id: randomUUID(), name: 'Research' };
  const valid = { version: 2, documents: [{ ...document, folderId: folder.id }], folders: [folder] };
  const corrupt: unknown[] = [
    { version: 3, documents: [] }, { version: 2, documents: [] },
    { version: 1, documents: [], folders: [] },
    { version: 1, documents: [{ ...document, folderId: folder.id }] },
    { ...valid, folders: null }, { ...valid, folders: {} },
    { ...valid, extra: true },
    { ...valid, folders: [folder, { ...folder, name: 'Other' }] },
    { ...valid, folders: [folder, { id: randomUUID(), name: 'research' }] },
    { ...valid, documents: [{ ...document, folderId: randomUUID() }] },
    { ...valid, documents: [{ ...document, folderId: null }] },
    { ...valid, documents: [{ ...document, folderId: 12 }] },
    { ...valid, folders: Array.from({ length: MAX_FOLDERS + 1 }, (_, index) => ({ id: randomUUID(), name: `Folder ${index}` })) },
  ];
  for (const bad of [null, {}, { ...folder, unexpected: true }, { id: 'bad', name: 'Research' },
    ...['', ' ', '.', '..', 'A/B', 'A\\B', ' Café', 'Cafe\u0301', 'A\nB', 'x'.repeat(81)].map(name => ({ ...folder, name }))]) {
    corrupt.push({ ...valid, folders: [bad] });
  }
  for (const value of corrupt) {
    const bytes = JSON.stringify(value);
    await fs.writeFile(catalog, bytes);
    await assert.rejects(LibraryStore.open(root), /damaged or unsupported/, bytes);
    assert.equal(await fs.readFile(catalog, 'utf8'), bytes);
  }
  await fs.writeFile(catalog, JSON.stringify(valid));
  assert.equal((await (await LibraryStore.open(root)).load()).documents[0].folderId, folder.id);
});

test('folder count is bounded and queued duplicate creations cannot bypass name uniqueness', async t => {
  const { root, store, catalog } = await fixture(t);
  const created = await Promise.allSettled([store.createFolder('Research'), store.createFolder('research')]);
  assert.equal(created.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(created.filter(result => result.status === 'rejected').length, 1);
  const folders = Array.from({ length: MAX_FOLDERS }, (_, index) => ({ id: randomUUID(), name: `Folder ${index}` }));
  await fs.writeFile(catalog, JSON.stringify({ version: 2, documents: [], folders }));
  const full = await LibraryStore.open(root);
  const before = await fs.readFile(catalog);
  await assert.rejects(full.createFolder('One too many'), /up to 200 folders/);
  assert.deepEqual(await fs.readFile(catalog), before);
  await full.removeFolder(folders[0].id);
  assert.equal((await full.createFolder('Replacement')).folders.length, MAX_FOLDERS);
});

test('failed first-folder publication keeps the v1 catalog and allows a clean retry', async t => {
  let fail = false;
  const { root, source, store, catalog } = await fixture(t, {
    rename: async (sourceName, destination) => {
      if (fail) throw new Error('Injected publication failure');
      await fs.rename(sourceName, destination);
    },
  });
  await store.import([source]);
  const before = await fs.readFile(catalog);
  const snapshot = await store.load();
  fail = true;
  await assert.rejects(store.createFolder('Research'), /Injected publication failure/);
  assert.deepEqual(await fs.readFile(catalog), before);
  assert.deepEqual(await store.load(), snapshot);
  assert.equal((await fs.readdir(root)).some(name => name.endsWith('.tmp')), false);
  fail = false;
  assert.equal((await store.createFolder('Research')).folders.length, 1);
  assert.equal(JSON.parse(await fs.readFile(catalog, 'utf8')).version, 2);
});

test('failed rename, move and populated-folder removal publish neither partial memberships nor metadata', async t => {
  let fail = false;
  const { root, source, store, catalog } = await fixture(t, {
    rename: async (sourceName, destination) => {
      if (fail) throw new Error('Injected publication failure');
      await fs.rename(sourceName, destination);
    },
  });
  const document = (await store.import([source])).library.documents[0];
  const first = (await store.createFolder('First')).folders[0];
  const second = (await store.createFolder('Second')).folders[1];
  await store.update(document.id, { folderId: first.id, favorite: true, lastPage: 4, pageCount: 8 });
  const before = await fs.readFile(catalog);
  const snapshot = await store.load();
  fail = true;
  for (const operation of [
    () => store.renameFolder(first.id, 'Renamed'),
    () => store.update(document.id, { folderId: second.id, title: 'Should not save' }),
    () => store.removeFolder(first.id),
  ]) {
    await assert.rejects(operation(), /Injected publication failure/);
    assert.deepEqual(await fs.readFile(catalog), before);
    assert.deepEqual(await store.load(), snapshot);
    assert.deepEqual(Buffer.from(await store.read(document.id)), pdf);
    assert.equal((await fs.readdir(root)).some(name => name.endsWith('.tmp')), false);
  }
  assert.deepEqual(await (await LibraryStore.open(root)).load(), snapshot);
  fail = false;
  assert.equal((await store.removeFolder(first.id)).documents[0].folderId, undefined);
});

test('folder operations refuse external catalog changes rather than overwriting them', async t => {
  const { source, store, catalog } = await fixture(t);
  const document = (await store.import([source])).library.documents[0];
  const folder = (await store.createFolder('Research')).folders[0];
  const outside = (await fs.readFile(catalog, 'utf8')) + '\n';
  await fs.writeFile(catalog, outside);
  for (const operation of [
    () => store.createFolder('New'), () => store.renameFolder(folder.id, 'Changed'),
    () => store.removeFolder(folder.id), () => store.update(document.id, { folderId: folder.id }),
  ]) await assert.rejects(operation(), /changed outside/);
  assert.equal(await fs.readFile(catalog, 'utf8'), outside);
});

test('an uncertain v2 publication retains a new PDF already referenced by the catalog', async t => {
  let failAfterRename = false;
  const { root, store } = await fixture(t, {
    rename: async (source, destination) => {
      await fs.rename(source, destination);
      if (failAfterRename) throw new Error('Injected uncertain publication');
    },
  });
  const folder = (await store.createFolder('Research')).folders[0];
  failAfterRename = true;
  await assert.rejects(store.importDownloaded({ filename: 'Research.pdf', bytes: pdf }), /retained for recovery/);
  const recovered = await LibraryStore.open(root);
  const snapshot = await recovered.load();
  assert.deepEqual(snapshot.folders, [folder]);
  assert.equal(snapshot.documents.length, 1);
  assert.deepEqual(snapshot.warnings, []);
  assert.deepEqual(Buffer.from(await recovered.read(snapshot.documents[0].id)), pdf);
});

test('service serializes folder lifecycle and drains accepted folder writes before releasing ownership', async t => {
  const { root } = await fixture(t);
  const service = new PDFLibraryService(root);
  t.after(() => service.close());
  const creation = service.createFolder('Research');
  await service.close();
  const created = await creation;
  assert.equal(created.folders.length, 1);
  await assert.rejects(service.createFolder('Too late'), /closing/);
  const reopened = new PDFLibraryService(root);
  t.after(() => reopened.close());
  const id = created.folders[0].id;
  assert.deepEqual((await reopened.load()).folders, created.folders);
  const renamed = reopened.renameFolder(id, 'Reviewed');
  const removed = reopened.removeFolder(id);
  assert.equal((await renamed).folders[0].name, 'Reviewed');
  assert.deepEqual((await removed).folders, []);
  await reopened.close();
});
