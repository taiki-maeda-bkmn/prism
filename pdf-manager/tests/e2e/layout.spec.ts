import { _electron as electron, expect, test, type ElectronApplication, type Locator } from '@playwright/test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { electronLaunchArguments } from '../../../scripts/electron-launch.mjs';
import { fixturePdf } from '../../../tests/fixtures/pdf';

test('standalone layout keeps native controls reachable and the loaded page intact in a narrow window', async ({}, testInfo) => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'prism-pdf-layout-standalone-'));
  const profile = path.join(temporary, 'profile');
  const source = path.join(temporary, 'Standalone reading.pdf');
  const bytes = fixturePdf();
  const errors: string[] = [];
  let desktop: ElectronApplication | undefined;
  try {
    await writeFile(source, bytes);
    const applicationRoot = path.resolve(process.env.PRISM_TEST_PDF_APP_ROOT || path.join(process.cwd(), 'pdf-manager'));
    desktop = await electron.launch({
      executablePath: process.env.PRISM_TEST_ELECTRON,
      args: electronLaunchArguments(['--no-sandbox', applicationRoot]), cwd: applicationRoot,
      env: { ...process.env, PRISM_PDF_USER_DATA: profile },
    });
    const page = await desktop.firstWindow();
    page.on('pageerror', error => errors.push(error.message));
    await expect(page.getByRole('heading', { name: 'All documents', exact: true })).toBeVisible();
    await page.setViewportSize({ width: 1440, height: 900 });
    await desktop.evaluate(({ dialog }, filename) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [filename] });
    }, source);
    await page.getByRole('button', { name: 'Import PDFs', exact: true }).click();
    await page.getByRole('button', { name: 'Open Standalone reading', exact: true }).click();
    const canvas = page.locator('.pdf-paper canvas');
    await expect(canvas).toHaveAttribute('data-page-number', '1');
    await page.getByLabel('Page zoom', { exact: true }).selectOption('2');
    await expect(canvas).toHaveCSS('width', '1224px');
    await expect(page.locator('.pdf-paper')).toHaveAttribute('aria-busy', 'false');
    await expect.poll(() => canvas.evaluate((element: HTMLCanvasElement) => {
      if (!element.width || !element.height) return 0;
      const pixel = element.getContext('2d')!.getImageData(Math.floor(element.width / 2), Math.floor(element.height * 0.2), 1, 1).data;
      return Math.max(pixel[0], pixel[1], pixel[2]) - Math.min(pixel[0], pixel[1], pixel[2]);
    })).toBeGreaterThan(40);
    const originalCanvas = await canvas.elementHandle();
    const layout = page.getByRole('button', { name: 'PDF layout', exact: true });
    const dialog = page.getByRole('dialog', { name: 'Reading layout', exact: true });
    const sidebar = page.locator('#pdf-library-navigation');
    const nativeNames = ['Minimize window', 'Maximize or restore window', 'Close window'] as const;

    async function insideWindow(control: Locator) {
      await expect(control).toBeVisible();
      const box = await control.boundingBox();
      if (!box) throw new Error('A standalone window control is not visible.');
      const bounds = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(bounds.width + 1);
      expect(box.y).toBeGreaterThanOrEqual(0);
      expect(box.y + box.height).toBeLessThanOrEqual(bounds.height + 1);
    }
    async function reachableTitlebar() {
      await insideWindow(layout);
      for (const name of nativeNames) await insideWindow(page.getByRole('button', { name, exact: true }));
    }
    async function samePage() {
      expect(await canvas.evaluate((element, original) => element === original, originalCanvas)).toBe(true);
      await expect(canvas).toHaveAttribute('data-page-number', '1');
    }

    const separator = page.getByRole('separator', { name: 'Resize PDF library sidebar', exact: true });
    await separator.focus();
    await separator.press('End');
    await expect(separator).toHaveAttribute('aria-valuenow', '420');
    // The transparent standalone host has no native minimum size. Exercise its
    // narrow 900px layout with the widest saved sidebar, which must clamp only
    // the displayed width while reserving room for the reader and titlebar.
    await page.setViewportSize({ width: 900, height: 900 });
    await expect.poll(async () => (await sidebar.boundingBox())!.width).toBeLessThan(420);
    expect(await page.evaluate(() => JSON.parse(localStorage.getItem('prism-pdf-layout')!).sidebarWidth)).toBe(420);
    await reachableTitlebar();
    await layout.click();
    await expect(dialog.getByRole('checkbox', { name: 'Linked notes', exact: true })).toHaveCount(0);
    await dialog.getByRole('button', { name: 'More reading space', exact: true }).click();
    await dialog.getByRole('button', { name: 'Done', exact: true }).click();
    await expect(sidebar).toBeHidden();
    await expect(page.locator('.pdf-reader-heading')).toBeHidden();
    await expect(page.locator('.pdf-reader-toolbar')).toBeVisible();
    await expect(page.locator('.pdf-reader-footer')).toBeHidden();
    await samePage();
    await reachableTitlebar();
    await layout.click();
    await dialog.getByRole('checkbox', { name: 'Page toolbar', exact: true }).uncheck();
    await dialog.getByRole('button', { name: 'Done', exact: true }).click();
    await expect(page.locator('.pdf-reader-toolbar')).toBeHidden();
    await samePage();
    await reachableTitlebar();
    await layout.click();
    await dialog.getByRole('button', { name: 'Reset layout', exact: true }).click();
    await dialog.getByRole('button', { name: 'Done', exact: true }).click();
    await expect.poll(async () => (await sidebar.boundingBox())!.width).toBeCloseTo(228, 0);
    await expect(page.getByLabel('Page zoom', { exact: true })).toHaveValue('2');
    await samePage();
    await reachableTitlebar();
    await testInfo.attach('Standalone layout and native window controls at 900px', {
      body: await page.screenshot({ path: testInfo.outputPath('standalone-pdf-layout.png') }), contentType: 'image/png',
    });
    expect(errors).toEqual([]);
    expect(await readFile(source)).toEqual(bytes);
    const closed = desktop.waitForEvent('close');
    await page.getByRole('button', { name: 'Close window', exact: true }).click();
    await closed;
    desktop = undefined;
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
