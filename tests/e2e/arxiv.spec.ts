import { electronLaunchArguments } from '../../scripts/electron-launch.mjs';
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { PDFDocument } from '../../pdf-manager/src/shared/types';
import type { ArxivPaper } from '../../src/shared/arxivSearch';
import { fixturePdf } from '../fixtures/pdf';

const firstId = '2601.00001v2';
const secondId = '2601.00002v2';
const ratesId = '2601.00002v1';
const editionId = '2026-10-28-daily';
const researchSite = 'https://beautysamurai.github.io/public-page/';
const original = '\ufeff# Welcome to Prism\r\n\r\nA notebook for independent research.\r\n';
const draft = '保存前のアイデアを残す。';
const makePaper = (arxivId: string, title: string, categories = ['q-fin.TR', 'q-fin.ST']): ArxivPaper => ({
  arxivId, baseId: arxivId.replace(/v\d+$/, ''), title, authors: ['Aiko Researcher', 'Ben Researcher'],
  summary: 'Market liquidity and execution costs. <img src="https://untrusted.invalid/pixel.png"> **A published abstract, not generated text.**\n\n' + '金利市場と約定の理論を検証します。 '.repeat(35),
  primaryCategory: categories[0], categories, published: '2026-01-02T09:00:00Z', updated: '2026-10-28T12:00:00Z',
});
const first = makePaper(firstId, 'Execution signals and liquidity');
const second = makePaper(secondId, 'Yield curve and market impact', ['q-fin.PR', 'math.PR']);
const last = makePaper('2601.00021v1', 'Last paper on the next page');
const obsolete = makePaper('2602.99999v1', 'Obsolete response must stay closed');
const papers = [first, second, ...Array.from({ length: 18 }, (_, index) => makePaper(`2601.${String(index + 3).padStart(5, '0')}v1`, `Market study ${index + 3}`))];
const xml = (value: string) => value.replace(/[<>&"']/g, character => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[character]!);
function atom(entries: ArxivPaper[], total = entries.length, start = 0): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom" xmlns:opensearch="http://a9.com/-/spec/opensearch/1.1/" xmlns:arxiv="http://arxiv.org/schemas/atom">
<id>https://export.arxiv.org/api/query</id><title>Deterministic arXiv fixture</title><updated>2026-10-28T12:00:00Z</updated>
<opensearch:totalResults>${total}</opensearch:totalResults><opensearch:startIndex>${start}</opensearch:startIndex><opensearch:itemsPerPage>${entries.length}</opensearch:itemsPerPage>
${entries.map(paper => `<entry><id>http://arxiv.org/abs/${paper.arxivId}</id><title>${xml(paper.title)}</title><summary>${xml(paper.summary)}</summary>
<published>${paper.published}</published><updated>${paper.updated}</updated>${paper.authors.map(name => `<author><name>${xml(name)}</name></author>`).join('')}
${paper.categories.map(category => `<category term="${xml(category)}" scheme="http://arxiv.org/schemas/atom"/>`).join('')}<arxiv:primary_category term="${paper.primaryCategory}"/>
<link href="http://arxiv.org/abs/${paper.arxivId}" rel="alternate" type="text/html"/><link href="http://arxiv.org/pdf/${paper.arxivId}" rel="related" type="application/pdf"/></entry>`).join('\n')}
</feed>`;
}

let temporary: string;
let notebook: string;
let userData: string;
let pdfProfile: string;
let desktop: ElectronApplication | undefined;
let page: Page;
let rendererErrors: string[];
let remoteRequests: string[];
const browser = () => page.getByRole('dialog', { name: 'Search arXiv', exact: true });
const workspace = (name: 'Notes' | 'PDFs') => page.getByRole('navigation', { name: 'Workspaces', exact: true }).getByRole('button', { name, exact: true });
const pdf = () => page.locator('.pdf-workspace');
const editor = () => page.locator('.app-body .cm-content');
const resultButton = (paper: ArxivPaper) => browser().getByRole('button', { name: `View paper ${paper.title} (${paper.arxivId})`, exact: true });
const catalogue = async () => (JSON.parse(await readFile(path.join(pdfProfile, 'library', 'catalog.json'), 'utf8')) as { documents: PDFDocument[] }).documents;

async function launch(options: { failSearch?: boolean } = {}) {
  desktop = await electron.launch({
    args: electronLaunchArguments(['--no-sandbox', '.']), cwd: process.cwd(),
    env: { ...process.env, PRISM_USER_DATA: userData, PRISM_WORKSPACE: notebook, PRISM_PDF_USER_DATA: pdfProfile },
  });
  page = await desktop.firstWindow();
  page.on('pageerror', error => rendererErrors.push(error.message));
  page.on('request', request => { if (/^https?:/.test(request.url())) remoteRequests.push(request.url()); });
  await expect(page.locator('.note-heading h1')).toBeVisible();
  await expect.poll(() => desktop!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible())).toBe(true);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.getByRole('group', { name: 'Editor mode', exact: true }).getByRole('button', { name: 'Source', exact: true }).click();
  const ratesPaper = { arxivId: ratesId, title: 'Published Rates review title', authors: second.authors, topics: ['Rates', 'Pricing'], schedulerRating: 8, schedulerRatingScale: 10, schedulerRank: 1, schedulerSummary: 'Published rates commentary.' };
  const ids = [...papers, last, { ...second, arxivId: ratesId }];
  await desktop.evaluate(({ shell }, fixtures) => {
    type FixtureState = { requests: string[]; completed: string[]; sourceLinks: string[]; failSearch: boolean; release?: () => void };
    const state: FixtureState = { requests: [], completed: [], sourceLinks: [], failSearch: !!fixtures.options.failSearch };
    (globalThis as typeof globalThis & { arxivFixture: FixtureState }).arxivFixture = state;
    shell.openExternal = async url => { state.sourceLinks.push(url); };
    globalThis.fetch = async input => {
      const address = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      state.requests.push(address);
      const url = new URL(address);
      if (url.origin === 'https://export.arxiv.org' && url.pathname === '/api/query') {
        const query = url.searchParams.get('search_query') || '';
        const id = url.searchParams.get('id_list');
        if (query.includes('obsolete')) await new Promise<void>(resolve => { state.release = resolve; });
        let feed: string;
        if (id) {
          const selected = fixtures.idFeeds[id];
          if (!selected) throw new Error('Unexpected fixture ID: ' + id);
          feed = selected;
        } else {
          if (state.failSearch) { state.failSearch = false; return new Response('Temporarily unavailable', { status: 503 }); }
          feed = query.includes('empty') ? fixtures.empty : query.includes('obsolete') ? fixtures.obsolete
            : query.includes('current') ? fixtures.current : Number(url.searchParams.get('start')) >= 20 ? fixtures.next : fixtures.first;
        }
        state.completed.push(address);
        return new Response(feed, { headers: { 'Content-Type': 'application/atom+xml; charset=utf-8' } });
      }
      if (address === fixtures.researchSite + `data/archive/${fixtures.editionId}.json`) return Response.json(fixtures.archive);
      if (address === fixtures.researchSite + 'data/papers.json') return Response.json(fixtures.researchCatalogue);
      if (url.origin === 'https://arxiv.org' && url.pathname.startsWith('/pdf/')) {
        const requestedId = url.pathname.slice('/pdf/'.length).replace(/\.pdf$/, '');
        const bytes = fixtures.pdfs[requestedId];
        if (!bytes) throw new Error('Unexpected PDF fixture: ' + requestedId);
        return new Response(Buffer.from(bytes, 'base64'), { headers: { 'Content-Type': 'application/pdf' } });
      }
      throw new Error('Unexpected external request: ' + address);
    };
  }, {
    options, first: atom(papers, 21), next: atom([last], 21, 20), empty: atom([]), obsolete: atom([obsolete]), current: atom([second]),
    idFeeds: Object.fromEntries(ids.map(paper => [paper.arxivId, atom([paper])])) as Record<string, string>,
    pdfs: Object.fromEntries(ids.map(paper => [paper.arxivId, Buffer.concat([fixturePdf(), Buffer.from(`\n% arxiv fixture ${paper.baseId}\n`)]).toString('base64')])) as Record<string, string>,
    researchSite, editionId,
    archive: { schemaVersion: 2, editionId, editionDate: '2026-10-28', editionKind: 'daily', papers: [ratesPaper], sourceText: '## 1. Published Rates review title\n\nPublished rates commentary.\n' },
    researchCatalogue: { schemaVersion: 1, editions: [{ editionId, date: '2026-10-28', kind: 'daily', papers: [ratesPaper] }] },
  });
}

async function stop() {
  const application = desktop;
  if (!application) return;
  const child = application.process();
  const closed = application.waitForEvent('close', { timeout: 5_000 }).catch(() => undefined);
  try {
    await application.evaluate(({ app }) => {
      (globalThis as typeof globalThis & { arxivFixture?: { release?: () => void } }).arxivFixture?.release?.();
      app.exit(0);
    }).catch(() => undefined);
    await closed;
  } finally {
    if (child.exitCode === null) child.kill();
    desktop = undefined;
  }
}

async function requests() {
  return desktop!.evaluate(() => (globalThis as typeof globalThis & { arxivFixture: { requests: string[] } }).arxivFixture.requests);
}
async function downloadCount() { return (await requests()).filter(url => url.startsWith('https://arxiv.org/pdf/')).length; }

async function openSearch() {
  await workspace('PDFs').click();
  const back = pdf().getByRole('button', { name: 'Back to library', exact: true });
  if (await back.isVisible()) await back.click();
  await pdf().getByRole('button', { name: 'Search arXiv', exact: true }).click();
  await expect(browser()).toBeVisible();
}
async function search(query: string, field = 'all') {
  await browser().getByLabel('Search in', { exact: true }).selectOption(field);
  await browser().getByLabel('Search terms', { exact: true }).fill(query);
  await browser().getByRole('button', { name: 'Search', exact: true }).click();
}
async function importPaper(paper: ArxivPaper) {
  await search(paper.arxivId, 'id');
  await resultButton(paper).click();
  await browser().getByRole('button', { name: 'Import PDF', exact: true }).click();
  await expect(browser().getByRole('button', { name: 'Open PDF', exact: true })).toBeVisible();
  return (await catalogue()).find(document => document.arxivId?.replace(/v\d+$/, '') === paper.baseId)!;
}

test.beforeEach(async () => {
  temporary = await mkdtemp(path.join(os.tmpdir(), 'prism-arxiv-'));
  notebook = path.join(temporary, 'Arxiv notebook');
  userData = path.join(temporary, 'notes-profile');
  pdfProfile = path.join(temporary, 'pdf-profile');
  rendererErrors = []; remoteRequests = [];
  await Promise.all([mkdir(notebook), mkdir(userData), mkdir(pdfProfile)]);
  await writeFile(path.join(notebook, 'Welcome to Prism.md'), original);
});

test.afterEach(async ({}, testInfo) => {
  try {
    if (page && !page.isClosed() && testInfo.status !== testInfo.expectedStatus) {
      const screenshot = await page.screenshot({ path: testInfo.outputPath('arxiv-failure.png') }).catch(() => undefined);
      if (screenshot) await testInfo.attach('arXiv at failure', { body: screenshot, contentType: 'image/png' });
    }
  } finally {
    try { await stop(); }
    finally { if (temporary) await rm(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
  }
});

test('searches by field, category and sort, pages results, and keeps details usable at 150 percent text', async ({}, testInfo) => {
  await launch();
  await openSearch();
  expect(await requests()).toEqual([]);
  await browser().getByLabel('Category', { exact: true }).selectOption('q-fin.TR');
  await browser().getByLabel('Sort by', { exact: true }).selectOption('updated');
  await search('liquidity', 'title');
  await expect(browser().getByRole('button', { name: /^View paper / })).toHaveCount(20);
  const query = new URL((await requests()).at(-1)!);
  expect(query.origin + query.pathname).toBe('https://export.arxiv.org/api/query');
  expect(query.searchParams.get('search_query')).toContain('cat:q-fin.TR');
  expect(query.searchParams.get('search_query')).toContain('ti:"liquidity"');
  expect(query.searchParams.get('sortBy')).toBe('lastUpdatedDate');
  expect(query.searchParams.get('start')).toBe('0');
  await resultButton(first).click();
  const details = browser().getByRole('region', { name: 'Paper details', exact: true });
  await expect(details).toContainText('Aiko Researcher');
  await expect(details).toContainText('q-fin.TR');
  await expect(browser().locator('.arxiv-abstract')).toContainText('Market liquidity and execution costs.');
  await expect(browser().locator('.arxiv-abstract img')).toHaveCount(0);
  await browser().getByRole('button', { name: 'arXiv paper', exact: true }).click();
  await expect.poll(() => desktop!.evaluate(() => (globalThis as typeof globalThis & { arxivFixture: { sourceLinks: string[] } }).arxivFixture.sourceLinks)).toEqual([`https://arxiv.org/abs/${firstId}`]);
  expect(await browser().evaluate(element => element.getBoundingClientRect().width)).toBeGreaterThan(900);
  await testInfo.attach('arXiv desktop layout', { body: await page.screenshot({ path: testInfo.outputPath('arxiv-desktop.png') }), contentType: 'image/png' });
  await browser().getByRole('button', { name: 'Next results', exact: true }).click();
  await expect(resultButton(last)).toBeVisible();
  await expect(browser().getByRole('button', { name: /^View paper / })).toHaveCount(1);
  expect(new URL((await requests()).at(-1)!).searchParams.get('start')).toBe('20');
  await expect(browser().getByRole('button', { name: 'Next results', exact: true })).toBeDisabled();
  await browser().getByRole('button', { name: 'Previous results', exact: true }).click();
  await expect(resultButton(first)).toBeVisible();
  await browser().getByLabel('Sort by', { exact: true }).selectOption('newest');
  await expect(browser()).toContainText('Search again to apply your changes.');
  await expect(browser().getByRole('button', { name: 'Next results', exact: true })).toBeDisabled();
  await browser().getByLabel('Category', { exact: true }).selectOption('');
  await search('Aiko', 'author');
  await expect(resultButton(first)).toBeVisible();
  await expect(browser().getByRole('button', { name: 'Search', exact: true })).toBeEnabled();
  const authorQuery = new URL((await requests()).at(-1)!);
  expect(authorQuery.searchParams.get('search_query')).toContain('au:"Aiko"');
  expect(authorQuery.searchParams.get('search_query')).not.toContain('cat:');
  expect(authorQuery.searchParams.get('sortBy')).toBe('submittedDate');
  expect(authorQuery.searchParams.get('start')).toBe('0');
  await browser().getByRole('button', { name: 'Close arXiv browser', exact: true }).click();
  await workspace('Notes').click();
  await page.getByRole('button', { name: 'Window appearance', exact: true }).click();
  const appearance = page.getByRole('dialog', { name: 'Make a little space', exact: true });
  await appearance.getByRole('slider', { name: 'Text size', exact: true }).fill('150');
  await appearance.getByRole('button', { name: 'Done', exact: true }).click();
  await page.setViewportSize({ width: 720, height: 1000 });
  await openSearch();
  await search('liquidity');
  await resultButton(first).click();
  await browser().getByRole('button', { name: 'Import PDF', exact: true }).scrollIntoViewIfNeeded();
  expect(await browser().evaluate(element => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1);
  await expect(browser().getByRole('button', { name: 'Import PDF', exact: true })).toBeVisible();
  await testInfo.attach('arXiv narrow layout at 150 percent text', { body: await page.screenshot({ path: testInfo.outputPath('arxiv-large-text.png') }), contentType: 'image/png' });
  expect(rendererErrors).toEqual([]);
  expect(remoteRequests).toEqual([]);
});

test('retries a failed search, shows empty results, and ignores a response from a closed browser', async () => {
  await launch({ failSearch: true });
  await openSearch();
  await search('current');
  await expect(browser().getByRole('alert')).toContainText('503');
  await browser().getByRole('button', { name: 'Retry search', exact: true }).click();
  await expect(resultButton(second)).toBeVisible();
  await search('empty');
  await expect(browser()).toContainText('No papers');
  await expect(browser().getByRole('button', { name: /^View paper / })).toHaveCount(0);
  await search('obsolete');
  await expect.poll(() => desktop!.evaluate(() => !!(globalThis as typeof globalThis & { arxivFixture: { release?: () => void } }).arxivFixture.release)).toBe(true);
  await browser().getByRole('button', { name: 'Close arXiv browser', exact: true }).click();
  await expect(browser()).toHaveCount(0);
  await openSearch();
  await search('current latest');
  await desktop!.evaluate(() => { (globalThis as typeof globalThis & { arxivFixture: { release?: () => void } }).arxivFixture.release?.(); });
  await expect.poll(() => desktop!.evaluate(() => (globalThis as typeof globalThis & { arxivFixture: { completed: string[] } }).arxivFixture.completed.some(url => url.includes('obsolete')))).toBe(true);
  await expect(resultButton(obsolete)).toHaveCount(0);
  await expect(resultButton(second)).toBeVisible();
  await expect(resultButton(obsolete)).toHaveCount(0);
  expect(await downloadCount()).toBe(0);
  expect(await readdir(notebook)).toEqual(['Welcome to Prism.md']);
  expect(rendererErrors).toEqual([]);
  expect(remoteRequests).toEqual([]);
});

test('imports selected PDFs without notes or draft loss, preserves metadata after restart and reuses a Rates source', async () => {
  test.setTimeout(120_000);
  await launch();
  await editor().focus();
  await editor().press('ControlOrMeta+End');
  await page.keyboard.insertText(draft);
  await openSearch();
  const imported = await importPaper(first);
  expect(imported.title).toBe(first.title);
  expect(imported.arxivId).toBe(firstId);
  expect(imported.tags).toEqual(expect.arrayContaining(first.categories));
  expect(await downloadCount()).toBe(1);
  expect(await readdir(notebook)).toEqual(['Welcome to Prism.md']);
  expect(await readFile(path.join(notebook, 'Welcome to Prism.md'), 'utf8')).toBe(original);
  await browser().getByRole('button', { name: 'Open PDF', exact: true }).click();
  await expect(browser()).toHaveCount(0);
  await expect(pdf().locator('.pdf-paper canvas[data-page-number="1"]')).toBeVisible();
  await expect(pdf().locator('.pdf-paper')).toHaveAttribute('aria-busy', 'false');
  await workspace('Notes').click();
  await expect(editor()).toContainText(draft);
  await editor().press('ControlOrMeta+z');
  await expect(editor()).not.toContainText(draft);
  await editor().press(process.platform === 'darwin' ? 'Meta+Shift+Z' : 'Control+y');
  await expect(editor()).toContainText(draft);
  await editor().press('ControlOrMeta+z');
  await page.evaluate(async id => { await window.prismPdf.updateDocument(id, { title: 'My execution paper', tags: ['Personal'], favorite: true, pageCount: 2, lastPage: 2 }); }, imported.id);
  await stop();
  await launch();
  await openSearch();
  const repeated = await importPaper(first);
  expect(repeated.id).toBe(imported.id);
  expect(repeated.title).toBe('My execution paper');
  expect(repeated.arxivId).toBe(firstId);
  expect(repeated.favorite).toBe(true);
  expect(repeated.lastPage).toBe(2);
  expect(repeated.tags).toEqual(expect.arrayContaining(['Personal', ...first.categories]));
  expect((await catalogue()).length).toBe(1);
  expect(await downloadCount()).toBe(0);
  await browser().getByRole('button', { name: 'Close arXiv browser', exact: true }).click();
  const rates = await page.evaluate(async request => window.prismResearch.importPaper(request), { editionId, arxivId: ratesId, notebookPath: notebook, grouping: 'topic' as const });
  expect(rates.note).not.toBeNull();
  const reviewPath = path.join(notebook, rates.note!.path);
  const reviewBytes = await readFile(reviewPath);
  await page.evaluate(async id => { await window.prismPdf.updateDocument(id, { title: 'My rates paper', tags: ['Rates', 'Personal'], favorite: true, pageCount: 2, lastPage: 2 }); }, rates.document.id);
  await openSearch();
  const connected = await importPaper(second);
  expect(connected.id).toBe(rates.document.id);
  expect(connected.arxivId).toBe(ratesId);
  expect(connected.title).toBe('My rates paper');
  expect(connected.favorite).toBe(true);
  expect(connected.lastPage).toBe(2);
  expect(connected.tags).toEqual(expect.arrayContaining(['Rates', 'Personal', ...second.categories]));
  await expect(browser()).toContainText(`saved PDF for arXiv ${ratesId}`);
  expect((await catalogue()).length).toBe(2);
  expect(await downloadCount()).toBe(1);
  expect(await readFile(reviewPath)).toEqual(reviewBytes);
  expect(await readFile(path.join(notebook, 'Welcome to Prism.md'), 'utf8')).toBe(original);
  const notes = await page.evaluate(async () => window.prism.loadWorkspace());
  expect(notes.notes.map(note => note.path).sort()).toEqual([rates.note!.path, 'Welcome to Prism.md'].sort());
  expect(rendererErrors).toEqual([]);
  expect(remoteRequests).toEqual([]);
});
