import { electronLaunchArguments } from '../../scripts/electron-launch.mjs';
import { _electron as electron, expect, test, type ElectronApplication, type Locator, type Page } from '@playwright/test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fixturePdf } from '../fixtures/pdf';

const welcome = '\ufeff# 読書ノート\r\n\r\n資料を読みながら、気づきを書き留める。\r\n';
const title = '読み方を調整する資料';
let temporary: string;
let notebook: string;
let userData: string;
let pdfProfile: string;
let desktop: ElectronApplication | undefined;
let page: Page;
let errors: string[];

const pdf = () => page.locator('.pdf-workspace');
const reader = () => pdf().locator('.pdf-reader');
const viewport = () => pdf().getByLabel('PDF page viewport', { exact: true });
const canvas = () => pdf().locator('.pdf-paper canvas');
const editor = () => page.locator('.app-body .cm-content');
const sidebar = () => pdf().locator('#pdf-library-navigation');
const separator = () => pdf().getByRole('separator', { name: 'Resize PDF library sidebar', exact: true });
const navigation = () => pdf().getByRole('button', { name: 'Library navigation', exact: true });
const layoutButton = () => pdf().getByRole('button', { name: 'PDF layout', exact: true });
const layoutDialog = () => page.getByRole('dialog', { name: 'Reading layout', exact: true });
const workspaceButton = (name: 'Notes' | 'PDFs') => page.getByRole('navigation', { name: 'Workspaces', exact: true }).getByRole('button', { name, exact: true });
const noteFile = () => path.join(notebook, 'Welcome to Prism.md');
const savedLayout = () => page.evaluate(() => JSON.parse(localStorage.getItem('prism-pdf-layout') || 'null'));

async function launch() {
  const applicationRoot = path.resolve(process.env.PRISM_TEST_APP_ROOT || process.cwd());
  desktop = await electron.launch({
    executablePath: process.env.PRISM_TEST_ELECTRON,
    args: electronLaunchArguments(['--no-sandbox', applicationRoot]), cwd: applicationRoot,
    env: { ...process.env, PRISM_USER_DATA: userData, PRISM_WORKSPACE: notebook, PRISM_PDF_USER_DATA: pdfProfile },
  });
  page = await desktop.firstWindow();
  page.on('pageerror', error => errors.push(error.message));
  await expect(page.locator('.note-heading h1')).toHaveText('読書ノート');
  await expect.poll(() => desktop!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible())).toBe(true);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.getByRole('group', { name: 'Editor mode', exact: true }).getByRole('button', { name: 'Source', exact: true }).click();
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

async function importPDF(password?: string) {
  const filename = path.join(temporary, `${title}.pdf`);
  await writeFile(filename, fixturePdf(password));
  await desktop!.evaluate(({ dialog }, filename) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [filename] });
  }, filename);
  await workspaceButton('PDFs').click();
  await pdf().getByRole('button', { name: 'Import PDFs', exact: true }).click();
  await expect(pdf().getByRole('button', { name: `Open ${title}`, exact: true })).toBeVisible();
}

async function openPDF(password?: string) {
  await pdf().getByRole('button', { name: `Open ${title}`, exact: true }).click();
  if (password) {
    await pdf().getByLabel('Document password', { exact: true }).fill(password);
    await pdf().getByRole('button', { name: 'Unlock PDF', exact: true }).click();
  }
  await renderedPage(1);
}

async function renderedPage(number: number) {
  await expect(canvas()).toBeVisible();
  await expect(canvas()).toHaveAttribute('data-page-number', String(number));
  await expect(pdf().locator('.pdf-paper')).toHaveAttribute('aria-busy', 'false');
  // Check the fixture's colored page, so a connected but blank canvas cannot pass.
  await expect.poll(() => canvas().evaluate((element: HTMLCanvasElement) => {
    if (!element.width || !element.height) return 0;
    const pixels = element.getContext('2d')!.getImageData(0, 0, element.width, element.height).data;
    let colored = 0;
    for (let offset = 0; offset < pixels.length; offset += 16) {
      if (Math.max(pixels[offset], pixels[offset + 1], pixels[offset + 2]) - Math.min(pixels[offset], pixels[offset + 1], pixels[offset + 2]) > 40) colored++;
    }
    return colored;
  })).toBeGreaterThan(100);
}

async function openLayout() {
  await layoutButton().click();
  await expect(layoutDialog()).toBeVisible();
}

async function doneLayout() {
  await layoutDialog().getByRole('button', { name: 'Done', exact: true }).click();
  await expect(layoutDialog()).toBeHidden();
}

async function width() { return (await sidebar().boundingBox())!.width; }
async function height() { return (await viewport().boundingBox())!.height; }

async function dragSidebar(delta: number, release = true) {
  const box = await separator().boundingBox();
  if (!box) throw new Error('The library sidebar resize handle is not visible.');
  await page.mouse.move(box.x + box.width / 2, box.y + 120);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + delta, box.y + 120, { steps: 8 });
  if (release) await page.mouse.up();
}

async function expectInside(control: Locator, panel: Locator) {
  await expect(control).toBeVisible();
  const box = await control.boundingBox();
  const bounds = await panel.boundingBox();
  if (!box || !bounds) throw new Error('A layout control or its containing pane is not visible.');
  expect(box.x).toBeGreaterThanOrEqual(bounds.x);
  expect(box.x + box.width).toBeLessThanOrEqual(bounds.x + bounds.width + 1);
  expect(box.y).toBeGreaterThanOrEqual(bounds.y);
  expect(box.y + box.height).toBeLessThanOrEqual(bounds.y + bounds.height + 1);
}

test.beforeEach(async () => {
  temporary = await mkdtemp(path.join(os.tmpdir(), 'prism-pdf-layout-'));
  notebook = path.join(temporary, 'Notebook');
  userData = path.join(temporary, 'notes-profile');
  pdfProfile = path.join(temporary, 'pdf-profile');
  errors = [];
  await Promise.all([mkdir(notebook), mkdir(userData)]);
  await writeFile(noteFile(), welcome);
  await launch();
});

test.afterEach(async ({}, testInfo) => {
  if (page && !page.isClosed() && testInfo.status !== testInfo.expectedStatus) {
    const screenshot = await page.screenshot().catch(() => undefined);
    if (screenshot) await testInfo.attach('PDF layout at failure', { body: screenshot, contentType: 'image/png' });
  }
  await stop();
  if (temporary) await rm(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

test('reclaims reader height section by section without repainting or losing the reading position', async () => {
  await importPDF();
  await openPDF();
  await pdf().getByRole('button', { name: 'Next page', exact: true }).click();
  await pdf().getByLabel('Page zoom', { exact: true }).selectOption('2');
  await renderedPage(2);
  await viewport().evaluate(element => element.scrollTo(0, 180));
  await expect.poll(() => viewport().evaluate(element => element.scrollTop)).toBe(180);
  const originalReader = await reader().elementHandle();
  const originalCanvas = await canvas().elementHandle();
  const sections = [
    { name: 'Library search', control: pdf().getByLabel('Search library', { exact: true }), reclaimsHeight: false },
    { name: 'Document heading', control: pdf().locator('.pdf-reader-heading'), reclaimsHeight: true },
    { name: 'Linked notes', control: pdf().getByRole('button', { name: 'Linked notes', exact: true }), reclaimsHeight: true },
    { name: 'Bottom page navigation', control: pdf().locator('.pdf-reader-footer'), reclaimsHeight: true },
    { name: 'Page toolbar', control: pdf().locator('.pdf-reader-toolbar'), reclaimsHeight: true },
  ];
  for (const section of sections) {
    await expect(section.control).toBeVisible();
    const previousHeight = await height();
    await openLayout();
    await layoutDialog().getByRole('checkbox', { name: section.name, exact: true }).uncheck();
    await doneLayout();
    await expect(section.control).toBeHidden();
    if (section.reclaimsHeight) await expect.poll(height).toBeGreaterThan(previousHeight + 10);
    else expect(await height()).toBeGreaterThanOrEqual(previousHeight - 1);
    expect(await reader().evaluate((element, original) => element === original, originalReader)).toBe(true);
    expect(await canvas().evaluate((element, original) => element === original, originalCanvas)).toBe(true);
    await expect.poll(() => viewport().evaluate(element => element.scrollTop)).toBe(180);
    await expect(layoutButton()).toBeVisible();
  }

  // With both navigation bars hidden, the persistent layout control recovers
  // page and zoom controls without replacing the loaded document.
  await openLayout();
  await layoutDialog().getByRole('checkbox', { name: 'Page toolbar', exact: true }).check();
  await doneLayout();
  await expect(pdf().getByLabel('Page number', { exact: true })).toHaveValue('2');
  await expect(pdf().getByLabel('Page zoom', { exact: true })).toHaveValue('2');
  await viewport().focus();
  await page.keyboard.press('ControlOrMeta+k');
  await expect(pdf().getByLabel('Search library', { exact: true })).toBeFocused();
  await expect.poll(savedLayout).toMatchObject({ search: true });
  expect(await canvas().evaluate((element, original) => element === original, originalCanvas)).toBe(true);
  expect(errors).toEqual([]);
});

test('persists resized and compact layouts while keeping narrow-screen navigation recoverable', async ({}, testInfo) => {
  await importPDF();
  await openPDF();
  await expect.poll(width).toBeCloseTo(228, 0);
  await separator().focus();
  await separator().press('ArrowRight');
  await expect.poll(width).toBeCloseTo(238, 0);
  await separator().press('Shift+ArrowRight');
  await expect.poll(width).toBeCloseTo(278, 0);
  await separator().press('Shift+ArrowLeft');
  await expect.poll(width).toBeCloseTo(238, 0);
  await separator().press('Home');
  await expect.poll(width).toBeCloseTo(228, 0);
  await dragSidebar(90);
  await expect.poll(width).toBeCloseTo(318, 0);
  await expect.poll(savedLayout).toMatchObject({ sidebarWidth: 318 });
  await dragSidebar(-75, false);
  await expect.poll(width).toBeLessThan(268);
  await page.keyboard.press('Escape');
  await page.mouse.up();
  await expect.poll(width).toBeCloseTo(318, 0);
  await expect.poll(savedLayout).toMatchObject({ sidebarWidth: 318 });
  await navigation().click();
  await expect(sidebar()).toBeHidden();
  await navigation().click();
  await expect.poll(width).toBeCloseTo(318, 0);
  await openLayout();
  await layoutDialog().getByRole('button', { name: 'More reading space', exact: true }).click();
  await doneLayout();
  await expect(sidebar()).toBeHidden();
  await expect(pdf().locator('.pdf-reader-heading')).toBeHidden();
  await expect(pdf().locator('.pdf-reader-toolbar')).toBeVisible();
  await expect.poll(savedLayout).toMatchObject({
    version: 1, sidebarWidth: 318, sidebar: false, search: false, heading: false,
    toolbar: true, backlinks: false, footer: false, compact: true,
  });
  const preferred = await savedLayout();
  await testInfo.attach('More reading space with the layout controls available', {
    body: await page.screenshot({ path: testInfo.outputPath('pdf-layout-compact.png') }), contentType: 'image/png',
  });

  await stop();
  await launch();
  await workspaceButton('PDFs').click();
  await openPDF();
  expect(await savedLayout()).toEqual(preferred);
  await expect(sidebar()).toBeHidden();
  await expect(pdf().getByLabel('Search library', { exact: true })).toBeHidden();
  await expect(pdf().locator('.pdf-reader-heading')).toBeHidden();
  await expect(pdf().locator('.pdf-reader-footer')).toBeHidden();
  await openLayout();
  await expect(layoutDialog().getByRole('checkbox', { name: 'Compact spacing', exact: true })).toBeChecked();
  await doneLayout();
  await navigation().click();
  await expect.poll(width).toBeCloseTo(318, 0);
  await page.setViewportSize({ width: 850, height: 1000 });
  await expect(pdf()).toHaveAttribute('data-compact', 'true');
  await expect(sidebar()).toBeHidden();
  await expect(separator()).toBeHidden();
  await navigation().click();
  await expect(sidebar()).toBeVisible();
  await pdf().getByRole('button', { name: 'Close library navigation', exact: true }).click();
  await expect(sidebar()).toBeHidden();
  await expect.poll(savedLayout).toMatchObject({ sidebar: true, sidebarWidth: 318 });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await expect.poll(width).toBeCloseTo(318, 0);
  await separator().dblclick();
  await expect.poll(width).toBeCloseTo(228, 0);
  await separator().press('ArrowRight');
  await expect.poll(width).toBeCloseTo(238, 0);
  await openLayout();
  await layoutDialog().getByRole('button', { name: 'Reset layout', exact: true }).click();
  await doneLayout();
  await expect.poll(width).toBeCloseTo(228, 0);
  await expect.poll(savedLayout).toMatchObject({
    sidebar: true, sidebarWidth: 228, search: true, heading: true,
    toolbar: true, backlinks: true, footer: true, compact: false,
  });
  expect(errors).toEqual([]);
});

test('recovers all hidden controls at large text beside an unsaved Japanese draft without locking the reader', async ({}, testInfo) => {
  const draft = '追記：画面を調整しても、この日本語の下書きは残る。';
  await editor().focus();
  await editor().press('ControlOrMeta+End');
  await page.keyboard.insertText(draft);
  await expect(page.locator('.statusbar')).toContainText('1 unsaved note');
  const originalEditor = await editor().elementHandle();
  await importPDF('layout-secret');
  await openPDF('layout-secret');
  await pdf().getByRole('button', { name: 'Next page', exact: true }).click();
  await pdf().getByLabel('Page zoom', { exact: true }).selectOption('1.5');
  await renderedPage(2);
  const originalReader = await reader().elementHandle();
  const originalCanvas = await canvas().elementHandle();
  await openLayout();
  for (const name of ['Library sidebar', 'Library search', 'Document heading', 'Page toolbar', 'Linked notes', 'Bottom page navigation']) {
    await layoutDialog().getByRole('checkbox', { name, exact: true }).uncheck();
  }
  await doneLayout();
  await page.getByRole('button', { name: 'Read & write', exact: true }).click();
  await expect(page.locator('.workspace-area')).toHaveAttribute('data-layout', 'split');
  await page.getByRole('button', { name: 'Window appearance', exact: true }).click();
  const appearance = page.getByRole('dialog', { name: 'Make a little space', exact: true });
  await appearance.getByRole('radio', { name: 'Paper theme', exact: true }).check();
  await appearance.getByRole('slider', { name: 'Text size', exact: true }).fill('150');
  await appearance.getByRole('button', { name: 'Done', exact: true }).click();
  const paneSeparator = page.getByRole('separator', { name: 'Resize note and PDF panes', exact: true });
  await paneSeparator.focus();
  for (let count = 0; count < 20; count++) await paneSeparator.press('Shift+ArrowRight');
  await expect.poll(async () => (await page.locator('.pdf-panel').boundingBox())!.width).toBeLessThan(430);
  await expect(pdf()).toHaveAttribute('data-compact', 'true');
  await expectInside(layoutButton(), page.locator('.pdf-panel'));
  await expectInside(navigation(), page.locator('.pdf-panel'));
  for (const section of ['.pdf-reader-heading', '.pdf-reader-toolbar', '.pdf-reader-backlinks', '.pdf-reader-footer', '.search-box']) {
    await expect(pdf().locator(section)).toBeHidden();
  }
  await openLayout();
  await layoutDialog().getByRole('button', { name: 'Reset layout', exact: true }).click();
  await doneLayout();
  for (const control of [pdf().getByLabel('Page zoom', { exact: true }), pdf().getByRole('button', { name: 'Next page', exact: true }), layoutButton()]) {
    await expectInside(control, page.locator('.pdf-panel'));
  }
  await expect(pdf().getByLabel('Page number', { exact: true })).toHaveValue('2');
  await expect(pdf().getByLabel('Page zoom', { exact: true })).toHaveValue('1.5');
  await expect(pdf().getByLabel('Document password', { exact: true })).toHaveCount(0);
  expect(await reader().evaluate((element, original) => element === original, originalReader)).toBe(true);
  expect(await canvas().evaluate((element, original) => element === original, originalCanvas)).toBe(true);
  expect(await editor().evaluate((element, original) => element === original, originalEditor)).toBe(true);
  await expect(editor()).toContainText(draft);
  expect(await readFile(noteFile(), 'utf8')).toBe(welcome);
  await editor().focus();
  await editor().press('ControlOrMeta+z');
  await expect(editor()).not.toContainText(draft);
  await editor().press(process.platform === 'win32' ? 'Control+y' : 'ControlOrMeta+Shift+z');
  await expect(editor()).toContainText(draft);
  await editor().press('ControlOrMeta+s');
  await expect.poll(async () => {
    try { return await readFile(noteFile(), 'utf8'); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }).toBe(welcome + draft);
  await testInfo.attach('Recovered PDF controls beside Japanese notes at 150%', {
    body: await page.screenshot({ path: testInfo.outputPath('pdf-layout-large-text.png') }), contentType: 'image/png',
  });
  expect(errors).toEqual([]);
});
