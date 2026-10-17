import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const initial = '# Blocks\n\n```java\nclass Demo {\n\n  String text = "**literal**";\n}\n```\n\n- [ ] Write note\n- [x] Finished\n\nA final paragraph.\n';
const windows = '\ufeff# Windows blocks\r\n\r\n';
let temporary: string;
let notebook: string;
let desktop: ElectronApplication | undefined;
let page: Page;

const editor = () => page.getByLabel('Live Markdown editor', { exact: true });
const mode = (name: string) => page.getByRole('group', { name: 'Editor mode', exact: true }).getByRole('button', { name, exact: true });
const task = (name: string) => editor().getByRole('checkbox', { name: `Toggle task: ${name}`, exact: true });

async function saveAndExpect(name: string, content: string) {
  await editor().press('ControlOrMeta+s');
  await expect(page.locator('.statusbar')).toContainText('All changes saved');
  expect(await readFile(path.join(notebook, name), 'utf8')).toBe(content);
}

test.beforeEach(async () => {
  temporary = await mkdtemp(path.join(os.tmpdir(), 'prism-live-blocks-test-'));
  notebook = path.join(temporary, 'Notebook');
  const userData = path.join(temporary, 'profile');
  await Promise.all([mkdir(notebook), mkdir(userData)]);
  await Promise.all([
    writeFile(path.join(notebook, 'Welcome to Prism.md'), initial),
    writeFile(path.join(notebook, 'Windows blocks.md'), windows),
  ]);
  desktop = await electron.launch({
    args: ['--no-sandbox', '.'], cwd: process.cwd(),
    env: { ...process.env, PRISM_USER_DATA: userData, PRISM_WORKSPACE: notebook },
  });
  page = await desktop.firstWindow();
  await expect(page.locator('.note-heading h1')).toBeVisible();
  await expect.poll(() => desktop!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible())).toBe(true);
  await mode('Live').click();
  await expect(editor()).toBeVisible();
});

test.afterEach(async ({}, testInfo) => {
  if (page && !page.isClosed() && testInfo.status !== testInfo.expectedStatus) {
    const screenshot = await page.screenshot().catch(() => undefined);
    if (screenshot) await testInfo.attach('Live blocks at failure', { body: screenshot, contentType: 'image/png' });
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

test('edits rendered code and toggles real task checkboxes with exact saves, undo, and copy', async ({}, testInfo) => {
  await expect(editor().locator('.cm-live-code-language')).toHaveText('java');
  await expect(editor().locator('.cm-live-codeblock')).toHaveCount(6);
  await expect(editor().locator('.cm-live-codeblock').filter({ hasText: 'String text' })).toHaveText('  String text = "**literal**";');
  await expect(editor().locator('.cm-live-codeblock .cm-live-strong')).toHaveCount(0);
  const body = editor().locator('.cm-live-codeblock').filter({ hasText: /^class Demo \{$/ });
  expect(await body.evaluate(element => getComputedStyle(element).fontFamily)).toMatch(/mono|Consolas|Cascadia/i);
  const keyword = body.locator('span').filter({ hasText: /^class$/ });
  await expect(keyword).toBeVisible();
  await expect.poll(() => keyword.evaluate(element => getComputedStyle(element).fontWeight)).toBe('600');
  expect(await body.evaluate(element => getComputedStyle(element).fontWeight)).toBe('400');
  const literal = editor().locator('.cm-live-codeblock span').filter({ hasText: /^"\*\*literal\*\*"$/ });
  await expect(literal).toBeVisible();
  expect(await keyword.evaluate(element => getComputedStyle(element).color)).not.toBe(await literal.evaluate(element => getComputedStyle(element).color));
  await expect(task('Write note')).not.toBeChecked();
  await expect(task('Finished')).toBeChecked();

  await body.click();
  await editor().press('End');
  await page.keyboard.insertText(' // edited /task');
  await expect(page.getByRole('listbox')).toHaveCount(0);
  await editor().press('Tab');
  const edited = initial.replace('class Demo {', 'class Demo { // edited /task');
  await expect(body).toHaveCount(0);
  await saveAndExpect('Welcome to Prism.md', edited);
  await task('Write note').check();
  await expect(task('Write note')).toBeChecked();
  const checked = edited.replace('- [ ] Write note', '- [x] Write note');
  await saveAndExpect('Welcome to Prism.md', checked);

  for (const name of ['Source', 'Read', 'Live']) await mode(name).click();
  await editor().focus();
  await editor().press('ControlOrMeta+z');
  await expect(task('Write note')).not.toBeChecked();
  await saveAndExpect('Welcome to Prism.md', edited);
  await editor().press(process.platform === 'darwin' ? 'Meta+Shift+Z' : 'Control+y');
  await expect(task('Write note')).toBeChecked();
  await saveAndExpect('Welcome to Prism.md', checked);

  await task('Write note').focus();
  await task('Write note').press('Space');
  await expect(task('Write note')).not.toBeChecked();
  await expect(task('Write note')).toBeFocused();
  await task('Write note').press('Space');
  await expect(task('Write note')).toBeChecked();
  await saveAndExpect('Welcome to Prism.md', checked);

  // Moving onto a fence reveals editable source and moving away restores it.
  await editor().locator('.cm-live-code-language').click();
  await expect(editor().locator('.cm-live-codeblock-start')).toHaveText('```java');
  await editor().press('ArrowDown');
  await expect(editor().locator('.cm-live-code-language')).toHaveText('java');

  await editor().press('ControlOrMeta+A');
  const copied = await editor().evaluate(element => {
    const clipboardData = new DataTransfer();
    element.dispatchEvent(new ClipboardEvent('copy', { bubbles: true, cancelable: true, clipboardData }));
    return clipboardData.getData('text/plain');
  });
  expect(copied).toBe(checked);
  await mode('Source').click();
  const source = page.getByLabel('Markdown source', { exact: true });
  await expect(source.locator('.cm-live-codeblock, .cm-live-task-checkbox')).toHaveCount(0);
  await expect.poll(async () => (await source.locator('.cm-line').allTextContents()).join('\n')).toBe(checked);
  await mode('Live').click();
  await editor().press('ControlOrMeta+Home');
  await testInfo.attach('Editable code and checklists', { body: await page.screenshot(), contentType: 'image/png' });
  await expect(page.locator('.message-banner.error')).toHaveCount(0);
});

test('code and task snippets render immediately and preserve Windows line endings and BOM', async () => {
  await page.getByRole('navigation', { name: 'Notes', exact: true }).getByRole('button', { name: 'Windows blocks', exact: true }).click();
  await editor().focus();
  await editor().press('ControlOrMeta+End');
  await editor().pressSequentially('/code');
  await editor().press('Tab');
  await expect.poll(() => page.evaluate(() => window.getSelection()?.toString())).toBe('language');
  await page.keyboard.insertText('java');
  await editor().press('Tab');
  await expect.poll(() => page.evaluate(() => window.getSelection()?.toString())).toBe('code');
  const code = 'class Hello {\n\n  int value = 1;\n}';
  await page.keyboard.insertText(code);
  await editor().press('Tab');
  await expect(editor().locator('.cm-live-code-language')).toHaveText('java');
  await expect(editor().locator('.cm-live-codeblock')).toHaveCount(6);
  await editor().pressSequentially('/task');
  await editor().press('Tab');
  await expect.poll(() => page.evaluate(() => window.getSelection()?.toString())).toBe('Task');
  await page.keyboard.insertText('Ship this note');
  await editor().press('Tab');
  await expect(task('Ship this note')).not.toBeChecked();
  const written = windows + ('```java\n' + code + '\n```\n- [ ] Ship this note\n').replaceAll('\n', '\r\n');
  await saveAndExpect('Windows blocks.md', written);
  await task('Ship this note').check();
  await expect(task('Ship this note')).toBeChecked();
  await saveAndExpect('Windows blocks.md', written.replace('[ ] Ship', '[x] Ship'));
  await expect(page.locator('.message-banner.error')).toHaveCount(0);
});

test('an unfinished fence keeps code literal while its closing fence can be typed and edited', async () => {
  await editor().focus();
  await editor().press('ControlOrMeta+A');
  const open = 'An example\n\n```md\n# **Literal heading**\n- [ ] Literal task\n';
  await page.keyboard.insertText(open);
  await expect(editor().locator('.cm-live-code-language')).toHaveText('md');
  await expect(editor().locator('.cm-live-heading-1, .cm-live-task-checkbox')).toHaveCount(0);
  await expect(editor()).toContainText('# **Literal heading**');
  await expect(editor()).toContainText('- [ ] Literal task');
  await page.keyboard.insertText('```\n\n- [ ] Real task\n');
  await expect(task('Real task')).not.toBeChecked();
  await expect(editor().locator('.cm-live-task-checkbox')).toHaveCount(1);
  const closed = open + '```\n\n- [ ] Real task\n';
  await saveAndExpect('Welcome to Prism.md', closed);
  await task('Real task').check();
  await saveAndExpect('Welcome to Prism.md', closed.replace('[ ] Real', '[x] Real'));
  await expect(page.locator('.message-banner.error')).toHaveCount(0);
});
