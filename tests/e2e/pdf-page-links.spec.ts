import { electronLaunchArguments } from '../../scripts/electron-launch.mjs';
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { PDFDocument } from '../../pdf-manager/src/shared/types';
import { fixturePdf } from '../fixtures/pdf';

const firstId = '1746f19d-10f0-485e-8017-73b73a5c37d5';
const secondId = '11814f12-5df3-418e-9808-3d6656fe3822';
const absentId = 'e8691b04-2b49-4b15-b2d7-3c9c366dbff2';
const href = (id: string, page: number) => `prism-pdf://v1/documents/${id}?page=${page}`;
const markdownLink = (label: string, id: string, page: number) => `[${label}](${href(id, page)})`;
const diskText = (value: string) => '\ufeff' + value.replace(/\n/g, '\r\n');
const initial = '# 読書ノート\n\n資料を読みながら、考えをつなぐ。\n\n';
const applicationRoot = path.resolve(process.env.PRISM_TEST_APP_ROOT || process.cwd());
let temporary: string;
let notebook: string;
let userData: string;
let pdfProfile: string;
let desktop: ElectronApplication | undefined;
let page: Page;
let rendererErrors: string[];
let remoteRequests: string[];
const noteFile = () => path.join(notebook, 'Welcome to Prism.md');
const catalogFile = () => path.join(pdfProfile, 'library', 'catalog.json');
const managedFile = (id: string) => path.join(pdfProfile, 'library', 'documents', `${id}.pdf`);
const catalog = async (): Promise<{ version: number; documents: PDFDocument[] }> => JSON.parse(await readFile(catalogFile(), 'utf8'));
const editor = () => page.locator('.app-body .cm-content');
const pdf = () => page.locator('.pdf-workspace');
// Inactive tab readers retain their canvases and password sessions. Assertions
// target the selected reader; library controls remain scoped to the workspace.
const reader = () => pdf().locator('[data-pdf-session][data-active="true"]');
const preview = () => page.locator('.preview-pane .markdown-body');
const workspaceButton = (name: 'Notes' | 'PDFs') => page.getByRole('navigation', { name: 'Workspaces', exact: true }).getByRole('button', { name, exact: true });
const mode = (name: 'Source' | 'Split' | 'Live' | 'Read') => page.getByRole('group', { name: 'Editor mode', exact: true }).getByRole('button', { name, exact: true });
const insertButton = () => reader().getByRole('button', { name: 'Insert page link', exact: true });
// Use CodeMirror's primary redo binding. A synthetic Shift+lowercase z can
// resolve as undo; uppercase Z is needed for the macOS shifted shortcut.
const redoKey = process.platform === 'darwin' ? 'Meta+Shift+Z' : 'Control+y';

function entry(id: string, title: string, bytes: Buffer, patch: Partial<PDFDocument> = {}): PDFDocument {
  return {
    id, title, filename: `${title}.pdf`, size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'),
    importedAt: '2025-08-09T10:11:12.000Z', updatedAt: '2025-09-10T11:12:13.000Z',
    tags: [], favorite: false, lastOpenedAt: null, lastPage: 1, pageCount: null, ...patch,
  };
}

async function seedLibrary(items: Array<{ document: PDFDocument; bytes: Buffer }>) {
  await mkdir(path.join(pdfProfile, 'library', 'documents'), { recursive: true });
  await writeFile(catalogFile(), JSON.stringify({ version: 1, documents: items.map(item => item.document) }) + '\n');
  await Promise.all(items.map(item => writeFile(managedFile(item.document.id), item.bytes)));
}

async function launch() {
  const env: Record<string, string> = {
    ...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)),
    PRISM_USER_DATA: userData, PRISM_WORKSPACE: notebook, PRISM_PDF_USER_DATA: pdfProfile,
  };
  delete env.ELECTRON_RUN_AS_NODE;
  desktop = await electron.launch({
    executablePath: process.env.PRISM_TEST_ELECTRON,
    args: electronLaunchArguments(['--no-sandbox', applicationRoot]), cwd: applicationRoot, env,
  });
  page = await desktop.firstWindow();
  page.on('pageerror', error => rendererErrors.push(error.message));
  page.on('request', request => { if (/^https?:/.test(request.url())) remoteRequests.push(request.url()); });
  await expect(page.locator('.note-heading h1')).toHaveText('読書ノート');
  await expect.poll(() => desktop!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible())).toBe(true);
  await page.setViewportSize({ width: 1440, height: 1000 });
  // A saved PDF tab may own the restored single-pane workspace after restart.
  await workspaceButton('Notes').click();
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

async function quitSaved() {
  const closed = desktop!.waitForEvent('close');
  await desktop!.evaluate(({ app }) => { setTimeout(() => app.quit(), 0); });
  await closed;
  desktop = undefined;
}

async function append(value: string) {
  await editor().focus();
  await editor().press('ControlOrMeta+End');
  await page.keyboard.insertText(value);
  await expect(page.locator('.statusbar')).toContainText('1 unsaved note');
}

async function enterSplit() {
  await page.getByRole('button', { name: 'Read & write', exact: true }).click();
  await expect(page.locator('.workspace-area')).toHaveAttribute('data-layout', 'split');
  await expect(pdf()).toBeVisible();
}

async function renderedPage(number: number) {
  const canvas = reader().locator(`.pdf-paper canvas[data-page-number="${number}"]`);
  await expect(canvas).toBeVisible();
  await expect(reader().getByLabel('Page number', { exact: true })).toHaveValue(String(number));
  await expect.poll(() => canvas.evaluate((element: HTMLCanvasElement) => {
    if (!element.isConnected || !element.width || !element.height) return 0;
    const pixels = element.getContext('2d')!.getImageData(0, 0, element.width, element.height).data;
    let colored = 0;
    for (let offset = 0; offset < pixels.length; offset += 16) {
      if (Math.max(pixels[offset], pixels[offset + 1], pixels[offset + 2]) - Math.min(pixels[offset], pixels[offset + 1], pixels[offset + 2]) > 40) colored++;
    }
    return colored;
  })).toBeGreaterThan(100);
  await expect(reader().locator('.pdf-paper')).toHaveAttribute('aria-busy', 'false');
  return canvas;
}

async function returnToNotes(noteMode: 'Source' | 'Split' | 'Live' | 'Read') {
  await workspaceButton('Notes').click();
  await mode(noteMode).click();
}

async function followPreview(label: string) {
  await preview().getByRole('link', { name: label, exact: true }).click();
  await expect(pdf()).toBeVisible();
}

test.beforeEach(async () => {
  temporary = await mkdtemp(path.join(os.tmpdir(), 'prism-pdf-page-links-'));
  notebook = path.join(temporary, 'Notebook');
  userData = path.join(temporary, 'notes-profile');
  pdfProfile = path.join(temporary, 'pdf-profile');
  rendererErrors = []; remoteRequests = [];
  await Promise.all([mkdir(notebook), mkdir(userData)]);
  await writeFile(noteFile(), diskText(initial));
});

test.afterEach(async ({}, testInfo) => {
  if (page && !page.isClosed() && testInfo.status !== testInfo.expectedStatus) {
    const screenshot = await page.screenshot().catch(() => undefined);
    if (screenshot) await testInfo.attach('PDF page links at failure', { body: screenshot, contentType: 'image/png' });
  }
  await stop();
  if (temporary) await rm(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

test('inserts at the retained selection with isolated undo in Source, Live and Read, then saves and follows after restart', async ({}, testInfo) => {
  const bytes = fixturePdf();
  await seedLibrary([{ document: entry(firstId, '日本語の資料', bytes), bytes }]);
  await launch();
  const draft = '先に書いた下書き。\n置き換え';
  await append(draft);
  await editor().press('Shift+Home');
  expect(await page.evaluate(() => window.getSelection()?.toString())).toBe('置き換え');
  const originalEditor = await editor().elementHandle();
  await enterSplit();
  await pdf().getByRole('button', { name: 'Open 日本語の資料', exact: true }).click();
  await renderedPage(1);
  await reader().getByRole('button', { name: 'Next page', exact: true }).click();
  await renderedPage(2);
  const reference = markdownLink('日本語の資料 — p. 2', firstId, 2);
  await insertButton().click();
  await expect(editor()).toBeFocused();
  await expect(editor()).toContainText(reference);
  await expect(editor()).not.toContainText('置き換え');
  expect(await readFile(noteFile(), 'utf8')).toBe(diskText(initial));
  expect(await editor().evaluate((element, original) => element === original, originalEditor)).toBe(true);

  await editor().press('ControlOrMeta+z');
  await expect(editor()).not.toContainText(reference);
  await expect(editor()).toContainText('先に書いた下書き。');
  await expect(editor()).toContainText('置き換え');
  await editor().press('ControlOrMeta+z');
  await expect(editor()).not.toContainText('先に書いた下書き。');
  await expect(page.locator('.statusbar')).toContainText('All changes saved');
  await editor().press(redoKey);
  await expect(editor()).toContainText('先に書いた下書き。');
  await expect(editor()).toContainText('置き換え');
  await expect(editor()).not.toContainText(reference);
  await editor().press(redoKey);
  await expect(editor()).toContainText(reference);
  let expected = initial + '先に書いた下書き。\n' + reference;

  for (const noteMode of ['Live', 'Read'] as const) {
    await mode('Source').click();
    await append(`\n${noteMode}からの引用: `);
    expected += `\n${noteMode}からの引用: `;
    await mode(noteMode).click();
    await insertButton().click();
    await expect(mode(noteMode === 'Read' ? 'Source' : 'Live')).toHaveAttribute('aria-pressed', 'true');
    await expect(editor()).toBeFocused();
    await editor().press('ControlOrMeta+z');
    await expect(editor()).toContainText(`${noteMode}からの引用: `);
    await editor().press(redoKey);
    expected += reference;
    expect(await readFile(noteFile(), 'utf8')).toBe(diskText(initial));
    expect(await editor().evaluate((element, original) => element === original, originalEditor)).toBe(true);
  }
  await editor().press('ControlOrMeta+s');
  await expect.poll(() => readFile(noteFile(), 'utf8')).toBe(diskText(expected));
  await expect(page.locator('.statusbar')).toContainText('All changes saved');
  await testInfo.attach('Inserted PDF reference beside its page', {
    body: await page.screenshot({ path: testInfo.outputPath('pdf-page-link.png') }), contentType: 'image/png',
  });
  await quitSaved();

  await launch();
  await mode('Read').click();
  await expect(preview().getByRole('link', { name: '日本語の資料 — p. 2', exact: true })).toHaveCount(3);
  await preview().getByRole('link', { name: '日本語の資料 — p. 2', exact: true }).first().click();
  await renderedPage(2);
  await returnToNotes('Split');
  await preview().getByRole('link', { name: '日本語の資料 — p. 2', exact: true }).last().click();
  await renderedPage(2);
  expect(await readFile(noteFile(), 'utf8')).toBe(diskText(expected));
  expect(rendererErrors).toEqual([]);
  expect(remoteRequests).toEqual([]);
});

test('follows Live and table references by ID after rename and with duplicate titles while preserving selection and drafts', async () => {
  const plain = fixturePdf();
  const locked = fixturePdf('different-document');
  await seedLibrary([
    { document: entry(firstId, '旧い資料名', plain), bytes: plain },
    { document: entry(secondId, '同じ資料名', locked), bytes: locked },
  ]);
  const content = initial + markdownLink('旧い資料名 — p. 2', firstId, 2) + '\n\n'
    + '| 資料 |\n| --- |\n| ' + markdownLink('表から参照', firstId, 1) + ' |\n\n'
    + markdownLink('同名の別資料', secondId, 2) + '\n\n';
  await writeFile(noteFile(), diskText(content));
  await launch();
  await append('選択した下書き');
  await editor().press('Shift+Home');
  const originalEditor = await editor().elementHandle();
  await workspaceButton('PDFs').click();
  await pdf().getByRole('button', { name: 'Details for 旧い資料名', exact: true }).click();
  await pdf().getByLabel('Document title', { exact: true }).fill('同じ資料名');
  await pdf().getByRole('button', { name: 'Save changes', exact: true }).click();
  await expect(pdf().getByRole('dialog')).toHaveCount(0);
  await expect(pdf().getByRole('button', { name: 'Open 同じ資料名', exact: true })).toHaveCount(2);

  await returnToNotes('Live');
  await editor().locator('a.cm-live-link').filter({ hasText: /^旧い資料名 — p\. 2$/ }).click({ modifiers: ['Control'] });
  await renderedPage(2);
  await expect(reader().getByLabel('Document password', { exact: true })).toHaveCount(0);
  await expect(reader().locator('.pdf-reader-document h1')).toHaveText('同じ資料名');
  await workspaceButton('Notes').click();
  await editor().focus();
  await expect.poll(() => page.evaluate(() => window.getSelection()?.toString())).toBe('選択した下書き');
  expect(await editor().evaluate((element, original) => element === original, originalEditor)).toBe(true);
  await enterSplit();
  await editor().locator('a.cm-live-link').filter({ hasText: /^表から参照$/ }).click({ modifiers: ['Control'] });
  await renderedPage(1);
  await expect(page.locator('.workspace-area')).toHaveAttribute('data-layout', 'split');
  await editor().locator('a.cm-live-link').filter({ hasText: /^同名の別資料$/ }).click({ modifiers: ['Control'] });
  await expect(reader().getByLabel('Document password', { exact: true })).toBeVisible();
  await reader().getByLabel('Document password', { exact: true }).fill('different-document');
  await reader().getByRole('button', { name: 'Unlock PDF', exact: true }).click();
  await renderedPage(2);
  await editor().focus();
  await expect.poll(() => page.evaluate(() => window.getSelection()?.toString())).toBe('選択した下書き');
  await editor().press('ControlOrMeta+z');
  await expect(editor()).not.toContainText('選択した下書き');
  await expect(page.locator('.statusbar')).toContainText('All changes saved');
  expect(await readFile(noteFile(), 'utf8')).toBe(diskText(content));
  expect(await readFile(managedFile(firstId))).toEqual(plain);
  expect(await readFile(managedFile(secondId))).toEqual(locked);
  expect(rendererErrors).toEqual([]);
  expect(remoteRequests).toEqual([]);
});

test('recovers library errors, malformed and missing links, invalid pages and removed IDs without changing the note or opening external URLs', async () => {
  const bytes = fixturePdf();
  // Stale catalogue metadata must never make page 99 valid in a two-page PDF.
  await seedLibrary([{ document: entry(firstId, '復元する資料', bytes, { pageCount: 99 }), bytes }]);
  const healthyCatalog = await readFile(catalogFile(), 'utf8');
  const damagedCatalog = '{ retain the failed catalogue';
  await writeFile(catalogFile(), damagedCatalog);
  const content = initial + [
    markdownLink('正しい参照', firstId, 2), markdownLink('存在しないページ', firstId, 99),
    markdownLink('見つからない資料', absentId, 1), markdownLink('ゼロページ', firstId, 0),
    `[未対応の形式](prism-pdf://v2/documents/${firstId}?page=1)`,
  ].join('\n\n') + '\n\n';
  await writeFile(noteFile(), diskText(content));
  await launch();
  const opened = await desktop!.evaluateHandle(({ shell }) => {
    const destinations: string[] = [];
    shell.openExternal = async url => { destinations.push(url); };
    return destinations;
  });
  await append('失いたくない下書き');
  await mode('Read').click();
  await followPreview('正しい参照');
  await expect(pdf().getByRole('alert')).toContainText('catalog is damaged or unsupported');
  expect(await readFile(catalogFile(), 'utf8')).toBe(damagedCatalog);
  // Failed opens release ownership; restore only this disposable fixture, then
  // retry the real library loader with its still-pending page destination.
  await writeFile(catalogFile(), healthyCatalog);
  await pdf().getByRole('button', { name: 'Try again', exact: true }).click();
  await renderedPage(2);

  for (const label of ['ゼロページ', '未対応の形式']) {
    await returnToNotes('Read');
    await preview().getByRole('link', { name: label, exact: true }).click();
    await expect(page.locator('.message-banner')).toContainText('invalid destination or an unsupported version');
    await expect(page.locator('.app-body')).toBeVisible();
  }
  await followPreview('見つからない資料');
  await expect(pdf().getByRole('alert')).toContainText('not in this library');
  await pdf().getByRole('button', { name: 'Browse library', exact: true }).click();
  await expect(pdf().getByRole('button', { name: 'Open 復元する資料', exact: true })).toBeVisible();
  await returnToNotes('Read');
  await followPreview('存在しないページ');
  await expect(reader().getByRole('alert', { name: 'PDF page link error', exact: true })).toContainText('Page 99 is not available in this PDF (2 pages)');
  await renderedPage(2);
  await reader().getByRole('button', { name: 'Previous page', exact: true }).click();
  await renderedPage(1);
  await reader().getByRole('button', { name: 'Back to library', exact: true }).click();
  await pdf().getByRole('button', { name: 'Details for 復元する資料', exact: true }).click();
  await pdf().getByRole('button', { name: 'Remove', exact: true }).click();
  await pdf().getByRole('button', { name: 'Remove document', exact: true }).click();
  await expect(pdf().getByRole('dialog')).toHaveCount(0);
  await returnToNotes('Read');
  await followPreview('正しい参照');
  await expect(pdf().getByRole('alert')).toContainText('not in this library');
  await pdf().getByRole('button', { name: 'Browse library', exact: true }).click();
  const source = path.join(temporary, '復元する資料.pdf');
  await writeFile(source, bytes);
  await desktop!.evaluate(({ dialog }, source) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [source] }); }, source);
  await pdf().getByRole('button', { name: 'Import PDFs', exact: true }).click();
  await expect(pdf().getByRole('button', { name: 'Open 復元する資料', exact: true })).toBeVisible();
  const imported = (await catalog()).documents[0];
  expect(imported.id).not.toBe(firstId);
  await returnToNotes('Read');
  await followPreview('正しい参照');
  await expect(pdf().getByRole('alert')).toContainText('not in this library');
  await pdf().getByRole('button', { name: 'Browse library', exact: true }).click();
  await pdf().getByRole('button', { name: 'Open 復元する資料', exact: true }).click();
  await renderedPage(1);
  await insertButton().click();
  await expect(editor()).toContainText(href(imported.id, 1));
  await expect(editor()).toContainText('失いたくない下書き');
  await editor().press('ControlOrMeta+z');
  await expect(editor()).not.toContainText(href(imported.id, 1));
  await expect(editor()).toContainText('失いたくない下書き');
  expect(await readFile(noteFile(), 'utf8')).toBe(diskText(content));
  expect(await readFile(managedFile(firstId))).toEqual(bytes);
  expect(await readFile(managedFile(imported.id))).toEqual(bytes);
  expect(await opened.jsonValue()).toEqual([]);
  await opened.dispose();
  expect(rendererErrors).toEqual([]);
  expect(remoteRequests).toEqual([]);
});

test('uses the newest target while password loading, retains the same reader on page links and cancels navigation when browsing', async () => {
  const locked = fixturePdf('page-secret');
  const plain = fixturePdf();
  await seedLibrary([
    { document: entry(firstId, '保護された資料', locked), bytes: locked },
    { document: entry(secondId, '別の資料', plain), bytes: plain },
  ]);
  const content = initial + [
    markdownLink('保護された一ページ', firstId, 1), markdownLink('保護された二ページ', firstId, 2),
    markdownLink('別の資料へ', secondId, 2),
  ].join('\n\n') + '\n\n';
  await writeFile(noteFile(), diskText(content));
  await launch();
  await append('パスワード待ちでも、下書きは残す。');
  await enterSplit();
  await mode('Read').click();
  await followPreview('保護された一ページ');
  await expect(reader().getByLabel('Document password', { exact: true })).toBeVisible();
  await expect(insertButton()).toBeDisabled();
  const originalReader = await reader().locator('.pdf-reader').elementHandle();
  await followPreview('保護された二ページ');
  expect(await reader().locator('.pdf-reader').evaluate((element, original) => element === original, originalReader)).toBe(true);
  await reader().getByLabel('Document password', { exact: true }).fill('page-secret');
  await reader().getByRole('button', { name: 'Unlock PDF', exact: true }).click();
  await renderedPage(2);
  await reader().getByLabel('Page zoom', { exact: true }).selectOption('1.5');
  await reader().getByRole('button', { name: 'Rotate page clockwise', exact: true }).click();
  const rotated = await renderedPage(2);
  expect(await rotated.evaluate((canvas: HTMLCanvasElement) => canvas.width > canvas.height)).toBe(true);
  await followPreview('保護された一ページ');
  const first = await renderedPage(1);
  expect(await first.evaluate((canvas: HTMLCanvasElement) => canvas.width > canvas.height)).toBe(true);
  await expect(reader().getByLabel('Page zoom', { exact: true })).toHaveValue('1.5');
  await expect(reader().getByLabel('Document password', { exact: true })).toHaveCount(0);
  expect(await reader().locator('.pdf-reader').evaluate((element, original) => element === original, originalReader)).toBe(true);

  await followPreview('別の資料へ');
  await renderedPage(2);
  // A tab switch deliberately retains the unlocked PDF. Close its tab to start
  // a fresh pending-password session for the navigation-cancellation checks.
  const protectedTab = page.locator(`.document-tabs .document-tab[data-tab-key="pdf:${firstId}"]`);
  await protectedTab.getByRole('button', { name: 'Close tab 保護された資料', exact: true }).click();
  await expect(protectedTab).toHaveCount(0);
  await followPreview('保護された一ページ');
  await expect(reader().getByLabel('Document password', { exact: true })).toBeVisible();
  await followPreview('別の資料へ');
  await renderedPage(2);
  await expect(reader().locator('.pdf-reader-document h1')).toHaveText('別の資料');
  await expect(reader().getByLabel('Document password', { exact: true })).toHaveCount(0);
  await followPreview('保護された二ページ');
  await expect(reader().getByLabel('Document password', { exact: true })).toBeVisible();
  await reader().getByRole('button', { name: 'Back to library', exact: true }).click();
  await pdf().getByRole('button', { name: 'Favorite 別の資料', exact: true }).click();
  await expect(pdf().getByRole('button', { name: 'Unfavorite 別の資料', exact: true })).toBeVisible();
  await expect(reader()).toHaveCount(0);
  await expect(pdf().locator('.pdf-reader:visible')).toHaveCount(0);
  await returnToNotes('Source');
  await expect(editor()).toContainText('パスワード待ちでも、下書きは残す。');
  await editor().focus();
  await editor().press('ControlOrMeta+z');
  await expect(page.locator('.statusbar')).toContainText('All changes saved');
  expect(await readFile(noteFile(), 'utf8')).toBe(diskText(content));
  expect(await page.evaluate(() => JSON.stringify(localStorage))).not.toContain('page-secret');
  expect(await readFile(catalogFile(), 'utf8')).not.toContain('page-secret');
  expect(rendererErrors).toEqual([]);
  expect(remoteRequests).toEqual([]);
});
