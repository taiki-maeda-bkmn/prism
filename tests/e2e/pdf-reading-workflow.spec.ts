import { electronLaunchArguments } from '../../scripts/electron-launch.mjs';
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { PDFDocument } from '../../pdf-manager/src/shared/types';
import { fixturePdf } from '../fixtures/pdf';

const title = '日本語の読書資料';
const original = '\ufeff# 読書の記録\r\n\r\n資料と考えを一緒に残す。\r\n\r\n';
const redoKey = process.platform === 'darwin' ? 'Meta+Shift+Z' : 'Control+y';
let temporary: string;
let notebook: string;
let userData: string;
let pdfProfile: string;
let source: string;
let desktop: ElectronApplication | undefined;
let page: Page;
let rendererErrors: string[];
let remoteRequests: string[];
const noteFile = () => path.join(notebook, 'Welcome to Prism.md');
const catalogFile = () => path.join(pdfProfile, 'library', 'catalog.json');
const managedFile = (id: string) => path.join(pdfProfile, 'library', 'documents', `${id}.pdf`);
const documents = async (): Promise<PDFDocument[]> => JSON.parse(await readFile(catalogFile(), 'utf8')).documents;
const editor = () => page.locator('.app-body .cm-content');
const pdf = () => page.locator('.pdf-workspace');
const viewport = () => pdf().getByLabel('PDF page viewport', { exact: true });
const workspaceButton = (name: 'Notes' | 'PDFs') => page.getByRole('navigation', { name: 'Workspaces', exact: true }).getByRole('button', { name, exact: true });
const mode = (name: 'Source' | 'Read') => page.getByRole('group', { name: 'Editor mode', exact: true }).getByRole('button', { name, exact: true });

async function launch() {
  desktop = await electron.launch({
    args: electronLaunchArguments(['--no-sandbox', '.']), cwd: process.cwd(),
    env: { ...process.env, PRISM_USER_DATA: userData, PRISM_WORKSPACE: notebook, PRISM_PDF_USER_DATA: pdfProfile },
  });
  page = await desktop.firstWindow();
  page.on('pageerror', error => rendererErrors.push(error.message));
  page.on('request', request => { if (/^https?:/.test(request.url())) remoteRequests.push(request.url()); });
  // Disable network before the first PDF workspace visit, including its lazy
  // module, worker, fonts, and later restart. This is an actual offline context.
  await page.context().setOffline(true);
  await expect.poll(() => page.evaluate(() => navigator.onLine)).toBe(false);
  await expect(page.locator('.note-heading h1')).toHaveText('読書の記録');
  await expect.poll(() => desktop!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible())).toBe(true);
  await mode('Source').click();
}

async function quitSaved() {
  const closed = desktop!.waitForEvent('close');
  await desktop!.evaluate(({ app }) => { setTimeout(() => app.quit(), 0); });
  await closed;
  desktop = undefined;
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
  await expect(pdf()).toBeVisible();
}

async function importPDF() {
  await desktop!.evaluate(({ dialog }, filename) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [filename] });
  }, source);
  await pdf().getByLabel('Search library', { exact: true }).focus();
  await page.keyboard.press('ControlOrMeta+o');
  await expect(pdf().getByRole('button', { name: `Open ${title}`, exact: true })).toBeVisible();
  const imported = await documents();
  expect(imported).toHaveLength(1);
  return imported[0];
}

async function renderedPage(number: number) {
  const canvas = pdf().locator(`.pdf-paper canvas[data-page-number="${number}"]`);
  await expect(canvas).toBeVisible();
  await expect(pdf().getByLabel('Page number', { exact: true })).toHaveValue(String(number));
  await expect(pdf().locator('.pdf-paper')).toHaveAttribute('aria-busy', 'false');
  // A visible but blank canvas cannot satisfy the offline rendering check.
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

async function append(text: string) {
  await editor().focus();
  await editor().press('ControlOrMeta+End');
  await page.keyboard.insertText(text);
  await expect(page.locator('.statusbar')).toContainText('1 unsaved note');
}

function identity(document: PDFDocument) {
  const { lastPage: _page, pageCount: _count, lastOpenedAt: _opened, updatedAt: _updated, ...metadata } = document;
  return metadata;
}

test.beforeEach(async () => {
  temporary = await mkdtemp(path.join(os.tmpdir(), 'prism-pdf-reading-workflow-'));
  notebook = path.join(temporary, 'Notebook');
  userData = path.join(temporary, 'notes-profile');
  pdfProfile = path.join(temporary, 'pdf-profile');
  source = path.join(temporary, `${title}.pdf`);
  rendererErrors = []; remoteRequests = [];
  await Promise.all([mkdir(notebook), mkdir(userData)]);
  await writeFile(noteFile(), original);
  await writeFile(source, fixturePdf());
});

test.afterEach(async ({}, testInfo) => {
  if (page && !page.isClosed() && testInfo.status !== testInfo.expectedStatus) {
    const screenshot = await page.screenshot().catch(() => undefined);
    if (screenshot) await testInfo.attach('Combined reading workflow at failure', { body: screenshot, contentType: 'image/png' });
  }
  await stop();
  if (temporary) await rm(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

test('reads, writes and links offline, then resumes the stored reading position independently of the linked page after restart', async ({}, testInfo) => {
  await launch();
  await enterSplit();
  const imported = await importPDF();
  await pdf().getByRole('button', { name: `Favorite ${title}`, exact: true }).click();
  await pdf().getByRole('button', { name: `Details for ${title}`, exact: true }).click();
  await pdf().getByLabel('Tags (comma-separated)', { exact: true }).fill('読書, Research');
  await pdf().getByRole('button', { name: 'Save changes', exact: true }).click();
  await expect(pdf().getByRole('dialog')).toHaveCount(0);
  const metadata = identity((await documents())[0]);
  expect(metadata).toMatchObject({ id: imported.id, tags: ['読書', 'Research'], favorite: true });

  await pdf().getByRole('button', { name: `Open ${title}`, exact: true }).click();
  await renderedPage(1);
  // PDF.js wraps its local module in a blob worker for file:// origins.
  await expect.poll(() => page.workers().some(worker => /^(?:file:|blob:)/.test(worker.url()))).toBe(true);
  await append('最初のページから得た考え: ');
  const reference = `[${title} — p. 1](prism-pdf://v1/documents/${imported.id}?page=1)`;
  await pdf().getByRole('button', { name: 'Insert page link', exact: true }).click();
  await expect(editor()).toBeFocused();
  await expect(editor()).toContainText(reference);
  const expected = original + '最初のページから得た考え: ' + reference;

  await viewport().focus();
  await page.keyboard.press('PageDown');
  await renderedPage(2);
  await page.keyboard.press('ControlOrMeta+s');
  await page.keyboard.press('ControlOrMeta+3');
  await expect(mode('Source')).toHaveAttribute('aria-pressed', 'true');
  expect(await readFile(noteFile(), 'utf8')).toBe(original);
  await expect(page.locator('.statusbar')).toContainText('1 unsaved note');
  await page.keyboard.press('ControlOrMeta+k');
  await expect(pdf().getByLabel('Search library', { exact: true })).toBeFocused();

  await editor().focus();
  await page.keyboard.press('ControlOrMeta+s');
  await expect.poll(() => readFile(noteFile(), 'utf8')).toBe(expected);
  await expect(page.locator('.statusbar')).toContainText('All changes saved');
  await expect.poll(async () => (await documents())[0].lastPage).toBe(2);
  await testInfo.attach('Offline notes and linked PDF', {
    body: await page.screenshot({ path: testInfo.outputPath('offline-read-and-write.png') }), contentType: 'image/png',
  });
  await quitSaved();

  // The saved link intentionally points to page 1, while ordinary library open
  // must resume page 2. Neither document title nor note text supplies the resume.
  expect((await documents())[0].lastPage).toBe(2);
  await launch();
  await expect(editor()).toContainText(reference);
  await workspaceButton('PDFs').click();
  await expect(pdf().getByRole('button', { name: `Unfavorite ${title}`, exact: true })).toBeVisible();
  await pdf().getByRole('button', { name: `Open ${title}`, exact: true }).click();
  await renderedPage(2);
  await enterSplit();
  await mode('Read').click();
  const link = page.locator('.preview-pane').getByRole('link', { name: `${title} — p. 1`, exact: true });
  await link.focus();
  await page.keyboard.press('Enter');
  await renderedPage(1);
  await expect(page.locator('.workspace-area')).toHaveAttribute('data-layout', 'split');
  await expect.poll(async () => (await documents())[0].lastPage).toBe(1);
  expect(identity((await documents())[0])).toEqual(metadata);
  expect(await readFile(noteFile(), 'utf8')).toBe(expected);
  const sourceBytes = await readFile(source);
  expect(await readFile(managedFile(imported.id))).toEqual(sourceBytes);
  expect(createHash('sha256').update(sourceBytes).digest('hex')).toBe(imported.sha256);
  expect(sourceBytes).toEqual(fixturePdf());
  expect(rendererErrors).toEqual([]);
  expect(remoteRequests).toEqual([]);
});

test('retains a linked draft, selection and reader through native window changes in the combined layout', async () => {
  // WSLg does not report the X11 hidden state; its host controls have separate
  // opt-in checks. The regular Linux journey runs under Xvfb/Openbox on WSL.
  test.skip(process.platform === 'linux' && Boolean(process.env.WSL_INTEROP)
    && /^(?:unix)?:0(?:\.0)?$/.test(process.env.DISPLAY ?? ''),
  'WSLg requires host-window checks; run this journey under Xvfb with a window manager.');
  await launch();
  await enterSplit();
  const imported = await importPDF();
  await pdf().getByRole('button', { name: `Open ${title}`, exact: true }).click();
  await renderedPage(1);
  await append('読み進める前の参照: ');
  await pdf().getByRole('button', { name: 'Insert page link', exact: true }).click();
  const reference = `[${title} — p. 1](prism-pdf://v1/documents/${imported.id}?page=1)`;
  const tail = 'ウィンドウを操作しても、この下書きを保つ。';
  await append('\n' + tail);
  await editor().press('Shift+Home');
  expect(await page.evaluate(() => window.getSelection()?.toString())).toBe(tail);
  const originalEditor = await editor().elementHandle();
  const originalReader = await pdf().locator('.pdf-reader').elementHandle();
  await viewport().focus();
  await page.keyboard.press('PageDown');
  await renderedPage(2);
  await pdf().getByLabel('Page zoom', { exact: true }).selectOption('1.5');
  await renderedPage(2);

  const nativeState = () => desktop!.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0];
    return { minimized: window.isMinimized(), maximized: window.isMaximized(), fullscreen: window.isFullScreen(), bounds: window.getBounds() };
  });
  await expect.poll(() => desktop!.evaluate(({ BrowserWindow, screen }) => {
    const window = BrowserWindow.getAllWindows()[0];
    const bounds = window.getBounds();
    const workArea = screen.getDisplayMatching(bounds).workArea;
    return window.isVisible() && bounds.x >= workArea.x && bounds.y >= workArea.y;
  })).toBe(true);
  const nativeBefore = await nativeState();
  await page.getByRole('button', { name: 'Minimize window', exact: true }).click();
  await expect.poll(async () => (await nativeState()).minimized).toBe(true);
  await desktop!.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0];
    window.restore(); window.show(); window.focus();
  });
  await expect.poll(async () => (await nativeState()).minimized).toBe(false);
  await page.getByRole('button', { name: 'Maximize window', exact: true }).click();
  await expect.poll(async () => (await nativeState()).maximized).toBe(true);
  expect((await nativeState()).fullscreen).toBe(false);
  await expect(page.locator('.workspace-area')).toHaveAttribute('data-layout', 'split');
  await renderedPage(2);
  await page.getByRole('button', { name: 'Restore window', exact: true }).click();
  await expect.poll(async () => (await nativeState()).bounds).toEqual(nativeBefore.bounds);
  await expect.poll(async () => (await nativeState()).maximized).toBe(false);
  await renderedPage(2);
  await expect(pdf().getByLabel('Page zoom', { exact: true })).toHaveValue('1.5');
  expect(await pdf().locator('.pdf-reader').evaluate((element, originalElement) => element === originalElement, originalReader)).toBe(true);
  expect(await editor().evaluate((element, originalElement) => element === originalElement, originalEditor)).toBe(true);

  await workspaceButton('Notes').focus();
  await page.keyboard.press('Space');
  await editor().focus();
  await expect.poll(() => page.evaluate(() => window.getSelection()?.toString())).toBe(tail);
  await editor().press('ControlOrMeta+z');
  await expect(editor()).not.toContainText(tail);
  await expect(editor()).toContainText(reference);
  await editor().press(redoKey);
  await expect(editor()).toContainText(tail);
  expect(await readFile(noteFile(), 'utf8')).toBe(original);
  await editor().press('ControlOrMeta+s');
  await expect.poll(() => readFile(noteFile(), 'utf8')).toBe(original + '読み進める前の参照: ' + reference + '\r\n' + tail);
  await renderedPage(2);
  expect(rendererErrors).toEqual([]);
  expect(remoteRequests).toEqual([]);
});
