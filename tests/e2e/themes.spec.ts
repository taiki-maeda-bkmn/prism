import { electronLaunchArguments } from '../../scripts/electron-launch.mjs';
import { _electron as electron, expect, test, type ElectronApplication, type Locator, type Page } from '@playwright/test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const welcome = '# Welcome to Prism\n\nA quiet place for connected ideas.\n\nExplore [[Garden]].\n';
const palettes = {
  prism: { accent: '#3e6242', background: '#faf9f5', text: '#344640' },
  paper: { accent: '#8a5438', background: '#fbf5e8', text: '#40362a' },
  scifi: { accent: '#57d9cf', background: '#0f1825', text: '#d9e7f5' },
};
const prismCustom = { accent: '#aa33cc', background: '#1c2430', text: '#e6edf5' };
const paperCustom = { accent: '#994422', background: '#fff0d9', text: '#4a3322' };

let temporary: string;
let notebook: string;
let userData: string;
let desktop: ElectronApplication | undefined;
let page: Page;

async function launch() {
  desktop = await electron.launch({
    args: electronLaunchArguments(['--no-sandbox', '.']), cwd: process.cwd(),
    env: { ...process.env, PRISM_USER_DATA: userData, PRISM_WORKSPACE: notebook },
  });
  page = await desktop.firstWindow();
  await expect(page.locator('.note-heading h1')).toHaveText('Welcome to Prism');
  await expect.poll(() => desktop!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible())).toBe(true);
  await expect(page.locator('.message-banner.error')).toHaveCount(0);
}

async function closeTestApp() {
  if (!desktop) return;
  // Only this test's temporary profile is closed, including on assertion failure.
  const child = desktop.process();
  const closed = desktop.waitForEvent('close', { timeout: 5_000 }).catch(() => undefined);
  await desktop.evaluate(({ app }) => app.exit(0)).catch(() => undefined);
  await closed;
  if (child.exitCode === null) child.kill();
  desktop = undefined;
}

async function appearance() {
  await page.getByRole('button', { name: 'Window appearance', exact: true }).click();
  return page.getByRole('dialog', { name: 'Make a little space', exact: true });
}

async function expectPalette(dialog: Locator, colors: typeof palettes.prism) {
  for (const [label, color] of [['Accent', colors.accent], ['Page background', colors.background], ['Text', colors.text]]) {
    await expect(dialog.getByLabel(`${label} color`, { exact: true })).toHaveValue(color);
    await expect(dialog.getByLabel(`${label} hex`, { exact: true })).toHaveValue(color);
  }
}

async function setPalette(dialog: Locator, colors: typeof palettes.prism) {
  await dialog.getByLabel('Accent hex', { exact: true }).fill(colors.accent);
  await dialog.getByLabel('Page background hex', { exact: true }).fill(colors.background);
  await dialog.getByLabel('Text hex', { exact: true }).fill(colors.text);
}

async function nativeBackgroundAlpha() {
  const heading = await page.locator('.note-heading').boundingBox();
  if (!heading) throw new Error('The note heading is not visible.');
  return desktop!.evaluate(async ({ BrowserWindow }, rectangle) => {
    const image = await BrowserWindow.getAllWindows()[0].webContents.capturePage(rectangle);
    return image.toBitmap({ scaleFactor: 1 })[3];
  }, { x: Math.round(heading.x + 4), y: Math.round(heading.y + 4), width: 1, height: 1 });
}

test.beforeEach(async () => {
  temporary = await mkdtemp(path.join(os.tmpdir(), 'prism-themes-test-'));
  notebook = path.join(temporary, 'Theme notebook');
  userData = path.join(temporary, 'user-data');
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
    if (screenshot) await testInfo.attach('Theme settings at failure', { body: screenshot, contentType: 'image/png' });
  }
  await closeTestApp();
  if (temporary) await rm(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

test('changes themes without losing edits and remembers independent palettes with native transparency', async ({}, testInfo) => {
  const editor = page.getByLabel('Markdown source', { exact: true });
  const draft = 'A thought that survives a change of scenery.';
  await editor.click();
  await editor.press('ControlOrMeta+End');
  await page.keyboard.insertText(draft);
  await expect(page.locator('.statusbar')).toContainText('1 unsaved note');
  const cursor = await page.locator('.statusbar span').filter({ hasText: /^Ln \d+, Col \d+$/ }).innerText();

  await test.step('choose distinct themes and retain each edited palette', async () => {
    const dialog = await appearance();
    await expect(dialog.getByRole('radio', { name: 'Prism theme', exact: true })).toBeChecked();
    await expectPalette(dialog, palettes.prism);
    await setPalette(dialog, prismCustom);

    await dialog.getByRole('radio', { name: 'Prism theme', exact: true }).focus();
    await page.keyboard.press('ArrowRight');
    await expect(dialog.getByRole('radio', { name: 'Paper theme', exact: true })).toBeChecked();
    await expect(page.locator('.app-shell')).toHaveAttribute('data-theme', 'paper');
    await expectPalette(dialog, palettes.paper);
    await expect(page.locator('.markdown-body')).toHaveCSS('font-family', /Georgia/);
    await expect(page.locator('.workspace-main')).toHaveCSS('background-color', 'rgb(251, 245, 232)');
    await setPalette(dialog, paperCustom);

    await dialog.getByRole('radio', { name: 'Sci-fi theme', exact: true }).check();
    await expect(page.locator('.app-shell')).toHaveAttribute('data-theme', 'scifi');
    await expectPalette(dialog, palettes.scifi);
    await expect(page.locator('.note-heading h1')).toHaveCSS('font-family', /monospace/);
    await expect(page.locator('.mode-switch')).toHaveCSS('border-radius', '2px');
    await expect(page.locator('.workspace-main')).toHaveCSS('background-color', 'rgb(15, 24, 37)');
    await expect(page.locator('.markdown-body')).toHaveCSS('color', 'rgb(217, 231, 245)');

    await dialog.getByRole('radio', { name: 'Paper theme', exact: true }).check();
    await expectPalette(dialog, paperCustom);
    await dialog.getByRole('radio', { name: 'Prism theme', exact: true }).check();
    await expectPalette(dialog, prismCustom);
    await dialog.getByRole('radio', { name: 'Sci-fi theme', exact: true }).check();
    await dialog.getByRole('button', { name: 'Done', exact: true }).click();

    await expect(editor).toContainText(draft);
    await expect(page.locator('.statusbar')).toContainText(cursor);
    expect(await readFile(path.join(notebook, 'Welcome to Prism.md'), 'utf8')).toBe(welcome);
    await editor.focus();
    await editor.press('ControlOrMeta+z');
    await expect(editor).not.toContainText(draft);
    await expect(page.locator('.statusbar')).toContainText('All changes saved');
    await editor.press('ControlOrMeta+Shift+z');
    await expect(editor).toContainText(draft);
    await page.keyboard.press('ControlOrMeta+S');
    await expect(page.locator('.statusbar')).toContainText('All changes saved');
    await expect.poll(() => readFile(path.join(notebook, 'Welcome to Prism.md'), 'utf8')).toBe(welcome + draft);
  });

  await test.step('preserve native transparency in both new themes', async () => {
    await page.getByRole('button', { name: 'Read', exact: true }).click();
    const dialog = await appearance();
    await dialog.getByRole('switch', { name: 'Transparent window', exact: true }).click();
    const slider = dialog.getByRole('slider', { name: 'Background opacity', exact: true });
    await slider.focus();
    await slider.press('Home');
    for (let index = 0; index < 10; index++) await slider.press('ArrowRight');
    await expect(slider).toHaveValue('35');
    await dialog.getByRole('button', { name: 'Done', exact: true }).click();
    await expect(page.locator('.workspace-main')).toHaveCSS('background-color', 'rgba(15, 24, 37, 0.35)');
    await expect.poll(nativeBackgroundAlpha).toBeGreaterThan(80);
    await expect.poll(nativeBackgroundAlpha).toBeLessThan(100);
    await testInfo.attach('Sci-fi theme', { body: await page.screenshot(), contentType: 'image/png' });

    const paperDialog = await appearance();
    await paperDialog.getByRole('radio', { name: 'Paper theme', exact: true }).check();
    await paperDialog.getByRole('button', { name: 'Done', exact: true }).click();
    await expect(page.locator('.workspace-main')).toHaveCSS('background-color', 'rgba(255, 240, 217, 0.35)');
    await expect.poll(nativeBackgroundAlpha).toBeGreaterThan(80);
    await expect.poll(nativeBackgroundAlpha).toBeLessThan(100);
    await testInfo.attach('Paper theme', { body: await page.screenshot(), contentType: 'image/png' });
  });

  await test.step('restore the selected theme on restart and reset only its colors', async () => {
    await closeTestApp();
    await launch();
    await expect(page.locator('.app-shell')).toHaveAttribute('data-theme', 'paper');
    await expect(page.getByRole('button', { name: 'Read', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('.markdown-body')).toHaveCSS('font-family', /Georgia/);
    const dialog = await appearance();
    await expect(dialog.getByRole('radio', { name: 'Paper theme', exact: true })).toBeChecked();
    await expectPalette(dialog, paperCustom);
    await expect(dialog.getByRole('switch', { name: 'Transparent window', exact: true })).toHaveAttribute('aria-checked', 'true');
    await expect(dialog.getByRole('slider', { name: 'Background opacity', exact: true })).toHaveValue('35');
    await dialog.getByRole('button', { name: 'Reset colors', exact: true }).click();
    await expectPalette(dialog, palettes.paper);
    await dialog.getByRole('radio', { name: 'Prism theme', exact: true }).check();
    await expectPalette(dialog, prismCustom);
    await dialog.getByRole('radio', { name: 'Paper theme', exact: true }).check();
    await expectPalette(dialog, palettes.paper);
    await expect(dialog.getByRole('switch', { name: 'Transparent window', exact: true })).toHaveAttribute('aria-checked', 'true');
    await expect(dialog.getByRole('slider', { name: 'Background opacity', exact: true })).toHaveValue('35');
    await dialog.getByRole('button', { name: 'Done', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Read', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('.workspace-main')).toHaveCSS('background-color', 'rgba(251, 245, 232, 0.35)');
    await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('prism.preferences')!))).toMatchObject({
      theme: 'paper', colors: palettes.paper, themeColors: { prism: prismCustom }, mode: 'preview', transparent: true, opacity: 35,
    });
    expect(await readFile(path.join(notebook, 'Welcome to Prism.md'), 'utf8')).toBe(welcome + draft);
  });
});
