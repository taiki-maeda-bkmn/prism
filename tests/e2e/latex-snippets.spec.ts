import { electronLaunchArguments } from '../../scripts/electron-launch.mjs';
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const heading = '# Snippet math\n\n';
const expression = '\\mathbb{E}[(/widehat)] &= 0';
const complete = heading + '$$\n\\begin{aligned}\n' + expression + '\n\\end{aligned}\n$$\n\nAfter equation.';
const diskText = (content: string) => '\ufeff' + content.replace(/\n/g, '\r\n');
let temporary: string;
let notebook: string;
let desktop: ElectronApplication | undefined;
let page: Page;
let pageErrors: string[];

const mode = (name: string) => page.getByRole('group', { name: 'Editor mode', exact: true }).getByRole('button', { name, exact: true });
const sourceEditor = () => page.getByLabel('Markdown source', { exact: true });
const liveEditor = () => page.getByLabel('Live Markdown editor', { exact: true });
const selectedText = () => page.evaluate(() => window.getSelection()?.toString() ?? '');
const source = async () => (await sourceEditor().locator('.cm-line').allTextContents()).join('\n');

async function replaceSource(content: string) {
  await mode('Source').click();
  await sourceEditor().focus();
  await sourceEditor().press('ControlOrMeta+A');
  await page.keyboard.insertText(content);
}

async function placeAfterShortcut() {
  // Position in source first: Live mode must retain this cursor and reveal the
  // equation instead of requiring navigation through an uneditable math widget.
  await mode('Source').click();
  await sourceEditor().focus();
  await sourceEditor().press('ControlOrMeta+Home');
  for (let line = 0; line < 4; line++) await sourceEditor().press('ArrowDown');
  await sourceEditor().press('Home');
  for (let offset = 0; offset < '\\mathbb{E}[(/widehat'.length; offset++) await sourceEditor().press('ArrowRight');
}

async function saveNote(content: string) {
  await page.keyboard.press('ControlOrMeta+s');
  await expect(page.locator('.statusbar')).toContainText('All changes saved');
  await expect.poll(async () => {
    try { return await readFile(path.join(notebook, 'Welcome to Prism.md'), 'utf8'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
  }).toBe(diskText(content));
}

test.beforeEach(async () => {
  temporary = await mkdtemp(path.join(os.tmpdir(), 'prism-latex-snippets-test-'));
  notebook = path.join(temporary, 'Notebook');
  const userData = path.join(temporary, 'profile');
  await Promise.all([mkdir(notebook), mkdir(userData)]);
  await writeFile(path.join(notebook, 'Welcome to Prism.md'), diskText(heading));
  desktop = await electron.launch({
    args: electronLaunchArguments(['--no-sandbox', '.']), cwd: process.cwd(),
    env: { ...process.env, PRISM_USER_DATA: userData, PRISM_WORKSPACE: notebook },
  });
  page = await desktop.firstWindow();
  pageErrors = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  await expect(page.locator('.note-heading h1')).toHaveText('Snippet math');
  await expect.poll(() => desktop!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible())).toBe(true);
  // Earlier versions saved custom templates as blocks by default. Math must
  // insert these at the cursor without adding blank lines or changing settings.
  await page.evaluate(() => localStorage.setItem('prism.snippets', JSON.stringify({ version: 1, snippets: [
    { trigger: '/widehat', title: 'Wide hat', description: '', template: '\\widehat{${1:x}}${0}', block: true },
  ] })));
  await page.reload();
  await expect(page.locator('.note-heading h1')).toHaveText('Snippet math');
});

test.afterEach(async ({}, testInfo) => {
  if (page && !page.isClosed() && testInfo.status !== testInfo.expectedStatus) {
    const screenshot = await page.screenshot().catch(() => undefined);
    if (screenshot) await testInfo.attach('LaTeX snippets at failure', { body: screenshot, contentType: 'image/png' });
  }
  if (desktop) {
    // Only this test's application, profile, and notebook are closed/removed.
    const child = desktop.process();
    const closed = desktop.waitForEvent('close', { timeout: 5_000 }).catch(() => undefined);
    await desktop.evaluate(({ app }) => app.exit(0)).catch(() => undefined);
    await closed;
    if (child.exitCode === null) child.kill();
    desktop = undefined;
  }
  if (temporary) await rm(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

test('expands the bracketed LaTeX shortcut in Source, Split, and Live with fields, undo, and exact saves', async ({}, testInfo) => {
  for (const name of ['Source', 'Split', 'Live']) {
    await replaceSource(complete);
    await placeAfterShortcut();
    await mode(name).click();
    const editor = name === 'Live' ? liveEditor() : sourceEditor();
    await editor.focus();
    await editor.press('Tab');
    await expect.poll(selectedText).toBe('x');

    await mode('Source').click();
    await expect.poll(source).toBe(complete.replace('/widehat', '\\widehat{x}'));
    await sourceEditor().focus();
    await sourceEditor().press('ControlOrMeta+z');
    await expect.poll(source).toBe(complete);

    await placeAfterShortcut();
    await mode(name).click();
    await editor.focus();
    await editor.press('Tab');
    await expect.poll(selectedText).toBe('x');
    await page.keyboard.insertText('X');
    await editor.press('Tab');
    await page.keyboard.insertText('+1');
    const saved = complete.replace('/widehat', '\\widehat{X}+1');
    await saveNote(saved);
    await mode('Source').click();
    await expect.poll(source).toBe(saved);
    await mode('Read').click();
    await expect(page.locator('.markdown-body .katex annotation')).toHaveText('\\begin{aligned}\n\\mathbb{E}[(\\widehat{X}+1)] &= 0\n\\end{aligned}');
    await expect(page.locator('.markdown-body .prism-math-error')).toHaveCount(0);
  }
  await mode('Live').click();
  await liveEditor().focus();
  await liveEditor().press('ControlOrMeta+Home');
  await expect(liveEditor().locator('.cm-live-math-display .katex')).toHaveCount(1);
  await testInfo.attach('Bracketed LaTeX after snippet expansion', {
    body: await page.screenshot({ path: testInfo.outputPath('latex-snippet-rendered.png') }), contentType: 'image/png',
  });
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('prism.snippets')!).snippets[0].block)).toBe(true);
  expect(pageErrors).toEqual([]);
});

test('expands while a display equation is unfinished and renders after its closing delimiters are added', async () => {
  const unfinished = heading + '$$\n\\begin{aligned}\n' + expression;
  await replaceSource(unfinished);
  await placeAfterShortcut();
  await mode('Live').click();
  await expect(liveEditor().locator('.katex')).toHaveCount(0);
  await liveEditor().focus();
  await liveEditor().press('Tab');
  await expect.poll(selectedText).toBe('x');
  await page.keyboard.insertText('Y');
  await liveEditor().press('Tab');
  await page.keyboard.insertText('+2');
  const expanded = unfinished.replace('/widehat', '\\widehat{Y}+2');
  await saveNote(expanded);

  await liveEditor().focus();
  await liveEditor().press('ControlOrMeta+End');
  const ending = '\n\\end{aligned}\n$$\n\nAfter equation.';
  await page.keyboard.insertText(ending);
  await liveEditor().press('ControlOrMeta+Home');
  await expect(liveEditor().locator('.cm-live-math-display .katex annotation')).toHaveText('\\begin{aligned}\n\\mathbb{E}[(\\widehat{Y}+2)] &= 0\n\\end{aligned}');
  await expect(liveEditor().locator('.prism-math-error')).toHaveCount(0);
  await saveNote(expanded + ending);
  await mode('Source').click();
  await expect.poll(source).toBe(expanded + ending);
  expect(pageErrors).toEqual([]);
});
