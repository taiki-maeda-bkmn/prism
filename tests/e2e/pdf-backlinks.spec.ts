import { electronLaunchArguments } from '../../scripts/electron-launch.mjs';
import { _electron as electron, expect, test, type ElectronApplication, type Locator, type Page } from '@playwright/test';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { PDFDocument } from '../../pdf-manager/src/shared/types';
import { fixturePdf } from '../fixtures/pdf';

const firstId = '1746f19d-10f0-485e-8017-73b73a5c37d5';
const secondId = '11814f12-5df3-418e-9808-3d6656fe3822';
const welcomePath = 'Welcome to Prism.md';
const initial = '# 読書ノート\n\n資料と考えをつなぐ。\n\n';
const href = (id: string, number: number) => `prism-pdf://v1/documents/${id}?page=${number}`;
const reference = (label: string, id: string, number: number) => `[${label}](${href(id, number)})`;
const diskText = (value: string) => '\ufeff' + value.replace(/\n/g, '\r\n');
const redoKey = process.platform === 'darwin' ? 'Meta+Shift+Z' : 'Control+y';
let temporary: string;
let notebook: string;
let secondNotebook: string;
let userData: string;
let pdfProfile: string;
let desktop: ElectronApplication | undefined;
let page: Page;
let rendererErrors: string[];
let remoteRequests: string[];
const pdf = () => page.locator('.pdf-workspace');
const editor = () => page.locator('.app-body .cm-content');
const mode = (name: 'Source' | 'Read') => page.getByRole('group', { name: 'Editor mode', exact: true }).getByRole('button', { name, exact: true });
const workspace = (name: 'Notes' | 'PDFs') => page.getByRole('navigation', { name: 'Workspaces', exact: true }).getByRole('button', { name, exact: true });
const toggle = () => pdf().getByRole('button', { name: 'Linked notes', exact: true });
const panel = () => pdf().getByRole('region', { name: 'Linked notes for this PDF', exact: true });
const openNote = (notePath: string) => panel().getByRole('button', { name: `Open note ${notePath}`, exact: true });
const citedPage = (number: number, notePath = welcomePath) => panel().getByRole('button', { name: `Page ${number} cited by ${notePath}`, exact: true });
const rows = () => panel().locator('.pdf-backlink');
const noteFile = (notePath = welcomePath, directory = notebook) => path.join(directory, notePath);
const catalogFile = () => path.join(pdfProfile, 'library', 'catalog.json');
const prompt = () => page.getByRole('dialog', { name: 'Keep your latest thoughts?', exact: true });

function entry(id: string, title: string, bytes: Buffer): PDFDocument {
  return {
    id, title, filename: `${title}.pdf`, size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'),
    importedAt: '2025-08-09T10:11:12.000Z', updatedAt: '2025-09-10T11:12:13.000Z',
    tags: ['Reading'], favorite: false, lastOpenedAt: null, lastPage: 1, pageCount: 99,
  };
}

async function writeNote(notePath: string, content: string, directory = notebook) {
  const filename = noteFile(notePath, directory);
  await mkdir(path.dirname(filename), { recursive: true });
  await writeFile(filename, diskText(content));
}

async function launch() {
  desktop = await electron.launch({
    args: electronLaunchArguments(['--no-sandbox', '.']), cwd: process.cwd(),
    env: { ...process.env, PRISM_USER_DATA: userData, PRISM_WORKSPACE: notebook, PRISM_PDF_USER_DATA: pdfProfile },
  });
  page = await desktop.firstWindow();
  page.on('pageerror', error => rendererErrors.push(error.message));
  page.on('request', request => { if (/^https?:/.test(request.url())) remoteRequests.push(request.url()); });
  await expect(page.locator('.note-heading h1')).toHaveText('読書ノート');
  await expect.poll(() => desktop!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible())).toBe(true);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await mode('Source').click();
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

async function enterSplit() {
  await page.getByRole('button', { name: 'Read & write', exact: true }).click();
  await expect(page.locator('.workspace-area')).toHaveAttribute('data-layout', 'split');
}

async function openDocument(title = 'Field notes') {
  await workspace('PDFs').click();
  await pdf().getByRole('button', { name: `Open ${title}`, exact: true }).click();
}

async function expand() {
  if (await toggle().getAttribute('aria-expanded') !== 'true') await toggle().click();
  await expect(panel()).toBeVisible();
}

async function renderedPage(number: number) {
  const canvas = pdf().locator(`.pdf-paper canvas[data-page-number="${number}"]`);
  await expect(canvas).toBeVisible();
  await expect(pdf().getByLabel('Page number', { exact: true })).toHaveValue(String(number));
  await expect(pdf().locator('.pdf-paper')).toHaveAttribute('aria-busy', 'false');
  await expect.poll(() => canvas.evaluate((element: HTMLCanvasElement) => {
    if (!element.isConnected || !element.width || !element.height) return 0;
    const pixels = element.getContext('2d')!.getImageData(0, 0, element.width, element.height).data;
    let colored = 0;
    for (let offset = 0; offset < pixels.length; offset += 16) {
      if (Math.max(pixels[offset], pixels[offset + 1], pixels[offset + 2]) - Math.min(pixels[offset], pixels[offset + 1], pixels[offset + 2]) > 40) colored++;
    }
    return colored;
  })).toBeGreaterThan(100);
}

async function append(value: string) {
  await editor().focus();
  await editor().press('ControlOrMeta+End');
  await page.keyboard.insertText(value);
}

async function showNotes() {
  if (!(await page.locator('#notes-navigation').isVisible())) await page.getByRole('button', { name: 'Show notes', exact: true }).click();
}

async function hideNotes() {
  await expect(page.locator('.app-body')).toHaveAttribute('aria-busy', 'false');
  const close = page.getByRole('button', { name: 'Close notes navigation', exact: true });
  if (await close.isVisible()) await close.click();
}

async function expectInsidePane(control: Locator) {
  await control.scrollIntoViewIfNeeded();
  const bounds = (await page.locator('.pdf-panel').boundingBox())!;
  const box = (await control.boundingBox())!;
  expect(box.x).toBeGreaterThanOrEqual(bounds.x);
  expect(box.x + box.width).toBeLessThanOrEqual(bounds.x + bounds.width + 1);
  expect(box.y).toBeGreaterThanOrEqual(bounds.y);
  expect(box.y + box.height).toBeLessThanOrEqual(bounds.y + bounds.height + 1);
}

test.beforeEach(async () => {
  temporary = await mkdtemp(path.join(os.tmpdir(), 'prism-pdf-backlinks-'));
  notebook = path.join(temporary, 'First notebook');
  secondNotebook = path.join(temporary, 'Second notebook');
  userData = path.join(temporary, 'notes-profile');
  pdfProfile = path.join(temporary, 'pdf-profile');
  rendererErrors = []; remoteRequests = [];
  await Promise.all([mkdir(notebook), mkdir(secondNotebook), mkdir(userData), mkdir(path.join(pdfProfile, 'library', 'documents'), { recursive: true })]);
  await writeNote(welcomePath, initial);
  const plain = fixturePdf();
  const protectedBytes = fixturePdf('linked-secret');
  await writeFile(catalogFile(), JSON.stringify({ version: 1, documents: [entry(firstId, 'Field notes', plain), entry(secondId, 'Protected', protectedBytes)] }) + '\n');
  await Promise.all([
    writeFile(path.join(pdfProfile, 'library', 'documents', `${firstId}.pdf`), plain),
    writeFile(path.join(pdfProfile, 'library', 'documents', `${secondId}.pdf`), protectedBytes),
  ]);
});

test.afterEach(async ({}, testInfo) => {
  if (page && !page.isClosed() && testInfo.status !== testInfo.expectedStatus) {
    const screenshot = await page.screenshot().catch(() => undefined);
    if (screenshot) await testInfo.attach('PDF linked notes at failure', { body: screenshot, contentType: 'image/png' });
  }
  await stop();
  if (temporary) await rm(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

test('updates grouped linked notes from drafts and undo, opens exact notes and pages, and saves unchanged Markdown bytes', async () => {
  const firstNote = '研究/引用.md';
  const secondNote = '別の場所/引用.md';
  await writeNote(firstNote, '# 同じ題名\n\n' + [reference('最初', firstId, 1), reference('次', firstId, 2), reference('再び', firstId, 2)].join('\n\n'));
  await writeNote(secondNote, '# 同じ題名\n\n| 引用 |\n| --- |\n| ' + reference('表の引用', firstId, 2) + ' |\n');
  await writeNote('Examples.md', '# Examples\n\n```md\n' + reference('example', firstId, 1) + '\n```\n\n`' + reference('inline example', firstId, 2) + '`\n');
  await launch();
  const draft = '保存前の考え。 ';
  await append(draft);
  await enterSplit();
  await openDocument();
  await renderedPage(1);
  await expect(toggle()).toHaveAttribute('aria-expanded', 'false');
  await expand();
  await expect(rows()).toHaveCount(2);
  await expect(toggle()).toContainText('2');
  await expect(openNote(firstNote)).toContainText('同じ題名');
  await expect(openNote(secondNote)).toContainText('同じ題名');
  await expect(panel()).toContainText(firstNote);
  await expect(panel()).toContainText(secondNote);
  await expect(citedPage(2, firstNote)).toHaveCount(1);
  await citedPage(2, firstNote).click();
  await renderedPage(2);
  await pdf().getByLabel('Page zoom', { exact: true }).selectOption('1.5');
  await renderedPage(2);
  const reader = await pdf().locator('.pdf-reader').elementHandle();
  await pdf().getByRole('button', { name: 'Insert page link', exact: true }).click();
  const inserted = reference('Field notes — p. 2', firstId, 2);
  await expect(editor()).toContainText(inserted);
  await expect(rows()).toHaveCount(3);
  await expect(citedPage(2)).toBeEnabled();
  expect(await readFile(noteFile(), 'utf8')).toBe(diskText(initial));
  await editor().press('ControlOrMeta+z');
  await expect(rows()).toHaveCount(2);
  await expect(editor()).toContainText(draft.trim());
  await editor().press(redoKey);
  await expect(rows()).toHaveCount(3);
  await citedPage(1, firstNote).focus();
  await page.keyboard.press('Enter');
  await renderedPage(1);
  await expect(pdf().getByLabel('Page zoom', { exact: true })).toHaveValue('1.5');
  await expect(editor()).toContainText(inserted);
  await openNote(firstNote).click();
  await expect(page.locator('.note-heading h1')).toHaveText('同じ題名');
  await expect(workspace('Notes')).toHaveAttribute('aria-pressed', 'true');
  await expect(editor()).toBeFocused();
  await expect(pdf()).toBeVisible();
  await openNote(welcomePath).click();
  await expect(editor()).toContainText(draft.trim());
  await expect(editor()).toContainText(inserted);
  expect(await pdf().locator('.pdf-reader').evaluate((element, previous) => element === previous, reader)).toBe(true);
  await editor().press('ControlOrMeta+s');
  const expected = initial + draft + inserted;
  await expect.poll(() => readFile(noteFile(), 'utf8')).toBe(diskText(expected));
  await editor().press('ControlOrMeta+Shift+g');
  await expect(page.locator('.graph-page')).toBeVisible();
  await openNote(welcomePath).click();
  await expect(page.locator('.graph-page')).toHaveCount(0);
  await expect(editor()).toBeFocused();
  await expect(editor()).toContainText(inserted);
  await workspace('PDFs').click();
  await page.getByRole('button', { name: 'Read & write', exact: true }).click();
  await workspace('Notes').click();
  await expect(pdf()).toBeHidden();
  await workspace('PDFs').click();
  await expect(toggle()).toHaveAttribute('aria-expanded', 'true');
  await expect(rows()).toHaveCount(3);
  await stop();
  await launch();
  await openDocument();
  await expand();
  await expect(rows()).toHaveCount(3);
  await expect(citedPage(2)).toBeEnabled();
  expect(await readFile(noteFile(), 'utf8')).toBe(diskText(expected));
  expect(rendererErrors).toEqual([]);
  expect(remoteRequests).toEqual([]);
});

test('keeps backlink identity through duplicate titles and rename, but does not transfer old references after re-import', async () => {
  const firstOnly = 'First document.md';
  const content = initial + reference('First PDF', firstId, 1) + '\n\n' + reference('Second PDF', secondId, 2) + '\n';
  await writeNote(welcomePath, content);
  await writeNote(firstOnly, '# First document only\n\n' + reference('Old title', firstId, 2));
  await launch();
  await workspace('PDFs').click();
  await pdf().getByRole('button', { name: 'Details for Field notes', exact: true }).click();
  await pdf().getByLabel('Document title', { exact: true }).fill('Protected');
  await pdf().getByRole('button', { name: 'Save changes', exact: true }).click();
  await expect(pdf().getByRole('dialog')).toHaveCount(0);
  await expect(pdf().getByRole('button', { name: 'Open Protected', exact: true })).toHaveCount(2);
  await workspace('Notes').click();
  await mode('Read').click();
  await page.locator('.preview-pane').getByRole('link', { name: 'First PDF', exact: true }).click();
  await renderedPage(1);
  await expand();
  await expect(rows()).toHaveCount(2);
  await expect(openNote(firstOnly)).toBeVisible();
  await expect(pdf().locator('.pdf-reader-document h1')).toHaveText('Protected');
  await openNote(firstOnly).click();
  await expect(page.locator('.note-heading h1')).toHaveText('First document only');
  await expect(mode('Read')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('.app-body')).toBeFocused();
  await expect(pdf()).toBeHidden();
  await workspace('PDFs').click();
  await openNote(welcomePath).click();
  await expect(mode('Read')).toHaveAttribute('aria-pressed', 'true');
  await page.locator('.preview-pane').getByRole('link', { name: 'Second PDF', exact: true }).click();
  await expect(pdf().getByLabel('Document password', { exact: true })).toBeVisible();
  await expand();
  await expect(rows()).toHaveCount(1);
  await expect(openNote(firstOnly)).toHaveCount(0);
  await expect(citedPage(2)).toBeDisabled();
  await pdf().getByRole('button', { name: 'Back to library', exact: true }).click();
  // The original filename still identifies the renamed document in metadata
  // search; never choose a duplicate title by its incidental card order.
  await pdf().getByLabel('Search library', { exact: true }).fill('Field notes.pdf');
  await pdf().getByRole('button', { name: 'Details for Protected', exact: true }).click();
  await pdf().getByLabel('Document title', { exact: true }).fill('Renamed original');
  await pdf().getByRole('button', { name: 'Save changes', exact: true }).click();
  await expect(pdf().getByRole('dialog')).toHaveCount(0);
  await pdf().getByLabel('Search library', { exact: true }).fill('');
  const catalog = JSON.parse(await readFile(catalogFile(), 'utf8')) as { documents: PDFDocument[] };
  expect(catalog.documents.find(document => document.id === firstId)?.title).toBe('Renamed original');
  await pdf().getByRole('button', { name: 'Details for Renamed original', exact: true }).click();
  await pdf().getByRole('button', { name: 'Remove', exact: true }).click();
  await pdf().getByRole('button', { name: 'Remove document', exact: true }).click();
  await expect(pdf().getByRole('dialog')).toHaveCount(0);
  const source = path.join(temporary, 'Renamed original.pdf');
  await writeFile(source, fixturePdf());
  await desktop!.evaluate(({ dialog }, filename) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [filename] }); }, source);
  await pdf().getByRole('button', { name: 'Import PDFs', exact: true }).click();
  await pdf().getByRole('button', { name: 'Open Renamed original', exact: true }).click();
  await renderedPage(1);
  await expand();
  await expect(rows()).toHaveCount(0);
  await expect(toggle()).toContainText('0');
  const replacement = (JSON.parse(await readFile(catalogFile(), 'utf8')) as { documents: PDFDocument[] }).documents.find(document => document.title === 'Renamed original')!;
  expect(replacement.id).not.toBe(firstId);
  expect(await readFile(noteFile(), 'utf8')).toBe(diskText(content));
  expect(rendererErrors).toEqual([]);
  expect(remoteRequests).toEqual([]);
});

test('refresh and notebook replacement remove stale references while cancellation keeps current drafts and the reader', async () => {
  const content = initial + reference('Saved reference', firstId, 1) + '\n\n';
  const external = initial + '別のエディターで変更した本文。\n';
  await writeNote(welcomePath, content);
  await launch();
  await enterSplit();
  await openDocument();
  await renderedPage(1);
  await expand();
  await append(reference('Draft reference', firstId, 2));
  await expect(citedPage(2)).toBeEnabled();
  await citedPage(2).click();
  await renderedPage(2);
  const reader = await pdf().locator('.pdf-reader').elementHandle();
  await writeNote(welcomePath, external);
  await writeNote('New reference.md', '# New reference\n\n' + reference('New saved reference', firstId, 2));
  await showNotes();
  await page.getByRole('button', { name: 'Refresh notebook', exact: true }).click();
  await prompt().getByRole('button', { name: 'Cancel', exact: true }).click();
  await hideNotes();
  await expect(citedPage(1)).toBeEnabled();
  await expect(citedPage(2)).toBeEnabled();
  await expect(openNote('New reference.md')).toHaveCount(0);
  await showNotes();
  await page.getByRole('button', { name: 'Refresh notebook', exact: true }).click();
  await prompt().getByRole('button', { name: 'Discard changes', exact: true }).click();
  await expect(prompt()).toHaveCount(0);
  await hideNotes();
  await expect(rows()).toHaveCount(1);
  await expect(openNote(welcomePath)).toHaveCount(0);
  await expect(openNote('New reference.md')).toBeVisible();
  await expect(editor()).toContainText('別のエディターで変更した本文。');
  await writeNote(welcomePath, external, secondNotebook);
  await writeNote('New reference.md', '# New reference\n\n別のノートブックの本文。\n', secondNotebook);
  await desktop!.evaluate(({ dialog }, directory) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [directory] }); }, secondNotebook);
  await editor().focus();
  await editor().press('ControlOrMeta+o');
  await expect(page.locator('.workspace-switch strong')).toHaveText('Second notebook');
  await expect(rows()).toHaveCount(0);
  await editor().focus();
  await editor().press(redoKey);
  await expect(rows()).toHaveCount(0);
  await expect(editor()).not.toContainText('prism-pdf:');
  await renderedPage(2);
  expect(await pdf().locator('.pdf-reader').evaluate((element, previous) => element === previous, reader)).toBe(true);
  await editor().press('ControlOrMeta+End');
  await pdf().getByRole('button', { name: 'Insert page link', exact: true }).click();
  await expect(rows()).toHaveCount(1);
  await expect(citedPage(2)).toBeEnabled();
  expect(await readFile(noteFile(), 'utf8')).toBe(diskText(external));
  expect(await readFile(noteFile(welcomePath, secondNotebook), 'utf8')).toBe(diskText(external));
  expect(rendererErrors).toEqual([]);
  expect(remoteRequests).toEqual([]);
});

test('keeps note access beside locked and invalid pages, and fits the expanded panel at 420px and large text', async ({}, testInfo) => {
  const longPath = '研究/長い名前の日本語ノートを読書中に開くための参照.md';
  await writeNote(welcomePath, initial + reference('Locked page', secondId, 2) + '\n\n' + reference('Invalid page', secondId, 99));
  await writeNote(longPath, '# 長い名前の日本語ノートを読書中に開くための参照\n\n' + reference('引用', secondId, 1));
  await launch();
  await enterSplit();
  await openDocument('Protected');
  const password = pdf().getByLabel('Document password', { exact: true });
  await expect(password).toBeVisible();
  await expand();
  await expect(citedPage(2)).toBeDisabled();
  await expect(citedPage(99)).toBeDisabled();
  await openNote(welcomePath).focus();
  await page.keyboard.press('Enter');
  await expect(editor()).toBeFocused();
  await expect(password).toBeVisible();
  await append('\nロック中も書ける。');
  await password.fill('linked-secret');
  await pdf().getByRole('button', { name: 'Unlock PDF', exact: true }).click();
  await renderedPage(1);
  await expect(citedPage(2)).toBeEnabled();
  await expect(citedPage(99)).toBeDisabled();
  await expect(citedPage(99)).toContainText(/unavailable/i);
  const divider = page.getByRole('separator', { name: 'Resize note and PDF panes', exact: true });
  await divider.focus();
  for (let count = 0; count < 20; count++) await divider.press('Shift+ArrowRight');
  await expect.poll(async () => (await page.locator('.pdf-panel').boundingBox())!.width).toBeGreaterThanOrEqual(420);
  await expect.poll(async () => (await page.locator('.pdf-panel').boundingBox())!.width).toBeLessThan(430);
  for (const theme of ['Prism', 'Paper', 'Sci-fi'] as const) {
    await page.getByRole('button', { name: 'Window appearance', exact: true }).click();
    const appearance = page.getByRole('dialog', { name: 'Make a little space', exact: true });
    await appearance.getByRole('radio', { name: `${theme} theme`, exact: true }).check();
    await appearance.getByRole('slider', { name: 'Text size', exact: true }).fill('150');
    if (theme === 'Sci-fi') {
      await appearance.getByRole('switch', { name: 'Transparent window', exact: true }).click();
      await appearance.getByRole('slider', { name: 'Background opacity', exact: true }).fill('35');
    }
    await appearance.getByRole('button', { name: 'Done', exact: true }).click();
    await expectInsidePane(toggle());
    await expectInsidePane(openNote(longPath));
    await expectInsidePane(citedPage(1, longPath));
    expect(await panel().evaluate(element => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1);
    const viewport = (await pdf().getByLabel('PDF page viewport', { exact: true }).boundingBox())!;
    expect(viewport.height).toBeGreaterThan(80);
    await citedPage(2).click();
    await renderedPage(2);
    await citedPage(1, longPath).click();
    await renderedPage(1);
  }
  await testInfo.attach('Expanded linked notes at 420 pixels and 150% text', {
    body: await page.screenshot({ path: testInfo.outputPath('pdf-backlinks-compact.png') }), contentType: 'image/png',
  });
  await expect(editor()).toContainText('ロック中も書ける。');
  expect(rendererErrors).toEqual([]);
  expect(remoteRequests).toEqual([]);
});
