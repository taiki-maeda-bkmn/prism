import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

let temporary: string;
let desktop: ElectronApplication;
let page: Page;

async function state() {
  return desktop.evaluate(({ BrowserWindow, screen }) => {
    const window = BrowserWindow.getAllWindows()[0];
    return {
      bounds: window.getBounds(),
      maximized: window.isMaximized(),
      fullscreen: window.isFullScreen(),
      resizable: window.isResizable(),
      workArea: screen.getDisplayMatching(window.getBounds()).workArea,
    };
  });
}

async function backgroundAlpha() {
  const heading = await page.locator('.note-heading').boundingBox();
  if (!heading) throw new Error('The note heading is not visible.');
  return desktop.evaluate(async ({ BrowserWindow }, rectangle) => {
    const image = await BrowserWindow.getAllWindows()[0].webContents.capturePage(rectangle);
    return image.toBitmap({ scaleFactor: 1 })[3];
  }, { x: Math.round(heading.x + 4), y: Math.round(heading.y + 4), width: 1, height: 1 });
}

test.beforeAll(async () => {
  temporary = await mkdtemp(path.join(os.tmpdir(), 'prism-window-test-'));
  const notebook = path.join(temporary, 'Notebook');
  await mkdir(notebook);
  await writeFile(path.join(notebook, 'Window.md'), '# Window\n\nKeep the desktop within reach.\n');
  desktop = await electron.launch({
    args: ['--no-sandbox', '.'], cwd: process.cwd(),
    env: { ...process.env, PRISM_USER_DATA: path.join(temporary, 'profile'), PRISM_WORKSPACE: notebook },
  });
  page = await desktop.firstWindow();
  await expect(page.locator('.note-heading h1')).toHaveText('Window');
});

test.afterAll(async () => {
  if (desktop) {
    const process = desktop.process();
    const closed = desktop.waitForEvent('close', { timeout: 5_000 }).catch(() => undefined);
    await desktop.evaluate(({ app }) => app.exit(0)).catch(() => undefined);
    await closed;
    if (process.exitCode === null) process.kill();
  }
  if (temporary) await rm(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

test('maximizes without fullscreen and restores native bounds with transparent controls intact', async ({}, testInfo) => {
  const original = await state();
  expect(original.maximized).toBe(false);
  expect(original.fullscreen).toBe(false);
  expect(original.resizable).toBe(process.platform !== 'win32');
  await page.getByRole('button', { name: 'Window appearance', exact: true }).click();
  await page.getByRole('switch', { name: 'Transparent window', exact: true }).click();
  await page.getByLabel('Background opacity').fill('35');
  await page.getByRole('button', { name: 'Close dialog', exact: true }).click();

  await page.getByRole('button', { name: 'Maximize window', exact: true }).click();
  await expect.poll(async () => (await state()).maximized).toBe(true);
  await expect(page.getByRole('button', { name: 'Restore window', exact: true })).toBeVisible();
  if (original.bounds.width < original.workArea.width || original.bounds.height < original.workArea.height) {
    await expect.poll(async () => {
      const { bounds } = await state();
      return bounds.width > original.bounds.width || bounds.height > original.bounds.height;
    }).toBe(true);
  }
  const maximized = await state();
  expect(maximized.fullscreen).toBe(false);
  expect(maximized.bounds.width).toBeGreaterThanOrEqual(original.bounds.width);
  expect(maximized.bounds.height).toBeGreaterThanOrEqual(original.bounds.height);
  // WSLg's workArea may include the Windows taskbar; native maximization must
  // remain within it, rather than force an exact size from inaccurate metadata.
  expect(maximized.bounds.x).toBeGreaterThanOrEqual(maximized.workArea.x);
  expect(maximized.bounds.y).toBeGreaterThanOrEqual(maximized.workArea.y);
  expect(maximized.bounds.x + maximized.bounds.width).toBeLessThanOrEqual(maximized.workArea.x + maximized.workArea.width);
  expect(maximized.bounds.y + maximized.bounds.height).toBeLessThanOrEqual(maximized.workArea.y + maximized.workArea.height);
  const controls = await page.locator('.window-controls').boundingBox();
  expect(controls).not.toBeNull();
  expect(controls!.y).toBeGreaterThanOrEqual(0);
  expect(controls!.y + controls!.height).toBeLessThan(maximized.bounds.height);
  await expect.poll(backgroundAlpha).toBeGreaterThanOrEqual(85);
  await expect.poll(backgroundAlpha).toBeLessThanOrEqual(95);
  await testInfo.attach('Maximized desktop', { body: await page.screenshot(), contentType: 'image/png' });

  await page.getByRole('button', { name: 'Restore window', exact: true }).click();
  await expect.poll(async () => (await state()).maximized).toBe(false);
  await expect.poll(async () => (await state()).bounds).toEqual(original.bounds);
  await expect(page.getByRole('button', { name: 'Maximize window', exact: true })).toBeVisible();
  await expect.poll(backgroundAlpha).toBeLessThanOrEqual(95);

  // A normal native resize must preserve alpha and CodeMirror's glyph geometry.
  await page.getByRole('button', { name: 'Source', exact: true }).click();
  const editor = page.getByRole('textbox', { name: 'Markdown source', exact: true });
  const bodyLine = editor.locator('.cm-line').filter({ hasText: 'Keep the desktop within reach.' });
  const fontSize = await bodyLine.evaluate(line => getComputedStyle(line).fontSize);
  const resizedBounds = { ...original.bounds, width: Math.round(original.bounds.width * 0.85), height: Math.round(original.bounds.height * 0.85) };
  await desktop.evaluate(({ BrowserWindow }, bounds) => BrowserWindow.getAllWindows()[0].setBounds(bounds), resizedBounds);
  await expect.poll(async () => (await state()).bounds).toEqual(resizedBounds);
  await expect.poll(backgroundAlpha).toBeGreaterThanOrEqual(85);
  await expect.poll(backgroundAlpha).toBeLessThanOrEqual(95);
  expect(await bodyLine.evaluate(line => getComputedStyle(line).fontSize)).toBe(fontSize);
  await bodyLine.scrollIntoViewIfNeeded();
  const point = await bodyLine.evaluate(line => {
    const walker = document.createTreeWalker(line, NodeFilter.SHOW_TEXT);
    let offset = 'Keep the '.length;
    for (let text = walker.nextNode(); text; text = walker.nextNode()) {
      if (offset > text.textContent!.length) { offset -= text.textContent!.length; continue; }
      const range = document.createRange();
      range.setStart(text, offset);
      range.collapse(true);
      const bounds = range.getBoundingClientRect();
      return { x: bounds.x, y: bounds.y + bounds.height / 2 };
    }
    throw new Error('The text boundary is missing.');
  });
  await page.mouse.click(point.x, point.y);
  await page.keyboard.insertText('|');
  await expect(editor).toContainText('Keep the |desktop within reach.');
  await editor.press('ControlOrMeta+z');
  await expect(editor).toContainText('Keep the desktop within reach.');
  await expect(page.locator('.unsaved-badge')).toHaveCount(0);

  // State updates also follow native changes and survive a renderer reload.
  await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].maximize());
  await expect(page.getByRole('button', { name: 'Restore window', exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByRole('button', { name: 'Restore window', exact: true })).toBeVisible();
  await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].unmaximize());
  await expect(page.getByRole('button', { name: 'Maximize window', exact: true })).toBeVisible();
  await expect.poll(async () => (await state()).bounds).toEqual(resizedBounds);
});
