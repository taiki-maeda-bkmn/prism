import { electronLaunchArguments } from '../../scripts/electron-launch.mjs';
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const initial = '# List practice\n\n'
  + '- Primary **bold**\n  - Nested bullet\n    - Deep bullet\n- Plain sibling\n\n'
  + '7. Seventh\n1. Eighth\n1. Ninth\n\n'
  + '3) Parenthesized\n1) Following\n\n'
  + '- [ ] Task survives\n- [x] Done task\n- [Go to note](Destination.md)\n\n'
  + 'After lists.\n';
const diskText = (content: string) => '\ufeff' + content.replace(/\n/g, '\r\n');
let temporary: string;
let notebook: string;
let desktop: ElectronApplication | undefined;
let page: Page;
let pageErrors: string[];

const editor = () => page.getByLabel('Live Markdown editor', { exact: true });
const mode = (name: string) => page.getByRole('group', { name: 'Editor mode', exact: true }).getByRole('button', { name, exact: true });
const lineWith = (text: string) => editor().locator('.cm-line').filter({ hasText: text });
const marker = (text: string) => lineWith(text).locator('.cm-live-list-marker');

async function showLists() {
  await editor().focus();
  await editor().press('ControlOrMeta+Home');
  await expect(marker('Primary')).toBeVisible();
}

async function saveAndExpect(content: string) {
  await page.keyboard.press('ControlOrMeta+s');
  await expect(page.locator('.statusbar')).toContainText('All changes saved');
  await expect.poll(async () => {
    try { return await readFile(path.join(notebook, 'Welcome to Prism.md'), 'utf8'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
  }).toBe(diskText(content));
}

async function replaceSource(content: string) {
  await mode('Source').click();
  const source = page.getByLabel('Markdown source', { exact: true });
  await source.focus();
  await source.press('ControlOrMeta+A');
  await page.keyboard.insertText(content);
  await mode('Live').click();
  await editor().focus();
}

test.beforeEach(async () => {
  temporary = await mkdtemp(path.join(os.tmpdir(), 'prism-live-lists-test-'));
  notebook = path.join(temporary, 'Notebook');
  const userData = path.join(temporary, 'profile');
  await Promise.all([mkdir(notebook), mkdir(userData)]);
  await Promise.all([
    writeFile(path.join(notebook, 'Welcome to Prism.md'), diskText(initial)),
    writeFile(path.join(notebook, 'Destination.md'), '# Destination\n\nA linked note.\n'),
  ]);
  desktop = await electron.launch({
    args: electronLaunchArguments(['--no-sandbox', '.']), cwd: process.cwd(),
    env: { ...process.env, PRISM_USER_DATA: userData, PRISM_WORKSPACE: notebook },
  });
  page = await desktop.firstWindow();
  pageErrors = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  await expect(page.locator('.note-heading h1')).toHaveText('List practice');
  await expect.poll(() => desktop!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible())).toBe(true);
  await mode('Live').click();
  await showLists();
});

test.afterEach(async ({}, testInfo) => {
  if (page && !page.isClosed() && testInfo.status !== testInfo.expectedStatus) {
    const screenshot = await page.screenshot().catch(() => undefined);
    if (screenshot) await testInfo.attach('Live lists at failure', { body: screenshot, contentType: 'image/png' });
  }
  if (desktop) {
    // Only this test's disposable profile and notebook are closed or removed.
    const child = desktop.process();
    const closed = desktop.waitForEvent('close', { timeout: 5_000 }).catch(() => undefined);
    await desktop.evaluate(({ app }) => app.exit(0)).catch(() => undefined);
    await closed;
    if (child.exitCode === null) child.kill();
    desktop = undefined;
  }
  if (temporary) await rm(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

test('renders nested bullets and ordered numbering alongside checkboxes and links without changing Markdown', async ({}, testInfo) => {
  for (const label of ['Primary', 'Nested bullet', 'Deep bullet', 'Plain sibling']) {
    await expect(marker(label)).toHaveAttribute('data-list-kind', 'bullet');
    await expect(marker(label)).not.toHaveText('-');
  }
  await expect(lineWith('Primary').locator('.cm-live-strong')).toHaveText('bold');
  const left = async (label: string) => {
    const bounds = await marker(label).boundingBox();
    if (!bounds) throw new Error(`The ${label} marker has no geometry.`);
    return bounds.x;
  };
  expect(await left('Nested bullet')).toBeGreaterThan(await left('Primary'));
  expect(await left('Deep bullet')).toBeGreaterThan(await left('Nested bullet'));
  for (const [label, number] of [['Seventh', '7.'], ['Eighth', '8.'], ['Ninth', '9.'], ['Parenthesized', '3.'], ['Following', '4.']]) {
    await expect(marker(label)).toHaveAttribute('data-list-kind', 'ordered');
    await expect(marker(label)).toHaveText(number);
  }
  for (const label of ['Task survives', 'Done task']) {
    await expect(lineWith(label).locator('.cm-live-list-marker')).toHaveCount(0);
    await expect(editor().getByRole('checkbox', { name: `Toggle task: ${label}`, exact: true })).toBeVisible();
  }
  const task = editor().getByRole('checkbox', { name: 'Toggle task: Task survives', exact: true });
  await task.check();
  await expect(task).toBeChecked();
  await saveAndExpect(initial.replace('[ ] Task', '[x] Task'));
  await editor().focus();
  await editor().press('ControlOrMeta+z');
  await expect(task).not.toBeChecked();
  await saveAndExpect(initial);

  await editor().locator('a.cm-live-link').filter({ hasText: /^Go to note$/ }).click({ modifiers: ['Control'] });
  await expect(page.locator('.note-heading h1')).toHaveText('Destination');
  await page.getByRole('navigation', { name: 'Notes', exact: true }).getByTitle('Welcome to Prism.md', { exact: true }).click();
  await showLists();
  await expect(page.locator('.statusbar')).toContainText('All changes saved');
  expect(await readFile(path.join(notebook, 'Welcome to Prism.md'), 'utf8')).toBe(diskText(initial));
  await testInfo.attach('Rendered lists in Live mode', {
    body: await page.screenshot({ path: testInfo.outputPath('live-lists.png') }), contentType: 'image/png',
  });
  expect(pageErrors).toEqual([]);
});

test('clicking a marker reveals exact source and preserves selection, copy, undo, and Windows saves across modes', async () => {
  await marker('Eighth').click();
  await expect(lineWith('Eighth')).toHaveText('1. Eighth');
  await expect(marker('Eighth')).toHaveCount(0);
  await editor().press('End');
  await page.keyboard.insertText(' edited');
  const edited = initial.replace('1. Eighth', '1. Eighth edited');
  await saveAndExpect(edited);
  const cursor = page.locator('.statusbar span').filter({ hasText: /^Ln \d+, Col \d+$/ });
  const position = await cursor.innerText();
  for (const name of ['Source', 'Split', 'Read', 'Live']) {
    await mode(name).click();
    await expect(cursor).toHaveText(position);
  }
  await editor().focus();
  await editor().press('ControlOrMeta+z');
  await expect(lineWith('Eighth')).toHaveText('1. Eighth');
  await saveAndExpect(initial);
  await editor().press(process.platform === 'darwin' ? 'Meta+Shift+Z' : 'Control+y');
  await expect(lineWith('Eighth edited')).toHaveText('1. Eighth edited');
  await saveAndExpect(edited);
  await showLists();
  await expect(marker('Eighth edited')).toHaveText('8.');

  await editor().press('ControlOrMeta+A');
  await expect(editor().locator('.cm-live-list-marker')).toHaveCount(0);
  const copied = await editor().evaluate(element => {
    const clipboardData = new DataTransfer();
    element.dispatchEvent(new ClipboardEvent('copy', { bubbles: true, cancelable: true, clipboardData }));
    return clipboardData.getData('text/plain');
  });
  // CodeMirror's editing document uses LF; disk saves retain the note's CRLF.
  expect(copied).toBe(edited);
  await mode('Source').click();
  const source = page.getByLabel('Markdown source', { exact: true });
  await expect(source.locator('.cm-live-list-marker')).toHaveCount(0);
  await expect.poll(async () => (await source.locator('.cm-line').allTextContents()).join('\n')).toBe(edited);
  expect(await readFile(path.join(notebook, 'Welcome to Prism.md'), 'utf8')).toBe(diskText(edited));
  expect(pageErrors).toEqual([]);
});

test('continues a typed list with Enter and accurately edits wrapped Japanese list text at larger text size', async () => {
  const typing = '# Typing lists\n\n- First item';
  await replaceSource(typing);
  await editor().press('End');
  await editor().press('Enter');
  await page.keyboard.insertText('Second item');
  const continued = typing + '\n- Second item';
  await saveAndExpect(continued);
  await editor().press('ControlOrMeta+Home');
  await expect(marker('First item')).toHaveAttribute('data-list-kind', 'bullet');
  await expect(marker('Second item')).toHaveAttribute('data-list-kind', 'bullet');

  const target = '途中の目印';
  const body = '折り返した日本語の文章です。'.repeat(8) + target + 'ここを編集します。'.repeat(3);
  const wrapped = '# Wrapped lists\n\n- ' + body + '\n\nAfter list.\n';
  await replaceSource(wrapped);
  await page.setViewportSize({ width: 1000, height: 900 });
  await page.getByRole('button', { name: 'Window appearance', exact: true }).click();
  const appearance = page.getByRole('dialog', { name: 'Make a little space', exact: true });
  const textSize = appearance.getByRole('slider', { name: 'Text size', exact: true });
  await textSize.focus();
  await textSize.press('End');
  await expect(textSize).toHaveValue('150');
  await appearance.getByRole('button', { name: 'Done', exact: true }).click();
  await editor().focus();
  await editor().press('ControlOrMeta+Home');
  const line = lineWith(target);
  await line.scrollIntoViewIfNeeded();
  await page.evaluate(async () => {
    await document.fonts.ready;
    await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
  });
  const point = await line.evaluate((element, text) => {
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const offset = node.textContent!.indexOf(text);
      if (offset < 0) continue;
      const range = document.createRange();
      range.setStart(node, offset);
      range.setEnd(node, offset + 1);
      const bounds = range.getBoundingClientRect();
      const marker = element.querySelector('.cm-live-list-marker')!.getBoundingClientRect();
      return { x: bounds.left + .1, y: bounds.top + bounds.height / 2, top: bounds.top, markerBottom: marker.bottom };
    }
    throw new Error('The wrapped Japanese edit target is missing.');
  }, target);
  expect(point.top).toBeGreaterThan(point.markerBottom);
  await page.mouse.click(point.x, point.y);
  await page.keyboard.insertText('入力');
  const changed = wrapped.replace(target, '入力' + target);
  await expect(lineWith(target)).toHaveText('- ' + body.replace(target, '入力' + target));
  await saveAndExpect(changed);
  await editor().press('ControlOrMeta+z');
  await expect(lineWith(target)).toHaveText('- ' + body);
  await saveAndExpect(wrapped);
  expect(pageErrors).toEqual([]);
});
