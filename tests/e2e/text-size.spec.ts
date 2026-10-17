import { _electron as electron, expect, test, type ElectronApplication, type Locator, type Page } from '@playwright/test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const welcome = '# Welcome to Prism\n\nA quiet place for connected ideas.\n';
let temporary: string;
let notebook: string;
let userData: string;
let desktop: ElectronApplication | undefined;
let page: Page;

async function launch() {
  desktop = await electron.launch({
    args: ['--no-sandbox', '.'], cwd: process.cwd(),
    env: { ...process.env, PRISM_USER_DATA: userData, PRISM_WORKSPACE: notebook },
  });
  page = await desktop.firstWindow();
  await expect(page.locator('.note-heading h1')).toHaveText('Welcome to Prism');
  await expect.poll(() => desktop!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible())).toBe(true);
}

async function closeTestApp() {
  if (!desktop) return;
  // Never close the user's running instance: this app has its own temporary profile.
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

async function fontSize(locator: Locator) {
  return locator.evaluate(element => parseFloat(getComputedStyle(element).fontSize));
}

test.beforeEach(async () => {
  temporary = await mkdtemp(path.join(os.tmpdir(), 'prism-text-size-test-'));
  notebook = path.join(temporary, 'Notebook');
  userData = path.join(temporary, 'profile');
  await Promise.all([mkdir(notebook), mkdir(userData)]);
  await writeFile(path.join(notebook, 'Welcome to Prism.md'), welcome);
  await launch();
});

test.afterEach(async ({}, testInfo) => {
  if (page && !page.isClosed() && testInfo.status !== testInfo.expectedStatus) {
    const screenshot = await page.screenshot().catch(() => undefined);
    if (screenshot) await testInfo.attach('Text size at failure', { body: screenshot, contentType: 'image/png' });
  }
  await closeTestApp();
  if (temporary) await rm(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

test('enlarges text live, preserves edits, and remembers size across themes and restart', async ({}, testInfo) => {
  const editor = page.getByLabel('Markdown source', { exact: true });
  const preview = page.locator('.markdown-body');
  const note = page.locator('.note-tree .note-item').first();
  const defaultSizes = await Promise.all([fontSize(editor), fontSize(preview), fontSize(note)]);
  expect(defaultSizes[0]).toBeGreaterThanOrEqual(16);
  expect(defaultSizes[1]).toBeGreaterThanOrEqual(15);
  expect(defaultSizes[2]).toBeGreaterThan(11);
  await testInfo.attach('Default text size workspace', { body: await page.screenshot({ path: testInfo.outputPath('default-workspace.png') }), contentType: 'image/png' });

  const draft = 'A thought that stays while text grows.';
  await editor.click();
  await editor.press('ControlOrMeta+End');
  await page.keyboard.insertText(draft);
  const cursor = await page.locator('.statusbar span').filter({ hasText: /^Ln \d+, Col \d+$/ }).innerText();
  let dialog = await appearance();
  const size = dialog.getByRole('slider', { name: 'Text size', exact: true });
  await expect(size).toHaveValue('120');
  await size.focus();
  await size.press('End');
  await expect(size).toHaveValue('150');
  for (const [index, locator] of [editor, preview, note].entries()) {
    await expect.poll(() => fontSize(locator)).toBeCloseTo(defaultSizes[index] * 1.25, 1);
  }

  await dialog.getByRole('radio', { name: 'Paper theme', exact: true }).check();
  await expect(size).toHaveValue('150');
  await dialog.getByLabel('Accent hex', { exact: true }).fill('#994422');
  await dialog.getByRole('switch', { name: 'Transparent window', exact: true }).click();
  const opacity = dialog.getByRole('slider', { name: 'Background opacity', exact: true });
  await opacity.focus();
  await opacity.press('Home');
  for (let index = 0; index < 10; index++) await opacity.press('ArrowRight');
  await expect(opacity).toHaveValue('35');
  await dialog.getByRole('button', { name: 'Done', exact: true }).click();
  await expect(editor).toContainText(draft);
  await expect(page.locator('.statusbar')).toContainText(cursor);
  await testInfo.attach('Large text workspace', { body: await page.screenshot({ path: testInfo.outputPath('large-workspace.png') }), contentType: 'image/png' });
  expect(await readFile(path.join(notebook, 'Welcome to Prism.md'), 'utf8')).toBe(welcome);
  // Click a known text boundary using its DOM glyph position after resizing.
  // A stale CodeMirror measurement can place the caret at a different character.
  const draftLine = editor.locator('.cm-line').filter({ hasText: draft });
  await draftLine.scrollIntoViewIfNeeded();
  const caretPoint = await draftLine.evaluate(line => {
    const walker = document.createTreeWalker(line, NodeFilter.SHOW_TEXT);
    let remaining = 'A thought '.length;
    for (let text = walker.nextNode(); text; text = walker.nextNode()) {
      if (remaining > text.textContent!.length) { remaining -= text.textContent!.length; continue; }
      const range = document.createRange();
      range.setStart(text, remaining);
      range.collapse(true);
      const bounds = range.getBoundingClientRect();
      return { x: bounds.x, y: bounds.y + bounds.height / 2 };
    }
    throw new Error('The draft text boundary is missing.');
  });
  await page.mouse.click(caretPoint.x, caretPoint.y);
  await page.keyboard.insertText('|');
  await expect(editor).toContainText('A thought |that stays while text grows.');
  await editor.press('ControlOrMeta+z');
  await expect(editor).toContainText(draft);
  await editor.focus();
  await editor.press('ControlOrMeta+z');
  await expect(editor).not.toContainText(draft);
  await editor.press('ControlOrMeta+Shift+z');
  await expect(editor).toContainText(draft);
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.locator('.statusbar')).toContainText('All changes saved');

  await test.step('keep settings and editor controls reachable at maximum size in a small viewport', async () => {
    await page.setViewportSize({ width: 960, height: 620 });
    await expect.poll(() => page.evaluate(() => ({ width: innerWidth, height: innerHeight }))).toEqual({ width: 960, height: 620 });
    dialog = await appearance();
    for (const control of [
      dialog.getByRole('slider', { name: 'Text size', exact: true }),
      dialog.getByRole('radio', { name: 'Sci-fi theme', exact: true }),
      dialog.getByLabel('Text hex', { exact: true }),
      dialog.getByRole('slider', { name: 'Background opacity', exact: true }),
      dialog.getByRole('button', { name: 'Done', exact: true }),
    ]) {
      await control.scrollIntoViewIfNeeded();
      await expect(control).toBeInViewport();
    }
    expect(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
    for (const label of ['Accent hex', 'Page background hex', 'Text hex']) {
      expect(await dialog.getByLabel(label, { exact: true }).evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
    }
    await testInfo.attach('Large text settings in a small viewport', { body: await page.screenshot({ path: testInfo.outputPath('large-settings.png') }), contentType: 'image/png' });
    await dialog.getByRole('button', { name: 'Done', exact: true }).click();
    await page.getByRole('button', { name: 'Read', exact: true }).click();
    await expect(preview).toContainText(draft);
    await page.getByRole('button', { name: 'Split', exact: true }).click();
    await expect(editor).toBeInViewport();
    await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeInViewport();
  });

  await closeTestApp();
  await launch();
  dialog = await appearance();
  await expect(dialog.getByRole('slider', { name: 'Text size', exact: true })).toHaveValue('150');
  await dialog.getByRole('button', { name: 'Reset text size', exact: true }).click();
  await expect(dialog.getByRole('slider', { name: 'Text size', exact: true })).toHaveValue('120');
  await expect(dialog.getByRole('radio', { name: 'Paper theme', exact: true })).toBeChecked();
  await expect(dialog.getByLabel('Accent hex', { exact: true })).toHaveValue('#994422');
  await expect(dialog.getByRole('switch', { name: 'Transparent window', exact: true })).toHaveAttribute('aria-checked', 'true');
  await expect(dialog.getByRole('slider', { name: 'Background opacity', exact: true })).toHaveValue('35');
  await dialog.getByRole('button', { name: 'Done', exact: true }).click();
  await expect.poll(() => fontSize(page.getByLabel('Markdown source', { exact: true }))).toBeCloseTo(defaultSizes[0], 1);
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('prism.preferences')!))).toMatchObject({
    textScale: 120, theme: 'paper', colors: { accent: '#994422' }, transparent: true, opacity: 35, mode: 'split',
  });
  expect(await readFile(path.join(notebook, 'Welcome to Prism.md'), 'utf8')).toBe(welcome + draft);
  await expect(page.locator('.message-banner.error')).toHaveCount(0);
});
