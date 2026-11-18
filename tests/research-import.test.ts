import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { PDFLibraryService } from '../pdf-manager/src/main/library-service';
import { ResearchImporter, researchFolderSegment } from '../src/main/research-import';
import { MAX_NOTE_BYTES, validateNotePath, WorkspaceStore } from '../src/main/workspace';
import { parsePDFPageLink } from '../src/shared/pdfLinks';
import type { ResearchGrouping, ResearchIdentity, ResearchReview } from '../src/shared/research';

const pdf = Buffer.from('%PDF-1.7\n1 0 obj\n<< /Type /Catalog >>\nendobj\n%%EOF\n');
const reviewFixture = (): ResearchReview => ({
  editionId: '2026-10-28-daily', arxivId: '2610.01234v2', baseId: '2610.01234',
  title: '金利と執行の研究', authors: ['Aiko Researcher', 'Ben Researcher'], topics: ['Rates', 'Execution'],
  date: '2026-10-28', kind: 'daily', rating: 4, ratingScale: 5, score: 8, rank: 1,
  summary: 'Published paper summary.', reviewText: 'Published review with **emphasis** and $x^2$.',
  reviewScope: 'paper', sourceUrl: 'https://taiki-maeda-bkmn.github.io/public-page/?edition=2026-10-28-daily',
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

async function fixture(t: TestContext, createIO?: Parameters<typeof WorkspaceStore.open>[1]) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'prism-research-import-'));
  const notebookRoot = path.join(directory, 'Notebook');
  const otherRoot = path.join(directory, 'Other notebook');
  const libraryRoot = path.join(directory, 'Library');
  const library = new PDFLibraryService(libraryRoot);
  t.after(async () => {
    try { await library.close(); }
    finally { await fs.rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); }
  });
  await fs.mkdir(notebookRoot);
  await fs.mkdir(otherRoot);
  const notebook = await WorkspaceStore.open(notebookRoot, createIO);
  const other = await WorkspaceStore.open(otherRoot);
  let current = notebook;
  const state = {
    review: reviewFixture(), reviewCalls: 0, downloads: 0,
    beforeReview: undefined as (() => Promise<void>) | undefined,
    beforeDownload: undefined as (() => Promise<void>) | undefined,
  };
  const client = {
    async review(value: unknown) {
      state.reviewCalls++;
      const identity = value as ResearchIdentity;
      if (identity?.editionId !== state.review.editionId || identity?.arxivId !== state.review.arxivId) throw new Error('Unknown published paper.');
      await state.beforeReview?.();
      return structuredClone(state.review);
    },
    async downloadPDF(arxivId: string) {
      assert.equal(arxivId, state.review.arxivId);
      state.downloads++;
      await state.beforeDownload?.();
      return pdf;
    },
  };
  const importer = new ResearchImporter(client, library, async () => current);
  const request = (grouping: ResearchGrouping = 'topic') => ({
    editionId: state.review.editionId, arxivId: state.review.arxivId, notebookPath: notebook.root, grouping,
  });
  return { directory, libraryRoot, notebook, other, library, state, importer, request,
    useWorkspace: (store: WorkspaceStore) => { current = store; },
    bytes: (notePath: string) => fs.readFile(path.join(notebook.root, notePath)),
  };
}

test('imports a linked published review with source metadata and topic, month, or flat grouping', async t => {
  for (const grouping of ['topic', 'month', 'flat'] as const) await t.test(grouping, async t => {
    const f = await fixture(t);
    const result = await f.importer.import(f.request(grouping));
    assert.ok(result.note);
    const folder = grouping === 'topic' ? 'Rates/' : grouping === 'month' ? '2026-10/' : '';
    assert.equal(result.note.path, `Research/Rates & Execution/${folder}arxiv-2610.01234v2-2026-10-28-daily.md`);
    assert.equal(result.duplicatePDF, false);
    assert.equal(result.duplicateNote, false);
    assert.equal(result.warning, undefined);
    assert.equal(result.document.arxivId, f.state.review.arxivId);
    assert.deepEqual(result.document.tags, ['Rates', 'Execution']);
    const content = result.note.content;
    const marker = JSON.parse(content.split('\n')[0].slice('<!-- prism-research:v1 '.length, -4));
    assert.deepEqual(marker, { editionId: f.state.review.editionId, arxivId: f.state.review.arxivId, documentId: result.document.id });
    const link = content.match(/\]\((prism-pdf:[^)]+)\)/)?.[1];
    assert.ok(link);
    assert.deepEqual(parsePDFPageLink(link), { documentId: result.document.id, page: 1 });
    assert.match(content, /Published rating: 4\/5/);
    assert.match(content, /Authors: Aiko Researcher, Ben Researcher/);
    assert.match(content, /Topics: Rates, Execution/);
    assert.ok(content.includes(`[Published review](${f.state.review.sourceUrl})`));
    assert.match(content, /https:\/\/arxiv.org\/abs\/2610\.01234v2/);
    assert.ok(content.includes(f.state.review.reviewText));
    assert.equal((await f.bytes(result.note.path)).toString(), content);
    assert.deepEqual(Buffer.from(await f.library.read(result.document.id)), pdf);
    assert.equal(f.state.downloads, 1);
  });
});

test('topic grouping sanitizes unsafe, hidden, reserved and Japanese folder names into writable destinations', async t => {
  const f = await fixture(t);
  const topics = ['../Rates', '.Hidden', 'node_modules', 'CON', 'NUL.txt', '... ', '金利/執行:理論?*', ' Long topic. ', '日'.repeat(80)];
  for (const [index, topic] of topics.entries()) {
    const segment = researchFolderSegment(topic);
    assert.equal(segment.includes('/'), false);
    assert.equal(segment.includes('\\'), false);
    assert.doesNotThrow(() => validateNotePath(`Research/${segment}/Review.md`), topic);
    f.state.review.editionId = `2026-10-28-daily-${index}`;
    f.state.review.topics = [topic];
    const result = await f.importer.import(f.request());
    assert.ok(result.note, result.warning || `No review was created for topic ${topic}.`);
    assert.ok(result.note.path.startsWith(`Research/Rates & Execution/${segment}/`));
    assert.equal((await f.bytes(result.note.path)).toString(), result.note.content);
  }
  f.state.review.editionId = '2026-10-28-empty-topic';
  f.state.review.topics = [];
  const uncategorized = await f.importer.import(f.request());
  assert.ok(uncategorized.note?.path.startsWith('Research/Rates & Execution/Uncategorized/'));
  assert.equal(f.state.downloads, 1);
});

test('source comments find a renamed and edited review after grouping changes without overwriting it', async t => {
  const f = await fixture(t);
  const first = await f.importer.import(f.request());
  assert.ok(first.note);
  const edited = `\ufeff${first.note.content}\n## My conclusions\n\nKeep this personal annotation.\n`;
  await f.notebook.save(first.note.path, edited, first.note.modified);
  const moved = 'My research/Personal title.md';
  await fs.mkdir(path.join(f.notebook.root, 'My research'));
  await fs.rename(path.join(f.notebook.root, first.note.path), path.join(f.notebook.root, moved));
  f.state.review.title = 'Updated published title';
  f.state.review.reviewText = 'An updated published review must not replace personal edits.';
  const repeated = await f.importer.import(f.request('flat'));
  assert.equal(repeated.duplicatePDF, true);
  assert.equal(repeated.duplicateNote, true);
  assert.equal(repeated.document.id, first.document.id);
  assert.equal(repeated.note?.path, moved);
  assert.equal(repeated.note?.content, edited.replace(/^\ufeff/, ''));
  assert.equal((await f.bytes(moved)).toString(), edited);
  assert.equal((await f.notebook.load()).notes.length, 1);
  assert.equal(f.state.downloads, 1);
});

test('unrelated files and malformed source comments are preserved when a review filename is occupied', async t => {
  const f = await fixture(t);
  const basename = 'Research/Rates & Execution/arxiv-2610.01234v2-2026-10-28-daily';
  const unrelated = '<!-- prism-research:v1 {"editionId":"some-other-edition","arxivId":"2610.01234v2","documentId":"other"} -->\n# Personal note\n';
  const malformed = '<!-- prism-research:v1 not JSON -->\n# Also personal\n';
  await f.notebook.create(`${basename}.md`, unrelated);
  await f.notebook.create(`${basename} (2).md`, malformed);
  const imported = await f.importer.import(f.request('flat'));
  assert.equal(imported.note?.path, `${basename} (3).md`);
  assert.equal((await f.bytes(`${basename}.md`)).toString(), unrelated);
  assert.equal((await f.bytes(`${basename} (2).md`)).toString(), malformed);
  assert.equal((await f.notebook.load()).notes.length, 3);
});

test('a file published after the notebook scan is preserved and the review gets another filename', async t => {
  let intercepted = false;
  const f = await fixture(t, {
    ...fs,
    link: async (source, destination) => {
      if (!intercepted) {
        intercepted = true;
        await fs.writeFile(destination, '# Created by another application\n', { flag: 'wx' });
      }
      await fs.link(source, destination);
    },
  });
  const result = await f.importer.import(f.request('flat'));
  assert.ok(result.note?.path.endsWith(' (2).md'));
  assert.equal((await f.bytes(result.note!.path.replace(' (2).md', '.md'))).toString(), '# Created by another application\n');
});

test('reimporting a removed PDF keeps its old review and creates a new review linked to the new managed ID', async t => {
  const f = await fixture(t);
  const first = await f.importer.import(f.request());
  assert.ok(first.note);
  const oldBytes = await f.bytes(first.note.path);
  await f.library.remove(first.document.id);
  const replacement = await f.importer.import(f.request());
  assert.ok(replacement.note);
  assert.notEqual(replacement.document.id, first.document.id);
  assert.notEqual(replacement.note.path, first.note.path);
  assert.equal(replacement.duplicatePDF, false);
  assert.equal(replacement.duplicateNote, false);
  assert.match(replacement.warning!, /earlier review links to a different managed PDF/);
  assert.ok(replacement.note.content.includes(`documents/${replacement.document.id}?page=1`));
  assert.deepEqual(await f.bytes(first.note.path), oldBytes);
  assert.equal((await f.notebook.load()).notes.length, 2);
  assert.equal(f.state.downloads, 2);
});

test('a failed note publication returns the saved PDF and retries the review without downloading again', async t => {
  let fail = true;
  const f = await fixture(t, {
    ...fs,
    link: async (source, destination) => {
      if (fail) throw new Error('Review folder is temporarily unavailable.');
      await fs.link(source, destination);
    },
  });
  const partial = await f.importer.import(f.request());
  assert.equal(partial.note, null);
  assert.equal(partial.duplicateNote, false);
  assert.equal(partial.duplicatePDF, false);
  assert.match(partial.warning!, /PDF is saved.*temporarily unavailable.*Retry/);
  assert.deepEqual(Buffer.from(await f.library.read(partial.document.id)), pdf);
  assert.deepEqual((await f.notebook.load()).notes, []);
  fail = false;
  const retry = await f.importer.import(f.request());
  assert.ok(retry.note);
  assert.equal(retry.document.id, partial.document.id);
  assert.equal(retry.duplicatePDF, true);
  assert.equal(retry.duplicateNote, false);
  assert.equal(retry.warning, undefined);
  assert.equal(f.state.downloads, 1);
});

test('a stale notebook request and a notebook changed during review fetch fail before any PDF download', async t => {
  const f = await fixture(t);
  await assert.rejects(f.importer.import({ ...f.request(), notebookPath: f.other.root }), /notebook changed/);
  assert.equal(f.state.reviewCalls, 0);
  f.state.beforeReview = async () => { f.useWorkspace(f.other); };
  await assert.rejects(f.importer.import(f.request()), /notebook changed/);
  assert.equal(f.state.downloads, 0);
  assert.deepEqual((await f.library.load()).documents, []);
  assert.deepEqual((await f.notebook.load()).notes, []);
  assert.deepEqual((await f.other.load()).notes, []);
});

test('switching notebook during PDF download retains the PDF and adds no review to either notebook', async t => {
  const f = await fixture(t);
  f.state.beforeDownload = async () => { f.useWorkspace(f.other); };
  const result = await f.importer.import(f.request());
  assert.equal(result.note, null);
  assert.match(result.warning!, /PDF is saved.*notebook changed/);
  assert.deepEqual(Buffer.from(await f.library.read(result.document.id)), pdf);
  assert.deepEqual((await f.notebook.load()).notes, []);
  assert.deepEqual((await f.other.load()).notes, []);
  f.useWorkspace(f.notebook);
  const retry = await f.importer.import(f.request());
  assert.ok(retry.note);
  assert.equal(retry.document.id, result.document.id);
  assert.equal(f.state.downloads, 1);
});

test('a replacement directory at the notebook path cannot receive a review after download', async t => {
  const f = await fixture(t);
  const moved = path.join(f.directory, 'Moved notebook');
  f.state.beforeDownload = async () => {
    await fs.rename(f.notebook.root, moved);
    await fs.mkdir(f.notebook.root);
  };
  const result = await f.importer.import(f.request());
  assert.equal(result.note, null);
  assert.match(result.warning!, /notebook folder changed/);
  assert.deepEqual(await fs.readdir(f.notebook.root), []);
  assert.deepEqual(await fs.readdir(moved), []);
  assert.deepEqual(Buffer.from(await f.library.read(result.document.id)), pdf);
});

test('invalid requests and oversized review notes fail before writing a PDF', async t => {
  const f = await fixture(t);
  for (const value of [null, [], true, {}, { ...f.request(), grouping: 'elsewhere' },
    { ...f.request(), notebookPath: 42 }, { ...f.request(), unexpected: true },
    { ...f.request(), editionId: '../private' }, { ...f.request(), arxivId: 'https://untrusted.invalid/paper' }]) {
    await assert.rejects(f.importer.import(value));
  }
  f.state.review.reviewText = '研'.repeat(Math.ceil(MAX_NOTE_BYTES / 3));
  await assert.rejects(f.importer.import(f.request()), /review is too large/);
  assert.equal(f.state.downloads, 0);
  assert.deepEqual((await f.library.load()).documents, []);
  assert.deepEqual(await fs.readdir(path.join(f.libraryRoot, 'documents')), []);
  await assert.rejects(fs.stat(path.join(f.libraryRoot, 'catalog.json')), { code: 'ENOENT' });
  assert.deepEqual((await f.notebook.load()).notes, []);
});

test('simultaneous repeat imports serialize review creation and publish one PDF and one note', async t => {
  const f = await fixture(t);
  const entered = deferred();
  const release = deferred();
  f.state.beforeReview = async () => {
    if (f.state.reviewCalls === 1) { entered.resolve(); await release.promise; }
  };
  const first = f.importer.import(f.request());
  const second = f.importer.import(f.request('month'));
  const completed = Promise.all([first, second]);
  try {
    await entered.promise;
    assert.equal(f.state.reviewCalls, 1);
    assert.equal(f.state.downloads, 0);
  } finally {
    release.resolve();
    await completed;
  }
  const [a, b] = await completed;
  assert.ok(a.note);
  assert.equal(a.document.id, b.document.id);
  assert.equal(a.note.path, b.note?.path);
  assert.equal(b.duplicatePDF, true);
  assert.equal(b.duplicateNote, true);
  assert.equal(f.state.downloads, 1);
  assert.equal((await f.notebook.load()).notes.length, 1);
  assert.equal((await f.library.load()).documents.length, 1);
});

test('the import scan keeps old note save versions conflict-safe and leaves other note contents untouched', async t => {
  const f = await fixture(t);
  const original = await f.notebook.create('Personal.md', '# Saved before import\n');
  const kept = await f.notebook.create('Untouched.md', '# Keep these bytes\r\n');
  const before = await f.bytes(kept.path);
  await fs.writeFile(path.join(f.notebook.root, original.path), '# Externally changed during my draft\n');
  const result = await f.importer.import(f.request());
  assert.ok(result.note);
  await assert.rejects(f.notebook.save(original.path, '# My unsaved draft\n', original.modified), /changed since you opened/);
  assert.equal((await f.bytes(original.path)).toString(), '# Externally changed during my draft\n');
  assert.deepEqual(await f.bytes(kept.path), before);
});

test('saved-version and topic-limit warnings remain visible while the review keeps all published topics', async t => {
  const f = await fixture(t);
  const first = await f.importer.import(f.request());
  f.state.review.arxivId = '2610.01234v3';
  f.state.review.editionId = '2026-10-29-daily';
  f.state.review.topics = Array.from({ length: 15 }, (_, index) => `Published topic ${index}`);
  const updated = await f.importer.import(f.request());
  assert.ok(updated.note);
  assert.equal(updated.document.id, first.document.id);
  assert.equal(updated.document.arxivId, '2610.01234v2');
  assert.match(updated.warning!, /first 12 tags/);
  assert.match(updated.warning!, /saved PDF for arXiv 2610\.01234v2/);
  assert.ok(updated.note.content.includes('Published topic 14'));
  assert.equal(f.state.downloads, 1);
});
