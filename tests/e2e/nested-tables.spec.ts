import { electronLaunchArguments } from '../../scripts/electron-launch.mjs';
import { _electron as electron, expect, test, type ElectronApplication, type Locator, type Page } from '@playwright/test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const quoted = '> | Quoted | Link | Math |\n> | :--- | --- | ---: |\n> | 東京 | [Guide][guide] | $x^2$ |\n> |  | literal \\| pipe | 3 |';
const listed = '- Parent list\n\n  | Listed | Value |\n  | --- | --- |\n  | 日本語 | 2 |\n  |  | 4 |';
const mixed = '> - | Mixed | Value |\n>   | --- | --- |\n>   | Nested | 5 |';
const after = 'After nested tables, this paragraph remains accurately editable.';
const japanese = '引用とリスト内の表の下でも、折り返した日本語を正しい位置で編集できます。'.repeat(5);
const initial = '# Nested tables\n\n' + quoted + '\n\n' + listed + '\n\n' + mixed
  + '\n\n[guide]: Destination.md#section\n\n' + after + '\n\n' + japanese + '\n\nEnd of note.\n';
const diskText = (content: string) => '\ufeff' + content.replace(/\n/g, '\r\n');
let temporary: string;
let notebook: string;
let desktop: ElectronApplication | undefined;
let page: Page;
let pageErrors: string[];

const editor = () => page.getByLabel('Live Markdown editor', { exact: true });
const mode = (name: string) => page.getByRole('group', { name: 'Editor mode', exact: true }).getByRole('button', { name, exact: true });
const widgets = () => editor().locator('.cm-live-table');
const table = (heading: string) => widgets().filter({ has: page.getByRole('columnheader', { name: heading, exact: true }) });
const lineWith = (text: string) => editor().locator('.cm-line').filter({ hasText: text });

async function showTables() {
  await editor().focus();
  await editor().press('ControlOrMeta+Home');
  await expect(widgets()).toHaveCount(3);
}

async function saveAndExpect(content: string) {
  await page.keyboard.press('ControlOrMeta+s');
  await expect(page.locator('.statusbar')).toContainText('All changes saved');
  await expect.poll(async () => {
    try { return await readFile(path.join(notebook, 'Welcome to Prism.md'), 'utf8'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
  }).toBe(diskText(content));
}

async function selectSourcePrefix(content: string, prefixLine: string) {
  await mode('Source').click();
  const source = page.getByLabel('Markdown source', { exact: true });
  await source.focus();
  await source.press('ControlOrMeta+Home');
  const lineNumber = content.slice(0, content.indexOf(prefixLine)).split('\n').length - 1;
  for (let index = 0; index < lineNumber; index++) await source.press('ArrowDown');
  await source.press('Home');
  await source.press('Shift+ArrowRight');
  await mode('Live').click();
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
      return { x: bounds.left, top: bounds.top, bottom: bounds.bottom, height: bounds.height };
    }
    throw new Error('The edit target is missing.');
  }, offset);
}

async function editAtGlyph(text: string, offset: number, wrapped = false) {
  const line = lineWith(text);
  await line.scrollIntoViewIfNeeded();
  await page.evaluate(async () => {
    await document.fonts.ready;
    await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
  });
  const bounds = await glyphBounds(line, offset);
  if (wrapped) expect(bounds.top).toBeGreaterThan((await glyphBounds(line, 0)).bottom);
  await page.mouse.click(bounds.x + .1, bounds.top + bounds.height / 2);
  await expect(editor().locator('.cm-activeLine')).toHaveText(text);
  await expect.poll(async () => {
    const current = await glyphBounds(line, offset);
    const cursor = await page.locator('.cm-cursor-primary').boundingBox();
    return cursor ? Math.max(Math.abs(cursor.y - current.top), Math.abs(cursor.y + cursor.height - current.bottom), Math.abs(cursor.x + cursor.width / 2 - current.x)) : Number.POSITIVE_INFINITY;
  }).toBeLessThan(1.5);
  await page.keyboard.insertText('追記');
  const changed = text.slice(0, offset) + '追記' + text.slice(offset);
  await expect(lineWith(changed)).toHaveText(changed);
  await saveAndExpect(initial.replace(text, changed));
  await editor().press('ControlOrMeta+z');
  await expect(lineWith(text)).toHaveText(text);
  await saveAndExpect(initial);
}

test.beforeEach(async () => {
  temporary = await mkdtemp(path.join(os.tmpdir(), 'prism-nested-tables-test-'));
  notebook = path.join(temporary, 'Notebook');
  const userData = path.join(temporary, 'profile');
  await Promise.all([mkdir(notebook), mkdir(userData)]);
  await Promise.all([
    writeFile(path.join(notebook, 'Welcome to Prism.md'), diskText(initial)),
    writeFile(path.join(notebook, 'Destination.md'), '# Destination\n\n## Section\n\nLinked from a nested table.\n'),
  ]);
  desktop = await electron.launch({
    args: electronLaunchArguments(['--no-sandbox', '.']), cwd: process.cwd(),
    env: { ...process.env, PRISM_USER_DATA: userData, PRISM_WORKSPACE: notebook },
  });
  page = await desktop.firstWindow();
  pageErrors = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  await expect(page.locator('.note-heading h1')).toHaveText('Nested tables');
  await expect.poll(() => desktop!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible())).toBe(true);
  await mode('Live').click();
  await showTables();
});

test.afterEach(async ({}, testInfo) => {
  if (page && !page.isClosed() && testInfo.status !== testInfo.expectedStatus) {
    const screenshot = await page.screenshot().catch(() => undefined);
    if (screenshot) await testInfo.attach('Nested tables at failure', { body: screenshot, contentType: 'image/png' });
  }
  if (desktop) {
    const child = desktop.process();
    const closed = desktop.waitForEvent('close', { timeout: 5_000 }).catch(() => undefined);
    await desktop.evaluate(({ app }) => app.exit(0)).catch(() => undefined);
    await closed;
    if (child.exitCode === null) child.kill();
    desktop = undefined;
  }
  if (temporary) await rm(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

test('renders quoted, listed, and mixed tables with references and math while retaining every container prefix', async ({}, testInfo) => {
  await expect(table('Quoted').getByRole('columnheader')).toHaveText(['Quoted', 'Link', 'Math']);
  await expect(table('Listed').getByRole('columnheader')).toHaveText(['Listed', 'Value']);
  await expect(table('Mixed').getByRole('columnheader')).toHaveText(['Mixed', 'Value']);
  await expect(table('Quoted').getByRole('columnheader').first()).toHaveAttribute('align', 'left');
  await expect(table('Quoted').getByRole('columnheader').last()).toHaveAttribute('align', 'right');
  await expect(table('Quoted').getByRole('cell', { name: 'literal | pipe', exact: true })).toBeVisible();
  await expect(table('Quoted').locator('.katex annotation')).toHaveText('x^2');
  await expect(editor().locator('.katex')).toHaveCount(1);
  await expect(lineWith('Parent list')).toContainText('Parent list');

  await table('Quoted').getByRole('link', { name: 'Guide', exact: true }).click({ modifiers: ['Control'] });
  await expect(page.locator('.note-heading h1')).toHaveText('Destination');
  await expect(editor().locator('.cm-live-heading-2')).toContainText('Section');
  await page.getByRole('navigation', { name: 'Notes', exact: true }).getByTitle('Welcome to Prism.md', { exact: true }).click();
  await showTables();

  for (const [heading, prefixLine] of [['Quoted', '> | Quoted | Link | Math |'], ['Listed', '  | Listed | Value |'], ['Mixed', '> - | Mixed | Value |']]) {
    await selectSourcePrefix(initial, prefixLine);
    await expect(table(heading)).toHaveCount(0);
    await expect(widgets()).toHaveCount(2);
    await expect(lineWith(prefixLine)).toHaveText(prefixLine);
    await showTables();
  }
  await editor().press('ControlOrMeta+A');
  await expect(widgets()).toHaveCount(0);
  const copied = await editor().evaluate(element => {
    const clipboardData = new DataTransfer();
    element.dispatchEvent(new ClipboardEvent('copy', { bubbles: true, cancelable: true, clipboardData }));
    return clipboardData.getData('text/plain');
  });
  expect(copied).toBe(initial);
  await showTables();
  expect(await readFile(path.join(notebook, 'Welcome to Prism.md'), 'utf8')).toBe(diskText(initial));
  await testInfo.attach('Tables nested inside quotes and lists', { body: await page.screenshot({ path: testInfo.outputPath('nested-tables.png') }), contentType: 'image/png' });
  await testInfo.attach('Mixed quote and list table', { body: await table('Mixed').screenshot({ path: testInfo.outputPath('mixed-table.png') }), contentType: 'image/png' });
  expect(pageErrors).toEqual([]);
});

test('clicks the original cell positions after preceding edits and preserves prefixes, undo, and BOM/CRLF saves', async () => {
  await editor().focus();
  await editor().press('ControlOrMeta+Home');
  await page.keyboard.insertText('A new introduction.\n\n');
  let saved = 'A new introduction.\n\n' + initial;
  await expect(widgets()).toHaveCount(3);
  for (const [heading, cell, insert] of [['Quoted', '東京', '新しい'], ['Listed', '日本語', '編集'], ['Mixed', 'Nested', 'Deep ']]) {
    await table(heading).getByRole('cell', { name: cell, exact: true }).click();
    await expect(table(heading)).toHaveCount(0);
    await page.keyboard.insertText(insert);
    saved = saved.replace(`| ${cell} |`, `| ${insert}${cell} |`);
    await saveAndExpect(saved);
    await showTables();
    await expect(table(heading).getByRole('cell', { name: insert + cell, exact: true })).toBeVisible();
  }
  // Filling an empty prefixed cell must not eat its surrounding pipes/spaces.
  await table('Listed').getByRole('cell').nth(2).click();
  await page.keyboard.insertText('空');
  const filled = saved.replace('  |  | 4 |', '  | 空 | 4 |');
  await saveAndExpect(filled);
  for (const name of ['Source', 'Split', 'Read', 'Live']) await mode(name).click();
  await editor().focus();
  await editor().press('ControlOrMeta+z');
  await showTables();
  await expect(table('Listed').getByRole('cell').nth(2)).toHaveText('');
  await saveAndExpect(saved);
  await editor().press(process.platform === 'darwin' ? 'Meta+Shift+Z' : 'Control+y');
  await showTables();
  await expect(table('Listed').getByRole('cell').nth(2)).toHaveText('空');
  await saveAndExpect(filled);
  await mode('Source').click();
  const source = page.getByLabel('Markdown source', { exact: true });
  await expect.poll(async () => (await source.locator('.cm-line').allTextContents()).join('\n')).toBe(filled);
  expect(pageErrors).toEqual([]);
});

test('keeps the drawn caret aligned below nested widgets after reveal, theme changes, and larger Japanese text', async () => {
  await page.setViewportSize({ width: 980, height: 900 });
  await editAtGlyph(after, 'After nested tables, '.length);
  await editAtGlyph(japanese, 60, true);
  for (const heading of ['Quoted', 'Listed', 'Mixed']) {
    await showTables();
    await table(heading).getByRole('button', { name: 'Edit table', exact: true }).click();
    await expect(table(heading)).toHaveCount(0);
    await showTables();
  }
  await page.getByRole('button', { name: 'Window appearance', exact: true }).click();
  const appearance = page.getByRole('dialog', { name: 'Make a little space', exact: true });
  await appearance.getByRole('radio', { name: 'Sci-fi theme', exact: true }).check();
  const size = appearance.getByRole('slider', { name: 'Text size', exact: true });
  await size.focus();
  await size.press('End');
  await expect(size).toHaveValue('150');
  await appearance.getByRole('button', { name: 'Done', exact: true }).click();
  await editAtGlyph(japanese, 60, true);
  expect(pageErrors).toEqual([]);
});
