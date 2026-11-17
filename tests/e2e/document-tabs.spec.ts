import { electronLaunchArguments } from '../../scripts/electron-launch.mjs';
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fixturePdf } from '../fixtures/pdf';

const firstFile = 'Welcome to Prism.md';
const secondFile = 'Second note.md';
const first = '# First note\n\nA saved first paragraph.\n';
const second = '# Second note\n\nA saved second paragraph.\n';
const firstDraft = '日本語の下書き：テーマごとに資料を整理する。';
const secondDraft = 'A separate draft in the second tab.';
const diskFirst = (text: string) => '\ufeff' + text.replace(/\n/g, '\r\n');
const moreFiles = Array.from({ length: 12 }, (_, index) => `Topic note ${String(index + 1).padStart(2, '0')}.md`);
const longFiles = ['Long reading A.md', 'Long reading B.md'];
const longContent = (name: string) => `# ${name.slice(0, -3)}\n\n` + Array.from({ length: 120 }, (_, index) => `Paragraph ${index + 1}: 読書の位置を保持しながら、別の資料と比較します。\n\n`).join('');
const applicationRoot = path.resolve(process.env.PRISM_TEST_APP_ROOT || process.cwd());
let temporary: string;
let notebook: string;
let otherNotebook: string;
let userData: string;
let pdfProfile: string;
let desktop: ElectronApplication | undefined;
let page: Page;
let errors: string[];

const editor = () => page.locator('.app-body .cm-content');
const source = async () => (await editor().locator('.cm-line').allTextContents()).join('\n');
const tabs = () => page.locator('.document-tabs');
// Keys are generated from controlled fixture paths and UUIDs; role queries keep
// the test independent of icons, dirty badges, and truncated visible titles.
const tabContainer = (key: string) => tabs().locator(`.document-tab[data-tab-key=${JSON.stringify(key)}]`);
const tab = (key: string) => tabContainer(key).getByRole('tab');
const noteTab = (filename: string) => tab(`note:${filename}`);
const closePrompt = () => page.getByRole('dialog', { name: 'Save changes before closing this tab?', exact: true });
const notebookPrompt = () => page.getByRole('dialog', { name: 'Keep your latest thoughts?', exact: true });
const pdf = () => page.locator('.pdf-workspace');
const reader = () => pdf().locator('[data-pdf-session][data-active="true"]');
const canvas = () => reader().locator('.pdf-paper canvas');
const viewport = () => reader().getByLabel('PDF page viewport', { exact: true });
const workspaceButton = (name: 'Notes' | 'PDFs') => page.getByRole('navigation', { name: 'Workspaces', exact: true }).getByRole('button', { name, exact: true });
const groupChoices = () => tabs().getByRole('navigation', { name: 'Tab groups', exact: true });
const groupChoice = (name: string) => groupChoices().getByRole('button', { name: `Show group ${name}`, exact: true });
const topic = (name: string) => tabs().locator(`.document-tab-group[aria-label=${JSON.stringify(`Topic ${name}`)}]`);

async function launch() {
  const env: Record<string, string> = {
    ...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)),
    PRISM_USER_DATA: userData, PRISM_WORKSPACE: notebook, PRISM_PDF_USER_DATA: pdfProfile,
  };
  delete env.ELECTRON_RUN_AS_NODE;
  desktop = await electron.launch({ executablePath: process.env.PRISM_TEST_ELECTRON,
    args: electronLaunchArguments(['--no-sandbox', applicationRoot]), cwd: applicationRoot, env });
  page = await desktop.firstWindow();
  page.on('pageerror', error => errors.push(error.message));
  await expect(tabs()).toBeVisible();
  await expect.poll(() => desktop!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible())).toBe(true);
  await page.setViewportSize({ width: 1440, height: 1000 });
}

async function stop() {
  if (!desktop) return;
  const child = desktop.process();
  const closed = desktop.waitForEvent('close', { timeout: 5_000 }).catch(() => undefined);
  await desktop.evaluate(({ app }) => app.exit(0)).catch(() => undefined);
  await closed;
  if (child.exitCode === null) child.kill();
  desktop = undefined;
}

async function cleanRestart() {
  const closed = desktop!.waitForEvent('close', { timeout: 10_000 });
  await page.getByRole('button', { name: 'Close window', exact: true }).click();
  await closed;
  desktop = undefined;
  await launch();
}

async function openNote(filename: string) {
  await workspaceButton('Notes').click();
  const navigation = page.getByRole('navigation', { name: 'Notes', exact: true });
  if (!await navigation.isVisible()) {
    const toggle = page.getByRole('button', { name: /^(Show notes|Show sidebars)$/ });
    await toggle.click();
  }
  await navigation.getByTitle(filename, { exact: true }).click();
  await expect(noteTab(filename)).toHaveAttribute('aria-selected', 'true');
  await expect(editor()).toBeVisible();
}

async function append(value: string) {
  await editor().focus();
  await editor().press('ControlOrMeta+End');
  await page.keyboard.insertText(value);
  await expect(editor()).toContainText(value);
}

async function readPublished(filename: string, directory = notebook) {
  try { return await readFile(path.join(directory, filename), 'utf8'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
}

async function rendered(number: number) {
  await expect(canvas()).toBeVisible();
  await expect(canvas()).toHaveAttribute('data-page-number', String(number));
  await expect(reader().locator('.pdf-paper')).toHaveAttribute('aria-busy', 'false');
}

async function createTopic(name: string) {
  await tabs().getByRole('button', { name: 'New topic', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'New topic', exact: true });
  await dialog.getByLabel('Topic name', { exact: true }).fill(name);
  await dialog.getByRole('button', { name: 'Create topic', exact: true }).click();
  await expect(dialog).toHaveCount(0);
}

async function showGroup(name: string) {
  await groupChoice(name).click();
  await expect(groupChoice(name)).toHaveAttribute('aria-pressed', 'true');
}

async function selectDocument(key: string) {
  if (!await tab(key).count()) {
    // Group selection only filters the strip, so looking through the available
    // groups cannot navigate away from the current editor or reader.
    const choices = groupChoices().getByRole('button');
    for (let index = 0; index < await choices.count(); index++) {
      await choices.nth(index).click();
      if (await tab(key).count()) break;
    }
  }
  await tab(key).click();
}

async function assignTopic(key: string, name: string) {
  await selectDocument(key);
  await tabs().getByLabel('Move tab to topic', { exact: true }).selectOption({ label: name });
}

async function importPapers() {
  const encrypted = path.join(temporary, 'Rates paper.pdf');
  const plain = path.join(temporary, 'Execution paper.pdf');
  await Promise.all([writeFile(encrypted, fixturePdf('topic-secret')), writeFile(plain, fixturePdf())]);
  await desktop!.evaluate(({ dialog }, filenames) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: filenames });
  }, [encrypted, plain]);
  await workspaceButton('PDFs').click();
  await pdf().getByRole('button', { name: 'Import PDFs', exact: true }).click();
  await expect(pdf().getByRole('button', { name: 'Open Rates paper', exact: true })).toBeVisible();
  await expect(pdf().getByRole('button', { name: 'Open Execution paper', exact: true })).toBeVisible();
  const library = await page.evaluate(() => window.prismPdf.loadLibrary());
  return {
    encrypted, plain,
    ratesId: library.documents.find(document => document.title === 'Rates paper')!.id,
    executionId: library.documents.find(document => document.title === 'Execution paper')!.id,
  };
}

test.beforeEach(async () => {
  temporary = await mkdtemp(path.join(os.tmpdir(), 'prism-document-tabs-'));
  notebook = path.join(temporary, 'First notebook');
  otherNotebook = path.join(temporary, 'Second notebook');
  userData = path.join(temporary, 'notes-profile');
  pdfProfile = path.join(temporary, 'pdf-profile');
  errors = [];
  await Promise.all([mkdir(notebook), mkdir(otherNotebook), mkdir(userData)]);
  await Promise.all([
    writeFile(path.join(notebook, firstFile), diskFirst(first)),
    writeFile(path.join(notebook, secondFile), second),
    writeFile(path.join(otherNotebook, firstFile), '# Other notebook\n\nDifferent content with the same filename.\n'),
    ...moreFiles.map(filename => writeFile(path.join(notebook, filename), `# ${filename.slice(0, -3)}\n\nA separate saved note.\n`)),
    ...longFiles.map(filename => writeFile(path.join(notebook, filename), longContent(filename))),
  ]);
  await launch();
  await expect(page.locator('.note-heading h1')).toHaveText('First note');
  await page.getByRole('group', { name: 'Editor mode', exact: true }).getByRole('button', { name: 'Source', exact: true }).click();
});

test.afterEach(async ({}, testInfo) => {
  if (page && !page.isClosed() && testInfo.status !== testInfo.expectedStatus) {
    const screenshot = await page.screenshot().catch(() => undefined);
    if (screenshot) await testInfo.attach('Document tabs at failure', { body: screenshot, contentType: 'image/png' });
  }
  await stop();
  if (temporary) await rm(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

test('keeps independent drafts and undo while deduplicating, cycling and safely closing note tabs', async () => {
  await expect(noteTab(firstFile)).toHaveAttribute('aria-selected', 'true');
  await append(firstDraft);
  await openNote(secondFile);
  await append(secondDraft);
  await openNote(firstFile);
  await openNote(firstFile);
  await expect(tabs().getByRole('tab')).toHaveCount(2);
  await expect.poll(source).toBe(first + firstDraft);
  await editor().focus();
  await editor().press('ControlOrMeta+z');
  await expect.poll(source).toBe(first);
  await editor().press(process.platform === 'win32' ? 'Control+y' : 'ControlOrMeta+Shift+Z');
  await expect.poll(source).toBe(first + firstDraft);

  await page.keyboard.press('Control+Tab');
  await expect(noteTab(secondFile)).toHaveAttribute('aria-selected', 'true');
  await expect.poll(source).toBe(second + secondDraft);
  await page.keyboard.press('Control+Shift+Tab');
  await expect(noteTab(firstFile)).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('ControlOrMeta+w');
  await expect(closePrompt()).toContainText(firstFile);
  await closePrompt().getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(noteTab(firstFile)).toHaveCount(1);
  await expect(page.locator('.statusbar')).toContainText('2 unsaved notes');
  expect(await readPublished(firstFile)).toBe(diskFirst(first));
  expect(await readPublished(secondFile)).toBe(second);

  await editor().focus();
  await editor().press('ControlOrMeta+w');
  await closePrompt().getByRole('button', { name: 'Discard & close', exact: true }).click();
  await expect(noteTab(firstFile)).toHaveCount(0);
  await expect.poll(source).toBe(second + secondDraft);
  await openNote(firstFile);
  await editor().focus();
  await editor().press('ControlOrMeta+z');
  await expect.poll(source).toBe(first);
  await append(firstDraft);
  await editor().press('ControlOrMeta+w');
  await closePrompt().getByRole('button', { name: 'Save & close', exact: true }).click();
  await expect(closePrompt()).toHaveCount(0);
  await expect(noteTab(firstFile)).toHaveCount(0);
  await expect.poll(() => readPublished(firstFile)).toBe(diskFirst(first + firstDraft));
  await expect(page.locator('.statusbar')).toContainText('1 unsaved note');
  await expect.poll(source).toBe(second + secondDraft);
  await editor().focus();
  await editor().press('ControlOrMeta+z');
  await expect.poll(source).toBe(second);
  await editor().press(process.platform === 'win32' ? 'Control+y' : 'ControlOrMeta+Shift+Z');
  await editor().press('ControlOrMeta+w');
  await closePrompt().getByRole('button', { name: 'Save & close', exact: true }).click();
  await expect(tabs().getByRole('tab')).toHaveCount(0);
  await expect.poll(() => readPublished(secondFile)).toBe(second + secondDraft);
  await expect(page.locator('.statusbar')).toContainText('All changes saved');
  expect(errors).toEqual([]);
});

test('groups notes with PDFs and retains independent readers beside a draft through switches and restart', async ({}, testInfo) => {
  await append(firstDraft);
  const papers = await importPapers();
  const ratesKey = `pdf:${papers.ratesId}`;
  const executionKey = `pdf:${papers.executionId}`;
  await pdf().getByRole('button', { name: 'Open Rates paper', exact: true }).click();
  await reader().getByLabel('Document password', { exact: true }).fill('topic-secret');
  await reader().getByRole('button', { name: 'Unlock PDF', exact: true }).click();
  await rendered(1);
  await page.getByRole('button', { name: 'Read & write', exact: true }).click();
  await expect(page.locator('.workspace-area')).toHaveAttribute('data-layout', 'split');
  await reader().getByRole('button', { name: 'Next page', exact: true }).click();
  await reader().getByLabel('Page zoom', { exact: true }).selectOption('2');
  await rendered(2);
  await expect(canvas()).toHaveCSS('width', '1224px');
  await viewport().evaluate(element => element.scrollTo(0, 180));
  await expect.poll(() => viewport().evaluate(element => element.scrollTop)).toBe(180);
  const ratesCanvas = await canvas().elementHandle();
  await createTopic('Rates research');
  await assignTopic(`note:${firstFile}`, 'Rates research');
  await assignTopic(ratesKey, 'Rates research');
  await expect(topic('Rates research').getByRole('tab')).toHaveCount(2);
  await reader().getByRole('button', { name: 'Back to library', exact: true }).click();
  await pdf().getByRole('button', { name: 'Open Execution paper', exact: true }).click();
  await expect(groupChoice('Ungrouped')).toHaveAttribute('aria-pressed', 'true');
  await expect(tabs().getByRole('tab')).toHaveCount(1);
  await expect(tab(executionKey)).toHaveAttribute('aria-selected', 'true');
  await expect(topic('Rates research')).toHaveCount(0);
  await rendered(1);
  await reader().getByLabel('Page zoom', { exact: true }).selectOption('1.5');
  await expect(canvas()).toHaveCSS('width', '918px');
  await rendered(1);
  await viewport().evaluate(element => element.scrollTo(0, 120));
  await expect.poll(() => viewport().evaluate(element => element.scrollTop)).toBe(120);
  const executionCanvas = await canvas().elementHandle();

  await selectDocument(`note:${firstFile}`);
  await expect(editor()).toContainText(firstDraft);
  await expect(page.locator('.workspace-area')).toHaveAttribute('data-layout', 'split');
  await selectDocument(ratesKey);
  await rendered(2);
  await expect(reader().getByLabel('Document password', { exact: true })).toHaveCount(0);
  await expect(reader().getByLabel('Page zoom', { exact: true })).toHaveValue('2');
  await expect.poll(() => viewport().evaluate(element => element.scrollTop)).toBe(180);
  expect(await canvas().evaluate((element, original) => element === original, ratesCanvas)).toBe(true);
  await selectDocument(executionKey);
  await rendered(1);
  await expect(reader().getByLabel('Page zoom', { exact: true })).toHaveValue('1.5');
  await expect.poll(() => viewport().evaluate(element => element.scrollTop)).toBe(120);
  expect(await canvas().evaluate((element, original) => element === original, executionCanvas)).toBe(true);
  await expect(tabs().getByRole('tab')).toHaveCount(1);

  // Reopening an already grouped PDF from the library preserves its explicit
  // membership and reveals that group, rather than creating another tab.
  await reader().getByRole('button', { name: 'Back to library', exact: true }).click();
  await pdf().getByRole('button', { name: 'Open Rates paper', exact: true }).click();
  await expect(groupChoice('Rates research')).toHaveAttribute('aria-pressed', 'true');
  await rendered(2);
  expect(await canvas().evaluate((element, original) => element === original, ratesCanvas)).toBe(true);
  await expect(topic('Rates research').getByRole('tab')).toHaveCount(2);
  await expect(topic('Rates research')).toContainText('First note');
  await expect(topic('Rates research')).toContainText('Rates paper');
  await selectDocument(`note:${firstFile}`);
  await editor().focus();
  await editor().press('ControlOrMeta+s');
  await expect.poll(() => readPublished(firstFile)).toBe(diskFirst(first + firstDraft));
  await expect(page.locator('.statusbar')).toContainText('All changes saved');
  await testInfo.attach('Mixed topic tabs beside a retained PDF', {
    body: await page.screenshot({ path: testInfo.outputPath('mixed-document-tabs.png') }), contentType: 'image/png',
  });
  await cleanRestart();
  await expect(tabs().getByRole('tab')).toHaveCount(2);
  await expect(groupChoice('Rates research')).toHaveAttribute('aria-pressed', 'true');
  await expect(topic('Rates research').getByRole('tab')).toHaveCount(2);
  await selectDocument(`note:${firstFile}`);
  await expect(editor()).toContainText(firstDraft);
  await selectDocument(ratesKey);
  await reader().getByLabel('Document password', { exact: true }).fill('topic-secret');
  await reader().getByRole('button', { name: 'Unlock PDF', exact: true }).click();
  await rendered(2);
  await tabs().getByRole('button', { name: 'Rename topic Rates research', exact: true }).click();
  const rename = page.getByRole('dialog', { name: 'Rename topic', exact: true });
  await rename.getByLabel('Topic name', { exact: true }).fill('金利と執行');
  await rename.getByRole('button', { name: 'Rename topic', exact: true }).click();
  await expect(topic('金利と執行').getByRole('tab')).toHaveCount(2);
  await tabs().getByRole('button', { name: 'Remove topic 金利と執行', exact: true }).click();
  const remove = page.getByRole('dialog', { name: 'Remove topic', exact: true });
  await remove.getByRole('button', { name: 'Remove topic', exact: true }).click();
  await expect(tabs().getByRole('tab')).toHaveCount(3);
  await expect(tabs()).not.toContainText('金利と執行');
  await selectDocument(executionKey);
  await rendered(1);
  await page.keyboard.press('ControlOrMeta+w');
  await expect(tab(executionKey)).toHaveCount(0);
  await expect(pdf().locator(`[data-pdf-session=${JSON.stringify(papers.executionId)}]`)).toHaveCount(0);
  expect(await readFile(papers.encrypted)).toEqual(fixturePdf('topic-secret'));
  expect(await readFile(papers.plain)).toEqual(fixturePdf());
  expect((await page.evaluate(() => window.prismPdf.loadLibrary())).documents).toHaveLength(2);
  expect(errors).toEqual([]);
});

test('wraps only the selected group and keeps many group choices in one compact row', async ({}, testInfo) => {
  for (const filename of moreFiles) await openNote(filename);
  await expect(tabs().getByRole('tab')).toHaveCount(13);
  await createTopic('Long-term reading');
  for (const filename of moreFiles) await assignTopic(`note:${filename}`, 'Long-term reading');
  await expect(tabs().getByRole('tab')).toHaveCount(12);
  await expect(noteTab(firstFile)).toHaveCount(0);
  await page.locator('.statusbar').getByRole('button').click();
  const appearance = page.getByRole('dialog', { name: 'Make a little space', exact: true });
  await appearance.getByRole('slider', { name: 'Text size', exact: true }).fill('150');
  await appearance.getByRole('button', { name: 'Done', exact: true }).click();
  await page.setViewportSize({ width: 420, height: 900 });
  const header = tabs().locator('.document-tabs-header');
  const headerHeight = (await header.boundingBox())!.height;
  const groupNames = Array.from({ length: 8 }, (_, index) => `Research topic ${index + 1}`);
  for (const name of groupNames) await createTopic(name);
  await expect.poll(async () => Math.abs((await header.boundingBox())!.height - headerHeight)).toBeLessThan(2);
  await expect.poll(() => groupChoices().evaluate(element => element.scrollWidth > element.clientWidth)).toBe(true);
  await showGroup('Long-term reading');
  await expect(tabs().getByRole('tab')).toHaveCount(12);
  await expect(tabs().locator('.document-tab-group')).toHaveCount(1);
  await expect.poll(() => tabs().evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
  const rows = await tabs().getByRole('tab').evaluateAll(elements => new Set(elements.map(element => Math.round(element.getBoundingClientRect().top))).size);
  expect(rows).toBeGreaterThan(1);
  await expect(page.locator('.workspace-area')).toBeVisible();
  expect((await page.locator('.workspace-area').boundingBox())!.height).toBeGreaterThan(300);

  // Overflow buttons make every group reachable with a mouse. Scrolling the
  // choices must not select a group, navigate the editor, or add another row.
  const scrollLeft = tabs().getByRole('button', { name: 'Scroll groups left', exact: true });
  const scrollRight = tabs().getByRole('button', { name: 'Scroll groups right', exact: true });
  const groupScroll = () => groupChoices().evaluate(element => element.scrollLeft);
  await expect(scrollLeft).toBeVisible();
  await expect(scrollRight).toBeVisible();
  for (let step = 0; step < 32; step++) {
    const before = await groupScroll();
    if (before <= 1) break;
    await expect(scrollLeft).toBeEnabled();
    await scrollLeft.click();
    await expect.poll(groupScroll).toBeLessThan(before);
    if (await groupScroll() <= 1) await expect(scrollLeft).toBeDisabled();
    else await expect(scrollLeft).toBeEnabled();
  }
  await expect(scrollLeft).toBeDisabled();
  await expect.poll(groupScroll).toBeLessThan(1);
  const remainingRight = () => groupChoices().evaluate(element => element.scrollWidth - element.clientWidth - element.scrollLeft);
  await expect(scrollRight).toBeEnabled();
  for (let step = 0; step < 32; step++) {
    if (await remainingRight() <= 1) break;
    const before = await groupScroll();
    await expect(scrollRight).toBeEnabled();
    await scrollRight.click();
    await expect.poll(groupScroll).toBeGreaterThan(before);
    if (await remainingRight() <= 1) await expect(scrollRight).toBeDisabled();
    else await expect(scrollRight).toBeEnabled();
  }
  await expect.poll(remainingRight).toBeLessThanOrEqual(1);
  await expect(scrollRight).toBeDisabled();
  await expect(scrollLeft).toBeEnabled();
  await expect(groupChoice('Long-term reading')).toHaveAttribute('aria-pressed', 'true');
  await expect(tabs().getByRole('tab')).toHaveCount(12);
  await expect(noteTab(moreFiles[11])).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('.note-heading h1')).toHaveText(moreFiles[11].slice(0, -3));
  expect(Math.abs((await header.boundingBox())!.height - headerHeight)).toBeLessThan(2);

  // Group keyboard navigation stays in its horizontal row; choosing an empty
  // group changes the strip without navigating away from the active note.
  await groupChoice('Long-term reading').focus();
  await page.keyboard.press('End');
  await expect(groupChoice(groupNames[7])).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(groupChoice(groupNames[7])).toHaveAttribute('aria-pressed', 'true');
  await expect(tabs().getByRole('tab')).toHaveCount(0);
  await expect(page.locator('.note-heading h1')).toHaveText(moreFiles[11].slice(0, -3));
  await page.keyboard.press('Home');
  await expect(groupChoice('Ungrouped')).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(tabs().getByRole('tab')).toHaveCount(1);
  await expect(noteTab(firstFile)).toBeVisible();
  await showGroup('Long-term reading');
  await noteTab(moreFiles[1]).focus();
  await page.keyboard.press('Home');
  const firstVisible = tabs().getByRole('tab').first();
  await expect(firstVisible).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(firstVisible).toHaveAttribute('aria-selected', 'true');
  await noteTab(moreFiles[11]).click();
  await expect(page.locator('.note-heading h1')).toHaveText(moreFiles[11].slice(0, -3));
  await testInfo.attach('One group with wrapped tabs at 150 percent text', {
    body: await page.screenshot({ path: testInfo.outputPath('wrapped-document-tabs.png') }), contentType: 'image/png',
  });
  expect(errors).toEqual([]);
});

test('browses groups without changing the editor and restores the viewed group with topic tools hidden', async () => {
  await createTopic('Writing');
  await assignTopic(`note:${firstFile}`, 'Writing');
  await append(firstDraft);
  await openNote(secondFile);
  await expect(groupChoice('Ungrouped')).toHaveAttribute('aria-pressed', 'true');
  await expect(tabs().getByRole('tab')).toHaveCount(1);
  await selectDocument(`note:${firstFile}`);
  const retainedEditor = await editor().elementHandle();
  await showGroup('Ungrouped');
  await expect(noteTab(firstFile)).toHaveCount(0);
  await expect(noteTab(secondFile)).toHaveAttribute('aria-selected', 'false');
  await expect.poll(source).toBe(first + firstDraft);
  expect(await editor().evaluate((element, original) => element === original, retainedEditor)).toBe(true);
  await editor().focus();
  await editor().press('ControlOrMeta+z');
  await expect.poll(source).toBe(first);
  await editor().press(process.platform === 'win32' ? 'Control+y' : 'ControlOrMeta+Shift+Z');
  await expect.poll(source).toBe(first + firstDraft);
  expect(await readPublished(firstFile)).toBe(diskFirst(first));

  await page.keyboard.press('Control+Tab');
  await expect(noteTab(secondFile)).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('Control+Shift+Tab');
  await expect(groupChoice('Writing')).toHaveAttribute('aria-pressed', 'true');
  await expect(noteTab(firstFile)).toHaveAttribute('aria-selected', 'true');
  await expect.poll(source).toBe(first + firstDraft);

  await page.locator('.document-toolbar').getByRole('button', { name: 'Markdown layout', exact: true }).click();
  const layout = page.getByRole('dialog', { name: 'Markdown layout', exact: true });
  await layout.getByRole('checkbox', { name: 'Topic tools', exact: true }).uncheck();
  await layout.getByRole('button', { name: 'Done', exact: true }).click();
  await expect(tabs().locator('.document-tabs-tools')).toBeHidden();
  await expect(groupChoices()).toBeVisible();
  await showGroup('Ungrouped');
  await expect(noteTab(secondFile)).toBeVisible();
  await expect.poll(source).toBe(first + firstDraft);
  await editor().focus();
  await editor().press('ControlOrMeta+s');
  await expect.poll(() => readPublished(firstFile)).toBe(diskFirst(first + firstDraft));
  await cleanRestart();
  await expect(tabs().locator('.document-tabs-tools')).toBeHidden();
  await expect(groupChoice('Ungrouped')).toHaveAttribute('aria-pressed', 'true');
  await expect(tabs().getByRole('tab')).toHaveCount(1);
  await expect(noteTab(secondFile)).toHaveAttribute('aria-selected', 'false');
  await expect.poll(source).toBe(first + firstDraft);
  await showGroup('Writing');
  await expect(noteTab(firstFile)).toHaveAttribute('aria-selected', 'true');
  expect(errors).toEqual([]);
});

test('keeps a tab and its draft after a save conflict and isolates topics between notebooks', async () => {
  await createTopic('First notebook topic');
  await assignTopic(`note:${firstFile}`, 'First notebook topic');
  await append(firstDraft);
  await openNote(secondFile);
  await append(secondDraft);
  await selectDocument(`note:${firstFile}`);
  const external = diskFirst('# First note\n\nAn independent external revision.\n');
  await writeFile(path.join(notebook, firstFile), external);
  await editor().focus();
  await editor().press('ControlOrMeta+w');
  await closePrompt().getByRole('button', { name: 'Save & close', exact: true }).click();
  await expect(closePrompt().getByRole('alert')).toContainText('changed by another application');
  await expect(noteTab(firstFile)).toHaveCount(1);
  await closePrompt().getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(editor()).toContainText(firstDraft);
  await expect(page.locator('.statusbar')).toContainText('2 unsaved notes');
  expect(await readPublished(firstFile)).toBe(external);
  expect(await readPublished(secondFile)).toBe(second);

  await desktop!.evaluate(({ dialog }, directory) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [directory] });
  }, otherNotebook);
  await page.getByRole('button', { name: 'Open notebook', exact: true }).click();
  await notebookPrompt().getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(topic('First notebook topic')).toBeVisible();
  await expect(page.locator('.statusbar')).toContainText('2 unsaved notes');
  await page.getByRole('button', { name: 'Open notebook', exact: true }).click();
  await notebookPrompt().getByRole('button', { name: 'Discard changes', exact: true }).click();
  await expect(page.locator('.note-heading h1')).toHaveText('Other notebook');
  await expect(tabs()).not.toContainText('First notebook topic');
  await expect(tabs().getByRole('tab')).toHaveCount(1);
  await expect(editor()).not.toContainText(firstDraft);
  await editor().focus();
  await editor().press('ControlOrMeta+z');
  await expect(editor()).toContainText('Different content with the same filename.');
  await desktop!.evaluate(({ dialog }, directory) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [directory] });
  }, notebook);
  await page.getByRole('button', { name: 'Open notebook', exact: true }).click();
  await expect(topic('First notebook topic')).toBeVisible();
  await expect(tabs().getByRole('tab')).toHaveCount(1);
  await expect(groupChoice('First notebook topic')).toHaveAttribute('aria-pressed', 'true');
  await selectDocument(`note:${firstFile}`);
  await expect(editor()).toContainText('An independent external revision.');
  await expect(editor()).not.toContainText(firstDraft);
  expect(await readPublished(firstFile)).toBe(external);
  expect(errors).toEqual([]);
});

test('bounds retained PDF readers, restores evicted reading state and keeps newer tab selection during import', async () => {
  const names = ['Retained paper A', 'Retained paper B', 'Retained paper C', 'Retained paper D'];
  const files = names.map(name => path.join(temporary, `${name}.pdf`));
  // Valid trailing comments give these small real PDFs distinct content hashes.
  await Promise.all(files.map((filename, index) => writeFile(filename, Buffer.concat([
    fixturePdf(), Buffer.from(`\n% Independent document ${index + 1}\n`),
  ]))));
  await desktop!.evaluate(({ dialog }, filenames) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: filenames });
  }, files);
  await workspaceButton('PDFs').click();
  await pdf().getByRole('button', { name: 'Import PDFs', exact: true }).click();
  await expect(pdf().getByRole('button', { name: `Open ${names[3]}`, exact: true })).toBeVisible();
  const library = await page.evaluate(() => window.prismPdf.loadLibrary());
  const ids = names.map(name => library.documents.find(document => document.title === name)!.id);
  await pdf().getByRole('button', { name: `Open ${names[0]}`, exact: true }).click();
  await rendered(1);
  await reader().getByRole('button', { name: 'Next page', exact: true }).click();
  await reader().getByLabel('Page zoom', { exact: true }).selectOption('2');
  await reader().getByRole('button', { name: 'Rotate page clockwise', exact: true }).click();
  await rendered(2);
  await expect(canvas()).toHaveCSS('width', '1584px');
  await expect(canvas()).toHaveCSS('height', '1224px');
  await viewport().evaluate(element => element.scrollTo({ top: 180, left: 120 }));
  await expect.poll(() => viewport().evaluate(element => ({ top: element.scrollTop, left: element.scrollLeft }))).toEqual({ top: 180, left: 120 });
  const retiredCanvas = await canvas().elementHandle();

  for (const name of names.slice(1)) {
    await reader().getByRole('button', { name: 'Back to library', exact: true }).click();
    await pdf().getByRole('button', { name: `Open ${name}`, exact: true }).click();
    await rendered(1);
    expect(await pdf().locator('[data-pdf-session]').count()).toBeLessThanOrEqual(3);
  }
  await expect(tabs().getByRole('tab')).toHaveCount(5);
  await expect(pdf().locator(`[data-pdf-session=${JSON.stringify(ids[0])}]`)).toHaveCount(0);
  expect(await retiredCanvas!.evaluate(element => element.isConnected)).toBe(false);
  await tab(`pdf:${ids[0]}`).click();
  await rendered(2);
  await expect(reader().getByLabel('Page zoom', { exact: true })).toHaveValue('2');
  await expect(canvas()).toHaveCSS('width', '1584px');
  await expect(canvas()).toHaveCSS('height', '1224px');
  await expect.poll(() => viewport().evaluate(element => ({ top: element.scrollTop, left: element.scrollLeft }))).toEqual({ top: 180, left: 120 });
  expect(await pdf().locator('[data-pdf-session]').count()).toBeLessThanOrEqual(3);
  expect(await canvas().evaluate((element, retired) => element === retired, retiredCanvas)).toBe(false);
  const restoredCanvas = await canvas().elementHandle();

  await reader().getByRole('button', { name: 'Back to library', exact: true }).click();
  const laterFile = path.join(temporary, 'Imported after navigation.pdf');
  await writeFile(laterFile, Buffer.concat([fixturePdf(), Buffer.from('\n% Later import\n')]));
  await desktop!.evaluate(({ dialog }, filename) => {
    const fixture = globalThis as typeof globalThis & { tabImportStarted?: boolean; finishTabImport?: () => void };
    fixture.tabImportStarted = false;
    dialog.showOpenDialog = async () => {
      fixture.tabImportStarted = true;
      return new Promise<{ canceled: boolean; filePaths: string[] }>(resolve => { fixture.finishTabImport = () => resolve({ canceled: false, filePaths: [filename] }); });
    };
  }, laterFile);
  await pdf().getByRole('button', { name: 'Import PDFs', exact: true }).click();
  await expect.poll(() => desktop!.evaluate(() => (globalThis as typeof globalThis & { tabImportStarted?: boolean }).tabImportStarted)).toBe(true);
  await tab(`pdf:${ids[0]}`).click();
  await rendered(2);
  await desktop!.evaluate(() => (globalThis as typeof globalThis & { finishTabImport?: () => void }).finishTabImport?.());
  await expect.poll(async () => (await page.evaluate(() => window.prismPdf.loadLibrary())).documents.length).toBe(5);
  await expect(tab(`pdf:${ids[0]}`)).toHaveAttribute('aria-selected', 'true');
  await rendered(2);
  await expect(reader().getByLabel('Page zoom', { exact: true })).toHaveValue('2');
  await expect.poll(() => viewport().evaluate(element => ({ top: element.scrollTop, left: element.scrollLeft }))).toEqual({ top: 180, left: 120 });
  expect(await canvas().evaluate((element, retained) => element === retained, restoredCanvas)).toBe(true);
  await expect(pdf().locator('.library-content')).toHaveCount(0);
  expect(await pdf().locator('[data-pdf-session]').count()).toBeLessThanOrEqual(3);
  expect(errors).toEqual([]);
});

test('retains each Read-mode scroll position through graph navigation and hidden notes', async () => {
  await openNote(longFiles[0]);
  await page.getByRole('group', { name: 'Editor mode', exact: true }).getByRole('button', { name: 'Read', exact: true }).click();
  const reading = () => page.locator('.app-body .preview-pane .markdown-body');
  await expect(reading()).toBeVisible();
  await reading().evaluate(element => element.scrollTo(0, 640));
  await expect.poll(() => reading().evaluate(element => element.scrollTop)).toBe(640);
  await page.getByRole('navigation', { name: 'Notes', exact: true }).getByTitle(longFiles[1], { exact: true }).click();
  await expect(page.locator('.note-heading h1')).toHaveText(longFiles[1].slice(0, -3));
  await expect(reading().locator('h1')).toHaveText(longFiles[1].slice(0, -3));
  await reading().evaluate(element => element.scrollTo(0, 320));
  await expect.poll(() => reading().evaluate(element => element.scrollTop)).toBe(320);
  await noteTab(longFiles[0]).click();
  await expect(reading().locator('h1')).toHaveText(longFiles[0].slice(0, -3));
  await expect.poll(() => reading().evaluate(element => element.scrollTop)).toBe(640);

  await page.getByRole('button', { name: 'Graph view', exact: true }).click();
  await expect(page.locator('.graph-page')).toBeVisible();
  await noteTab(longFiles[1]).click();
  await expect(reading()).toBeVisible();
  await expect(reading().locator('h1')).toHaveText(longFiles[1].slice(0, -3));
  await expect.poll(() => reading().evaluate(element => element.scrollTop)).toBe(320);
  await noteTab(longFiles[0]).click();
  await expect.poll(() => reading().evaluate(element => element.scrollTop)).toBe(640);

  // Hiding the note pane produces zero geometry. Neither a hidden scroll event
  // nor selecting a different note while hidden may overwrite the saved view.
  await workspaceButton('PDFs').click();
  await expect(page.locator('.pdf-workspace')).toBeVisible();
  await expect(reading()).toBeHidden();
  await noteTab(longFiles[1]).click();
  await expect(reading().locator('h1')).toHaveText(longFiles[1].slice(0, -3));
  await expect.poll(() => reading().evaluate(element => element.scrollTop)).toBe(320);
  await noteTab(longFiles[0]).click();
  await expect(reading().locator('h1')).toHaveText(longFiles[0].slice(0, -3));
  await expect.poll(() => reading().evaluate(element => element.scrollTop)).toBe(640);
  for (const filename of longFiles) expect(await readPublished(filename)).toBe(longContent(filename));
  await expect(page.locator('.statusbar')).toContainText('All changes saved');
  expect(errors).toEqual([]);
});
