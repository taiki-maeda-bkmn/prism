import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const welcome = '# Welcome to Prism\n\nA quiet place for connected ideas.\n\nExplore [[Garden]].\n';
const defaults = { accent: '#3e6242', background: '#faf9f5', text: '#344640' };
const custom = { accent: '#aa33cc', background: '#1c2430', text: '#e6edf5' };

let temporary: string;
let notebook: string;
let userData: string;
let desktop: ElectronApplication | undefined;
let page: Page;

async function launch() {
  desktop = await electron.launch({
    args: ['--no-sandbox', '.'],
    cwd: process.cwd(),
    env: { ...process.env, PRISM_USER_DATA: userData, PRISM_WORKSPACE: notebook },
  });
  page = await desktop.firstWindow();
  await expect(page.locator('.note-heading h1')).toHaveText('Welcome to Prism');
  await expect.poll(() => desktop!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible())).toBe(true);
  await expect(page.locator('.message-banner.error')).toHaveCount(0);
}

async function closeTestApp() {
  if (!desktop) return;
  // This process belongs only to the disposable profile created by this test.
  const process = desktop.process();
  const closed = desktop.waitForEvent('close', { timeout: 5_000 }).catch(() => undefined);
  await desktop.evaluate(({ app }) => app.exit(0)).catch(() => undefined);
  await closed;
  if (process.exitCode === null) process.kill();
  desktop = undefined;
}

async function appearance() {
  await page.getByRole('button', { name: 'Window appearance', exact: true }).click();
  return page.getByRole('dialog', { name: 'Make a little space', exact: true });
}

async function nativeBackgroundAlpha() {
  const heading = await page.locator('.note-heading').boundingBox();
  if (!heading) throw new Error('The note heading is not visible.');
  // Empty heading padding has no text, control, or editor selection above it.
  return desktop!.evaluate(async ({ BrowserWindow }, rectangle) => {
    const image = await BrowserWindow.getAllWindows()[0].webContents.capturePage(rectangle);
    return image.toBitmap({ scaleFactor: 1 })[3];
  }, { x: Math.round(heading.x + 4), y: Math.round(heading.y + 4), width: 1, height: 1 });
}

test.beforeEach(async () => {
  temporary = await mkdtemp(path.join(os.tmpdir(), 'prism-colors-test-'));
  notebook = path.join(temporary, 'Color notebook');
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
    if (screenshot) await testInfo.attach('Color settings at failure', { body: screenshot, contentType: 'image/png' });
  }
  await closeTestApp();
  if (temporary) await rm(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

test('customizes real editor colors without losing drafts, persists them, and resets only colors', async ({}, testInfo) => {
  const editor = page.getByLabel('Markdown source', { exact: true });
  const draft = 'A private color draft.';
  const defaultLinkColor = await page.locator('.markdown-body a').evaluate(element => getComputedStyle(element).color);
  let cursor: string;
  let customLinkColor: string;

  await test.step('change colors while a note has an unsaved edit', async () => {
    await editor.click();
    await editor.press('ControlOrMeta+End');
    await page.keyboard.insertText(draft);
    await expect(page.locator('.statusbar')).toContainText('1 unsaved note');
    cursor = await page.locator('.statusbar span').filter({ hasText: /^Ln \d+, Col \d+$/ }).innerText();

    const dialog = await appearance();
    await expect(dialog.getByLabel('Accent color', { exact: true })).toHaveValue(defaults.accent);
    await dialog.getByLabel('Accent hex', { exact: true }).fill('#A3C');
    await expect(dialog.getByLabel('Accent color', { exact: true })).toHaveValue(custom.accent);
    // Playwright fills the native input, exercising its real input/change events.
    await dialog.getByLabel('Page background color', { exact: true }).fill(custom.background);
    await dialog.getByLabel('Text hex', { exact: true }).fill(custom.text);
    await expect(dialog.getByLabel('Text color', { exact: true })).toHaveValue(custom.text);
    await expect.poll(() => page.locator('.markdown-body a').evaluate(element => getComputedStyle(element).color)).not.toBe(defaultLinkColor);
    customLinkColor = await page.locator('.markdown-body a').evaluate(element => getComputedStyle(element).color);

    await dialog.getByLabel('Accent hex', { exact: true }).fill('not a color');
    await expect(dialog.getByLabel('Accent hex', { exact: true })).toHaveAttribute('aria-invalid', 'true');
    await expect(dialog.getByLabel('Accent color', { exact: true })).toHaveValue(custom.accent);
    await expect(page.locator('.markdown-body a')).toHaveCSS('color', customLinkColor);
    await dialog.getByRole('button', { name: 'Done', exact: true }).click();
    await expect(dialog).toHaveCount(0);

    await expect(editor).toContainText(draft);
    await expect(page.locator('.statusbar')).toContainText(cursor);
    expect(await readFile(path.join(notebook, 'Welcome to Prism.md'), 'utf8')).toBe(welcome);
    await expect(page.locator('.cm-editor')).toHaveCSS('color', 'rgb(230, 237, 245)');
    await expect(page.locator('.cm-line').filter({ hasText: 'A quiet place for connected ideas.' })).toHaveCSS('color', 'rgb(230, 237, 245)');
    await expect(page.locator('.cm-line').first().locator('span').last()).toHaveCSS('color', customLinkColor);
    await expect(page.locator('.markdown-body > p').first()).toHaveCSS('color', 'rgb(230, 237, 245)');
    await expect(page.locator('.workspace-main')).toHaveCSS('background-color', 'rgb(28, 36, 48)');
    await expect(page.locator('.graph-node-active .graph-node-dot')).toHaveCSS('fill', 'rgb(170, 51, 204)');

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

  await test.step('keep the chosen background genuinely transparent', async () => {
    await page.getByRole('button', { name: 'Read', exact: true }).click();
    const dialog = await appearance();
    // Invalid text has reverted to the last valid color when the dialog closed.
    await expect(dialog.getByLabel('Accent hex', { exact: true })).toHaveValue(custom.accent);
    await dialog.getByRole('switch', { name: 'Transparent window', exact: true }).click();
    const slider = dialog.getByRole('slider', { name: 'Background opacity', exact: true });
    await slider.focus();
    await slider.press('Home');
    for (let index = 0; index < 10; index++) await slider.press('ArrowRight');
    await expect(slider).toHaveValue('35');
    await dialog.getByRole('button', { name: 'Done', exact: true }).click();
    await expect(page.locator('.workspace-main')).toHaveCSS('background-color', 'rgba(28, 36, 48, 0.35)');
    await expect.poll(nativeBackgroundAlpha).toBeGreaterThan(80);
    await expect.poll(nativeBackgroundAlpha).toBeLessThan(100);
    await testInfo.attach('Customized Prism colors', { body: await page.screenshot(), contentType: 'image/png' });
  });

  await test.step('reopen the app and restore colors without changing reading or transparency preferences', async () => {
    await desktop!.close();
    desktop = undefined;
    await launch();
    await expect(page.getByRole('button', { name: 'Read', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('.markdown-body')).toHaveCSS('color', 'rgb(230, 237, 245)');
    await expect(page.locator('.markdown-body a')).toHaveCSS('color', customLinkColor);
    const dialog = await appearance();
    await expect(dialog.getByLabel('Accent color', { exact: true })).toHaveValue(custom.accent);
    await expect(dialog.getByLabel('Page background color', { exact: true })).toHaveValue(custom.background);
    await expect(dialog.getByLabel('Text color', { exact: true })).toHaveValue(custom.text);
    await expect(dialog.getByRole('switch', { name: 'Transparent window', exact: true })).toHaveAttribute('aria-checked', 'true');
    await expect(dialog.getByRole('slider', { name: 'Background opacity', exact: true })).toHaveValue('35');

    await dialog.getByRole('button', { name: 'Reset colors', exact: true }).click();
    await expect(dialog.getByLabel('Accent color', { exact: true })).toHaveValue(defaults.accent);
    await expect(dialog.getByLabel('Page background color', { exact: true })).toHaveValue(defaults.background);
    await expect(dialog.getByLabel('Text color', { exact: true })).toHaveValue(defaults.text);
    await expect(dialog.getByRole('switch', { name: 'Transparent window', exact: true })).toHaveAttribute('aria-checked', 'true');
    await expect(dialog.getByRole('slider', { name: 'Background opacity', exact: true })).toHaveValue('35');
    await dialog.getByRole('button', { name: 'Done', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Read', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('.markdown-body')).toHaveCSS('color', 'rgb(52, 70, 64)');
    await expect(page.locator('.workspace-main')).toHaveCSS('background-color', 'rgba(250, 249, 245, 0.35)');
    await expect.poll(nativeBackgroundAlpha).toBeLessThan(100);
    await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('prism.preferences')!))).toMatchObject({
      colors: defaults, mode: 'preview', transparent: true, opacity: 35,
    });
  });
});

test('recovers invalid saved color fields independently while keeping valid preferences', async () => {
  await page.evaluate(() => localStorage.setItem('prism.preferences', JSON.stringify({
    mode: 'source', transparent: true, opacity: 46,
    colors: { accent: 'url(https://invalid.example/color)', background: '#BAD', text: { hex: '#123456' } },
  })));
  await page.reload();
  await expect(page.locator('.note-heading h1')).toHaveText('Welcome to Prism');
  await expect(page.getByRole('button', { name: 'Source', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByLabel('Markdown source', { exact: true })).toContainText('A quiet place');
  await expect(page.locator('.workspace-main')).toHaveCSS('background-color', 'rgba(187, 170, 221, 0.46)');
  const dialog = await appearance();
  await expect(dialog.getByLabel('Accent color', { exact: true })).toHaveValue(defaults.accent);
  await expect(dialog.getByLabel('Page background color', { exact: true })).toHaveValue('#bbaadd');
  await expect(dialog.getByLabel('Text color', { exact: true })).toHaveValue(defaults.text);
  await expect(dialog.getByRole('switch', { name: 'Transparent window', exact: true })).toHaveAttribute('aria-checked', 'true');
  await expect(dialog.getByRole('slider', { name: 'Background opacity', exact: true })).toHaveValue('46');
  expect(await readFile(path.join(notebook, 'Welcome to Prism.md'), 'utf8')).toBe(welcome);
});
