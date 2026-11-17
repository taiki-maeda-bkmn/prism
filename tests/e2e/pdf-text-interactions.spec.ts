import { electronLaunchArguments } from '../../scripts/electron-launch.mjs';
import { _electron as electron, expect, test, type ElectronApplication, type Locator, type Page } from '@playwright/test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fixturePdf } from '../fixtures/pdf';
import { imageOnlyPdf, interactionPdf } from '../fixtures/pdf-interactions';

const applicationRoot = path.resolve(process.env.PRISM_TEST_APP_ROOT || process.cwd());
const initial = '\ufeff# 読書ノート\r\n\r\n資料を読んで、自分の考えを書く。\r\n';
let temporary: string;
let notebook: string;
let desktop: ElectronApplication | undefined;
let page: Page;
let errors: string[];
let remoteRequests: string[];

const workspace = (name: 'Notes' | 'PDFs') => page.getByRole('navigation', { name: 'Workspaces', exact: true }).getByRole('button', { name, exact: true });
const pdf = () => page.locator('.pdf-workspace');
const reader = () => pdf().locator('[data-pdf-session][data-active="true"]');
const canvas = () => reader().locator('.pdf-paper canvas');
const viewport = () => reader().getByLabel('PDF page viewport', { exact: true });
const textLayer = () => reader().locator('.pdf-text-layer');
const linkLayer = () => reader().locator('.pdf-link-layer');
const find = () => reader().getByLabel('Find text in PDF', { exact: true });
const searchStatus = () => reader().locator('.pdf-find-status');
const currentMatch = () => reader().locator('.pdf-search-highlight[data-current="true"]');
const copy = () => reader().getByRole('button', { name: 'Copy selected text', exact: true });
const editor = () => page.locator('.app-body .cm-content');
const noteFile = () => path.join(notebook, 'Welcome to Prism.md');

async function renderedPage(number: number) {
  await expect(canvas()).toBeVisible();
  await expect(canvas()).toHaveAttribute('data-page-number', String(number));
  await expect(reader().locator('.pdf-paper')).toHaveAttribute('aria-busy', 'false');
  await expect(textLayer()).toBeAttached();
}

async function openDocument(title: string, password?: string) {
  await pdf().getByRole('button', { name: `Open ${title}`, exact: true }).click();
  if (password) {
    await expect(reader().getByRole('button', { name: 'Find in PDF', exact: true })).toBeDisabled();
    await reader().getByLabel('Document password', { exact: true }).fill(password);
    await reader().getByRole('button', { name: 'Unlock PDF', exact: true }).click();
  }
  await renderedPage(1);
}

async function openSearch() {
  await reader().getByRole('button', { name: 'Find in PDF', exact: true }).click();
  await expect(find()).toBeFocused();
}

async function goToPage(number: number) {
  await reader().getByLabel('Page number', { exact: true }).fill(String(number));
  await reader().getByLabel('Page number', { exact: true }).press('Enter');
  await renderedPage(number);
}

async function clipboardText() { return desktop!.evaluate(({ clipboard }) => clipboard.readText()); }

async function selectText(text: string) {
  const span = textLayer().getByText(text, { exact: true }).first();
  await expect(span).toBeVisible();
  await span.evaluate(element => {
    const range = document.createRange();
    range.selectNodeContents(element);
    const selection = window.getSelection()!;
    selection.removeAllRanges(); selection.addRange(range);
    document.dispatchEvent(new Event('selectionchange'));
  });
  await expect.poll(() => page.evaluate(() => window.getSelection()?.toString())).toBe(text);
}

async function inside(control: Locator) {
  await expect(control).toBeVisible();
  // Read both bounds in the same frame and wait for responsive layout to settle.
  await expect.poll(() => control.evaluate(element => {
    const box = element.getBoundingClientRect();
    const bounds = element.closest('.pdf-workspace')!.getBoundingClientRect();
    return box.width > 0 && box.left >= bounds.left - 1 && box.right <= bounds.right + 1
      && box.top >= bounds.top - 1 && box.bottom <= bounds.bottom + 1;
  })).toBe(true);
}

test.beforeEach(async () => {
  temporary = await mkdtemp(path.join(os.tmpdir(), 'prism-pdf-text-'));
  notebook = path.join(temporary, 'Notebook');
  errors = []; remoteRequests = [];
  await mkdir(notebook);
  await writeFile(noteFile(), initial);
  const files = [
    { name: 'Interactive reference', bytes: interactionPdf() },
    { name: 'Image only', bytes: imageOnlyPdf() },
    { name: 'Locked reference', bytes: fixturePdf('read-secret') },
  ];
  const paths = files.map(file => path.join(temporary, `${file.name}.pdf`));
  await Promise.all(files.map((file, index) => writeFile(paths[index], file.bytes)));
  const env: Record<string, string> = {
    ...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)),
    PRISM_USER_DATA: path.join(temporary, 'notes-profile'), PRISM_WORKSPACE: notebook,
    PRISM_PDF_USER_DATA: path.join(temporary, 'pdf-profile'),
  };
  delete env.ELECTRON_RUN_AS_NODE;
  desktop = await electron.launch({ executablePath: process.env.PRISM_TEST_ELECTRON,
    args: electronLaunchArguments(['--no-sandbox', applicationRoot]), cwd: applicationRoot, env });
  page = await desktop.firstWindow();
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => { if (/^https?:/.test(request.url())) remoteRequests.push(request.url()); });
  await expect(page.locator('.note-heading h1')).toHaveText('読書ノート');
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.getByRole('group', { name: 'Editor mode', exact: true }).getByRole('button', { name: 'Source', exact: true }).click();
  await desktop.evaluate(async ({ clipboard, dialog, shell }, filePaths) => {
    const previous = await clipboard.read();
    const state = { previous, external: [] as string[] };
    Object.assign(globalThis, { pdfInteractionTest: state });
    shell.openExternal = async url => { state.external.push(url); };
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths });
  }, paths);
  await workspace('PDFs').click();
  await pdf().getByRole('button', { name: 'Import PDFs', exact: true }).click();
  for (const file of files) await expect(pdf().getByRole('button', { name: `Open ${file.name}`, exact: true })).toBeVisible();
});

test.afterEach(async ({}, testInfo) => {
  if (page && !page.isClosed() && testInfo.status !== testInfo.expectedStatus) {
    const screenshot = await page.screenshot().catch(() => undefined);
    if (screenshot) await testInfo.attach('PDF text interactions at failure', { body: screenshot, contentType: 'image/png' });
  }
  if (desktop) {
    const child = desktop.process();
    // Keep clipboard contents in the main process and restore them without
    // exposing copied user data in test output or saving it to the filesystem.
    await desktop.evaluate(async ({ clipboard }) => {
      const state = (globalThis as typeof globalThis & { pdfInteractionTest?: { previous: Electron.ClipboardItem[] } }).pdfInteractionTest;
      if (state?.previous.length) await clipboard.write(state.previous);
      else if (state) await clipboard.clear();
    }).catch(() => undefined);
    const closed = desktop.waitForEvent('close', { timeout: 5_000 }).catch(() => undefined);
    await desktop.evaluate(({ app }) => app.exit(0)).catch(() => undefined);
    await closed;
    if (child.exitCode === null) child.kill();
    desktop = undefined;
  }
  if (temporary) await rm(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

test('selects and copies PDF text and follows only safe web, email and internal links', async () => {
  await openDocument('Interactive reference');
  await expect(textLayer()).toContainText('Selectable copy text.');
  const span = textLayer().locator('span').filter({ hasText: /^Selectable copy text\.$/ }).first();
  const box = await span.boundingBox();
  if (!box) throw new Error('The selectable PDF line has no bounds.');
  await page.mouse.move(box.x + 0.5, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width - 0.5, box.y + box.height / 2, { steps: 12 });
  await page.mouse.up();
  await expect.poll(() => page.evaluate(() => window.getSelection()?.toString())).toBe('Selectable copy text.');
  await page.keyboard.press('ControlOrMeta+c');
  await expect.poll(clipboardText).toBe('Selectable copy text.');
  await selectText('needle appears on page one.');
  await copy().click();
  await expect.poll(clipboardText).toBe('needle appears on page one.');

  // A PDF selection can survive focusing a form control. Its copy shortcut
  // must not replace the query selected in the Find input with PDF text.
  await openSearch();
  await find().fill('needle');
  await expect(searchStatus()).toContainText('1 of 2 matches');
  await selectText('Selectable copy text.');
  await expect(copy()).toBeEnabled();
  await find().focus();
  await find().evaluate(element => (element as HTMLInputElement).select());
  await expect(find()).toBeFocused();
  expect(await find().evaluate(element => {
    const input = element as HTMLInputElement;
    return input.value.slice(input.selectionStart ?? 0, input.selectionEnd ?? 0);
  })).toBe('needle');
  await find().press('ControlOrMeta+c');
  await expect.poll(clipboardText).toBe('needle');
  await reader().getByRole('button', { name: 'Close PDF search', exact: true }).click();

  const mainURL = page.url();
  await expect(linkLayer().locator('a')).toHaveCount(4);
  await linkLayer().locator('a[href="https://example.com/prism"]').click();
  await linkLayer().locator('a[href="mailto:reader@example.com"]').click();
  await expect.poll(() => desktop!.evaluate(() => (globalThis as typeof globalThis & { pdfInteractionTest: { external: string[] } }).pdfInteractionTest.external))
    .toEqual(['https://example.com/prism', 'mailto:reader@example.com']);
  expect(page.url()).toBe(mainURL);
  await expect(linkLayer().locator('a[href^="javascript:"],a[href^="file:"]')).toHaveCount(0);

  await linkLayer().getByRole('link', { name: 'Go to linked page', exact: true }).click();
  await renderedPage(2);
  await expect(textLayer()).toContainText('Chapter two');
  await linkLayer().getByRole('link', { name: 'First page', exact: true }).click();
  await renderedPage(1);
  await linkLayer().getByRole('link', { name: 'Go to ChapterTwo', exact: true }).click();
  await renderedPage(2);

  for (const url of ['javascript:alert(1)', 'file:///C:/Windows/notepad.exe']) {
    expect(await page.evaluate(async url => {
      try { await window.prismPdf.openExternal(url); return 'opened'; }
      catch { return 'rejected'; }
    }, url)).toBe('rejected');
  }
  const copied = await clipboardText();
  expect(await page.evaluate(async () => {
    try { await window.prismPdf.copyText('x'.repeat(2_000_001)); return 'copied'; }
    catch { return 'rejected'; }
  })).toBe('rejected');
  expect(await clipboardText()).toBe(copied);
  expect(await readFile(path.join(temporary, 'Interactive reference.pdf'))).toEqual(interactionPdf());
  expect(remoteRequests).toEqual([]);
  expect(errors).toEqual([]);
});

test('searches the whole PDF and keeps the draft, highlights and compact controls through zoom and rotation', async ({}, testInfo) => {
  await workspace('Notes').click();
  await editor().focus();
  await editor().press('ControlOrMeta+End');
  const draft = '検索しながら、日本語の下書きを残す。';
  await page.keyboard.insertText(draft);
  const originalEditor = await editor().elementHandle();
  await page.getByRole('button', { name: 'Read & write', exact: true }).click();
  await openDocument('Interactive reference');
  await viewport().focus();
  await page.keyboard.press('ControlOrMeta+f');
  await expect(find()).toBeFocused();
  await find().fill('NEEDLE');
  await expect(searchStatus()).toContainText('1 of 2 matches');
  await expect(currentMatch()).toHaveCount(1);
  await find().press('Enter');
  await renderedPage(2);
  await expect(searchStatus()).toContainText('2 of 2 matches');
  await expect(currentMatch()).toHaveCount(1);

  await reader().getByRole('button', { name: 'Back to library', exact: true }).click();
  await openDocument('Image only');
  await page.getByRole('tab', { name: 'Interactive reference · PDF', exact: true }).click();
  await renderedPage(2);
  await expect(find()).toHaveValue('NEEDLE');
  await expect(searchStatus()).toContainText('2 of 2 matches');
  await expect(currentMatch()).toHaveCount(1);
  // Reusing both already-open tabs must retain the selected result too.
  await page.getByRole('tab', { name: 'Image only · PDF', exact: true }).click();
  await renderedPage(1);
  await page.getByRole('tab', { name: 'Interactive reference · PDF', exact: true }).click();
  await renderedPage(2);
  await expect(searchStatus()).toContainText('2 of 2 matches');
  await expect(currentMatch()).toHaveCount(1);
  await reader().getByRole('button', { name: 'Previous match', exact: true }).click();
  await renderedPage(1);
  await find().fill('no-result-token');
  await expect(searchStatus()).toContainText('No matches');
  await expect(currentMatch()).toHaveCount(0);
  await find().fill('cross line match');
  await expect(searchStatus()).toContainText('1 of 1 matches');
  await expect.poll(() => currentMatch().count()).toBeGreaterThan(1);
  await find().fill('alpha beta');
  await expect(searchStatus()).toContainText('1 of 1 matches');
  await find().fill('needle');
  await expect(searchStatus()).toContainText('1 of 2 matches');

  await reader().getByLabel('Page zoom', { exact: true }).selectOption('1.5');
  await reader().getByRole('button', { name: 'Rotate page clockwise', exact: true }).click();
  await expect(canvas()).toHaveCSS('width', '1188px');
  await renderedPage(1);
  await expect(currentMatch()).toHaveCount(1);
  await selectText('Selectable copy text.');
  await copy().click();
  await expect.poll(clipboardText).toBe('Selectable copy text.');
  await reader().getByRole('button', { name: 'Close PDF search', exact: true }).click();
  await editor().focus();
  await page.keyboard.press('ControlOrMeta+f');
  await expect(page.locator('.app-body .cm-search')).toBeVisible();
  await expect(reader().locator('.pdf-find-bar')).toBeHidden();
  await page.keyboard.press('Escape');
  await openSearch();

  await page.locator('.app-body .document-toolbar').getByRole('button', { name: 'Window appearance', exact: true }).click();
  const appearance = page.getByRole('dialog', { name: 'Make a little space', exact: true });
  await appearance.getByRole('radio', { name: 'Sci-fi theme', exact: true }).check();
  await appearance.getByRole('slider', { name: 'Text size', exact: true }).fill('150');
  await appearance.getByRole('button', { name: 'Done', exact: true }).click();
  await pdf().getByRole('button', { name: 'PDF layout', exact: true }).click();
  const layout = page.getByRole('dialog', { name: 'Reading layout', exact: true });
  await layout.getByRole('button', { name: 'More reading space', exact: true }).click();
  await layout.getByRole('checkbox', { name: 'Page toolbar', exact: true }).uncheck();
  await layout.getByRole('button', { name: 'Done', exact: true }).click();
  await expect(reader().locator('.pdf-reader-toolbar')).toBeHidden();
  await workspace('PDFs').click();
  await page.setViewportSize({ width: 420, height: 900 });
  for (const control of [find(), copy(), reader().getByRole('button', { name: 'Find in PDF', exact: true }),
    reader().getByRole('button', { name: 'Previous match', exact: true }), reader().getByRole('button', { name: 'Next match', exact: true }),
    reader().getByRole('button', { name: 'Close PDF search', exact: true })]) await inside(control);
  await reader().getByRole('button', { name: 'Next match', exact: true }).click();
  await renderedPage(2);
  await expect(searchStatus()).toContainText('2 of 2 matches');
  await testInfo.attach('Search and copy controls in compact PDF layout', {
    body: await page.screenshot({ path: testInfo.outputPath('pdf-text-compact.png') }), contentType: 'image/png',
  });
  await workspace('Notes').click();
  await expect(editor()).toContainText(draft);
  expect(await editor().evaluate((element, original) => element === original, originalEditor)).toBe(true);
  await editor().focus();
  await editor().press('ControlOrMeta+z');
  await expect(editor()).not.toContainText(draft);
  expect(await readFile(noteFile(), 'utf8')).toBe(initial);
  expect(remoteRequests).toEqual([]);
  expect(errors).toEqual([]);
});

test('explains image-only PDFs and searches password-protected text after unlocking', async () => {
  await openDocument('Image only');
  await expect(textLayer().locator('span')).toHaveCount(0);
  await expect(reader().locator('.pdf-text-notice')).toContainText(/text/i);
  await expect(copy()).toBeDisabled();
  await openSearch();
  await find().fill('anything');
  await expect(searchStatus()).toContainText(/No searchable text/i);
  await find().press('Escape');
  await expect(reader().locator('.pdf-find-bar')).toBeHidden();
  await reader().getByRole('button', { name: 'Back to library', exact: true }).click();
  await openDocument('Locked reference', 'read-secret');
  await expect(textLayer()).toContainText('Prism PDF field notes');
  await openSearch();
  await find().fill('remembered');
  await expect(searchStatus()).toContainText('1 of 1 matches');
  await renderedPage(2);
  await expect(currentMatch()).toHaveCount(1);
  await find().fill('');
  await expect(currentMatch()).toHaveCount(0);
  await reader().getByRole('button', { name: 'Close PDF search', exact: true }).click();
  await goToPage(1);
  await selectText('Prism PDF field notes');
  await copy().click();
  await expect.poll(clipboardText).toBe('Prism PDF field notes');
  expect(remoteRequests).toEqual([]);
  expect(errors).toEqual([]);
});
