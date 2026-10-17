import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const welcome = '# Snippet practice\n\n';
const windows = '\ufeff# Windows note\r\n\r\n';
let temporary: string;
let notebook: string;
let desktop: ElectronApplication | undefined;
let page: Page;

const editor = () => page.getByLabel('Markdown source', { exact: true });
const source = async () => (await editor().locator('.cm-line').allTextContents()).join('\n');
const selectedText = () => page.evaluate(() => window.getSelection()?.toString() ?? '');

async function replaceSource(content: string) {
  await editor().focus();
  await editor().press('ControlOrMeta+A');
  await page.keyboard.insertText(content);
}

test.beforeEach(async () => {
  temporary = await mkdtemp(path.join(os.tmpdir(), 'prism-snippets-test-'));
  notebook = path.join(temporary, 'Notebook');
  const userData = path.join(temporary, 'profile');
  await Promise.all([mkdir(notebook), mkdir(userData)]);
  await Promise.all([
    writeFile(path.join(notebook, 'Welcome to Prism.md'), welcome),
    writeFile(path.join(notebook, 'Windows note.md'), windows),
  ]);
  desktop = await electron.launch({
    args: ['--no-sandbox', '.'], cwd: process.cwd(),
    env: { ...process.env, PRISM_USER_DATA: userData, PRISM_WORKSPACE: notebook },
  });
  page = await desktop.firstWindow();
  await expect(page.locator('.note-heading h1')).toHaveText('Snippet practice');
  await expect.poll(() => desktop!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible())).toBe(true);
});

test.afterEach(async ({}, testInfo) => {
  if (page && !page.isClosed() && testInfo.status !== testInfo.expectedStatus) {
    const screenshot = await page.screenshot().catch(() => undefined);
    if (screenshot) await testInfo.attach('Snippets at failure', { body: screenshot, contentType: 'image/png' });
  }
  if (desktop) {
    // The temporary profile guarantees this is our test process, not the user's app.
    const child = desktop.process();
    const closed = desktop.waitForEvent('close', { timeout: 5_000 }).catch(() => undefined);
    await desktop.evaluate(({ app }) => app.exit(0)).catch(() => undefined);
    await closed;
    if (child.exitCode === null) child.kill();
    desktop = undefined;
  }
  if (temporary) await rm(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

test('expands immediately, follows the chosen suggestion, and edits link fields into a saved note', async ({}, testInfo) => {
  await page.getByRole('button', { name: 'Snippet help', exact: true }).click();
  const help = page.getByRole('dialog', { name: 'Markdown snippets', exact: true });
  await expect(help).toBeVisible();
  await expect(help.locator('.snippet-catalog dt')).toHaveCount(8);
  for (const trigger of ['/h1', '/h2', '/task', '/quote', '/code', '/table', '/link', '/wiki']) {
    await expect(help.locator('.snippet-catalog').getByText(trigger, { exact: true })).toBeVisible();
  }
  await help.getByRole('button', { name: 'Done', exact: true }).click();

  await editor().focus();
  await editor().press('ControlOrMeta+End');
  await editor().pressSequentially('/h1');
  // Deliberately do not wait for a completion popup before pressing Tab.
  await editor().press('Tab');
  await expect.poll(source).toBe(welcome + '# Heading\n');
  await editor().press('ControlOrMeta+z');
  await expect.poll(source).toBe(welcome + '/h1');
  await editor().press('Tab');
  await expect.poll(selectedText).toBe('Heading');
  await page.keyboard.insertText('First snippet');
  await editor().press('Tab');
  await expect(page.locator('.markdown-body h1').last()).toHaveText('First snippet');

  await editor().pressSequentially('/h');
  const options = page.getByRole('listbox');
  await expect(options.getByRole('option')).toHaveCount(2);
  await editor().press('1');
  await expect(options.getByRole('option')).toHaveCount(1);
  await editor().press('Backspace');
  await expect(options.getByRole('option')).toHaveCount(2);
  await editor().press('ArrowDown');
  await expect(options.locator('[aria-selected="true"]')).toContainText('/h2');
  await editor().press('Tab');
  await expect.poll(selectedText).toBe('Heading');
  await page.keyboard.insertText('A subsection');
  await editor().press('Tab');
  await expect(page.locator('.markdown-body h2')).toHaveText('A subsection');

  await page.keyboard.insertText('Read ');
  await editor().pressSequentially('/link');
  await editor().press('Tab');
  await expect.poll(selectedText).toBe('label');
  await page.keyboard.insertText('Prism');
  await editor().press('Tab');
  await expect.poll(selectedText).toBe('https://example.com');
  await page.keyboard.insertText('https://example.org/prism');
  await editor().press('Shift+Tab');
  await expect.poll(selectedText).toBe('Prism');
  await page.keyboard.insertText('Project');
  await editor().press('Tab');
  await expect.poll(selectedText).toBe('https://example.org/prism');
  await editor().press('Tab');
  await page.keyboard.insertText(' today.');
  const saved = welcome + '# First snippet\n## A subsection\nRead [Project](https://example.org/prism) today.';
  await expect.poll(source).toBe(saved);
  await expect(page.locator('.markdown-body a')).toHaveText('Project');
  await expect(page.locator('.markdown-body a')).toHaveAttribute('href', 'https://example.org/prism');
  expect(await readFile(path.join(notebook, 'Welcome to Prism.md'), 'utf8')).toBe(welcome);
  await editor().press('ControlOrMeta+s');
  await expect(page.locator('.statusbar')).toContainText('All changes saved');
  await expect.poll(() => readFile(path.join(notebook, 'Welcome to Prism.md'), 'utf8')).toBe(saved);

  await editor().press('Tab');
  await expect(editor()).not.toBeFocused();
  await expect.poll(source).toBe(saved);
  await testInfo.attach('Saved snippets and live preview', {
    body: await page.screenshot({ path: testInfo.outputPath('snippets-preview.png') }), contentType: 'image/png',
  });
});

test('preserves Windows line endings and lets Escape and ordinary Tab leave snippet completion', async () => {
  await page.getByRole('navigation', { name: 'Notes', exact: true }).getByRole('button', { name: 'Windows note', exact: true }).click();
  await editor().focus();
  await editor().press('ControlOrMeta+End');
  await editor().pressSequentially('/code');
  await editor().press('Tab');
  await expect.poll(selectedText).toBe('language');
  await page.keyboard.insertText('js');
  await editor().press('Tab');
  await expect.poll(selectedText).toBe('code');
  await page.keyboard.insertText('console.log("Prism");');
  await editor().press('Tab');
  await expect(page.locator('.markdown-body pre code')).toHaveText('console.log("Prism");\n');
  await editor().press('ControlOrMeta+s');
  const saved = windows + '```js\r\nconsole.log("Prism");\r\n```\r\n';
  await expect.poll(() => readFile(path.join(notebook, 'Windows note.md'), 'utf8')).toBe(saved);

  await editor().pressSequentially('/h');
  await expect(page.getByRole('listbox')).toBeVisible();
  await editor().press('Escape');
  await expect(page.getByRole('listbox')).toHaveCount(0);
  const dismissed = await source();
  await editor().press('Tab');
  await expect(editor()).not.toBeFocused();
  await expect.poll(source).toBe(dismissed);

  await replaceSource('/link');
  await editor().press('Tab');
  await expect.poll(selectedText).toBe('label');
  await editor().press('Escape');
  const abandonedFields = await source();
  await editor().press('Tab');
  await expect(editor()).not.toBeFocused();
  await expect.poll(source).toBe(abandonedFields);

  await replaceSource('/h');
  await expect(page.getByRole('listbox')).toBeVisible();
  await editor().press('Enter');
  await expect.poll(source).toBe('/h\n');
  await expect(editor()).toBeFocused();

  for (const content of ['Ordinary text', '/unknown', '`/link`']) {
    await replaceSource(content);
    await editor().press('Tab');
    await expect(editor()).not.toBeFocused();
    await expect.poll(source).toBe(content);
  }
  expect(await readFile(path.join(notebook, 'Windows note.md'), 'utf8')).toBe(saved);
  await expect(page.locator('.message-banner.error')).toHaveCount(0);
});
