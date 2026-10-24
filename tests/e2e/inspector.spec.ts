import { electronLaunchArguments } from '../../scripts/electron-launch.mjs';
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const welcome = '\ufeff# Welcome to Prism\r\n\r\nA quiet place for connected ideas.\r\n\r\n## A longer heading to read in the expanded outline\r\n\r\nExplore [[Garden]].\r\n';
let temporary: string;
let notebook: string;
let userData: string;
let desktop: ElectronApplication | undefined;
let page: Page;
let pageErrors: string[];
const inspector = () => page.getByRole('complementary', { name: 'In this note', exact: true });
const divider = () => page.getByRole('separator', { name: 'Resize note inspector', exact: true });

async function launch() {
  desktop = await electron.launch({
    args: electronLaunchArguments(['--no-sandbox', '.']), cwd: process.cwd(),
    env: { ...process.env, PRISM_USER_DATA: userData, PRISM_WORKSPACE: notebook },
  });
  page = await desktop.firstWindow();
  pageErrors = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  await expect(page.locator('.note-heading h1')).toHaveText('Welcome to Prism');
  await expect.poll(() => desktop!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible())).toBe(true);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await expect(inspector()).toBeVisible();
}

async function closeTestApp() {
  if (!desktop) return;
  const child = desktop.process();
  const closed = desktop.waitForEvent('close', { timeout: 5_000 }).catch(() => undefined);
  await desktop.evaluate(({ app }) => app.exit(0)).catch(() => undefined);
  await closed;
  if (child.exitCode === null) child.kill();
  desktop = undefined;
}

async function expectWidth(width: number) {
  await expect(divider()).toHaveAttribute('aria-valuenow', String(width));
  await expect.poll(async () => (await inspector().boundingBox())?.width).toBeCloseTo(width, 0);
}

async function dragBy(delta: number, release = true) {
  const box = await divider().boundingBox();
  if (!box) throw new Error('Inspector divider is not visible.');
  await page.mouse.move(box.x + box.width / 2, box.y + 180);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + delta, box.y + 180, { steps: 8 });
  if (release) await page.mouse.up();
}

test.beforeEach(async () => {
  temporary = await mkdtemp(path.join(os.tmpdir(), 'prism-inspector-test-'));
  notebook = path.join(temporary, 'Notebook');
  userData = path.join(temporary, 'profile');
  await Promise.all([mkdir(notebook), mkdir(userData)]);
  await Promise.all([
    writeFile(path.join(notebook, 'Welcome to Prism.md'), welcome),
    writeFile(path.join(notebook, 'Garden.md'), '# Garden\n\nReturn to [[Welcome to Prism]].\n'),
  ]);
  await launch();
});

test.afterEach(async ({}, testInfo) => {
  if (page && !page.isClosed() && testInfo.status !== testInfo.expectedStatus) {
    const screenshot = await page.screenshot().catch(() => undefined);
    if (screenshot) await testInfo.attach('Inspector at failure', { body: screenshot, contentType: 'image/png' });
  }
  await closeTestApp();
  if (temporary) await rm(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

test('resizes the inspector with mouse and keyboard while preserving live drafts and undo', async ({}, testInfo) => {
  await page.getByRole('button', { name: 'Live', exact: true }).click();
  const editor = page.getByLabel('Live Markdown editor', { exact: true });
  await editor.click();
  await editor.press('ControlOrMeta+End');
  await page.keyboard.insertText('A retained draft.');
  const cursor = await page.locator('.statusbar span').filter({ hasText: /^Ln \d+, Col \d+$/ }).innerText();
  await expectWidth(226);
  const initialMain = (await page.locator('.workspace-main').boundingBox())!.width;
  const initialGraph = (await inspector().locator('.graph-canvas').boundingBox())!.width;
  await dragBy(-200);
  await expectWidth(426);
  expect((await page.locator('.workspace-main').boundingBox())!.width).toBeCloseTo(initialMain - 200, 0);
  expect((await inspector().locator('.graph-canvas').boundingBox())!.width).toBeCloseTo(initialGraph + 200, 0);
  await expect(editor).toContainText('A retained draft.');
  await expect(page.locator('.statusbar')).toContainText(cursor);
  await testInfo.attach('Expanded note inspector', { body: await page.screenshot({ path: testInfo.outputPath('expanded-inspector.png') }), contentType: 'image/png' });

  await divider().focus();
  await divider().press('ArrowLeft');
  await expectWidth(436);
  await divider().press('Shift+ArrowRight');
  await expectWidth(396);
  await page.getByRole('button', { name: 'Focus mode', exact: true }).click();
  await expect(divider()).toHaveCount(0);
  await page.getByRole('button', { name: 'Show sidebars', exact: true }).click();
  await expectWidth(396);
  await divider().dblclick();
  await expectWidth(226);
  await dragBy(-100, false);
  await expectWidth(326);
  await divider().dispatchEvent('pointerup', { pointerId: 999 });
  await expect(page.locator('.inspector-panel')).toHaveAttribute('data-resizing', 'true');
  await page.keyboard.press('Escape');
  await page.mouse.up();
  await expectWidth(226);
  await expect(page.locator('.inspector-panel')).toHaveAttribute('data-resizing', 'false');
  await dragBy(100);
  await expectWidth(198);
  await divider().press('Home');
  await expectWidth(226);

  await editor.focus();
  await editor.press('ControlOrMeta+z');
  await expect(editor).not.toContainText('A retained draft.');
  await expect(page.locator('.statusbar')).toContainText('All changes saved');
  await editor.press('ControlOrMeta+Shift+z');
  await expect(editor).toContainText('A retained draft.');
  await editor.press('ControlOrMeta+s');
  await expect.poll(() => readFile(path.join(notebook, 'Welcome to Prism.md'), 'utf8')).toBe(welcome + 'A retained draft.');
  expect(pageErrors).toEqual([]);
});

test('bounds the inspector on smaller windows and restores its width across themes and restart', async () => {
  await divider().focus();
  await divider().press('End');
  await expectWidth(600);
  await page.setViewportSize({ width: 1050, height: 1000 });
  const available = await page.locator('.app-body').evaluate(element => element.clientWidth - element.querySelector('.sidebar')!.getBoundingClientRect().width);
  await expectWidth(available - 480);
  expect((await page.locator('.workspace-main').boundingBox())!.width).toBeGreaterThanOrEqual(480);
  expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBe(0);
  await page.setViewportSize({ width: 960, height: 1000 });
  await expect(inspector()).toBeHidden();
  await expect(divider()).toBeHidden();
  await page.setViewportSize({ width: 1440, height: 1000 });
  await expectWidth(600);

  await page.getByRole('button', { name: 'Graph view', exact: true }).click();
  await expect(divider()).toHaveCount(0);
  await page.getByRole('button', { name: 'Back to note', exact: true }).click();
  await expectWidth(600);

  for (const theme of ['Paper', 'Sci-fi']) {
    await page.getByRole('button', { name: 'Window appearance', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Make a little space', exact: true });
    await dialog.getByRole('radio', { name: `${theme} theme`, exact: true }).check();
    if (theme === 'Sci-fi') await dialog.getByRole('switch', { name: 'Transparent window', exact: true }).click();
    await dialog.getByRole('button', { name: 'Done', exact: true }).click();
    await expectWidth(600);
  }
  await expect(inspector()).toHaveCSS('background-color', /rgba\(.+, 0\.82\)/);
  await closeTestApp();
  await launch();
  await expectWidth(600);
  await expect(page.locator('.app-shell')).toHaveAttribute('data-theme', 'scifi');
  await expect(page.locator('.app-shell')).toHaveAttribute('data-transparent', 'true');
  await divider().press('Home');
  await expectWidth(226);
  expect(await readFile(path.join(notebook, 'Welcome to Prism.md'), 'utf8')).toBe(welcome);
  expect(pageErrors).toEqual([]);
});
