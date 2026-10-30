import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { PDFLibraryService } from '../pdf-manager/src/main/library-service';
import { ArxivImporter } from '../src/main/arxiv-import';
import type { ArxivPaper } from '../src/shared/arxivSearch';
import { fixturePdf } from './fixtures/pdf';

const paper: ArxivPaper = {
  arxivId: '2610.01234v2', baseId: '2610.01234', title: 'Execution research', authors: ['Aiko Researcher'],
  summary: 'An original abstract.', primaryCategory: 'q-fin.TR', categories: ['q-fin.TR', 'stat.ML'],
  published: '2026-10-01T00:00:00Z', updated: '2026-10-28T00:00:00Z',
};

test('arXiv imports trusted metadata and repeats preserve custom library data without downloading', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'prism-arxiv-import-'));
  const service = new PDFLibraryService(directory);
  t.after(async () => { await service.close(); await rm(directory, { recursive: true, force: true }); });
  const resolved: unknown[] = [];
  const downloaded: string[] = [];
  const importer = new ArxivImporter({ resolve: async id => { resolved.push(id); return paper; } },
    { downloadPDF: async id => { downloaded.push(id); return fixturePdf(); } }, service);
  const first = await importer.import(paper.arxivId);
  assert.equal(first.duplicate, false);
  assert.equal(first.document.arxivId, paper.arxivId);
  assert.equal(first.document.title, paper.title);
  assert.deepEqual(first.document.tags, paper.categories);
  await service.update(first.document.id, { title: 'My paper title', tags: ['Personal'], favorite: true, pageCount: 2, lastPage: 2 });
  const repeated = await importer.import(paper.arxivId);
  assert.equal(repeated.duplicate, true);
  assert.equal(repeated.document.id, first.document.id);
  assert.equal(repeated.document.title, 'My paper title');
  assert.equal(repeated.document.favorite, true);
  assert.equal(repeated.document.lastPage, 2);
  assert.deepEqual(repeated.document.tags, ['Personal', ...paper.categories]);
  assert.deepEqual(resolved, [paper.arxivId, paper.arxivId]);
  assert.deepEqual(downloaded, [paper.arxivId]);
});

test('arXiv import reuses a Rates & Execution copy and reports its retained version', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'prism-arxiv-reuse-'));
  const service = new PDFLibraryService(directory);
  t.after(async () => { await service.close(); await rm(directory, { recursive: true, force: true }); });
  const existing = await service.importArxiv({ arxivId: '2610.01234v1', title: 'Existing reviewed paper', tags: ['Execution'] }, async () => fixturePdf());
  const importer = new ArxivImporter({ resolve: async () => paper },
    { downloadPDF: async () => { throw new Error('Unexpected duplicate download'); } }, service);
  const result = await importer.import(paper.arxivId);
  assert.equal(result.document.id, existing.document.id);
  assert.equal(result.document.arxivId, '2610.01234v1');
  assert.equal(result.document.title, 'Existing reviewed paper');
  assert.deepEqual(result.document.tags, ['Execution', ...paper.categories]);
  assert.match(result.warning!, /Reused the saved PDF.*v1/);
  assert.equal((await service.load()).documents.length, 1);
});

test('invalid renderer payloads and mismatched metadata never reach the library or downloader', async () => {
  let resolves = 0;
  let metadata = paper;
  const importer = new ArxivImporter({ resolve: async () => { resolves++; return metadata; } },
    { downloadPDF: async () => { assert.fail('Unexpected download'); } },
    { importArxiv: async () => { assert.fail('Unexpected library write'); } });
  for (const value of [null, {}, { arxivId: paper.arxivId, title: 'Forged title' }, 'https://arxiv.org/pdf/2610.01234v2', '../secret', ' 2610.01234v2']) {
    await assert.rejects(importer.import(value), /valid arXiv paper/);
  }
  assert.equal(resolves, 0);
  for (const arxivId of ['2610.01234v1', '2610.01235v2', ' 2610.01234v2']) {
    metadata = { ...paper, arxivId };
    await assert.rejects(importer.import(paper.arxivId), /different paper or version/);
  }
});

test('metadata and download failures remain retryable without publishing a document', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'prism-arxiv-retry-'));
  const service = new PDFLibraryService(directory);
  t.after(async () => { await service.close(); await rm(directory, { recursive: true, force: true }); });
  let failMetadata = true;
  let failDownload = true;
  const importer = new ArxivImporter({ resolve: async () => {
    if (failMetadata) { failMetadata = false; throw new Error('Metadata unavailable'); }
    return paper;
  } }, { downloadPDF: async () => {
    if (failDownload) { failDownload = false; throw new Error('Download unavailable'); }
    return fixturePdf();
  } }, service);
  await assert.rejects(importer.import(paper.arxivId), /Metadata unavailable/);
  assert.deepEqual((await service.load()).documents, []);
  await assert.rejects(importer.import(paper.arxivId), /Download unavailable/);
  assert.deepEqual((await service.load()).documents, []);
  const result = await importer.import(paper.arxivId);
  assert.equal(result.duplicate, false);
  assert.equal((await service.load()).documents.length, 1);
});
