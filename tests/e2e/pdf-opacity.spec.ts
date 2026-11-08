import { electronLaunchArguments } from '../../scripts/electron-launch.mjs';
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fixturePdf } from '../fixtures/pdf';

test('PDF opacity reveals the desktop independently while retaining the reader, drafts and saved settings', async ({}, testInfo) => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'prism-pdf-opacity-'));
  const notebook = path.join(temporary, 'Notebook');
  const userData = path.join(temporary, 'notes-profile');
  const pdfProfile = path.join(temporary, 'pdf-profile');
  const noteFile = path.join(notebook, 'Welcome to Prism.md');
  const original = '\ufeff# 透明な読書\r\n\r\n資料とメモを一緒に読む。\r\n';
  const draft = '追記：透明度を変えても日本語の下書きを保持する。';
  const source = path.join(temporary, 'Transparent reading.pdf');
  const errors: string[] = [];
  let desktop: ElectronApplication | undefined;
  let page!: Page;
  const pdf = () => page.locator('.pdf-workspace');
  const canvas = () => pdf().locator('.pdf-paper canvas');
  const viewport = () => pdf().getByLabel('PDF page viewport', { exact: true });
  const editor = () => page.locator('.app-body .cm-content');
  const layout = () => page.getByRole('dialog', { name: 'Reading layout', exact: true });
  const slider = () => layout().getByRole('slider', { name: 'PDF page opacity', exact: true });
  const workspace = (name: 'Notes' | 'PDFs') => page.getByRole('navigation', { name: 'Workspaces', exact: true }).getByRole('button', { name, exact: true });

  async function launch() {
    const applicationRoot = path.resolve(process.env.PRISM_TEST_APP_ROOT || process.cwd());
    desktop = await electron.launch({
      executablePath: process.env.PRISM_TEST_ELECTRON,
      args: electronLaunchArguments(['--no-sandbox', applicationRoot]), cwd: applicationRoot,
      env: { ...process.env, PRISM_USER_DATA: userData, PRISM_WORKSPACE: notebook, PRISM_PDF_USER_DATA: pdfProfile },
    });
    page = await desktop.firstWindow();
    page.on('pageerror', error => errors.push(error.message));
    await expect(page.locator('.note-heading h1')).toHaveText('透明な読書');
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.getByRole('group', { name: 'Editor mode', exact: true }).getByRole('button', { name: 'Source', exact: true }).click();
  }
  async function stop() {
    if (!desktop) return;
    const child = desktop.process();
    const closed = desktop.waitForEvent('close', { timeout: 5000 }).catch(() => undefined);
    await desktop.evaluate(({ app }) => app.exit(0)).catch(() => undefined);
    await closed;
    if (child.exitCode === null) child.kill();
    desktop = undefined;
  }
  async function openLayout() {
    await pdf().getByRole('button', { name: 'PDF layout', exact: true }).click();
    await expect(layout()).toBeVisible();
  }
  async function closeLayout() {
    await layout().getByRole('button', { name: 'Done', exact: true }).click();
    await expect(layout()).toBeHidden();
  }
  async function appearance(transparent: boolean, opacity?: number) {
    // The status bar stays reachable even when the layout preset hides the sidebar.
    await page.locator('.statusbar').getByRole('button').click();
    const dialog = page.getByRole('dialog', { name: 'Make a little space', exact: true });
    const toggle = dialog.getByRole('switch', { name: 'Transparent window', exact: true });
    if ((await toggle.getAttribute('aria-checked') === 'true') !== transparent) await toggle.click();
    if (opacity !== undefined) await dialog.getByRole('slider', { name: 'Background opacity', exact: true }).fill(String(opacity));
    await dialog.getByRole('button', { name: 'Done', exact: true }).click();
  }
  async function rendered(number: number) {
    await expect(canvas()).toBeVisible();
    await expect(canvas()).toHaveAttribute('data-page-number', String(number));
    await expect(pdf().locator('.pdf-paper')).toHaveAttribute('aria-busy', 'false');
  }
  async function alpha(x: number, y: number) {
    return desktop!.evaluate(async ({ BrowserWindow }, point) => {
      const image = await BrowserWindow.getAllWindows()[0].webContents.capturePage({ ...point, width: 1, height: 1 });
      return image.toBitmap({ scaleFactor: 1 })[3];
    }, { x: Math.round(x), y: Math.round(y) });
  }
  async function pageAlpha() {
    const paper = await canvas().boundingBox();
    const visible = await viewport().boundingBox();
    if (!paper || !visible) throw new Error('The PDF page is not visible.');
    return alpha(Math.max(paper.x, visible.x) + 20, Math.max(paper.y, visible.y) + 20);
  }
  async function nativeOpacity(translucent: boolean) {
    if (process.platform === 'win32') {
      await expect.poll(() => desktop!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getOpacity())).toBeCloseTo(translucent ? 254 / 255 : 1, 3);
    }
  }

  try {
    await Promise.all([mkdir(notebook), mkdir(userData)]);
    await writeFile(noteFile, original);
    await writeFile(source, fixturePdf('opacity-secret'));
    await launch();
    await editor().focus();
    await editor().press('ControlOrMeta+End');
    await page.keyboard.insertText(draft);
    const originalEditor = await editor().elementHandle();
    await workspace('PDFs').click();
    await desktop!.evaluate(({ dialog }, filename) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [filename] }); }, source);
    await pdf().getByRole('button', { name: 'Import PDFs', exact: true }).click();
    await pdf().getByRole('button', { name: 'Open Transparent reading', exact: true }).click();
    await pdf().getByLabel('Document password', { exact: true }).fill('opacity-secret');
    await pdf().getByRole('button', { name: 'Unlock PDF', exact: true }).click();
    await rendered(1);
    await pdf().getByRole('button', { name: 'Next page', exact: true }).click();
    await pdf().getByLabel('Page zoom', { exact: true }).selectOption('2');
    await expect(canvas()).toHaveCSS('width', '1224px');
    await rendered(2);
    await viewport().evaluate(element => element.scrollTo(0, 180));
    const originalCanvas = await canvas().elementHandle();
    await openLayout();
    await expect(slider()).toHaveValue('100');
    await expect(slider()).toBeDisabled();
    await layout().getByRole('button', { name: 'Open Appearance', exact: true }).click();
    await expect(layout()).toBeHidden();
    const initialAppearance = page.getByRole('dialog', { name: 'Make a little space', exact: true });
    await expect(initialAppearance).toBeVisible();
    await initialAppearance.getByRole('switch', { name: 'Transparent window', exact: true }).click();
    await initialAppearance.getByRole('slider', { name: 'Background opacity', exact: true }).fill('100');
    await initialAppearance.getByRole('button', { name: 'Done', exact: true }).click();
    await openLayout();
    await expect(slider()).toBeEnabled();
    await slider().fill('50');
    await closeLayout();
    await expect(pdf()).toHaveAttribute('data-pdf-page-translucent', 'true');
    await expect.poll(pageAlpha).toBeGreaterThanOrEqual(125);
    await expect.poll(pageAlpha).toBeLessThanOrEqual(130);
    await nativeOpacity(true);
    await openLayout();
    await slider().fill('25');
    await closeLayout();
    await expect.poll(pageAlpha).toBeGreaterThanOrEqual(62);
    await expect.poll(pageAlpha).toBeLessThanOrEqual(66);
    expect(await canvas().evaluate((element, original) => element === original, originalCanvas)).toBe(true);
    await openLayout();
    await slider().fill('50');
    await closeLayout();
    await expect.poll(pageAlpha).toBeGreaterThanOrEqual(125);
    await expect.poll(pageAlpha).toBeLessThanOrEqual(130);
    expect(await pdf().locator('.pdf-reader-toolbar').evaluate(element => getComputedStyle(element).opacity)).toBe('1');
    const heading = await pdf().locator('.pdf-reader-heading').boundingBox();
    if (!heading) throw new Error('PDF heading is unavailable.');
    expect(await alpha(heading.x + 4, heading.y + 4)).toBe(255);
    await appearance(true, 35);
    await expect.poll(pageAlpha).toBeGreaterThanOrEqual(125);
    await expect.poll(pageAlpha).toBeLessThanOrEqual(130);
    await expect.poll(() => alpha(heading.x + 4, heading.y + 4)).toBeGreaterThan(80);
    await expect.poll(() => alpha(heading.x + 4, heading.y + 4)).toBeLessThan(100);
    expect(await canvas().evaluate((element, original) => element === original, originalCanvas)).toBe(true);
    await expect.poll(() => viewport().evaluate(element => element.scrollTop)).toBe(180);

    await appearance(false);
    await expect.poll(pageAlpha).toBe(255);
    await nativeOpacity(false);
    await openLayout();
    await expect(slider()).toHaveValue('50');
    await expect(slider()).toBeDisabled();
    await closeLayout();
    await appearance(true, 100);
    await nativeOpacity(true);
    await expect.poll(pageAlpha).toBeGreaterThanOrEqual(125);
    await expect.poll(pageAlpha).toBeLessThanOrEqual(130);
    await workspace('Notes').click();
    await nativeOpacity(false);
    await expect(editor()).toContainText(draft);
    await page.getByRole('button', { name: 'Read & write', exact: true }).click();
    await expect(page.locator('.workspace-area')).toHaveAttribute('data-layout', 'split');
    await editor().focus();
    await nativeOpacity(true);
    // Compact notices have outer margins; those still belong to app chrome,
    // not the independently translucent reading surface.
    const noticeSurface = await pdf().locator('.workspace > .pdf-workspace-notices').boundingBox();
    if (!noticeSurface || noticeSurface.height < 10) throw new Error('The import notice is unavailable.');
    expect(await alpha(noticeSurface.x + 2, noticeSurface.y + 6)).toBe(255);
    expect(await editor().evaluate((element, original) => element === original, originalEditor)).toBe(true);
    expect(await canvas().evaluate((element, original) => element === original, originalCanvas)).toBe(true);
    await expect(pdf().getByLabel('Document password', { exact: true })).toHaveCount(0);
    expect(await readFile(noteFile, 'utf8')).toBe(original);
    await editor().press('ControlOrMeta+z');
    await expect(editor()).not.toContainText(draft);
    await editor().press(process.platform === 'win32' ? 'Control+y' : 'ControlOrMeta+Shift+z');
    await expect(editor()).toContainText(draft);
    await editor().press('ControlOrMeta+s');
    await expect(page.locator('.statusbar')).toContainText('All changes saved');
    expect(await readFile(noteFile, 'utf8')).toBe(original + draft);
    await openLayout();
    await layout().getByRole('button', { name: 'More reading space', exact: true }).click();
    await expect(slider()).toHaveValue('50');
    await closeLayout();
    await testInfo.attach('Independent PDF opacity beside Japanese notes', {
      body: await page.screenshot({ path: testInfo.outputPath('pdf-page-opacity.png') }), contentType: 'image/png',
    });
    await pdf().getByRole('button', { name: 'Back to library', exact: true }).click();
    await nativeOpacity(false);
    await stop();
    await launch();
    await workspace('PDFs').click();
    await pdf().getByRole('button', { name: 'Open Transparent reading', exact: true }).click();
    await pdf().getByLabel('Document password', { exact: true }).fill('opacity-secret');
    await pdf().getByRole('button', { name: 'Unlock PDF', exact: true }).click();
    await rendered(2);
    await openLayout();
    await expect(slider()).toHaveValue('50');
    await expect(slider()).toBeEnabled();
    await closeLayout();
    await nativeOpacity(true);
    await expect.poll(pageAlpha).toBeGreaterThanOrEqual(125);
    await expect.poll(pageAlpha).toBeLessThanOrEqual(130);
    await openLayout();
    await layout().getByRole('button', { name: 'Reset layout', exact: true }).click();
    await expect(slider()).toHaveValue('100');
    await closeLayout();
    await expect.poll(pageAlpha).toBe(255);
    await nativeOpacity(false);
    expect(errors).toEqual([]);
  } finally {
    await stop();
    await rm(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
