import { electronLaunchArguments } from '../../scripts/electron-launch.mjs';
import { _electron as electron, expect, test, type ElectronApplication, type Locator, type Page } from '@playwright/test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fixturePdf } from '../fixtures/pdf';

const filename = 'Welcome to Prism.md';
const content = '# 読書ノート\n\nFollow [[Second note]].\n\n' + Array.from({ length: 100 }, (_, index) =>
  `段落 ${index + 1}：資料を読みながら、日本語の考えを書き留めます。\n\n`).join('');
const disk = (value: string) => '\ufeff' + value.replace(/\n/g, '\r\n');
const applicationRoot = path.resolve(process.env.PRISM_TEST_APP_ROOT || process.cwd());
let temporary: string;
let notebook: string;
let userData: string;
let pdfProfile: string;
let desktop: ElectronApplication | undefined;
let page: Page;
let errors: string[];

const notes = () => page.locator('.app-body');
const editor = () => notes().locator('.cm-content');
const scroller = () => notes().locator('.cm-scroller');
const toolbar = () => notes().locator('.document-toolbar');
const layoutButton = () => toolbar().getByRole('button', { name: 'Markdown layout', exact: true });
const layoutDialog = () => page.getByRole('dialog', { name: 'Markdown layout', exact: true });
const modeSelect = () => toolbar().getByRole('combobox', { name: 'Editor mode', exact: true });
const topicTools = () => page.locator('.document-tabs-tools');
const status = () => page.locator('.statusbar');
const pdf = () => page.locator('.pdf-workspace');
const reader = () => pdf().locator('[data-pdf-session][data-active="true"]');
const canvas = () => reader().locator('.pdf-paper canvas');
const pdfViewport = () => reader().getByLabel('PDF page viewport', { exact: true });
const workspace = (name: 'Notes' | 'PDFs') => page.getByRole('navigation', { name: 'Workspaces', exact: true }).getByRole('button', { name, exact: true });
const savedLayout = () => page.evaluate(() => JSON.parse(localStorage.getItem('prism.markdown-layout') || 'null'));

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
  await expect(page.locator('.document-tabs')).toBeVisible();
  await expect.poll(() => desktop!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible())).toBe(true);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await workspace('Notes').click();
  await expect(layoutButton()).toBeVisible();
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

async function append(value: string) {
  await editor().focus();
  await editor().press('ControlOrMeta+End');
  await page.keyboard.insertText(value);
  await expect(editor()).toContainText(value.trim());
}

async function readPublished() {
  try { return await readFile(path.join(notebook, filename), 'utf8'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
}

async function expectSaved(value: string) {
  await expect.poll(readPublished).toBe(disk(value));
  await expect(status()).not.toContainText('Working…');
  await expect(toolbar().locator('.save-button')).toBeDisabled();
}

async function openLayout() {
  await layoutButton().click();
  await expect(layoutDialog()).toBeVisible();
}

async function doneLayout() {
  await layoutDialog().getByRole('button', { name: 'Done', exact: true }).click();
  await expect(layoutDialog()).toBeHidden();
}

async function moreWritingSpace() {
  await openLayout();
  await layoutDialog().getByRole('button', { name: 'More writing space', exact: true }).click();
  await doneLayout();
}

async function expectInside(control: Locator, panel: Locator) {
  await expect(control).toBeVisible();
  const box = await control.boundingBox();
  const bounds = await panel.boundingBox();
  if (!box || !bounds) throw new Error('A Markdown layout control or its containing pane is not visible.');
  expect(box.x).toBeGreaterThanOrEqual(bounds.x - 1);
  expect(box.x + box.width).toBeLessThanOrEqual(bounds.x + bounds.width + 1);
  expect(box.y).toBeGreaterThanOrEqual(bounds.y - 1);
  expect(box.y + box.height).toBeLessThanOrEqual(bounds.y + bounds.height + 1);
}

async function renderedPage(number: number) {
  await expect(canvas()).toBeVisible();
  await expect(canvas()).toHaveAttribute('data-page-number', String(number));
  await expect(reader().locator('.pdf-paper')).toHaveAttribute('aria-busy', 'false');
}

test.beforeEach(async () => {
  temporary = await mkdtemp(path.join(os.tmpdir(), 'prism-markdown-layout-'));
  notebook = path.join(temporary, 'Notebook');
  userData = path.join(temporary, 'notes-profile');
  pdfProfile = path.join(temporary, 'pdf-profile');
  errors = [];
  await Promise.all([mkdir(notebook), mkdir(userData)]);
  await Promise.all([
    writeFile(path.join(notebook, filename), disk(content)),
    writeFile(path.join(notebook, 'Second note.md'), '# Second note\n\nReturn to [[Welcome to Prism]].\n'),
  ]);
  await launch();
  await expect(notes().locator('.note-heading h1')).toHaveText('読書ノート');
  await notes().getByRole('group', { name: 'Editor mode', exact: true }).getByRole('button', { name: 'Source', exact: true }).click();
});

test.afterEach(async ({}, testInfo) => {
  if (page && !page.isClosed() && testInfo.status !== testInfo.expectedStatus) {
    const screenshot = await page.screenshot().catch(() => undefined);
    if (screenshot) await testInfo.attach('Markdown layout at failure', { body: screenshot, contentType: 'image/png' });
  }
  await stop();
  if (temporary) await rm(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

test('reclaims writing height without losing Japanese edits, selection, scrolling, undo or save errors', async () => {
  const saved = '最初の日本語の保存。';
  const draft = '\n配置を変えても、この日本語の下書きを残す。';
  await append(saved);
  await editor().press('ControlOrMeta+s');
  await expectSaved(content + saved);
  await expect(notes().locator('.message-banner.notice')).toContainText('Saved to your notebook.');
  await editor().press('ArrowLeft');
  await editor().press('ArrowRight');
  await append(draft);

  // Keep the selection in the middle, where a taller viewport cannot clamp
  // the scroll position at the end of the document.
  await editor().press('ControlOrMeta+Home');
  await editor().press('PageDown');
  await editor().press('PageDown');
  await editor().press('Home');
  await editor().press('Shift+End');
  if (!await page.evaluate(() => window.getSelection()?.toString())) {
    await editor().press('ArrowDown');
    await editor().press('Home');
    await editor().press('Shift+End');
  }
  const selection = await page.evaluate(() => window.getSelection()?.toString());
  expect(selection?.length).toBeGreaterThan(0);
  const cursor = await status().locator('span').filter({ hasText: /^Ln \d+, Col \d+$/ }).innerText();
  const scroll = () => scroller().evaluate(element => element.scrollTop);
  await expect.poll(scroll).toBeGreaterThan(300);
  const position = await scroll();
  const originalEditor = await editor().elementHandle();
  const originalScroller = await scroller().elementHandle();
  const height = () => scroller().evaluate(element => element.clientHeight);
  const originalHeight = await height();

  for (const section of [
    { name: 'Document heading', control: notes().locator('.note-heading') },
    { name: 'Editor labels and hints', control: notes().locator('.source-pane .pane-label') },
    { name: 'Save notifications', control: notes().locator('.message-banner.notice') },
    { name: 'Topic tools', control: topicTools() },
  ]) {
    await expect(section.control).toBeVisible();
    const previousHeight = await height();
    await openLayout();
    await layoutDialog().getByRole('checkbox', { name: section.name, exact: true }).uncheck();
    await doneLayout();
    await expect(section.control).toBeHidden();
    await expect.poll(height).toBeGreaterThan(previousHeight + 10);
    expect(await editor().evaluate((element, original) => element === original, originalEditor)).toBe(true);
    expect(await scroller().evaluate((element, original) => element === original, originalScroller)).toBe(true);
    await editor().evaluate(element => element.focus({ preventScroll: true }));
    await expect.poll(() => page.evaluate(() => window.getSelection()?.toString())).toBe(selection);
    await expect(status()).toContainText(cursor);
    await expect.poll(async () => Math.abs(await scroll() - position)).toBeLessThan(3);
    expect(await readPublished()).toBe(disk(content + saved));
  }
  await moreWritingSpace();
  await expect.poll(height).toBeGreaterThan(originalHeight + 120);
  expect(await editor().evaluate((element, original) => element === original, originalEditor)).toBe(true);
  expect(await scroller().evaluate((element, original) => element === original, originalScroller)).toBe(true);
  await expect(modeSelect()).toHaveValue('source');
  await expect(toolbar().getByRole('button', { name: 'Snippet help', exact: true })).toBeVisible();
  await expect(page.locator('.document-tabs').getByRole('tab')).toHaveCount(1);

  await editor().focus();
  await editor().press('ControlOrMeta+End');
  await editor().press('ControlOrMeta+z');
  await expect(editor()).not.toContainText(draft.trim());
  await expect(status()).toContainText('All changes saved');
  await editor().press(process.platform === 'win32' ? 'Control+y' : 'ControlOrMeta+Shift+z');
  await expect(editor()).toContainText(draft.trim());
  await toolbar().locator('.save-button').click();
  await expectSaved(content + saved + draft);
  await expect(notes().locator('.message-banner.notice')).toBeHidden();
  const keyboardDraft = '\nキーボードからも保存できる。';
  await append(keyboardDraft);
  await editor().press('ControlOrMeta+s');
  await expectSaved(content + saved + draft + keyboardDraft);
  await expect(notes().locator('.message-banner.notice')).toBeHidden();

  // Hiding routine save notices must not hide a real failed-save warning or
  // overwrite the external writer's bytes.
  const conflictDraft = '\n競合した下書きも保護する。';
  await append(conflictDraft);
  const external = disk(content + '\n別のアプリから保存された内容。\n');
  await writeFile(path.join(notebook, filename), external);
  await editor().press('ControlOrMeta+s');
  await expect(notes().locator('.message-banner.error')).toContainText('changed by another application');
  await expect(editor()).toContainText(conflictDraft.trim());
  expect(await readPublished()).toBe(external);
  expect(errors).toEqual([]);
});

test('remembers compact Markdown layout and keeps every mode, snippets and graph navigation recoverable', async () => {
  await moreWritingSpace();
  await expect.poll(savedLayout).toMatchObject({
    version: 1, heading: false, paneLabels: false, saveNotifications: false, topicTools: false, compact: true,
  });
  const preferred = await savedLayout();
  await cleanRestart();
  expect(await savedLayout()).toEqual(preferred);
  await expect(notes().locator('.note-heading')).toBeHidden();
  await expect(topicTools()).toBeHidden();
  await openLayout();
  for (const name of ['Document heading', 'Editor labels and hints', 'Save notifications', 'Topic tools']) {
    await expect(layoutDialog().getByRole('checkbox', { name, exact: true })).not.toBeChecked();
  }
  await expect(layoutDialog().getByRole('checkbox', { name: 'Compact spacing', exact: true })).toBeChecked();
  await doneLayout();
  const originalEditor = await editor().elementHandle();
  for (const mode of ['source', 'live', 'preview', 'split'] as const) {
    await modeSelect().selectOption(mode);
    await expect(notes().locator('.editor-layout')).toHaveClass(new RegExp(`mode-${mode}`));
    if (mode === 'preview') await expect(editor()).toBeHidden();
    else {
      await expect(editor()).toBeVisible();
      await expect(editor()).toHaveAttribute('aria-label', mode === 'live' ? 'Live Markdown editor' : 'Markdown source');
    }
    if (mode === 'preview' || mode === 'split') await expect(notes().locator('.markdown-body')).toBeVisible();
    else await expect(notes().locator('.markdown-body')).toHaveCount(0);
    await expect(notes().locator('.pane-label:visible')).toHaveCount(0);
    expect(await editor().evaluate((element, original) => element === original, originalEditor)).toBe(true);
  }
  await modeSelect().selectOption('source');
  await toolbar().getByRole('button', { name: 'Snippet help', exact: true }).click();
  const snippets = page.getByRole('dialog', { name: 'Markdown snippets', exact: true });
  await expect(snippets).toBeVisible();
  await snippets.getByRole('button', { name: 'Done', exact: true }).click();

  await modeSelect().selectOption('preview');
  const preview = notes().locator('.markdown-body');
  const originalPreview = await preview.elementHandle();
  await preview.evaluate(element => element.scrollTo(0, 400));
  await expect.poll(() => preview.evaluate(element => element.scrollTop)).toBe(400);
  await openLayout();
  await layoutDialog().getByRole('button', { name: 'Reset layout', exact: true }).click();
  await doneLayout();
  await expect(notes().locator('.note-heading')).toBeVisible();
  await expect(notes().locator('.preview-pane .pane-label')).toBeVisible();
  await expect(topicTools()).toBeVisible();
  await expect(modeSelect()).toHaveCount(0);
  expect(await preview.evaluate((element, original) => element === original, originalPreview)).toBe(true);
  await expect.poll(() => preview.evaluate(element => element.scrollTop)).toBe(400);
  await expect.poll(savedLayout).toMatchObject({
    heading: true, paneLabels: true, saveNotifications: true, topicTools: true, compact: false,
  });
  await notes().getByRole('group', { name: 'Editor mode', exact: true }).getByRole('button', { name: 'Source', exact: true }).click();
  await page.getByRole('button', { name: 'Graph view', exact: true }).click();
  const graph = page.locator('.graph-view:not(.graph-compact) .graph-canvas');
  await expect(graph).toBeVisible();
  await expect(layoutButton()).toBeVisible();
  await graph.getByRole('button', { name: 'Open 読書ノート', exact: true }).click();
  await expect(editor()).toBeVisible();
  await expect(notes().locator('.note-heading h1')).toHaveText('読書ノート');
  expect(await readPublished()).toBe(disk(content));
  expect(errors).toEqual([]);
});

test('keeps the unlocked PDF and draft beside adjustable Notes at 420 pixels and 150 percent text', async ({}, testInfo) => {
  const draft = '配置を調整しながら、資料と日本語の下書きを並べて読む。';
  await append(draft);
  const originalEditor = await editor().elementHandle();
  const document = path.join(temporary, 'Layout reference.pdf');
  await writeFile(document, fixturePdf('layout-secret'));
  await desktop!.evaluate(({ dialog }, document) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [document] });
  }, document);
  await workspace('PDFs').click();
  await pdf().getByRole('button', { name: 'Import PDFs', exact: true }).click();
  await pdf().getByRole('button', { name: 'Open Layout reference', exact: true }).click();
  await reader().getByLabel('Document password', { exact: true }).fill('layout-secret');
  await reader().getByRole('button', { name: 'Unlock PDF', exact: true }).click();
  await renderedPage(1);
  await reader().getByRole('button', { name: 'Next page', exact: true }).click();
  await reader().getByLabel('Page zoom', { exact: true }).selectOption('2');
  await renderedPage(2);
  await expect(canvas()).toHaveCSS('width', '1224px');
  const originalCanvas = await canvas().elementHandle();
  const originalReader = await reader().elementHandle();
  await page.getByRole('button', { name: 'Read & write', exact: true }).click();
  await expect(page.locator('.workspace-area')).toHaveAttribute('data-layout', 'split');
  await pdfViewport().evaluate(element => element.scrollTo(0, 180));
  await expect.poll(() => pdfViewport().evaluate(element => element.scrollTop)).toBe(180);
  await workspace('Notes').click();
  await moreWritingSpace();
  await expect(topicTools()).toBeHidden();
  await workspace('PDFs').click();
  await expect(topicTools()).toBeHidden();
  await expect(reader().getByLabel('Page number', { exact: true })).toHaveValue('2');
  await expect(reader().getByLabel('Page zoom', { exact: true })).toHaveValue('2');
  await expect.poll(() => pdfViewport().evaluate(element => element.scrollTop)).toBe(180);
  expect(await reader().evaluate((element, original) => element === original, originalReader)).toBe(true);
  expect(await canvas().evaluate((element, original) => element === original, originalCanvas)).toBe(true);

  // Notes preferences never hide the PDF-only topic tools. Returning to the
  // combined layout hides them again without closing either document tab.
  await page.getByRole('button', { name: 'Read & write', exact: true }).click();
  await expect(page.locator('.workspace-area')).toHaveAttribute('data-layout', 'single');
  await expect(topicTools()).toBeVisible();
  await workspace('Notes').click();
  await expect(topicTools()).toBeHidden();
  await page.getByRole('button', { name: 'Read & write', exact: true }).click();
  await expect(page.locator('.workspace-area')).toHaveAttribute('data-layout', 'split');
  await expect(page.locator('.document-tabs').getByRole('tab')).toHaveCount(2);

  const divider = page.getByRole('separator', { name: 'Resize note and PDF panes', exact: true });
  await divider.focus();
  for (let count = 0; count < 20; count++) await divider.press('Shift+ArrowLeft');
  await expect.poll(async () => (await notes().boundingBox())!.width).toBeGreaterThanOrEqual(420);
  await expect.poll(async () => (await notes().boundingBox())!.width).toBeLessThan(430);
  for (const theme of ['Prism', 'Paper', 'Sci-fi']) {
    await toolbar().getByRole('button', { name: 'Window appearance', exact: true }).click();
    const appearance = page.getByRole('dialog', { name: 'Make a little space', exact: true });
    await appearance.getByRole('radio', { name: `${theme} theme`, exact: true }).check();
    await appearance.getByRole('slider', { name: 'Text size', exact: true }).fill('150');
    await appearance.getByRole('button', { name: 'Done', exact: true }).click();
    for (const control of [layoutButton(), modeSelect(), toolbar().locator('.save-button'), toolbar().getByRole('button', { name: 'Snippet help', exact: true })]) {
      await expectInside(control, notes());
    }
    await openLayout();
    await layoutDialog().getByRole('button', { name: 'Reset layout', exact: true }).click();
    await doneLayout();
    await expect(notes().locator('.note-heading')).toBeVisible();
    await expectInside(layoutButton(), notes());
    for (const name of ['Source', 'Split', 'Live', 'Read']) {
      await expectInside(notes().getByRole('group', { name: 'Editor mode', exact: true }).getByRole('button', { name, exact: true }), notes());
    }
    await moreWritingSpace();
    expect(await toolbar().evaluate(element => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1);
    expect(await editor().evaluate((element, original) => element === original, originalEditor)).toBe(true);
    expect(await canvas().evaluate((element, original) => element === original, originalCanvas)).toBe(true);
    await expect(reader().getByLabel('Page number', { exact: true })).toHaveValue('2');
    await expect(reader().getByLabel('Page zoom', { exact: true })).toHaveValue('2');
    await expect(reader().getByLabel('Document password', { exact: true })).toHaveCount(0);
  }
  await editor().focus();
  await editor().press('ControlOrMeta+End');
  await expect(editor()).toContainText(draft);
  expect(await readPublished()).toBe(disk(content));
  await testInfo.attach('Markdown layout at 420 pixels and 150 percent text beside the PDF', {
    body: await page.screenshot({ path: testInfo.outputPath('markdown-layout-narrow.png') }), contentType: 'image/png',
  });
  // Also exercise a whole 420px window: the sidebar leaves less room for the
  // toolbar than a 420px split pane, so its controls must wrap and retain names.
  await page.setViewportSize({ width: 420, height: 900 });
  await expect(page.locator('.workspace-area')).toHaveAttribute('data-layout', 'single');
  for (const control of [layoutButton(), modeSelect(), toolbar().getByRole('button', { name: 'Save', exact: true }), toolbar().getByRole('button', { name: 'Snippet help', exact: true })]) {
    await expectInside(control, notes());
  }
  expect(await toolbar().evaluate(element => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1);
  await openLayout();
  await doneLayout();
  await testInfo.attach('Markdown layout in a narrow window', {
    body: await page.screenshot({ path: testInfo.outputPath('markdown-layout-window.png') }), contentType: 'image/png',
  });
  expect(errors).toEqual([]);
});
