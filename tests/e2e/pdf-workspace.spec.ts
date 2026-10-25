import { electronLaunchArguments } from '../../scripts/electron-launch.mjs';
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import assert from 'node:assert/strict';
import { fixturePdf } from '../fixtures/pdf';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const welcome = '# Working note\n\nA note alongside a PDF.\n';
let temporary: string;
let notebook: string;
let userData: string;
let pdfProfile: string;
let desktop: ElectronApplication | undefined;
let page: Page;
let pageErrors: string[];
let remoteRequests: string[];
const noteFile = () => path.join(notebook, 'Welcome to Prism.md');
const catalogFile = () => path.join(pdfProfile, 'library', 'catalog.json');
const lockFile = () => path.join(pdfProfile, 'library', '.prism-library-lock.sqlite');
const editor = () => page.getByLabel('Markdown source', { exact: true });
const workspaceButton = (name: 'Notes' | 'PDFs') => page.getByRole('navigation', { name: 'Workspaces', exact: true }).getByRole('button', { name, exact: true });
const pdfWorkspace = () => page.locator('.pdf-workspace');

async function launch() {
  desktop = await electron.launch({
    args: electronLaunchArguments(['--no-sandbox', '.']), cwd: process.cwd(),
    env: { ...process.env, PRISM_USER_DATA: userData, PRISM_WORKSPACE: notebook, PRISM_PDF_USER_DATA: pdfProfile },
  });
  page = await desktop.firstWindow();
  page.on('pageerror', error => pageErrors.push(error.message));
  page.on('request', request => { if (/^https?:/.test(request.url())) remoteRequests.push(request.url()); });
  await expect(page.locator('.note-heading h1')).toHaveText('Working note');
  await expect.poll(() => desktop!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible())).toBe(true);
  await page.getByRole('group', { name: 'Editor mode', exact: true }).getByRole('button', { name: 'Source', exact: true }).click();
}

async function cleanupApp() {
  if (!desktop) return;
  const child = desktop.process();
  const closed = desktop.waitForEvent('close', { timeout: 5_000 }).catch(() => undefined);
  await desktop.evaluate(({ app }) => app.exit(0)).catch(() => undefined);
  await closed;
  if (child.exitCode === null) child.kill();
  desktop = undefined;
}

async function addDraft(value = 'Draft survives PDF switching.') {
  await editor().focus();
  await editor().press('ControlOrMeta+End');
  await page.keyboard.insertText(value);
  await expect(page.locator('.statusbar')).toContainText('1 unsaved note');
  return value;
}

async function visitPDFs() {
  await workspaceButton('PDFs').click();
  await expect(pdfWorkspace()).toBeVisible();
}

async function importPDF(name: string, password?: string) {
  const filename = path.join(temporary, name + '.pdf');
  await writeFile(filename, fixturePdf(password));
  await desktop!.evaluate(({ dialog }, filename) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [filename] });
  }, filename);
  await pdfWorkspace().getByRole('button', { name: 'Import PDFs', exact: true }).click();
  await expect(pdfWorkspace().getByRole('button', { name: `Open ${name}`, exact: true })).toBeVisible();
}

async function renderedPage(number: number) {
  const canvas = pdfWorkspace().locator(`.pdf-paper canvas[data-page-number="${number}"]`);
  await expect(canvas).toBeVisible();
  // Verify PDF.js has actually painted the fixture's colored page artwork.
  await expect.poll(() => canvas.evaluate((element: HTMLCanvasElement) => {
    const pixels = element.getContext('2d')!.getImageData(0, 0, element.width, element.height).data;
    let colored = 0;
    for (let offset = 0; offset < pixels.length; offset += 16) {
      if (Math.max(pixels[offset], pixels[offset + 1], pixels[offset + 2]) - Math.min(pixels[offset], pixels[offset + 1], pixels[offset + 2]) > 40) colored++;
    }
    return colored;
  })).toBeGreaterThan(100);
  return canvas;
}

function expectLibraryOwned() {
  const contender = new DatabaseSync(lockFile());
  try {
    assert.throws(() => contender.exec('BEGIN EXCLUSIVE'), (error: unknown) => [5, 6].includes((error as { errcode: number }).errcode));
  } finally { contender.close(); }
}

async function requestNativeQuit() {
  await desktop!.evaluate(({ app }) => { setTimeout(() => app.quit(), 0); });
  return page.getByRole('dialog', { name: 'Keep your latest thoughts?', exact: true });
}

async function completeQuit(action: 'Save & continue' | 'Discard changes') {
  const closed = desktop!.waitForEvent('close');
  const [clicked, stopped] = await Promise.allSettled([
    page.getByRole('dialog', { name: 'Keep your latest thoughts?', exact: true }).getByRole('button', { name: action, exact: true }).click(),
    closed,
  ]);
  if (stopped.status === 'rejected') throw stopped.reason;
  // A successful native quit can destroy the page before Playwright finishes
  // its post-click wait. Only tolerate that specific error after app close.
  if (clicked.status === 'rejected' && !(clicked.reason instanceof Error
    && /Target page, context or browser has been closed/.test(clicked.reason.message))) throw clicked.reason;
  expect(page.isClosed()).toBe(true);
  desktop = undefined;
}

test.beforeEach(async () => {
  temporary = await mkdtemp(path.join(os.tmpdir(), 'prism-pdf-workspace-'));
  notebook = path.join(temporary, 'Notebook');
  userData = path.join(temporary, 'notes-profile');
  pdfProfile = path.join(temporary, 'pdf-profile');
  pageErrors = [];
  remoteRequests = [];
  await Promise.all([mkdir(notebook), mkdir(userData)]);
  await writeFile(noteFile(), welcome);
  await launch();
});

test.afterEach(async ({}, testInfo) => {
  if (page && !page.isClosed() && testInfo.status !== testInfo.expectedStatus) {
    const screenshot = await page.screenshot().catch(() => undefined);
    if (screenshot) await testInfo.attach('Integrated PDF workspace at failure', { body: screenshot, contentType: 'image/png' });
  }
  await cleanupApp();
  if (temporary) await rm(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

test('switches between a real PDF and the same unsaved editor, retaining selection, undo, filters and scoped shortcuts', async ({}, testInfo) => {
  await expect(stat(pdfProfile)).rejects.toMatchObject({ code: 'ENOENT' });
  const draft = await addDraft();
  await editor().press('Shift+Home');
  expect(await page.evaluate(() => window.getSelection()?.toString())).toBe(draft);
  const originalEditor = await editor().elementHandle();
  const source = path.join(temporary, '日本語の資料.pdf');
  const bytes = fixturePdf();
  await writeFile(source, bytes);
  const pickerCalls = await desktop!.evaluateHandle(({ dialog }, source) => {
    const calls: string[] = [];
    dialog.showOpenDialog = async (...args: unknown[]) => {
      const options = args[args.length - 1] as { title?: string; properties?: string[] };
      calls.push(options.title ?? '');
      const notebookPicker = options.properties?.includes('openDirectory') ?? false;
      return { canceled: notebookPicker, filePaths: notebookPicker ? [] : [source] };
    };
    return calls;
  }, source);

  await visitPDFs();
  await expect(pdfWorkspace().getByRole('heading', { name: 'A home for your PDFs.', exact: true })).toBeVisible();
  await page.keyboard.press('ControlOrMeta+o');
  await expect(pdfWorkspace().getByRole('button', { name: 'Open 日本語の資料', exact: true })).toBeVisible();
  expect(await pickerCalls.jsonValue()).toEqual(['Add PDFs to your library']);
  await page.keyboard.press('ControlOrMeta+s');
  await page.keyboard.press('ControlOrMeta+3');
  expect(await readFile(noteFile(), 'utf8')).toBe(welcome);
  await pdfWorkspace().getByRole('button', { name: 'Favorite 日本語の資料', exact: true }).click();
  await pdfWorkspace().getByRole('button', { name: 'Favorites', exact: true }).click();
  const libraryScreenshot = testInfo.outputPath('integrated-pdf-library.png');
  await page.screenshot({ path: libraryScreenshot });
  await testInfo.attach('PDF library inside Prism', { path: libraryScreenshot, contentType: 'image/png' });
  await pdfWorkspace().getByRole('button', { name: 'Open 日本語の資料', exact: true }).click();
  await renderedPage(1);
  await pdfWorkspace().getByRole('button', { name: 'Next page', exact: true }).click();
  await renderedPage(2);
  const readerScreenshot = testInfo.outputPath('integrated-pdf-reader.png');
  await page.screenshot({ path: readerScreenshot });
  await testInfo.attach('PDF reader inside Prism', { path: readerScreenshot, contentType: 'image/png' });

  await workspaceButton('Notes').click();
  await expect(editor()).toBeVisible();
  expect(await editor().evaluate((element, original) => element === original, originalEditor)).toBe(true);
  await expect(page.getByRole('button', { name: 'Source', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(editor()).toContainText(draft);
  await editor().focus();
  expect(await page.evaluate(() => window.getSelection()?.toString())).toBe(draft);
  await editor().press('ControlOrMeta+z');
  await expect(editor()).not.toContainText(draft);
  await expect(page.locator('.statusbar')).toContainText('All changes saved');
  await page.keyboard.press('ControlOrMeta+o');
  await expect.poll(() => pickerCalls.jsonValue()).toEqual(['Add PDFs to your library', 'Open a notebook']);
  await expect(page.getByRole('dialog')).toHaveCount(0);

  await visitPDFs();
  await renderedPage(2);
  await expect(pdfWorkspace().getByLabel('Page number', { exact: true })).toHaveValue('2');
  await pdfWorkspace().getByRole('button', { name: 'Back to library', exact: true }).click();
  await expect(pdfWorkspace().getByRole('heading', { name: 'Favorites', exact: true })).toBeVisible();
  expect(await readFile(source)).toEqual(bytes);
  expect(JSON.parse(await readFile(catalogFile(), 'utf8')).documents[0]).toMatchObject({ lastPage: 2, favorite: true });
  expect(pageErrors).toEqual([]);
  expect(remoteRequests).toEqual([]);
});

test('keeps dirty-close cancellation, saving and discard active while PDFs are visible', async () => {
  const draft = await addDraft('Saved from the PDF workspace.');
  await visitPDFs();
  await expect(pdfWorkspace().getByRole('heading', { name: 'A home for your PDFs.', exact: true })).toBeVisible();
  let prompt = await requestNativeQuit();
  await expect(prompt).toBeVisible();
  await prompt.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(prompt).toHaveCount(0);
  expectLibraryOwned();
  await expect(pdfWorkspace()).toBeVisible();
  expect(await readFile(noteFile(), 'utf8')).toBe(welcome);
  expect(await page.evaluate(() => window.prismPdf.loadLibrary())).toMatchObject({ documents: [] });

  prompt = await requestNativeQuit();
  await expect(prompt).toBeVisible();
  await completeQuit('Save & continue');
  expect(await readFile(noteFile(), 'utf8')).toBe(welcome + draft);
  const nextOwner = new DatabaseSync(lockFile());
  nextOwner.exec('BEGIN EXCLUSIVE');
  nextOwner.close();

  await launch();
  await addDraft('Discard this later draft.');
  await visitPDFs();
  await expect(pdfWorkspace().getByRole('heading', { name: 'A home for your PDFs.', exact: true })).toBeVisible();
  prompt = await requestNativeQuit();
  await expect(prompt).toBeVisible();
  await completeQuit('Discard changes');
  expect(await readFile(noteFile(), 'utf8')).toBe(welcome + draft);
  expect(pageErrors).toEqual([]);
});

test('defers library ownership until PDFs is visited and retries conflicts and corrupt catalogs without losing a note', async () => {
  await expect(stat(pdfProfile)).rejects.toMatchObject({ code: 'ENOENT' });
  await mkdir(path.join(pdfProfile, 'library'), { recursive: true });
  let owner: DatabaseSync | undefined = new DatabaseSync(lockFile());
  owner.exec('BEGIN EXCLUSIVE');
  try {
    const draft = await addDraft();
    await visitPDFs();
    await expect(pdfWorkspace().getByRole('alert')).toContainText('already open in another Prism window');
    await workspaceButton('Notes').click();
    await expect(editor()).toContainText(draft);
    await editor().focus();
    await editor().press('ControlOrMeta+z');
    await expect(page.locator('.statusbar')).toContainText('All changes saved');
    owner.close();
    owner = undefined;

    const damaged = '{ preserve this damaged catalog';
    await writeFile(catalogFile(), damaged);
    await visitPDFs();
    await pdfWorkspace().getByRole('button', { name: 'Try again', exact: true }).click();
    await expect(pdfWorkspace().getByRole('alert')).toContainText('catalog is damaged or unsupported');
    expect(await readFile(catalogFile(), 'utf8')).toBe(damaged);
    owner = new DatabaseSync(lockFile());
    owner.exec('BEGIN EXCLUSIVE');
    owner.close();
    owner = undefined;
    const repaired = JSON.stringify({ version: 1, documents: [] }) + '\n';
    await writeFile(catalogFile(), repaired);
    await pdfWorkspace().getByRole('button', { name: 'Try again', exact: true }).click();
    await expect(pdfWorkspace().getByRole('heading', { name: 'A home for your PDFs.', exact: true })).toBeVisible();
    expectLibraryOwned();
    const closed = desktop!.waitForEvent('close');
    await page.getByRole('button', { name: 'Close window', exact: true }).click();
    await closed;
    desktop = undefined;
    owner = new DatabaseSync(lockFile());
    owner.exec('BEGIN EXCLUSIVE');
    expect(await readFile(catalogFile(), 'utf8')).toBe(repaired);
    expect(await readFile(noteFile(), 'utf8')).toBe(welcome);
  } finally { owner?.close(); }
  expect(pageErrors).toEqual([]);
});

test('retains an unlocked reader across switches and inherits Prism appearance while PDF pages stay opaque', async () => {
  await visitPDFs();
  await importPDF('Protected', 'read-secret');
  await pdfWorkspace().getByRole('button', { name: 'Open Protected', exact: true }).click();
  await pdfWorkspace().getByLabel('Document password', { exact: true }).fill('read-secret');
  await pdfWorkspace().getByRole('button', { name: 'Unlock PDF', exact: true }).click();
  await renderedPage(1);
  await pdfWorkspace().getByRole('button', { name: 'Next page', exact: true }).click();
  await renderedPage(2);
  const originalHeadingSize = await pdfWorkspace().locator('.pdf-reader-document h1').evaluate(element => parseFloat(getComputedStyle(element).fontSize));

  await workspaceButton('Notes').click();
  await page.getByRole('button', { name: 'Window appearance', exact: true }).click();
  const appearance = page.getByRole('dialog', { name: 'Make a little space', exact: true });
  await appearance.getByRole('radio', { name: 'Sci-fi theme', exact: true }).check();
  await appearance.getByRole('slider', { name: 'Text size', exact: true }).focus();
  await page.keyboard.press('End');
  await appearance.getByRole('switch', { name: 'Transparent window', exact: true }).click();
  const opacity = appearance.getByRole('slider', { name: 'Background opacity', exact: true });
  await opacity.focus();
  await opacity.press('Home');
  for (let index = 0; index < 10; index++) await opacity.press('ArrowRight');
  await appearance.getByRole('button', { name: 'Done', exact: true }).click();
  await visitPDFs();
  await renderedPage(2);
  await expect(pdfWorkspace().getByLabel('Document password', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Minimize window', exact: true })).toHaveCount(1);
  await expect(pdfWorkspace()).toHaveCSS('color', 'rgb(217, 231, 245)');
  await expect.poll(() => pdfWorkspace().locator('.pdf-reader-document h1').evaluate(element => parseFloat(getComputedStyle(element).fontSize))).toBeGreaterThan(originalHeadingSize);
  const paper = await pdfWorkspace().locator('.pdf-paper').boundingBox();
  const background = await pdfWorkspace().locator('.pdf-reader-heading').boundingBox();
  if (!paper || !background) throw new Error('The PDF reader is not visible.');
  const alpha = (x: number, y: number) => desktop!.evaluate(async ({ BrowserWindow }, point) => {
    const capture = await BrowserWindow.getAllWindows()[0].webContents.capturePage({ ...point, width: 1, height: 1 });
    return capture.toBitmap({ scaleFactor: 1 })[3];
  }, { x: Math.round(x), y: Math.round(y) });
  await expect.poll(() => alpha(background.x + 4, background.y + 4)).toBeGreaterThan(80);
  await expect.poll(() => alpha(background.x + 4, background.y + 4)).toBeLessThan(100);
  expect(await alpha(paper.x + 20, paper.y + 20)).toBe(255);
  expect(await readFile(catalogFile(), 'utf8')).not.toContain('read-secret');
  expect(await page.evaluate(() => JSON.stringify(localStorage))).not.toContain('read-secret');
  expect(pageErrors).toEqual([]);
  expect(remoteRequests).toEqual([]);
});

test('keeps keyboard navigation, native minimize/maximize/restore and a draft usable in both workspaces', async () => {
  // WSLg's Xwayland window manager does not report the X11 hidden state.
  // Its Windows host controls are covered by the opt-in host-window suite;
  // run this generic native-state journey under Xvfb/Openbox on WSL instead.
  test.skip(process.platform === 'linux' && Boolean(process.env.WSL_INTEROP)
    && /^(?:unix)?:0(?:\.0)?$/.test(process.env.DISPLAY ?? ''),
  'WSLg requires host-window checks; run this journey under Xvfb with a window manager.');
  const draft = await addDraft('Still editable after native window changes.');
  await workspaceButton('PDFs').focus();
  await page.keyboard.press('Enter');
  await expect(pdfWorkspace()).toBeVisible();
  await importPDF('Window controls');
  await pdfWorkspace().getByRole('button', { name: 'Open Window controls', exact: true }).focus();
  await page.keyboard.press('Enter');
  await renderedPage(1);
  const viewport = pdfWorkspace().getByLabel('PDF page viewport', { exact: true });
  await viewport.focus();
  await page.keyboard.press('PageDown');
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
  const original = await nativeState();
  for (const workspace of ['PDFs', 'Notes'] as const) {
    await workspaceButton(workspace).focus();
    await page.keyboard.press('Space');
    await expect(workspaceButton(workspace)).toHaveAttribute('aria-pressed', 'true');
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
    await page.getByRole('button', { name: 'Restore window', exact: true }).click();
    await expect.poll(async () => (await nativeState()).maximized).toBe(false);
    await expect.poll(async () => (await nativeState()).bounds).toEqual(original.bounds);
  }
  await expect(editor()).toContainText(draft);
  await editor().focus();
  await editor().press('ControlOrMeta+z');
  await expect(editor()).not.toContainText(draft);
  await expect(page.locator('.statusbar')).toContainText('All changes saved');
  await workspaceButton('PDFs').focus();
  await page.keyboard.press('Enter');
  await renderedPage(2);
  expect(await readFile(noteFile(), 'utf8')).toBe(welcome);
  expect(pageErrors).toEqual([]);
});
