import { electronLaunchArguments } from '../../scripts/electron-launch.mjs';
import { _electron as electron, expect, test, type ElectronApplication, type ElementHandle, type Page } from '@playwright/test';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { PDFDocument } from '../../pdf-manager/src/shared/types';
import { fixturePdf } from '../fixtures/pdf';

const documentId = '1746f19d-10f0-485e-8017-73b73a5c37d5';
const original = '# 読書と回復\n\n保存済みの本文。\n\n';
const external = '# 読書と回復\n\n別のエディターで保存した変更。\n\n';
const diskText = (value: string) => '\ufeff' + value.replace(/\n/g, '\r\n');
const href = (number: number) => `prism-pdf://v1/documents/${documentId}?page=${number}`;
const reference = `[回復の資料 — p. 2](${href(2)})`;
const redoKey = process.platform === 'darwin' ? 'Meta+Shift+Z' : 'Control+y';
let temporary: string;
let notebook: string;
let secondNotebook: string;
let userData: string;
let pdfProfile: string;
let desktop: ElectronApplication | undefined;
let page: Page;
let rendererErrors: string[];
let remoteRequests: string[];

const noteFile = (directory = notebook) => path.join(directory, 'Welcome to Prism.md');
const managedFile = () => path.join(pdfProfile, 'library', 'documents', `${documentId}.pdf`);
const catalogFile = () => path.join(pdfProfile, 'library', 'catalog.json');
const editor = () => page.locator('.app-body .cm-content');
const pdf = () => page.locator('.pdf-workspace');
const mode = (name: 'Source' | 'Read') => page.getByRole('group', { name: 'Editor mode', exact: true }).getByRole('button', { name, exact: true });
const workspaceButton = (name: 'Notes' | 'PDFs') => page.getByRole('navigation', { name: 'Workspaces', exact: true }).getByRole('button', { name, exact: true });
const prompt = () => page.getByRole('dialog', { name: 'Keep your latest thoughts?', exact: true });
const selection = () => page.evaluate(() => window.getSelection()?.toString());

async function seedLibrary(bytes: Buffer, missing = false) {
  const document: PDFDocument = {
    id: documentId, title: '回復の資料', filename: '回復の資料.pdf', size: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    importedAt: '2025-08-09T10:11:12.000Z', updatedAt: '2025-09-10T11:12:13.000Z',
    tags: ['読む'], favorite: true, lastOpenedAt: null, lastPage: 1, pageCount: 2,
  };
  await mkdir(path.dirname(managedFile()), { recursive: true });
  await writeFile(catalogFile(), JSON.stringify({ version: 1, documents: [document] }) + '\n');
  if (!missing) await writeFile(managedFile(), bytes);
}

async function launch() {
  desktop = await electron.launch({
    args: electronLaunchArguments(['--no-sandbox', '.']), cwd: process.cwd(),
    env: { ...process.env, PRISM_USER_DATA: userData, PRISM_WORKSPACE: notebook, PRISM_PDF_USER_DATA: pdfProfile },
  });
  page = await desktop.firstWindow();
  page.on('pageerror', error => rendererErrors.push(error.message));
  page.on('request', request => { if (/^https?:/.test(request.url())) remoteRequests.push(request.url()); });
  await expect(page.locator('.note-heading h1')).toHaveText('読書と回復');
  await page.setViewportSize({ width: 1440, height: 1000 });
  await mode('Source').click();
  await page.getByRole('button', { name: 'Read & write', exact: true }).click();
  await expect(page.locator('.workspace-area')).toHaveAttribute('data-layout', 'split');
}

async function append(value: string) {
  await editor().focus();
  await editor().press('ControlOrMeta+End');
  await page.keyboard.insertText(value);
  await expect(page.locator('.statusbar')).toContainText('1 unsaved note');
}

async function renderedPage(number: number) {
  const canvas = pdf().locator(`.pdf-paper canvas[data-page-number="${number}"]`);
  await expect(canvas).toBeVisible();
  await expect(pdf().getByLabel('Page number', { exact: true })).toHaveValue(String(number));
  await expect(pdf().locator('.pdf-paper')).toHaveAttribute('aria-busy', 'false');
  await expect.poll(() => canvas.evaluate((element: HTMLCanvasElement) => {
    const pixels = element.getContext('2d')!.getImageData(0, 0, element.width, element.height).data;
    let colored = 0;
    for (let offset = 0; offset < pixels.length; offset += 16) {
      if (Math.max(pixels[offset], pixels[offset + 1], pixels[offset + 2]) - Math.min(pixels[offset], pixels[offset + 1], pixels[offset + 2]) > 40) colored++;
    }
    return colored;
  })).toBeGreaterThan(100);
}

async function expectReaderRetained(reader: ElementHandle<SVGElement | HTMLElement>) {
  await renderedPage(2);
  expect(await pdf().locator('.pdf-reader').evaluate((element, previous) => element === previous, reader)).toBe(true);
  await expect(pdf().getByLabel('Document password', { exact: true })).toHaveCount(0);
  await expect(pdf().getByLabel('Page zoom', { exact: true })).toHaveValue('1.5');
}

async function showNotes() {
  const navigation = page.locator('#notes-navigation');
  if (!(await navigation.isVisible())) await page.getByRole('button', { name: 'Show notes', exact: true }).click();
  await expect(navigation).toBeVisible();
}

async function hideNotes() {
  await expect(page.locator('.app-body')).toHaveAttribute('aria-busy', 'false');
  const close = page.getByRole('button', { name: 'Close notes navigation', exact: true });
  if (await close.isVisible()) await close.click();
}

async function expectEmptyHistory(expected: string) {
  await editor().focus();
  for (const key of ['ControlOrMeta+z', redoKey]) {
    await editor().press(key);
    await expect(editor()).toContainText(expected);
    await expect(editor()).not.toContainText('prism-pdf:');
    await expect(page.locator('.statusbar')).toContainText('All changes saved');
  }
}

test.beforeEach(async () => {
  temporary = await mkdtemp(path.join(os.tmpdir(), 'prism-pdf-linked-recovery-'));
  notebook = path.join(temporary, 'First notebook');
  secondNotebook = path.join(temporary, 'Second notebook');
  userData = path.join(temporary, 'notes-profile');
  pdfProfile = path.join(temporary, 'pdf-profile');
  rendererErrors = []; remoteRequests = [];
  await Promise.all([mkdir(notebook), mkdir(secondNotebook), mkdir(userData)]);
  await writeFile(noteFile(), diskText(original));
});

test.afterEach(async ({}, testInfo) => {
  if (page && !page.isClosed() && testInfo.status !== testInfo.expectedStatus) {
    const screenshot = await page.screenshot().catch(() => undefined);
    if (screenshot) await testInfo.attach('Linked-note recovery at failure', { body: screenshot, contentType: 'image/png' });
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

test('keeps a linked draft through save conflicts and canceled close/refresh, then isolates it from a matching notebook', async () => {
  const bytes = fixturePdf('recovery-session');
  await seedLibrary(bytes);
  await launch();
  await append('引用の前に書いた下書き。\n');
  await pdf().getByRole('button', { name: 'Open 回復の資料', exact: true }).click();
  await pdf().getByLabel('Document password', { exact: true }).fill('recovery-session');
  await pdf().getByRole('button', { name: 'Unlock PDF', exact: true }).click();
  await renderedPage(1);
  await pdf().getByRole('button', { name: 'Next page', exact: true }).click();
  await renderedPage(2);
  await pdf().getByLabel('Page zoom', { exact: true }).selectOption('1.5');
  await renderedPage(2);
  await pdf().getByRole('button', { name: 'Insert page link', exact: true }).click();
  await expect(editor()).toContainText(reference);
  await append('\n保持したい選択');
  await editor().press('Shift+Home');
  const originalEditor = await editor().elementHandle();
  const originalReader = (await pdf().locator('.pdf-reader').elementHandle())!;
  expect(await selection()).toBe('保持したい選択');
  await workspaceButton('PDFs').click();
  await page.keyboard.press('ControlOrMeta+k');
  await expect(pdf().getByLabel('Search library', { exact: true })).toBeFocused();
  await workspaceButton('Notes').click();
  await expect(editor()).toBeFocused();
  await expect.poll(selection).toBe('保持したい選択');

  // A real concurrent filesystem edit must block saving the linked draft.
  await writeFile(noteFile(), diskText(external));
  await editor().press('ControlOrMeta+s');
  await expect(page.locator('.message-banner.error')).toContainText('changed by another application');
  await expect(page.locator('.app-body')).toHaveAttribute('aria-busy', 'false');
  await expect(editor()).toContainText(reference);
  await editor().focus();
  await expect.poll(selection).toBe('保持したい選択');
  expect(await readFile(noteFile(), 'utf8')).toBe(diskText(external));

  await workspaceButton('PDFs').click();
  await desktop!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
  await expect(prompt()).toContainText('closing Prism');
  await prompt().getByRole('button', { name: 'Save & continue', exact: true }).click();
  await expect(prompt().getByRole('alert')).toContainText('changed by another application');
  await prompt().getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(prompt()).toHaveCount(0);
  await expectReaderRetained(originalReader);
  await editor().focus();
  await expect.poll(selection).toBe('保持したい選択');

  await showNotes();
  await page.getByRole('button', { name: 'Refresh notebook', exact: true }).click();
  await expect(prompt()).toContainText('reloading from disk');
  await prompt().getByRole('button', { name: 'Cancel', exact: true }).click();
  await hideNotes();
  await editor().focus();
  // Native focus restores CodeMirror's DOM selection on its focus update.
  await expect.poll(selection).toBe('保持したい選択');
  expect(await editor().evaluate((element, previous) => element === previous, originalEditor)).toBe(true);
  await editor().press('ControlOrMeta+z');
  await expect(editor()).not.toContainText('保持したい選択');
  await expect(editor()).toContainText(reference);
  await editor().press('ControlOrMeta+z');
  await expect(editor()).not.toContainText('prism-pdf:');
  await expect(editor()).toContainText('引用の前に書いた下書き。');
  await editor().press(redoKey);
  await expect(editor()).toContainText(reference);
  await editor().press(redoKey);
  await expect(editor()).toContainText('保持したい選択');
  await expectReaderRetained(originalReader);
  expect(await readFile(noteFile(), 'utf8')).toBe(diskText(external));

  // Discard is deliberate: reload the competing saved text, then ensure neither
  // undo nor a notebook with an identical path/content can revive the draft.
  await showNotes();
  await page.getByRole('button', { name: 'Refresh notebook', exact: true }).click();
  await prompt().getByRole('button', { name: 'Discard changes', exact: true }).click();
  await expect(prompt()).toHaveCount(0);
  await expect(editor()).toContainText('別のエディターで保存した変更。');
  await hideNotes();
  await expectEmptyHistory('別のエディターで保存した変更。');
  await expectReaderRetained(originalReader);
  // Leave a reference only in redo history. The next notebook has identical
  // path and content, so a missing editor reset cannot hide behind a text change.
  await editor().press('ControlOrMeta+End');
  await pdf().getByRole('button', { name: 'Insert page link', exact: true }).click();
  await expect(editor()).toContainText(reference);
  await editor().press('ControlOrMeta+z');
  await expect(editor()).not.toContainText('prism-pdf:');
  await expect(page.locator('.statusbar')).toContainText('All changes saved');
  await writeFile(noteFile(secondNotebook), diskText(external));
  await desktop!.evaluate(({ dialog }, directory) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [directory] });
  }, secondNotebook);
  await editor().press('ControlOrMeta+o');
  await expect(page.locator('.workspace-switch strong')).toHaveText('Second notebook');
  await showNotes();
  await hideNotes();
  await expectEmptyHistory('別のエディターで保存した変更。');
  await expectReaderRetained(originalReader);
  await editor().press('ControlOrMeta+End');
  await pdf().getByRole('button', { name: 'Insert page link', exact: true }).click();
  await editor().press('ControlOrMeta+s');
  await expect.poll(() => readFile(noteFile(secondNotebook), 'utf8')).toBe(diskText(external + reference));
  expect(await readFile(noteFile(), 'utf8')).toBe(diskText(external));
  expect(await readFile(managedFile())).toEqual(bytes);
  expect(rendererErrors).toEqual([]);
  expect(remoteRequests).toEqual([]);
});

test('retries a missing managed PDF at the linked page while retaining edits made during the failure', async () => {
  const bytes = fixturePdf();
  await seedLibrary(bytes, true);
  const content = original + `[開きたい二ページ](${href(2)})\n\n`;
  await writeFile(noteFile(), diskText(content));
  const catalogBefore = await readFile(catalogFile());
  await launch();
  await mode('Read').click();
  await page.locator('.preview-pane').getByRole('link', { name: '開きたい二ページ', exact: true }).click();
  await expect(pdf().getByRole('heading', { name: 'Unable to display this PDF', exact: true })).toBeVisible();
  await expect(pdf().getByRole('button', { name: 'Insert page link', exact: true })).toBeDisabled();
  expect(await readFile(catalogFile())).toEqual(catalogBefore);
  await mode('Source').click();
  await append('PDFを回復している間の下書き。');
  await editor().press('Shift+Home');
  const originalEditor = await editor().elementHandle();
  expect(await selection()).toBe('PDFを回復している間の下書き。');

  // Restore only this disposable fixture's bytes. Its catalog ID is preserved;
  // the pending page-2 link must override its saved reading position of page 1.
  await writeFile(managedFile(), bytes);
  await pdf().getByRole('button', { name: 'Try again', exact: true }).click();
  await renderedPage(2);
  await expect(pdf().getByRole('button', { name: 'Insert page link', exact: true })).toBeEnabled();
  await editor().focus();
  await expect.poll(selection).toBe('PDFを回復している間の下書き。');
  expect(await editor().evaluate((element, previous) => element === previous, originalEditor)).toBe(true);
  await editor().press('ControlOrMeta+z');
  await expect(editor()).not.toContainText('PDFを回復している間の下書き。');
  await expect(page.locator('.statusbar')).toContainText('All changes saved');
  await editor().press(redoKey);
  await expect(editor()).toContainText('PDFを回復している間の下書き。');
  await editor().press('ControlOrMeta+s');
  await expect.poll(() => readFile(noteFile(), 'utf8')).toBe(diskText(content + 'PDFを回復している間の下書き。'));
  await expect.poll(async () => {
    const catalog = JSON.parse(await readFile(catalogFile(), 'utf8')) as { documents: PDFDocument[] };
    return catalog.documents[0].lastPage;
  }).toBe(2);
  const catalog = JSON.parse(await readFile(catalogFile(), 'utf8')) as { documents: PDFDocument[] };
  expect(catalog.documents).toHaveLength(1);
  expect(catalog.documents[0]).toMatchObject({ id: documentId, tags: ['読む'], favorite: true, pageCount: 2 });
  expect(await readFile(managedFile())).toEqual(bytes);
  expect(rendererErrors).toEqual([]);
  expect(remoteRequests).toEqual([]);
});
