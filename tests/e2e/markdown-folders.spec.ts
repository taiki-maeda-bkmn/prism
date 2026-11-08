import { electronLaunchArguments } from '../../scripts/electron-launch.mjs';
import { _electron as electron, expect, test, type ElectronApplication, type Locator, type Page } from '@playwright/test';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const welcomePath = 'Welcome to Prism.md';
const original = '\ufeff# Folder notebook\r\n\r\nフォルダを作っても、このノートを保持する。\r\n';
const draft = '追記：未保存の日本語をそのまま残す。';
let temporary: string;
let notebook: string;
let userData: string;
let desktop: ElectronApplication | undefined;
let page: Page;
let errors: string[];

const editor = () => page.locator('.app-body .cm-content');
const sidebar = () => page.locator('#notes-navigation');
const tree = () => page.getByRole('navigation', { name: 'Notes', exact: true });
const filter = () => page.getByRole('combobox', { name: 'Filter notes by folder', exact: true });
const folderDialog = () => page.getByRole('dialog', { name: 'New folder', exact: true });
const noteDialog = () => page.getByRole('dialog', { name: 'A new place for an idea', exact: true });

async function launch() {
  const applicationRoot = path.resolve(process.env.PRISM_TEST_APP_ROOT || process.cwd());
  const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
  delete env.ELECTRON_RUN_AS_NODE;
  desktop = await electron.launch({
    executablePath: process.env.PRISM_TEST_ELECTRON,
    args: electronLaunchArguments(['--no-sandbox', applicationRoot]), cwd: applicationRoot,
    env: { ...env, PRISM_USER_DATA: userData, PRISM_WORKSPACE: notebook, PRISM_PDF_USER_DATA: path.join(temporary, 'pdf-profile') },
  });
  page = await desktop.firstWindow();
  page.on('pageerror', error => errors.push(error.message));
  await expect(page.locator('.note-heading h1')).toHaveText('Folder notebook');
  await expect.poll(() => desktop!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible())).toBe(true);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.getByRole('group', { name: 'Editor mode', exact: true }).getByRole('button', { name: 'Source', exact: true }).click();
}

async function stop() {
  if (!desktop) return;
  const child = desktop.process();
  const closed = desktop.waitForEvent('close', { timeout: 5000 }).catch(() => undefined);
  await desktop.evaluate(({ app }) => app.exit(0)).catch(() => undefined);
  await closed;
  if (child.exitCode === null) child.kill();
  desktop = undefined;
}

async function append(text: string) {
  await editor().focus();
  await editor().press('ControlOrMeta+End');
  await page.keyboard.insertText(text);
  await expect(editor()).toContainText(text);
}

async function openNote(relative: string) {
  await tree().getByTitle(relative, { exact: true }).click();
  await expect(editor()).toBeVisible();
}

async function openFolderDialog(name: string, parent = '') {
  await sidebar().getByRole('button', { name: 'New folder', exact: true }).click();
  await folderDialog().getByRole('textbox', { name: 'Folder name', exact: true }).fill(name);
  await folderDialog().getByRole('combobox', { name: 'Parent folder', exact: true }).selectOption(parent);
}

async function createFolder(name: string, parent = '') {
  await openFolderDialog(name, parent);
  await folderDialog().getByRole('button', { name: 'Create folder', exact: true }).click();
  await expect(folderDialog()).toBeHidden();
  const relative = [parent, name].filter(Boolean).join('/');
  await expect.poll(async () => {
    try { return (await stat(path.join(notebook, relative))).isDirectory(); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
  }).toBe(true);
  await expect.poll(() => filter().locator('option').allTextContents()).toContain(relative);
}

async function published(relative: string) {
  try { return await readFile(path.join(notebook, relative), 'utf8'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
}

async function save(relative: string, expected: string) {
  await editor().press('ControlOrMeta+s');
  await expect.poll(() => published(relative)).toBe(expected);
  await expect(page.locator('.statusbar')).not.toContainText('Working…');
  await expect(page.locator('.save-button')).toBeDisabled();
}

async function inside(control: Locator, container: Locator) {
  await expect(control).toBeVisible();
  const box = await control.boundingBox();
  const bounds = await container.boundingBox();
  if (!box || !bounds) throw new Error('Folder controls are not visible.');
  expect(box.x).toBeGreaterThanOrEqual(bounds.x);
  expect(box.x + box.width).toBeLessThanOrEqual(bounds.x + bounds.width + 1);
}

test.beforeEach(async () => {
  temporary = await mkdtemp(path.join(os.tmpdir(), 'prism-markdown-folders-'));
  notebook = path.join(temporary, 'Notebook');
  userData = path.join(temporary, 'notes-profile');
  errors = [];
  await Promise.all([
    mkdir(path.join(notebook, 'Existing/Nested'), { recursive: true }),
    mkdir(path.join(notebook, 'ExistingPlus'), { recursive: true }),
    mkdir(path.join(notebook, 'Empty'), { recursive: true }),
    mkdir(userData),
  ]);
  await Promise.all([
    writeFile(path.join(notebook, welcomePath), original),
    writeFile(path.join(notebook, 'Root note.md'), '# Root note\n\nRoot-only paragraph.\n'),
    writeFile(path.join(notebook, 'Existing/One.md'), '# Grouped note\n\nneedle in the parent folder.\n'),
    writeFile(path.join(notebook, 'Existing/Nested/Two.md'), '# Nested note\n\nneedle nested-only paragraph.\n\n[[Root note|Open the root note]]\n'),
    writeFile(path.join(notebook, 'ExistingPlus/Other.md'), '# Prefix sibling\n\nneedle outside the selected folder.\n'),
  ]);
  await launch();
});

test.afterEach(async ({}, testInfo) => {
  if (page && !page.isClosed() && testInfo.status !== testInfo.expectedStatus) {
    const screenshot = await page.screenshot().catch(() => undefined);
    if (screenshot) await testInfo.attach('Markdown folders at failure', { body: screenshot, contentType: 'image/png' });
  }
  await stop();
  if (temporary) await rm(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

test('creates real nested folders and notes without losing another draft, then restores the folders after restart', async ({}, testInfo) => {
  await expect(filter()).toContainText('Empty');
  await expect(tree().getByRole('button', { name: 'Empty', exact: true })).toBeVisible();
  await append(draft);
  const originalEditor = await editor().elementHandle();
  await createFolder('資料', 'Existing');
  await expect(editor()).toContainText(draft);
  expect(await editor().evaluate((element, original) => element === original, originalEditor)).toBe(true);
  expect(await published(welcomePath)).toBe(original);

  await filter().selectOption('Existing/資料');
  await expect(tree().locator('.note-item')).toHaveCount(0);
  await editor().focus();
  await editor().press('ControlOrMeta+n');
  await expect(noteDialog().getByRole('combobox', { name: 'Note folder', exact: true })).toHaveValue('Existing/資料');
  await noteDialog().getByRole('textbox', { name: 'Note name', exact: true }).fill('追加/下書き');
  await noteDialog().getByRole('button', { name: 'Create note', exact: true }).click();
  await expect(noteDialog()).toBeHidden();
  await expect(page.locator('.document-location')).toContainText('Existing/資料/追加/下書き');
  const newPath = 'Existing/資料/追加/下書き.md';
  await expect.poll(() => published(newPath)).toBe('# 下書き\n\n');
  const newContent = '# 新しいフォルダのノート\n\n本文をここに保存する。\n';
  await editor().focus();
  await editor().press('ControlOrMeta+a');
  await page.keyboard.insertText(newContent);
  await save(newPath, newContent);
  await expect(page.locator('.statusbar')).toContainText('1 unsaved note');
  expect(await published(welcomePath)).toBe(original);
  await expect(filter()).toContainText('Existing/資料/追加');

  await filter().selectOption('*');
  await openNote(welcomePath);
  await expect(editor()).toContainText(draft);
  await editor().focus();
  await editor().press('ControlOrMeta+z');
  await expect(editor()).not.toContainText(draft);
  await editor().press(process.platform === 'win32' ? 'Control+y' : 'ControlOrMeta+Shift+z');
  await expect(editor()).toContainText(draft);
  await save(welcomePath, original + draft);
  await expect(page.locator('.statusbar')).toContainText('All changes saved');
  await filter().selectOption('Existing/資料');
  const closed = desktop!.waitForEvent('close');
  await page.getByRole('button', { name: 'Close window', exact: true }).click();
  await closed;
  desktop = undefined;
  await launch();
  await expect(filter()).toHaveValue('Existing/資料');
  await expect(filter()).toContainText('Existing/資料/追加');
  await expect(filter()).toContainText('Empty');
  await filter().selectOption('Existing/資料');
  await openNote(newPath);
  await expect(editor()).toContainText('本文をここに保存する。');
  expect(await published(welcomePath)).toBe(original + draft);
  expect(await published(newPath)).toBe(newContent);
  await testInfo.attach('Nested Markdown folders with a selected destination', {
    body: await page.screenshot({ path: testInfo.outputPath('markdown-folders.png') }), contentType: 'image/png',
  });
  expect(errors).toEqual([]);
});

test('scopes search to folders and retains save-conflict protection through folder creation', async ({}, testInfo) => {
  await filter().selectOption('');
  await expect(tree().locator('.note-item')).toHaveCount(2);
  await expect(tree().getByTitle(welcomePath, { exact: true })).toBeVisible();
  await expect(tree().getByTitle('Existing/One.md', { exact: true })).toHaveCount(0);
  await filter().selectOption('Existing');
  await expect(tree().locator('.note-item')).toHaveCount(2);
  await expect(tree().getByTitle('Existing/Nested/Two.md', { exact: true })).toBeVisible();
  await expect(tree().getByTitle('ExistingPlus/Other.md', { exact: true })).toHaveCount(0);
  await page.getByRole('textbox', { name: 'Search notes', exact: true }).fill('nested-only');
  await expect(tree().locator('.note-item')).toHaveCount(1);
  await expect(tree().getByTitle('Existing/Nested/Two.md', { exact: true })).toBeVisible();
  await filter().selectOption('ExistingPlus');
  await expect(page.locator('.note-list-scroll .note-item')).toHaveCount(0);
  await page.getByRole('textbox', { name: 'Search notes', exact: true }).fill('');
  await expect(tree().getByTitle('ExistingPlus/Other.md', { exact: true })).toBeVisible();

  await filter().selectOption('Existing/Nested');
  await openNote('Existing/Nested/Two.md');
  const modes = page.getByRole('group', { name: 'Editor mode', exact: true });
  await modes.getByRole('button', { name: 'Read', exact: true }).click();
  await page.locator('.markdown-body').getByRole('link', { name: 'Open the root note', exact: true }).click();
  await expect(page.locator('.note-heading h1')).toHaveText('Root note');
  await expect(filter()).toHaveValue('*');
  await expect(tree().getByTitle('Root note.md', { exact: true })).toBeVisible();
  await modes.getByRole('button', { name: 'Source', exact: true }).click();
  await openNote(welcomePath);
  await append(draft);
  await page.getByRole('button', { name: 'Window appearance', exact: true }).click();
  const appearance = page.getByRole('dialog', { name: 'Make a little space', exact: true });
  await appearance.getByRole('slider', { name: 'Text size', exact: true }).fill('150');
  await appearance.getByRole('button', { name: 'Done', exact: true }).click();
  await page.setViewportSize({ width: 1100, height: 900 });
  await inside(filter(), sidebar());
  await openFolderDialog('Existing');
  await inside(folderDialog().getByRole('combobox', { name: 'Parent folder', exact: true }), folderDialog());
  await folderDialog().getByRole('button', { name: 'Create folder', exact: true }).click();
  await expect(folderDialog().getByRole('alert')).toContainText('already exists');
  await expect(folderDialog()).toBeVisible();
  await folderDialog().getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(editor()).toContainText(draft);
  expect(await published('Existing/One.md')).toBe('# Grouped note\n\nneedle in the parent folder.\n');

  // Creating a directory must not reload the notebook or replace the note's
  // baseline with an external edit that the user has never reviewed.
  const external = '\ufeff# Folder notebook\r\n\r\n別のアプリケーションで保存した内容。\r\n';
  await writeFile(path.join(notebook, welcomePath), external);
  const currentEditor = await editor().elementHandle();
  await createFolder('保存前の整理');
  expect(await editor().evaluate((element, original) => element === original, currentEditor)).toBe(true);
  await expect(editor()).toContainText(draft);
  await editor().focus();
  await editor().press('ControlOrMeta+s');
  await expect(page.locator('.message-banner[role="alert"]')).toContainText('changed by another application');
  await expect(page.locator('.statusbar')).toContainText('1 unsaved note');
  await expect(editor()).toContainText(draft);
  expect(await published(welcomePath)).toBe(external);
  await testInfo.attach('Folder controls at 150% preserve an external-edit conflict', {
    body: await page.screenshot({ path: testInfo.outputPath('markdown-folders-large-text.png') }), contentType: 'image/png',
  });
  expect(errors).toEqual([]);
});
