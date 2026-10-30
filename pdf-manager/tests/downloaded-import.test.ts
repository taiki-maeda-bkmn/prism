import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { MAX_PDF_BYTES, type DownloadedPDFImport, type LibraryWriteIO } from '../src/main/library';
import { PDFLibraryService } from '../src/main/library-service';

const pdf = Buffer.from('%PDF-1.7\n1 0 obj\n<< /Type /Catalog >>\nendobj\n%%EOF\n');
async function fixture(t: TestContext, io: Partial<LibraryWriteIO> = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'prism-downloaded-import-'));
  const root = path.join(directory, 'library');
  const services: PDFLibraryService[] = [];
  t.after(async () => {
    try { await Promise.all(services.map(service => service.close())); }
    finally { await fs.rm(directory, { recursive: true, force: true }); }
  });
  const service = () => { const owner = new PDFLibraryService(root, io); services.push(owner); return owner; };
  return { directory, root, service, catalog: path.join(root, 'catalog.json'), managed: (id: string) => path.join(root, 'documents', `${id}.pdf`) };
}

test('downloaded PDFs persist ordinary metadata and bytes, with no URL or arXiv provenance added', async t => {
  const f = await fixture(t);
  const service = f.service();
  const first = await service.importDownloaded({ filename: '日本語の研究.PDF', bytes: pdf });
  assert.equal(first.duplicate, false);
  assert.equal(first.document.filename, '日本語の研究.PDF');
  assert.equal(first.document.title, '日本語の研究');
  assert.deepEqual(first.document.tags, []);
  assert.equal(first.document.favorite, false);
  assert.equal(first.document.lastPage, 1);
  assert.equal(first.document.pageCount, null);
  assert.equal(Object.hasOwn(first.document, 'arxivId'), false);
  assert.deepEqual(await fs.readFile(f.managed(first.document.id)), pdf);
  (first.document.tags as string[]).push('Caller mutation');
  await service.close();
  const reopened = f.service();
  const documents = (await reopened.load()).documents;
  assert.equal(documents.length, 1);
  assert.equal(documents[0].id, first.document.id);
  assert.deepEqual(documents[0].tags, []);
  assert.deepEqual(Buffer.from(await reopened.read(first.document.id)), pdf);
});

test('hash duplicates retain custom title, filename, tags, reading state and arXiv identity without a catalog rewrite', async t => {
  const f = await fixture(t);
  const service = f.service();
  const original = await service.importArxiv({ arxivId: '2601.01234v2', title: 'Published name', tags: ['Source'] }, async () => pdf);
  const edited = await service.update(original.document.id, { title: 'My title', tags: ['Personal'], favorite: true, lastPage: 4, pageCount: 8 });
  const before = await fs.readFile(f.catalog);
  const duplicate = await service.importDownloaded({ filename: 'different-name.pdf', bytes: pdf });
  assert.equal(duplicate.duplicate, true);
  assert.deepEqual(duplicate.document, edited);
  assert.deepEqual(await fs.readFile(f.catalog), before);
  assert.deepEqual(await fs.readdir(path.join(f.root, 'documents')), [`${edited.id}.pdf`]);
  duplicate.document.tags.push('Caller mutation');
  assert.deepEqual((await service.load()).documents[0], edited);
});

test('duplicate detection verifies managed bytes and leaves changed or missing copies untouched', async t => {
  const f = await fixture(t);
  const service = f.service();
  const { document } = await service.importDownloaded({ filename: 'Paper.pdf', bytes: pdf });
  const catalog = await fs.readFile(f.catalog);
  const external = Buffer.concat([pdf, Buffer.from('External edit')]);
  await fs.writeFile(f.managed(document.id), external);
  await assert.rejects(service.importDownloaded({ filename: 'Same.pdf', bytes: pdf }), /existing library copy is missing or changed/);
  assert.deepEqual(await fs.readFile(f.managed(document.id)), external);
  await fs.unlink(f.managed(document.id));
  await assert.rejects(service.importDownloaded({ filename: 'Same.pdf', bytes: pdf }), /existing library copy is missing or changed/);
  assert.deepEqual(await fs.readFile(f.catalog), catalog);
});

test('invalid filenames, headers and byte lengths never publish a document', async t => {
  const f = await fixture(t);
  const service = f.service();
  for (const filename of ['', '../private.pdf', 'folder\\file.pdf', 'https://example.com/a.pdf', 'report.txt', ' padded.pdf ', 'control\n.pdf', 'x'.repeat(252) + '.pdf']) {
    await assert.rejects(service.importDownloaded({ filename, bytes: pdf }), /filename/);
  }
  for (const bytes of [new Uint8Array(), new Uint8Array(MAX_PDF_BYTES + 1), Buffer.from('<html>not a PDF</html>')]) {
    await assert.rejects(service.importDownloaded({ filename: 'Paper.pdf', bytes }), /PDF/);
  }
  await assert.rejects(service.importDownloaded(null as unknown as DownloadedPDFImport), /filename/);
  assert.deepEqual((await service.load()).documents, []);
  assert.deepEqual(await fs.readdir(path.join(f.root, 'documents')), []);
  await assert.rejects(fs.stat(f.catalog), { code: 'ENOENT' });
});

test('concurrent identical downloads serialize into one document', async t => {
  const f = await fixture(t);
  const service = f.service();
  const [first, second] = await Promise.all([
    service.importDownloaded({ filename: 'First.pdf', bytes: pdf }),
    service.importDownloaded({ filename: 'Second.pdf', bytes: pdf }),
  ]);
  assert.equal(first.document.id, second.document.id);
  assert.equal(first.duplicate, false);
  assert.equal(second.duplicate, true);
  assert.equal(second.document.filename, 'First.pdf');
  assert.equal((await service.load()).documents.length, 1);
});

test('failed publication cleans the new PDF and keeps previously imported documents safe', async t => {
  let fail = false;
  const f = await fixture(t, { rename: async (source, target) => {
    if (fail) throw new Error('Simulated catalog publication failure');
    await fs.rename(source, target);
  } });
  const service = f.service();
  const first = await service.importDownloaded({ filename: 'Existing.pdf', bytes: pdf });
  const before = await fs.readFile(f.catalog);
  fail = true;
  await assert.rejects(service.importDownloaded({ filename: 'New.pdf', bytes: Buffer.concat([pdf, Buffer.from('% Different')]) }), /publication failure/);
  assert.deepEqual(await fs.readFile(f.catalog), before);
  assert.deepEqual(await fs.readFile(f.managed(first.document.id)), pdf);
  assert.deepEqual(await fs.readdir(path.join(f.root, 'documents')), [`${first.document.id}.pdf`]);
  assert.deepEqual((await fs.readdir(f.root)).filter(name => name.endsWith('.tmp')), []);
});
