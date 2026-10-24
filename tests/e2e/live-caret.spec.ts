import { electronLaunchArguments } from '../../scripts/electron-launch.mjs';
import { _electron as electron, expect, test, type ElectronApplication, type Locator, type Page } from '@playwright/test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const afterTable = 'After the first table, this is the clicked paragraph.';
const japanese = '折り返した日本語の行でも、見えている文字の位置を正しく選択します。'.repeat(5);
const initial = [
  '# Live cursor positions', '',
  '| First table | Value |', '| --- | --- |', '| One | 1 |', '',
  afterTable, '', '$$x^2$$', '',
  '| Second table | Value |', '| --- | --- |', '| Two | 2 |', '',
  '$$\\frac{a}{b}$$', '', japanese, '',
  'A final paragraph keeps the target away from the document boundary.', '',
].join('\n');
let temporary: string;
let notebook: string;
let desktop: ElectronApplication | undefined;
let page: Page;

const editor = () => page.getByLabel('Live Markdown editor', { exact: true });
const lineWith = (text: string) => editor().locator('.cm-line').filter({ hasText: text });

async function settleLayout() {
  await page.evaluate(async () => {
    await document.fonts.ready;
    await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
  });
}

async function glyphBounds(line: Locator, offset: number) {
  return line.evaluate((element, boundary) => {
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    let remaining = boundary;
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const length = node.textContent!.length;
      if (remaining >= length) { remaining -= length; continue; }
      const range = document.createRange();
      range.setStart(node, remaining);
      range.setEnd(node, remaining + 1);
      const bounds = range.getBoundingClientRect();
      return { left: bounds.left, top: bounds.top, bottom: bounds.bottom, height: bounds.height };
    }
    throw new Error('The requested text boundary is missing.');
  }, offset);
}

async function saveAndExpect(content: string) {
  await editor().press('ControlOrMeta+s');
  await expect(page.locator('.statusbar')).toContainText('All changes saved');
  await expect.poll(async () => {
    // Atomic publication briefly moves the previous file out of the way.
    try { return await readFile(path.join(notebook, 'Welcome to Prism.md'), 'utf8'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
  }).toBe(content);
}

async function editAtGlyph(text: string, offset: number, wrapped = false) {
  const line = lineWith(text);
  await line.scrollIntoViewIfNeeded();
  await settleLayout();
  const target = await glyphBounds(line, offset);
  if (wrapped) {
    const first = await glyphBounds(line, 0);
    expect(target.top).toBeGreaterThan(first.bottom);
  }
  // Use the glyph's leading edge rather than the line box: wrapped lines and
  // rendered blocks can have very different heights from ordinary source.
  await page.mouse.click(target.left + .1, target.top + target.height / 2);
  await expect(editor().locator('.cm-activeLine')).toHaveText(text);
  await expect.poll(async () => {
    const glyph = await glyphBounds(line, offset);
    const cursor = await page.locator('.cm-cursor-primary').boundingBox();
    if (!cursor) return Number.POSITIVE_INFINITY;
    return Math.max(
      Math.abs(cursor.y - glyph.top),
      Math.abs(cursor.y + cursor.height - glyph.bottom),
      Math.abs(cursor.x + cursor.width / 2 - glyph.left),
    );
  }, { message: 'The drawn caret should align with the clicked glyph after rendered blocks' }).toBeLessThan(1.5);

  const changed = text.slice(0, offset) + 'INSERTED' + text.slice(offset);
  await page.keyboard.insertText('INSERTED');
  await expect(lineWith(changed)).toHaveText(changed);
  await saveAndExpect(initial.replace(text, changed));
  await editor().press('ControlOrMeta+z');
  await expect(lineWith(text)).toHaveText(text);
  await saveAndExpect(initial);
}

test.beforeEach(async () => {
  temporary = await mkdtemp(path.join(os.tmpdir(), 'prism-live-caret-test-'));
  notebook = path.join(temporary, 'Notebook');
  const userData = path.join(temporary, 'profile');
  await Promise.all([mkdir(notebook), mkdir(userData)]);
  await writeFile(path.join(notebook, 'Welcome to Prism.md'), initial);
  desktop = await electron.launch({
    args: electronLaunchArguments(['--no-sandbox', '.']), cwd: process.cwd(),
    env: { ...process.env, PRISM_USER_DATA: userData, PRISM_WORKSPACE: notebook },
  });
  page = await desktop.firstWindow();
  await expect(page.locator('.note-heading h1')).toBeVisible();
  await expect.poll(() => desktop!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible())).toBe(true);
  await page.setViewportSize({ width: 960, height: 900 });
  await page.getByRole('group', { name: 'Editor mode', exact: true }).getByRole('button', { name: 'Live', exact: true }).click();
  await expect(editor()).toBeVisible();
});

test.afterEach(async ({}, testInfo) => {
  if (page && !page.isClosed() && testInfo.status !== testInfo.expectedStatus) {
    const screenshot = await page.screenshot().catch(() => undefined);
    if (screenshot) await testInfo.attach('Live caret at failure', { body: screenshot, contentType: 'image/png' });
  }
  if (desktop) {
    // This process has a temporary profile and does not share the user's notes.
    const child = desktop.process();
    const closed = desktop.waitForEvent('close', { timeout: 5_000 }).catch(() => undefined);
    await desktop.evaluate(({ app }) => app.exit(0)).catch(() => undefined);
    await closed;
    if (child.exitCode === null) child.kill();
    desktop = undefined;
  }
  if (temporary) await rm(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

test('keeps clicked text and the drawn caret aligned below tables and math across reflow', async () => {
  await expect(editor().locator('.cm-live-table')).toHaveCount(2);
  await expect(editor().locator('.cm-live-math-display')).toHaveCount(2);
  await editAtGlyph(afterTable, 'After the '.length);
  await editAtGlyph(japanese, 60, true);

  // Revealing and hiding blocks changes their height without changing the note.
  await editor().locator('.cm-live-table').first().getByRole('button', { name: 'Edit table', exact: true }).click();
  await expect(lineWith('| First table | Value |')).toBeVisible();
  await editor().press('ControlOrMeta+Home');
  await expect(editor().locator('.cm-live-table')).toHaveCount(2);
  await editor().getByRole('button', { name: 'Edit formula: x^2', exact: true }).click();
  await expect(lineWith('$$x^2$$')).toBeVisible();
  await editor().press('ControlOrMeta+Home');
  await expect(editor().locator('.cm-live-math-display')).toHaveCount(2);
  await editAtGlyph(japanese, 60, true);

  await page.getByRole('button', { name: 'Window appearance', exact: true }).click();
  const appearance = page.getByRole('dialog', { name: 'Make a little space', exact: true });
  await appearance.getByRole('radio', { name: 'Sci-fi theme', exact: true }).check();
  const size = appearance.getByRole('slider', { name: 'Text size', exact: true });
  await size.focus();
  await size.press('End');
  await expect(size).toHaveValue('150');
  await appearance.getByRole('button', { name: 'Done', exact: true }).click();
  await editAtGlyph(japanese, 60, true);
  await expect(page.locator('.message-banner.error')).toHaveCount(0);
});
