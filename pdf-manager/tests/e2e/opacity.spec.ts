import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { electronLaunchArguments } from '../../../scripts/electron-launch.mjs';
import { fixturePdf } from '../../../tests/fixtures/pdf';

test('standalone PDF opacity reveals the desktop independently and retains its page through appearance changes', async ({}, testInfo) => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'prism-pdf-opacity-standalone-'));
  const profile = path.join(temporary, 'profile');
  const source = path.join(temporary, 'Transparent reading.pdf');
  const bytes = fixturePdf();
  const errors: string[] = [];
  let desktop: ElectronApplication | undefined;
  let page!: Page;

  async function launch() {
    const applicationRoot = path.resolve(process.env.PRISM_TEST_PDF_APP_ROOT || path.join(process.cwd(), 'pdf-manager'));
    desktop = await electron.launch({
      executablePath: process.env.PRISM_TEST_ELECTRON,
      args: electronLaunchArguments(['--no-sandbox', applicationRoot]), cwd: applicationRoot,
      env: { ...process.env, PRISM_PDF_USER_DATA: profile },
    });
    page = await desktop.firstWindow();
    page.on('pageerror', error => errors.push(error.message));
    await expect(page.getByRole('heading', { name: 'All documents', exact: true })).toBeVisible();
    await page.setViewportSize({ width: 1440, height: 1000 });
  }
  async function close() {
    if (!desktop) return;
    const closed = desktop.waitForEvent('close');
    await page.getByRole('button', { name: 'Close window', exact: true }).click();
    await closed;
    desktop = undefined;
  }
  const layout = () => page.getByRole('dialog', { name: 'Reading layout', exact: true });
  const slider = () => layout().getByRole('slider', { name: 'PDF page opacity', exact: true });
  const canvas = () => page.locator('.pdf-paper canvas');
  const master = () => page.getByRole('switch', { name: 'Transparent window', exact: true });
  const background = () => page.locator('.appearance-panel input[type="range"]');
  async function openLayout() {
    await page.getByRole('button', { name: 'PDF layout', exact: true }).click();
    await expect(layout()).toBeVisible();
  }
  async function doneLayout() {
    await layout().getByRole('button', { name: 'Done', exact: true }).click();
    await expect(layout()).toBeHidden();
  }
  async function paperAlpha() {
    const box = await canvas().boundingBox();
    if (!box) throw new Error('The PDF canvas is not visible.');
    return desktop!.evaluate(async ({ BrowserWindow }, point) => {
      const image = await BrowserWindow.getAllWindows()[0].webContents.capturePage({ ...point, width: 1, height: 1 });
      return image.toBitmap({ scaleFactor: 1 })[3];
    }, { x: Math.round(box.x + 20), y: Math.round(box.y + 20) });
  }
  async function translucentPaper() {
    await expect.poll(paperAlpha).toBeGreaterThan(123);
    await expect.poll(paperAlpha).toBeLessThan(132);
  }
  async function nativeOpacity(expected: number) {
    if (process.platform !== 'win32') return;
    await expect.poll(() => desktop!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getOpacity())).toBeCloseTo(expected, 3);
  }

  try {
    await writeFile(source, bytes);
    await launch();
    await desktop!.evaluate(({ dialog }, filename) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [filename] });
    }, source);
    await page.getByRole('button', { name: 'Import PDFs', exact: true }).click();
    await page.getByRole('button', { name: 'Open Transparent reading', exact: true }).click();
    await page.getByLabel('Page zoom', { exact: true }).selectOption('2');
    await expect(canvas()).toHaveCSS('width', '1224px');
    await expect(canvas()).toHaveAttribute('data-page-number', '1');
    await expect(page.locator('.pdf-paper')).toHaveAttribute('aria-busy', 'false');
    const originalCanvas = await canvas().elementHandle();
    await openLayout();
    await expect(slider()).toHaveValue('100');
    await expect(slider()).toBeDisabled();
    await layout().getByRole('button', { name: 'Open Appearance', exact: true }).click();
    await expect(layout()).toBeHidden();
    await expect(page.locator('.appearance-panel')).toBeVisible();
    await master().check();
    await background().fill('100');
    await openLayout();
    await expect(slider()).toBeEnabled();
    await slider().fill('50');
    await doneLayout();
    await translucentPaper();
    await nativeOpacity(254 / 255);
    await expect(page.locator('.pdf-reader-toolbar')).toHaveCSS('opacity', '1');
    expect(await canvas().evaluate((element, original) => element === original, originalCanvas)).toBe(true);

    // A whole-workspace background behind the PDF would incorrectly combine
    // with its alpha; the captured surface must retain the same page alpha.
    await background().fill('35');
    await translucentPaper();
    await background().fill('100');
    await translucentPaper();
    await master().uncheck();
    await expect.poll(paperAlpha).toBe(255);
    await nativeOpacity(1);
    await openLayout();
    await expect(slider()).toBeDisabled();
    await expect(slider()).toHaveValue('50');
    await doneLayout();
    await master().check();
    await translucentPaper();
    await nativeOpacity(254 / 255);
    expect(await canvas().evaluate((element, original) => element === original, originalCanvas)).toBe(true);
    await expect(page.getByLabel('Page zoom', { exact: true })).toHaveValue('2');
    await testInfo.attach('Standalone PDF at 50% with app background at 100%', {
      body: await page.screenshot({ path: testInfo.outputPath('standalone-pdf-opacity.png') }), contentType: 'image/png',
    });
    await page.getByRole('button', { name: 'Back to library', exact: true }).click();
    await nativeOpacity(1);
    await close();

    await launch();
    await nativeOpacity(1);
    await page.getByRole('button', { name: 'Open Transparent reading', exact: true }).click();
    await expect(canvas()).toHaveAttribute('data-page-number', '1');
    await expect(page.locator('.pdf-paper')).toHaveAttribute('aria-busy', 'false');
    await translucentPaper();
    await nativeOpacity(254 / 255);
    await openLayout();
    await expect(slider()).toHaveValue('50');
    await expect(slider()).toBeEnabled();
    await doneLayout();
    expect(errors).toEqual([]);
    expect(await readFile(source)).toEqual(bytes);
    await close();
  } finally {
    if (desktop) {
      const child = desktop.process();
      const closed = desktop.waitForEvent('close', { timeout: 5000 }).catch(() => undefined);
      await desktop.evaluate(({ app }) => app.exit(0)).catch(() => undefined);
      await closed;
      if (child.exitCode === null) child.kill();
    }
    await rm(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
