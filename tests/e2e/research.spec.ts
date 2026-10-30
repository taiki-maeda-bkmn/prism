import { electronLaunchArguments } from '../../scripts/electron-launch.mjs';
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { PDFDocument } from '../../pdf-manager/src/shared/types';
import { fixturePdf } from '../fixtures/pdf';

const firstId = '2601.00001v2';
const oldId = '2601.00001v1';
const secondId = '2601.00002v1';
const editionId = '2026-10-28-daily';
const olderEdition = '2026-10-20-weekly';
const source = 'https://beautysamurai.github.io/public-page/';
const original = '\ufeff# Welcome to Prism\r\n\r\nA notebook for research.\r\n';
const draft = '保存前の研究メモ。';
const first = {
  arxivId: firstId, title: 'Execution notes', authors: ['Aiko Researcher'], topics: ['Market microstructure', 'Execution'],
  schedulerRating: 8, schedulerRatingScale: 10, schedulerRank: 1, schedulerSummary: 'Published execution summary.',
};
const second = {
  arxivId: secondId, title: 'Yield curve research', authors: ['Ben Researcher'], topics: ['Rates'],
  schedulerRating: 3, schedulerRatingScale: 5, schedulerRank: 2, schedulerSummary: 'Published rates summary.',
};
const older = { ...first, arxivId: oldId, schedulerRating: 7, schedulerRank: 1 };
const catalogue = { schemaVersion: 1, editions: [
  { editionId, date: '2026-10-28', kind: 'daily', papers: [first, second] },
  { editionId: olderEdition, date: '2026-10-20', kind: 'weekly', papers: [older] },
] };
const archives = {
  [editionId]: { schemaVersion: 2, editionId, editionDate: '2026-10-28', editionKind: 'daily', papers: [first, second],
    sourceText: '## 1. Execution notes\n\nPublished execution commentary with $x^2$.\n\n## 2. Yield curve research\n\nPublished rates commentary.\n\n![Remote image](https://untrusted.invalid/pixel.png)\n\n[Do not navigate](prism-note:Unexpected.md)\n' },
  [olderEdition]: { schemaVersion: 2, editionId: olderEdition, editionDate: '2026-10-20', editionKind: 'weekly', papers: [older],
    sourceText: '# Weekly research\n\nEarlier published edition commentary.\n' },
};
let temporary: string;
let notebook: string;
let userData: string;
let pdfProfile: string;
let desktop: ElectronApplication | undefined;
let page: Page;
let rendererErrors: string[];
let remoteRequests: string[];
const browser = () => page.getByRole('dialog', { name: 'Rates & Execution', exact: true });
const workspace = (name: 'Notes' | 'PDFs') => page.getByRole('navigation', { name: 'Workspaces', exact: true }).getByRole('button', { name, exact: true });
const pdf = () => page.locator('.pdf-workspace');
const editor = () => page.locator('.app-body .cm-content');
const catalogFile = () => path.join(pdfProfile, 'library', 'catalog.json');

async function launch(options: { failCatalogue?: boolean; failReview?: boolean; holdDownload?: boolean; longCatalogue?: boolean } = {}) {
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
  await desktop.evaluate(({ shell }, fixtures) => {
    type FixtureState = { requests: string[]; sourceLinks: string[]; failCatalogue: boolean; failReview: boolean; holdDownload: boolean; release?: () => void };
    const state: FixtureState = { requests: [], sourceLinks: [], failCatalogue: !!fixtures.options.failCatalogue,
      failReview: !!fixtures.options.failReview, holdDownload: !!fixtures.options.holdDownload };
    const global = globalThis as typeof globalThis & { researchFixture: FixtureState };
    global.researchFixture = state;
    shell.openExternal = async url => { state.sourceLinks.push(url); };
    globalThis.fetch = async (input) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      state.requests.push(url);
      if (url === fixtures.source + 'data/papers.json') {
        if (state.failCatalogue) { state.failCatalogue = false; return new Response('Unavailable', { status: 503 }); }
        const catalogue = structuredClone(fixtures.catalogue);
        if (fixtures.options.longCatalogue) catalogue.editions[0].papers.push(...Array.from({ length: 30 }, (_, index) => ({
          ...catalogue.editions[0].papers[0], arxivId: `2601.${String(index + 100).padStart(5, '0')}v1`,
          title: `Published market research ${index + 1}`, schedulerRank: index + 3,
        })));
        return Response.json(catalogue);
      }
      if (url.startsWith(fixtures.source + 'data/archive/')) {
        if (state.failReview) { state.failReview = false; return new Response('Unavailable', { status: 503 }); }
        const id = url.slice((fixtures.source + 'data/archive/').length).replace(/\.json$/, '');
        const archive = fixtures.archives[id as keyof typeof fixtures.archives];
        if (!archive) throw new Error('Unexpected review fixture: ' + url);
        return Response.json(fixtures.options.longCatalogue ? { ...archive, sourceText: archive.sourceText.replace(
          'Published execution commentary with $x^2$.',
          'Published execution commentary with $x^2$.\n\n' + '市場構造と取引コストを検証する研究の解説です。\n\n'.repeat(80),
        ) } : archive);
      }
      if (url.startsWith('https://arxiv.org/pdf/')) {
        if (state.holdDownload) await new Promise<void>(resolve => { state.release = () => { state.holdDownload = false; resolve(); }; });
        return new Response(Buffer.from(fixtures.pdfBytes, 'base64'), { headers: { 'Content-Type': 'application/pdf' } });
      }
      throw new Error('Unexpected external request: ' + url);
    };
  }, { source, catalogue, archives, options, pdfBytes: fixturePdf().toString('base64') });
}

async function stop() {
  if (!desktop) return;
  const child = desktop.process();
  const closed = desktop.waitForEvent('close', { timeout: 5_000 }).catch(() => undefined);
  await desktop.evaluate(({ app }) => app.exit(0)).catch(() => undefined);
  await closed;
  if (child.exitCode === null) child.kill();
  desktop = undefined;
}

async function openResearch() {
  await workspace('PDFs').click();
  const back = pdf().getByRole('button', { name: 'Back to library', exact: true });
  if (await back.isVisible()) await back.click();
  await pdf().getByRole('button', { name: 'Rates & Execution', exact: true }).click();
  await expect(browser()).toBeVisible();
}

async function chooseExecution() {
  await browser().getByRole('button', { name: 'View review for Execution notes (2601.00001)', exact: true }).click();
  await expect(browser().locator('.research-review')).toContainText('Published execution commentary');
  await expect(browser().locator('.research-review .katex')).toHaveCount(1);
}

async function importExecution() {
  await chooseExecution();
  await browser().getByRole('button', { name: 'Import PDF + review', exact: true }).click();
  await expect(browser().getByRole('button', { name: 'Open review', exact: true })).toBeVisible();
  const relative = await browser().locator('.research-note-path').innerText();
  const catalog = JSON.parse(await readFile(catalogFile(), 'utf8')) as { documents: PDFDocument[] };
  return { relative, document: catalog.documents[0] };
}

async function downloadCount() {
  return desktop!.evaluate(() => (globalThis as typeof globalThis & { researchFixture: { requests: string[] } }).researchFixture.requests
    .filter(url => url.startsWith('https://arxiv.org/pdf/')).length);
}

test.beforeEach(async () => {
  temporary = await mkdtemp(path.join(os.tmpdir(), 'prism-research-'));
  notebook = path.join(temporary, 'Research notebook');
  userData = path.join(temporary, 'notes-profile');
  pdfProfile = path.join(temporary, 'pdf-profile');
  rendererErrors = []; remoteRequests = [];
  await Promise.all([mkdir(notebook), mkdir(userData), mkdir(pdfProfile)]);
  await writeFile(path.join(notebook, 'Welcome to Prism.md'), original);
});

test.afterEach(async ({}, testInfo) => {
  if (page && !page.isClosed() && testInfo.status !== testInfo.expectedStatus) {
    const screenshot = await page.screenshot({ path: testInfo.outputPath('research-failure.png') }).catch(() => undefined);
    if (screenshot) await testInfo.attach('Research at failure', { body: screenshot, contentType: 'image/png' });
  }
  await stop();
  if (temporary) await rm(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

test('imports a tagged PDF and linked review while preserving drafts, then reuses the PDF and edited review after restart', async () => {
  await launch();
  await editor().focus();
  await editor().press('ControlOrMeta+End');
  await page.keyboard.insertText(draft);
  await openResearch();
  const imported = await importExecution();
  expect(imported.document.title).toBe(first.title);
  expect(imported.document.tags).toEqual(expect.arrayContaining(first.topics));
  expect(imported.document.arxivId).toBe(firstId);
  expect(await downloadCount()).toBe(1);
  const reviewFile = path.join(notebook, imported.relative);
  const savedReview = await readFile(reviewFile, 'utf8');
  expect(savedReview).toContain(`prism-pdf://v1/documents/${imported.document.id}?page=1`);
  expect(savedReview).toContain('Published execution commentary');
  expect(savedReview).toContain('8/10');
  expect(savedReview).not.toContain('Published rates commentary');
  expect(await readFile(path.join(notebook, 'Welcome to Prism.md'), 'utf8')).toBe(original);
  await browser().getByRole('button', { name: 'Close research browser', exact: true }).click();
  await workspace('Notes').click();
  await expect(editor()).toContainText(draft);
  await editor().press('ControlOrMeta+z');
  await expect(editor()).not.toContainText(draft);
  await editor().press(process.platform === 'darwin' ? 'Meta+Shift+Z' : 'Control+y');
  await expect(editor()).toContainText(draft);
  await openResearch();
  const repeated = await importExecution();
  expect(repeated.document.id).toBe(imported.document.id);
  expect(repeated.relative).toBe(imported.relative);
  await expect(browser()).toContainText('Existing review preserved.');
  expect(await downloadCount()).toBe(1);
  await browser().getByRole('button', { name: 'Open review', exact: true }).click();
  await expect(browser()).toHaveCount(0);
  await expect(page.locator('.note-heading h1')).toHaveText(first.title);
  await expect(page.locator(`.graph-compact [data-pdf-id="${imported.document.id}"]`)).toBeVisible();
  await editor().focus();
  await editor().press('ControlOrMeta+End');
  await page.keyboard.insertText('\nMy own review edits.\n');
  await editor().press('ControlOrMeta+s');
  await expect.poll(() => readFile(reviewFile, 'utf8')).toContain('My own review edits.');
  const edited = await readFile(reviewFile, 'utf8');
  await page.getByRole('group', { name: 'Editor mode', exact: true }).getByRole('button', { name: 'Read', exact: true }).click();
  await page.locator(`.preview-pane a[href="prism-pdf://v1/documents/${imported.document.id}?page=1"]`).click();
  await expect(pdf().locator('.pdf-paper canvas[data-page-number="1"]')).toBeVisible();
  await expect(pdf().locator('.pdf-paper')).toHaveAttribute('aria-busy', 'false');
  await pdf().getByRole('button', { name: 'Linked notes', exact: true }).click();
  await expect(pdf().getByRole('button', { name: `Open note ${imported.relative}`, exact: true })).toBeVisible();
  await page.evaluate(async id => { await window.prismPdf.updateDocument(id, { title: 'My execution paper', tags: ['Personal'] }); }, imported.document.id);
  await stop();
  await launch();
  await openResearch();
  const restarted = await importExecution();
  expect(restarted.document.id).toBe(imported.document.id);
  expect(restarted.document.title).toBe('My execution paper');
  expect(restarted.document.tags).toContain('Personal');
  expect(restarted.relative).toBe(imported.relative);
  expect(await readFile(reviewFile, 'utf8')).toBe(edited);
  expect(await downloadCount()).toBe(0);
  expect(rendererErrors).toEqual([]);
  expect(remoteRequests).toEqual([]);
});

test('retries catalogue and review failures, filters editions, and keeps a pending import and enlarged browser usable', async ({}, testInfo) => {
  await launch({ failCatalogue: true, failReview: true, holdDownload: true });
  await openResearch();
  await expect(browser().getByRole('alert')).toContainText('503');
  await browser().getByRole('button', { name: 'Retry catalogue', exact: true }).click();
  await expect(browser().getByRole('button', { name: 'Retry review', exact: true })).toBeVisible();
  await browser().getByRole('button', { name: 'Retry review', exact: true }).click();
  await chooseExecution();
  expect(await browser().evaluate(element => element.getBoundingClientRect().width)).toBeGreaterThan(900);
  await testInfo.attach('Research browser at desktop width', {
    body: await page.screenshot({ path: testInfo.outputPath('research-desktop.png') }), contentType: 'image/png',
  });
  await expect(browser().getByLabel('Review edition', { exact: true }).locator('option')).toHaveCount(2);
  await browser().getByLabel('Review edition', { exact: true }).selectOption(`${olderEdition}:${oldId}`);
  await expect(browser()).toContainText('Earlier published edition commentary.');
  await expect(browser()).toContainText('Full edition review');
  await browser().getByLabel('Edition type', { exact: true }).selectOption('daily');
  await browser().getByLabel('Minimum rating', { exact: true }).selectOption('8');
  await expect(browser().locator('.research-paper')).toHaveCount(1);
  await browser().getByLabel('Minimum rating', { exact: true }).selectOption('');
  await browser().getByLabel('Topic', { exact: true }).selectOption('Rates');
  await expect(browser().locator('.research-paper')).toHaveCount(1);
  await expect(browser().locator('.research-review')).toContainText('Published rates commentary');
  await expect(browser().locator('.research-review img')).toHaveCount(0);
  await expect(browser().locator('.research-review a[href]')).toHaveCount(0);
  await browser().getByRole('button', { name: 'Published source', exact: true }).click();
  await expect.poll(() => desktop!.evaluate(() => (globalThis as typeof globalThis & { researchFixture: { sourceLinks: string[] } }).researchFixture.sourceLinks.length)).toBe(1);
  await browser().getByLabel('Topic', { exact: true }).selectOption('');
  await browser().getByLabel('Search published papers', { exact: true }).fill('Aiko');
  await expect(browser().locator('.research-paper')).toHaveCount(1);
  await chooseExecution();
  await browser().getByRole('button', { name: 'Close research browser', exact: true }).click();
  await workspace('Notes').click();
  await page.getByRole('button', { name: 'Window appearance', exact: true }).click();
  const appearance = page.getByRole('dialog', { name: 'Make a little space', exact: true });
  await appearance.getByRole('radio', { name: 'Sci-fi theme', exact: true }).check();
  await appearance.getByRole('slider', { name: 'Text size', exact: true }).fill('150');
  await appearance.getByRole('switch', { name: 'Transparent window', exact: true }).click();
  await appearance.getByRole('slider', { name: 'Background opacity', exact: true }).fill('35');
  await appearance.getByRole('button', { name: 'Done', exact: true }).click();
  await page.setViewportSize({ width: 720, height: 1000 });
  await openResearch();
  await chooseExecution();
  await browser().getByLabel('Group review notes', { exact: true }).selectOption('month');
  await browser().getByRole('button', { name: 'Import PDF + review', exact: true }).scrollIntoViewIfNeeded();
  expect(await browser().evaluate(element => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1);
  await testInfo.attach('Research browser at 150 percent text', {
    body: await page.screenshot({ path: testInfo.outputPath('research-large-text.png') }), contentType: 'image/png',
  });
  await browser().getByRole('button', { name: 'Import PDF + review', exact: true }).click();
  await expect(browser().getByRole('button', { name: 'Close research browser', exact: true })).toBeDisabled();
  await browser().press('Escape');
  await expect(browser()).toBeVisible();
  await expect.poll(() => downloadCount()).toBe(1);
  await desktop!.evaluate(() => { (globalThis as typeof globalThis & { researchFixture: { release?: () => void } }).researchFixture.release?.(); });
  await expect(browser().getByRole('button', { name: 'Open review', exact: true })).toBeVisible();
  await expect(browser().locator('.research-note-path')).toContainText('2026-10');
  expect(rendererErrors).toEqual([]);
  expect(remoteRequests).toEqual([]);
});

test('fills the review column height with scrollable papers in tall windows and keeps narrow layouts usable', async ({}, testInfo) => {
  await launch({ longCatalogue: true });
  await page.getByRole('button', { name: 'Window appearance', exact: true }).click();
  const appearance = page.getByRole('dialog', { name: 'Make a little space', exact: true });
  await appearance.getByRole('radio', { name: 'Sci-fi theme', exact: true }).check();
  await appearance.getByRole('slider', { name: 'Text size', exact: true }).fill('150');
  await appearance.getByRole('button', { name: 'Done', exact: true }).click();
  await page.setViewportSize({ width: 1440, height: 1800 });
  await openResearch();
  await chooseExecution();
  const results = browser().locator('.research-results');
  const detail = browser().locator('.research-detail');
  const review = browser().locator('.research-review');
  const importButton = browser().getByRole('button', { name: 'Import PDF + review', exact: true });
  await expect(results.locator('.research-paper')).toHaveCount(32);
  expect((await results.boundingBox())!.height).toBeGreaterThan(900);
  for (const viewport of [{ width: 1440, height: 1800 }, { width: 1440, height: 1000 }, { width: 1100, height: 600 }]) {
    await page.setViewportSize(viewport);
    await expect.poll(async () => {
      const left = (await results.boundingBox())!;
      const right = (await detail.boundingBox())!;
      return Math.abs(left.y + left.height - right.y - right.height);
    }).toBeLessThanOrEqual(1);
    expect(await results.evaluate(element => element.scrollHeight > element.clientHeight)).toBe(true);
    expect(await browser().evaluate(element => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1);
    await importButton.scrollIntoViewIfNeeded();
    expect((await importButton.boundingBox())!.y + (await importButton.boundingBox())!.height).toBeLessThanOrEqual(viewport.height);
    await browser().getByRole('button', { name: 'Close research browser', exact: true }).scrollIntoViewIfNeeded();
    if (viewport.height === 1800) await testInfo.attach('Full-height research list', {
      body: await page.screenshot({ path: testInfo.outputPath('research-full-height.png') }), contentType: 'image/png',
    });
  }
  await page.setViewportSize({ width: 1440, height: 1800 });
  const leftBox = (await results.boundingBox())!;
  await page.mouse.move(leftBox.x + leftBox.width / 2, leftBox.y + 100);
  await page.mouse.wheel(0, 500);
  await expect.poll(() => results.evaluate(element => element.scrollTop)).toBeGreaterThan(0);
  expect(await review.evaluate(element => element.scrollTop)).toBe(0);
  const listScroll = await results.evaluate(element => element.scrollTop);
  await review.hover();
  await page.mouse.wheel(0, 400);
  await expect.poll(() => review.evaluate(element => element.scrollTop)).toBeGreaterThan(0);
  expect(await results.evaluate(element => element.scrollTop)).toBe(listScroll);
  const search = browser().getByLabel('Search published papers', { exact: true });
  await search.fill('no matching research paper');
  await expect(results.locator('.research-empty')).toHaveText('No papers match these filters.');
  const emptyBox = (await results.locator('.research-empty').boundingBox())!;
  const emptyResults = (await results.boundingBox())!;
  expect(emptyBox.y + emptyBox.height).toBeLessThanOrEqual(emptyResults.y + emptyResults.height);
  await search.fill('');
  await chooseExecution();
  await page.setViewportSize({ width: 720, height: 1000 });
  expect((await results.boundingBox())!.height).toBeLessThanOrEqual(280);
  expect((await results.boundingBox())!.height).toBeGreaterThan(100);
  await importButton.scrollIntoViewIfNeeded();
  expect(await browser().evaluate(element => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1);
  await browser().getByRole('button', { name: 'Close research browser', exact: true }).click();
  await expect(browser()).toHaveCount(0);
  expect(rendererErrors).toEqual([]);
  expect(remoteRequests).toEqual([]);
});
