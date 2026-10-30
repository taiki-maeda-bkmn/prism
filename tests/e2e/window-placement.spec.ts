import { electronLaunchArguments } from '../../scripts/electron-launch.mjs';
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

interface Bounds { x: number; y: number; width: number; height: number }
interface SavedPlacement { version: 1; bounds: Bounds; maximized: boolean }

const original = '# Window placement\n\nKeep this notebook in view.\n';
let temporary: string;
let notebook: string;
let userData: string;
let pdfProfile: string;
let desktop: ElectronApplication | undefined;
let page: Page;
let rendererErrors: string[];
const noteFile = () => path.join(notebook, 'Window.md');
const placementFile = () => path.join(userData, 'window-placement.json');
const editor = () => page.getByRole('textbox', { name: 'Markdown source', exact: true });

async function state() {
  return desktop!.evaluate(({ BrowserWindow, screen }) => {
    const window = BrowserWindow.getAllWindows()[0];
    const bounds = window.getBounds();
    return {
      bounds, normalBounds: window.getNormalBounds(), maximized: window.isMaximized(),
      minimized: window.isMinimized(), fullscreen: window.isFullScreen(), visible: window.isVisible(),
      workArea: screen.getDisplayMatching(bounds).workArea,
    };
  });
}

async function launch() {
  desktop = await electron.launch({
    args: electronLaunchArguments(['--no-sandbox', '.']), cwd: process.cwd(),
    env: { ...process.env, PRISM_USER_DATA: userData, PRISM_WORKSPACE: notebook, PRISM_PDF_USER_DATA: pdfProfile },
  });
  page = await desktop.firstWindow();
  page.on('pageerror', error => rendererErrors.push(error.message));
  const nativeWayland = await desktop.evaluate(({ app }) => {
    const backend = app.commandLine.getSwitchValue('ozone-platform');
    const hint = app.commandLine.getSwitchValue('ozone-platform-hint') || process.env.ELECTRON_OZONE_PLATFORM_HINT;
    return process.platform === 'linux' && (backend === 'wayland'
      || (backend !== 'x11' && (hint === 'wayland' || (!process.env.DISPLAY && !!process.env.WAYLAND_DISPLAY))));
  });
  test.skip(nativeWayland, 'Native Wayland owns absolute window coordinates; host restoration is covered separately.');
  await expect(page.locator('.note-heading h1')).toHaveText('Window placement');
  await expect.poll(async () => (await state()).visible).toBe(true);
  await expect.poll(async () => (await state()).minimized).toBe(false);
  await page.getByRole('group', { name: 'Editor mode', exact: true }).getByRole('button', { name: 'Source', exact: true }).click();
}

/** Exercise the real shutdown path: forced exits cannot prove close-time persistence. */
async function quit() {
  const application = desktop!;
  const closed = application.waitForEvent('close', { timeout: 15_000 });
  await application.evaluate(({ app }) => { setTimeout(() => app.quit(), 0); });
  await closed;
  desktop = undefined;
}

async function cleanup() {
  if (!desktop) return;
  const application = desktop;
  const child = application.process();
  const closed = application.waitForEvent('close', { timeout: 5_000 }).catch(() => undefined);
  await application.evaluate(({ app }) => app.exit(0)).catch(() => undefined);
  await closed;
  if (child.exitCode === null) child.kill();
  desktop = undefined;
}

async function placeNormalWindow(): Promise<Bounds> {
  const { workArea } = await state();
  test.skip(workArea.width < 640 || workArea.height < 480, 'The placement journey needs a desktop work area of at least 640 × 480.');
  const bounds = {
    x: workArea.x + 48, y: workArea.y + 44,
    width: Math.min(1000, workArea.width - 120), height: Math.min(700, workArea.height - 120),
  };
  await desktop!.evaluate(({ BrowserWindow }, rectangle) => BrowserWindow.getAllWindows()[0].setBounds(rectangle), bounds);
  await expect.poll(async () => (await state()).bounds).toEqual(bounds);
  return bounds;
}

async function readPlacement(): Promise<SavedPlacement> {
  return JSON.parse(await readFile(placementFile(), 'utf8')) as SavedPlacement;
}

async function expectUsableNormalWindow() {
  const current = await state();
  expect(current.maximized).toBe(false);
  expect(current.fullscreen).toBe(false);
  expect(current.minimized).toBe(false);
  expect(current.bounds.width).toBeGreaterThan(0);
  expect(current.bounds.height).toBeGreaterThan(0);
  expect(current.bounds.x).toBeGreaterThanOrEqual(current.workArea.x);
  expect(current.bounds.y).toBeGreaterThanOrEqual(current.workArea.y);
  expect(current.bounds.x + current.bounds.width).toBeLessThanOrEqual(current.workArea.x + current.workArea.width);
  expect(current.bounds.y + current.bounds.height).toBeLessThanOrEqual(current.workArea.y + current.workArea.height);
  await expect(page.getByRole('button', { name: 'Close window', exact: true })).toBeInViewport({ ratio: 1 });
  await expect(page.getByRole('button', { name: 'Maximize window', exact: true })).toBeInViewport({ ratio: 1 });
  return current.bounds;
}

test.beforeEach(async () => {
  temporary = await mkdtemp(path.join(os.tmpdir(), 'prism-window-placement-'));
  notebook = path.join(temporary, 'Notebook');
  userData = path.join(temporary, 'notes-profile');
  pdfProfile = path.join(temporary, 'pdf-profile');
  rendererErrors = [];
  await Promise.all([mkdir(notebook), mkdir(userData), mkdir(pdfProfile)]);
  await writeFile(noteFile(), original);
});

test.afterEach(async ({}, testInfo) => {
  if (desktop && page && !page.isClosed() && testInfo.status !== testInfo.expectedStatus) {
    const screenshot = await page.screenshot().catch(() => undefined);
    if (screenshot) await testInfo.attach('Window placement at failure', { body: screenshot, contentType: 'image/png' });
    const native = await state().catch(() => undefined);
    if (native) await testInfo.attach('Native window state', { body: JSON.stringify(native, null, 2), contentType: 'application/json' });
  }
  await cleanup();
  if (temporary) await rm(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

test('remembers moved and resized normal bounds while a cancelled close preserves the draft', async () => {
  await launch();
  const bounds = await placeNormalWindow();
  const draft = 'Keep my draft and window.';
  await editor().focus();
  await editor().press('ControlOrMeta+End');
  await page.keyboard.insertText(draft);
  await expect(page.locator('.statusbar')).toContainText('1 unsaved note');
  await page.getByRole('button', { name: 'Close window', exact: true }).click();
  const confirmation = page.getByRole('dialog', { name: 'Keep your latest thoughts?', exact: true });
  await expect(confirmation).toBeVisible();
  await confirmation.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(confirmation).toHaveCount(0);
  await expect(editor()).toContainText(draft);
  expect((await state()).bounds).toEqual(bounds);
  expect(await readFile(noteFile(), 'utf8')).toBe(original);
  await editor().press('ControlOrMeta+s');
  await expect.poll(() => readFile(noteFile(), 'utf8')).toBe(original + draft);
  await quit();
  expect(await readPlacement()).toEqual({ version: 1, bounds, maximized: false });
  await launch();
  await expect.poll(async () => (await state()).bounds).toEqual(bounds);
  await expectUsableNormalWindow();
  await expect(editor()).toContainText(draft);
  expect(rendererErrors).toEqual([]);
});

test('reopens maximized and restores the saved normal bounds when unmaximized', async () => {
  await launch();
  const bounds = await placeNormalWindow();
  await page.getByRole('button', { name: 'Maximize window', exact: true }).click();
  await expect.poll(async () => (await state()).maximized).toBe(true);
  expect((await state()).fullscreen).toBe(false);
  await quit();
  expect(await readPlacement()).toEqual({ version: 1, bounds, maximized: true });
  await launch();
  await expect.poll(async () => (await state()).maximized).toBe(true);
  await expect(page.getByRole('button', { name: 'Restore window', exact: true })).toBeInViewport({ ratio: 1 });
  expect((await state()).fullscreen).toBe(false);
  await page.getByRole('button', { name: 'Restore window', exact: true }).click();
  await expect.poll(async () => (await state()).maximized).toBe(false);
  await expect.poll(async () => (await state()).bounds).toEqual(bounds);
  await expectUsableNormalWindow();
  await quit();
  expect(await readPlacement()).toEqual({ version: 1, bounds, maximized: false });
  expect(rendererErrors).toEqual([]);
});

test('quitting minimized reopens visibly and retains the preceding normal or maximized state', async () => {
  await launch();
  const bounds = await placeNormalWindow();
  await page.getByRole('button', { name: 'Minimize window', exact: true }).click();
  await expect.poll(async () => (await state()).minimized).toBe(true);
  await quit();
  expect(await readPlacement()).toEqual({ version: 1, bounds, maximized: false });
  await launch();
  await expect.poll(async () => (await state()).bounds).toEqual(bounds);
  await expectUsableNormalWindow();
  await page.getByRole('button', { name: 'Maximize window', exact: true }).click();
  await expect.poll(async () => (await state()).maximized).toBe(true);
  await page.getByRole('button', { name: 'Minimize window', exact: true }).click();
  await expect.poll(async () => (await state()).minimized).toBe(true);
  await quit();
  expect(await readPlacement()).toEqual({ version: 1, bounds, maximized: true });
  await launch();
  await expect.poll(async () => (await state()).maximized).toBe(true);
  expect((await state()).minimized).toBe(false);
  await page.getByRole('button', { name: 'Restore window', exact: true }).click();
  await expect.poll(async () => (await state()).bounds).toEqual(bounds);
  await expectUsableNormalWindow();
  expect(rendererErrors).toEqual([]);
});

for (const fixture of [
  { name: 'an offscreen oversized window', content: JSON.stringify({ version: 1, bounds: { x: 999999, y: 999999, width: 5000, height: 4000 }, maximized: false }) },
  { name: 'malformed JSON', content: '{"version":1,"bounds":' },
  { name: 'an invalid rectangle marked maximized', content: JSON.stringify({ version: 1, bounds: { x: 0, y: 0, width: 0, height: 600 }, maximized: true }) },
]) {
  test(`recovers ${fixture.name} into the current desktop work area`, async () => {
    await writeFile(placementFile(), fixture.content);
    await launch();
    const bounds = await expectUsableNormalWindow();
    expect(await readFile(noteFile(), 'utf8')).toBe(original);
    await quit();
    expect(await readPlacement()).toEqual({ version: 1, bounds, maximized: false });
    expect(rendererErrors).toEqual([]);
  });
}
