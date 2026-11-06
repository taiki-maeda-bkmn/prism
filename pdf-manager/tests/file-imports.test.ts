import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { LibraryStore, type LibraryWriteIO } from '../src/main/library';
import { PDFLibraryService } from '../src/main/library-service';
import { validateImportPaths } from '../src/main/file-imports';
import { droppedFilePaths } from '../src/shared/fileImports';

const pdf = Buffer.from('%PDF-1.7\n1 0 obj\n<< /Type /Catalog >>\nendobj\n%%EOF\n');

async function fixture(t: TestContext, io: Partial<LibraryWriteIO> = {}) {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'prism-pdf-file-imports-'));
  const cleanup: Array<() => Promise<void>> = [];
  t.after(async () => {
    for (const action of cleanup.reverse()) await action();
    await fs.rm(temporary, { recursive: true, force: true });
  });
  const root = path.join(temporary, 'library');
  const source = path.join(temporary, '日本語の資料.PDF');
  await fs.writeFile(source, pdf);
  return { temporary, root, source, cleanup, store: await LibraryStore.open(root, io) };
}

test('new copies receive their target folder in the initial publication and survive restart', async t => {
  const publications: Array<{ documents: Array<{ folderId?: string }> }> = [];
  const { root, source, store } = await fixture(t, { rename: async (from, to) => {
    publications.push(JSON.parse(await fs.readFile(from, 'utf8')));
    await fs.rename(from, to);
  } });
  const folder = (await store.createFolder('Execution参考資料')).folders[0];
  const result = await store.import([source], folder.id);
  assert.equal(result.importedIds.length, 1);
  assert.deepEqual(result.errors, []);
  assert.equal(result.library.documents[0].folderId, folder.id);
  const imports = publications.filter(catalog => catalog.documents.length);
  assert.equal(imports.length, 1, 'No follow-up metadata move is needed.');
  assert.equal(imports[0].documents[0].folderId, folder.id);
  assert.deepEqual((await (await LibraryStore.open(root)).load()).documents, result.library.documents);
  assert.deepEqual(await fs.readFile(source), pdf);
  assert.deepEqual(await fs.readFile(path.join(root, 'documents', `${result.importedIds[0]}.pdf`)), pdf);
});

test('dropping a duplicate elsewhere preserves its folder, title, tags, favorite and reading state', async t => {
  const { temporary, source, store } = await fixture(t);
  const firstFolder = (await store.createFolder('First')).folders[0];
  const otherFolder = (await store.createFolder('Other')).folders.find(folder => folder.name === 'Other')!;
  const document = (await store.import([source], firstFolder.id)).library.documents[0];
  const saved = await store.update(document.id, { title: 'My title', tags: ['Execution', '日本語'], favorite: true, pageCount: 10, lastPage: 4 });
  const duplicate = path.join(temporary, 'Different name.pdf');
  await fs.writeFile(duplicate, pdf);
  for (const destination of [otherFolder.id, null, undefined]) {
    const result = await store.import([duplicate], destination);
    assert.equal(result.duplicateCount, 1);
    assert.deepEqual(result.importedIds, []);
    assert.deepEqual(result.library.documents, [saved]);
    assert.deepEqual(result.errors, []);
  }
  assert.deepEqual(await fs.readFile(source), pdf);
  assert.deepEqual(await fs.readFile(duplicate), pdf);
});

test('mixed batches import valid files into the target while reporting bad files separately', async t => {
  const { temporary, source, store } = await fixture(t);
  const folder = (await store.createFolder('Research')).folders[0];
  const invalid = path.join(temporary, 'Broken.pdf');
  const text = path.join(temporary, 'Notes.txt');
  const directory = path.join(temporary, 'Directory.pdf');
  await fs.writeFile(invalid, 'This is not a PDF');
  await fs.writeFile(text, pdf);
  await fs.mkdir(directory);
  const result = await store.import([invalid, source, text, directory], folder.id);
  assert.equal(result.importedIds.length, 1);
  assert.equal(result.errors.length, 3);
  assert.match(result.errors[0], /Broken\.pdf:.*PDF header/);
  assert.match(result.errors[1], /Notes\.txt:.*extension/);
  assert.match(result.errors[2], /Directory\.pdf:.*ordinary files/);
  assert.equal(result.library.documents[0].folderId, folder.id);
  assert.deepEqual(await fs.readFile(source), pdf);
});

test('missing or malformed folder targets reject the complete batch before publication', async t => {
  const { root, source, store } = await fixture(t);
  const folder = (await store.createFolder('Removed')).folders[0];
  await store.removeFolder(folder.id);
  const before = await fs.readFile(path.join(root, 'catalog.json'));
  for (const destination of [folder.id, randomUUID(), '', '../folder', 3, {}]) {
    await assert.rejects(store.import([source], destination), /Unknown PDF folder/);
    assert.deepEqual(await fs.readFile(path.join(root, 'catalog.json')), before);
    assert.deepEqual(await fs.readdir(path.join(root, 'documents')), []);
  }
  assert.deepEqual((await store.import([], folder.id)).importedIds, [], 'Cancelling a picker remains a no-op even if its folder was removed.');
  assert.deepEqual(await fs.readFile(path.join(root, 'catalog.json')), before);
  const result = await store.import([source], null);
  assert.equal(Object.hasOwn(result.library.documents[0], 'folderId'), false);
});

test('folder removal and import obey queue order without dangling folder references', async t => {
  const { source, store } = await fixture(t);
  const first = (await store.createFolder('First')).folders[0];
  const removing = store.removeFolder(first.id);
  const rejected = store.import([source], first.id);
  await removing;
  await assert.rejects(rejected, /Unknown PDF folder/);
  assert.deepEqual((await store.load()).documents, []);
  const second = (await store.createFolder('Second')).folders[0];
  const importing = store.import([source], second.id);
  const removed = store.removeFolder(second.id);
  assert.equal((await importing).library.documents[0].folderId, second.id);
  const final = await removed;
  assert.equal(final.documents.length, 1);
  assert.equal(Object.hasOwn(final.documents[0], 'folderId'), false);
  assert.deepEqual(final.folders, []);
});

test('failed publication does not leave an unfiled partial import and the same destination can retry', async t => {
  let fail = false;
  const { root, source, store } = await fixture(t, { rename: async (from, to) => {
    if (fail) throw new Error('Injected publication failure');
    await fs.rename(from, to);
  } });
  const folder = (await store.createFolder('Target')).folders[0];
  fail = true;
  const result = await store.import([source], folder.id);
  assert.deepEqual(result.importedIds, []);
  assert.match(result.errors[0], /Injected publication failure/);
  assert.deepEqual(result.library.documents, []);
  assert.deepEqual(await fs.readdir(path.join(root, 'documents')), []);
  fail = false;
  assert.equal((await store.import([source], folder.id)).library.documents[0].folderId, folder.id);
  assert.deepEqual(await fs.readFile(source), pdf);
});

test('invalid path batches cannot partially publish or resolve relative paths against the app directory', async t => {
  const { source, store } = await fixture(t);
  for (const value of ['', 'Relative.pdf', 'file:///tmp/Document.pdf', 'https://example.org/Document.pdf', source + '\0', 'x'.repeat(32_769)]) {
    await assert.rejects(store.import([source, value]), /absolute paths/);
    assert.deepEqual((await store.load()).documents, []);
  }
  for (const value of [null, {}, [source, 1], Array(101).fill(source)]) {
    assert.throws(() => validateImportPaths(value), /100 PDF files/);
  }
  const sparse = new Array<string>(2);
  sparse[0] = source;
  await assert.rejects(store.import(sparse), /100 PDF files/);
  assert.deepEqual((await store.load()).documents, []);
  assert.doesNotThrow(() => validateImportPaths([source]));
  assert.doesNotThrow(() => validateImportPaths([]));
});

test('the shared service forwards the import destination and drains the import on close', async t => {
  const { root, source, cleanup } = await fixture(t);
  const service = new PDFLibraryService(root);
  cleanup.push(() => service.close());
  const folder = (await service.createFolder('Research')).folders[0];
  const importing = service.import([source], folder.id);
  const closing = service.close();
  assert.equal((await importing).library.documents[0].folderId, folder.id);
  await closing;
  const next = new PDFLibraryService(root);
  cleanup.push(() => next.close());
  assert.equal((await next.load()).documents[0].folderId, folder.id);
});

test('dropped File resolution uses only the native resolver and rejects pathless or oversized batches', () => {
  const diskFile = new File([pdf], 'Original.pdf');
  Object.defineProperty(diskFile, 'path', { value: '/spoofed-path.pdf' });
  assert.deepEqual(droppedFilePaths([diskFile], () => '/actual-native-path.pdf'), ['/actual-native-path.pdf']);
  assert.throws(() => droppedFilePaths([diskFile], () => ''), /file manager/);
  assert.throws(() => droppedFilePaths([{} as File], () => { throw new TypeError('Not a File'); }), /file manager/);
  const sparse = new Array<File>(2);
  sparse[0] = diskFile;
  assert.throws(() => droppedFilePaths(sparse, file => {
    if (!file) throw new TypeError('Not a File');
    return '/actual-native-path.pdf';
  }), /file manager/);
  for (const files of [[], Array(101).fill(diskFile), null]) {
    assert.throws(() => droppedFilePaths(files as File[], () => assert.fail('Invalid batches must not reach the native resolver.')), /100 PDF files/);
  }
});
