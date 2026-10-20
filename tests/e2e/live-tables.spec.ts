import { electronLaunchArguments } from '../../scripts/electron-launch.mjs';
import { _electron as electron, expect, test, type ElectronApplication, type Locator, type Page } from '@playwright/test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const tableSource = '| Item | Details | Value |\n| :--- | :---: | ---: |\n| **東京** | `const value = 1` | $x^2$ |\n|  | [Linked note][guide] |  |';
const wideSource = [
  `| ${Array.from({ length: 12 }, (_, index) => `WideColumn${index + 1}WithoutBreaks`).join(' | ')} |`,
  `| ${Array.from({ length: 12 }, () => '---').join(' | ')} |`,
  `| ${Array.from({ length: 12 }, (_, index) => `value ${index + 1}`).join(' | ')} |`,
].join('\n');
const initial = `# Tables\n\n${tableSource}\n\n${wideSource}\n\n> [guide]: Linked%20note.md\n\nAfter tables.\n`;
const windows = '\ufeff# Windows tables\r\n\r\n| Name | Value |\r\n| --- | ---: |\r\n| 東京 | 1 |\r\n|  | 2 |\r\n\r\nAfter tables.\r\n';
let temporary: string;
let notebook: string;
let desktop: ElectronApplication | undefined;
let page: Page;
let pageErrors: string[];

const editor = () => page.getByLabel('Live Markdown editor', { exact: true });
const mode = (name: string) => page.getByRole('group', { name: 'Editor mode', exact: true }).getByRole('button', { name, exact: true });
const widgets = () => editor().locator('.cm-live-table');

async function saveAndExpect(name: string, content: string) {
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.locator('.statusbar')).toContainText('All changes saved');
  expect(await readFile(path.join(notebook, name), 'utf8')).toBe(content);
}

async function replaceDocument(content: string) {
  await editor().focus();
  await editor().press('ControlOrMeta+A');
  await page.keyboard.insertText(content);
}

async function expectRichTable(container: Locator) {
  const tables = container.getByRole('table');
  await expect(tables).toHaveCount(2);
  const table = tables.first();
  await expect(table.getByRole('columnheader')).toHaveText(['Item', 'Details', 'Value']);
  await expect(table.getByRole('columnheader').nth(0)).toHaveAttribute('align', 'left');
  await expect(table.getByRole('columnheader').nth(1)).toHaveAttribute('align', 'center');
  await expect(table.getByRole('columnheader').nth(2)).toHaveAttribute('align', 'right');
  await expect(table.locator('strong')).toHaveText('東京');
  await expect(table.locator('code')).toHaveText('const value = 1');
  await expect(table.locator('.katex')).toHaveCount(1);
  await expect(table.locator('.katex-mathml annotation')).toHaveText('x^2');
  await expect(table.getByRole('cell').nth(3)).toHaveText('');
  await expect(table.getByRole('cell').nth(4)).toHaveText('Linked note');
  await expect(table.getByRole('cell').nth(5)).toHaveText('');
  await expect(container.locator('.katex')).toHaveCount(1);
}

test.beforeEach(async () => {
  temporary = await mkdtemp(path.join(os.tmpdir(), 'prism-live-tables-test-'));
  notebook = path.join(temporary, 'Notebook');
  const userData = path.join(temporary, 'profile');
  await Promise.all([mkdir(notebook), mkdir(userData)]);
  await Promise.all([
    writeFile(path.join(notebook, 'Welcome to Prism.md'), initial),
    writeFile(path.join(notebook, 'Windows tables.md'), windows),
    writeFile(path.join(notebook, 'Linked note.md'), '# Linked note\n'),
  ]);
  desktop = await electron.launch({
    args: electronLaunchArguments(['--no-sandbox', '.']), cwd: process.cwd(),
    env: { ...process.env, PRISM_USER_DATA: userData, PRISM_WORKSPACE: notebook },
  });
  page = await desktop.firstWindow();
  pageErrors = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  await expect(page.locator('.note-heading h1')).toBeVisible();
  await expect.poll(() => desktop!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible())).toBe(true);
  await mode('Live').click();
  await expect(editor()).toBeVisible();
});

test.afterEach(async ({}, testInfo) => {
  if (page && !page.isClosed() && testInfo.status !== testInfo.expectedStatus) {
    const screenshot = await page.screenshot().catch(() => undefined);
    if (screenshot) await testInfo.attach('Live tables at failure', { body: screenshot, contentType: 'image/png' });
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

test('renders rich tables, keeps wide tables scrollable, and reveals source through mouse and keyboard', async ({}, testInfo) => {
  await expectRichTable(editor());
  for (const [index, alignment] of ['left', 'center', 'right'].entries()) {
    await expect(widgets().first().getByRole('columnheader').nth(index)).toHaveCSS('text-align', alignment);
  }
  for (const name of ['Split', 'Read']) {
    await mode(name).click();
    await expectRichTable(page.locator('.markdown-body'));
  }
  await mode('Live').click();

  // Focusing the explicit edit control must not remove a table before the
  // user can inspect it or scroll its cells. Activation reveals its source.
  for (const key of ['Enter', 'Space']) {
    const edit = widgets().first().getByRole('button', { name: 'Edit table', exact: true });
    await edit.focus();
    await expect(edit).toBeFocused();
    await expect(widgets()).toHaveCount(2);
    await edit.press(key);
    await expect(editor().locator('.cm-line').filter({ hasText: '| Item | Details | Value |' })).toBeVisible();
    await expect(widgets()).toHaveCount(1);
    await editor().press('ControlOrMeta+Home');
    await expect(widgets()).toHaveCount(2);
  }

  await widgets().first().getByRole('cell', { name: 'Linked note', exact: true }).click();
  await expect(page.locator('.note-heading h1')).toHaveText('Tables');
  await expect(editor()).toContainText('|  | [Linked note][guide] |  |');
  await expect(widgets()).toHaveCount(1);
  await editor().press('ControlOrMeta+Home');
  await expect(widgets()).toHaveCount(2);
  await editor().press('ArrowDown');
  await editor().press('ArrowDown');
  await expect(editor().locator('.cm-line').filter({ hasText: '| Item | Details | Value |' })).toBeVisible();
  await expect(widgets()).toHaveCount(1);
  await editor().press('ControlOrMeta+A');
  await expect(widgets()).toHaveCount(0);
  await expect(editor().locator('.katex')).toHaveCount(0);
  await editor().press('ControlOrMeta+Home');
  await expect(widgets()).toHaveCount(2);

  await page.getByRole('button', { name: 'Window appearance', exact: true }).click();
  const appearance = page.getByRole('dialog', { name: 'Make a little space', exact: true });
  const cell = widgets().first().getByRole('cell').first();
  for (const theme of ['Prism', 'Paper', 'Sci-fi']) {
    await appearance.getByRole('radio', { name: `${theme} theme`, exact: true }).check();
    await expect(widgets()).toHaveCount(2);
    await expect(cell).toBeVisible();
    await expect(cell).toHaveCSS('color', await editor().evaluate(element => getComputedStyle(element).color));
  }
  const originalSize = await cell.evaluate(element => parseFloat(getComputedStyle(element).fontSize));
  const size = appearance.getByRole('slider', { name: 'Text size', exact: true });
  const originalScale = Number(await size.inputValue());
  await size.focus();
  await size.press('End');
  await expect(size).toHaveValue('150');
  await expect.poll(() => cell.evaluate(element => parseFloat(getComputedStyle(element).fontSize)))
    .toBeCloseTo(originalSize * 150 / originalScale, 1);
  await appearance.getByLabel('Text hex', { exact: true }).fill('#ddeeff');
  await expect(cell).toHaveCSS('color', 'rgb(221, 238, 255)');
  await appearance.getByRole('switch', { name: 'Transparent window', exact: true }).click();
  const opacity = appearance.getByRole('slider', { name: 'Background opacity', exact: true });
  await opacity.focus();
  await opacity.press('Home');
  await expect(opacity).toHaveValue('25');
  await appearance.getByRole('button', { name: 'Done', exact: true }).click();
  await expect(cell).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
  await expect(page.locator('.workspace-main')).toHaveCSS('background-color', 'rgba(15, 24, 37, 0.25)');
  await expect(widgets().first().locator('.katex')).toHaveCount(1);

  const scroll = widgets().nth(1).locator('.cm-live-table-content');
  await scroll.scrollIntoViewIfNeeded();
  expect(await scroll.evaluate(element => element.scrollWidth > element.clientWidth)).toBe(true);
  await scroll.hover();
  await page.mouse.wheel(900, 0);
  await expect.poll(() => scroll.evaluate(element => element.scrollLeft)).toBeGreaterThan(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1)).toBe(true);
  const editorWidth = await editor().evaluate(element => {
    const scroller = element.closest('.cm-editor')!.querySelector('.cm-scroller')!;
    return { scroll: scroller.scrollWidth, client: scroller.clientWidth };
  });
  expect(editorWidth.scroll).toBeLessThanOrEqual(editorWidth.client + 1);
  await testInfo.attach('Rendered and scrollable Live tables', {
    body: await page.screenshot({ path: testInfo.outputPath('live-tables.png') }), contentType: 'image/png',
  });
  expect(await readFile(path.join(notebook, 'Welcome to Prism.md'), 'utf8')).toBe(initial);
  expect(pageErrors).toEqual([]);
  await expect(page.locator('.message-banner.error')).toHaveCount(0);
});

test('edits clicked cells and blank cells with undo across modes and exact BOM/CRLF saves', async () => {
  await page.getByRole('navigation', { name: 'Notes', exact: true }).getByRole('button', { name: 'Windows tables', exact: true }).click();
  await widgets().getByRole('cell', { name: '東京', exact: true }).click();
  await expect(widgets()).toHaveCount(0);
  await expect(editor()).toContainText('| --- | ---: |');
  await page.keyboard.insertText('新しい');
  await expect(editor()).toContainText('| 新しい東京 | 1 |');
  await editor().press('ControlOrMeta+Home');
  await expect(widgets().getByRole('cell', { name: '新しい東京', exact: true })).toBeVisible();
  const edited = windows.replace('東京', '新しい東京');
  await saveAndExpect('Windows tables.md', edited);

  await widgets().getByRole('cell').nth(2).click();
  await page.keyboard.insertText('空');
  await editor().press('ControlOrMeta+Home');
  await expect(widgets().getByRole('cell', { name: '空', exact: true })).toBeVisible();
  const filled = edited.replace('|  | 2 |', '| 空 | 2 |');
  await saveAndExpect('Windows tables.md', filled);

  for (const name of ['Source', 'Read', 'Live']) await mode(name).click();
  await editor().focus();
  await editor().press('ControlOrMeta+z');
  await editor().press('ControlOrMeta+Home');
  await expect(widgets().getByRole('cell').nth(2)).toHaveText('');
  await expect(widgets().getByRole('cell', { name: '新しい東京', exact: true })).toBeVisible();
  await saveAndExpect('Windows tables.md', edited);
  await editor().focus();
  await editor().press(process.platform === 'darwin' ? 'Meta+Shift+Z' : 'Control+y');
  await editor().press('ControlOrMeta+Home');
  await expect(widgets().getByRole('cell', { name: '空', exact: true })).toBeVisible();
  await saveAndExpect('Windows tables.md', filled);
  expect(pageErrors).toEqual([]);
  await expect(page.locator('.message-banner.error')).toHaveCount(0);
});

test('recovers from an incomplete table, leaves nested tables editable, and renders a completed table snippet', async () => {
  const malformed = '# Recovery\n\n| Item | Value |\n| --- |\n| 東京 | 1 |\n\nAfter tables.\n';
  await replaceDocument(malformed);
  await editor().press('ControlOrMeta+Home');
  await expect(widgets()).toHaveCount(0);
  const delimiter = editor().locator('.cm-line').filter({ hasText: /^\| --- \|$/ });
  await delimiter.click();
  await editor().press('Home');
  await editor().press('Shift+End');
  await page.keyboard.insertText('| --- | ---: |');
  await editor().press('ControlOrMeta+Home');
  await expect(widgets()).toHaveCount(1);
  await expect(widgets().getByRole('cell', { name: '東京', exact: true })).toBeVisible();
  await saveAndExpect('Welcome to Prism.md', malformed.replace('| --- |', '| --- | ---: |'));

  const nested = '# Nested\n\n> | Quote | Value |\n> | --- | --- |\n> | 東京 | 1 |\n\n- Parent\n\n  | List | Value |\n  | --- | --- |\n  | 日本語 | 2 |\n\nAfter tables.\n';
  await replaceDocument(nested);
  await editor().press('ControlOrMeta+Home');
  await expect(widgets()).toHaveCount(0);
  await expect(editor()).toContainText('| Quote | Value |');
  await expect(editor()).toContainText('| List | Value |');
  await saveAndExpect('Welcome to Prism.md', nested);

  const prefix = '# Snippet\n\n';
  await replaceDocument(prefix);
  await editor().pressSequentially('/table');
  await editor().press('Tab');
  for (const [placeholder, value] of [['Column 1', 'Name'], ['Column 2', 'Value'], ['Value 1', '東京'], ['Value 2', '空']]) {
    await expect.poll(() => page.evaluate(() => window.getSelection()?.toString())).toBe(placeholder);
    await expect(widgets()).toHaveCount(0);
    await page.keyboard.insertText(value);
    await editor().press('Tab');
  }
  await expect(widgets()).toHaveCount(1);
  await expect(widgets().getByRole('columnheader')).toHaveText(['Name', 'Value']);
  await expect(widgets().getByRole('cell')).toHaveText(['東京', '空']);
  await saveAndExpect('Welcome to Prism.md', `${prefix}| Name | Value |\n| --- | --- |\n| 東京 | 空 |\n`);
  expect(pageErrors).toEqual([]);
  await expect(page.locator('.message-banner.error')).toHaveCount(0);
});
