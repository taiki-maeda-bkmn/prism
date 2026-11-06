import { _electron as electron, expect, test, type ElectronApplication, type Locator, type Page } from '@playwright/test';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { electronLaunchArguments } from '../../scripts/electron-launch.mjs';
import { fixturePdf } from '../fixtures/pdf';
import type { PDFDocument, PDFFolder } from '../../pdf-manager/src/shared/types';

const applicationRoot = path.resolve(process.env.PRISM_TEST_APP_ROOT || process.cwd());
const original = '\ufeff# Drop notes\r\n\r\nThe notebook remains independent of PDF imports.\r\n';
const draft = '資料を読みながら保存前のメモ。';
let temporary: string, notebook: string, profile: string;
let desktop: ElectronApplication | undefined, page: Page;
let existing: PDFDocument, research: PDFFolder, archive: PDFFolder;
let sources: Map<string, Buffer>, errors: string[];

const pdf = () => page.locator('.pdf-workspace');
const workspace = (name: 'Notes' | 'PDFs') => page.getByRole('navigation', { name: 'Workspaces', exact: true }).getByRole('button', { name, exact: true });
const folder = (name: string) => pdf().getByRole('button', { name: `Folder ${name}`, exact: true });
const editor = () => page.getByRole('textbox', { name: 'Markdown source', exact: true });
const importButton = () => pdf().getByRole('button', { name: 'Import PDFs', exact: true });
const library = () => pdf().locator('.library-content');
const catalogPath = () => path.join(profile, 'library/catalog.json');
const sourcePath = (filename: string) => path.join(temporary, 'External 資料', filename);
const catalog = async (): Promise<{ version: number; documents: PDFDocument[]; folders: PDFFolder[] }> => JSON.parse(await readFile(catalogPath(), 'utf8'));
const documents = async () => (await catalog()).documents;
const byFilename = async (filename: string) => (await documents()).find(document => document.filename === filename)!;
const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

async function readPublishedNote() {
  try { return await readFile(path.join(notebook, 'Drop notes.md'), 'utf8'); }
  catch (error) {
    // A Windows publication gap is a pending save, not a completed assertion.
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

async function launch() {
  const env: Record<string, string> = {
    ...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)),
    PRISM_USER_DATA: path.join(temporary, 'notes-profile'), PRISM_WORKSPACE: notebook, PRISM_PDF_USER_DATA: profile,
  };
  delete env.ELECTRON_RUN_AS_NODE;
  desktop = await electron.launch({ executablePath: process.env.PRISM_TEST_ELECTRON,
    args: electronLaunchArguments(['--no-sandbox', applicationRoot]), cwd: applicationRoot, env });
  page = await desktop.firstWindow();
  page.on('pageerror', error => errors.push(error.message));
  await expect(page.locator('.note-heading h1')).toHaveText('Drop notes');
  await page.setViewportSize({ width: 1440, height: 1000 });
}

async function stop(graceful = false) {
  if (!desktop) return;
  const application = desktop;
  const child = application.process();
  const closed = application.waitForEvent('close', { timeout: 5_000 }).catch(() => undefined);
  await application.evaluate(({ app }, normal) => { if (normal) app.quit(); else app.exit(0); }, graceful).catch(() => undefined);
  await closed;
  if (child.exitCode === null) child.kill();
  desktop = undefined;
}

async function visit() { await workspace('PDFs').click(); await expect(importButton()).toBeEnabled(); }

async function dragFiles(filenames: string[]) {
  // Chromium creates disk-backed Files from these host paths. The normal
  // preload/webUtils/IPC route remains intact; this is not a physical Explorer drag.
  const session = await page.context().newCDPSession(page);
  const data = { items: [], files: filenames.map(sourcePath), dragOperationsMask: 1 };
  let point = { x: 0, y: 0 };
  const send = async (type: 'dragEnter' | 'dragOver' | 'drop' | 'dragCancel', target?: Locator) => {
    if (target) {
      await expect(target).toBeVisible();
      const box = await target.boundingBox();
      expect(box).not.toBeNull();
      point = { x: box!.x + box!.width / 2, y: box!.y + Math.min(box!.height / 2, 160) };
    }
    await session.send('Input.dispatchDragEvent', { type, ...point, data });
  };
  return { session, enter: (target: Locator) => send('dragEnter', target), over: (target: Locator) => send('dragOver', target),
    drop: (target: Locator) => send('drop', target), cancel: () => send('dragCancel') };
}

async function dropFiles(target: Locator, filenames: string[], accepted = true) {
  const drag = await dragFiles(filenames);
  try {
    await drag.enter(target);
    // A move can only enter a new DOM target. Continue hovering so Chromium
    // also delivers dragover, then confirm acceptance before releasing files.
    await drag.over(target); await drag.over(target);
    if (accepted) await expect(target).toHaveClass(/pdf-file-drop-target|pdf-drop-target/);
    await drag.drop(target);
  }
  finally { await drag.session.detach(); }
}

async function expectOriginals() {
  for (const [filename, bytes] of sources) expect(await readFile(sourcePath(filename))).toEqual(bytes);
}

test.beforeEach(async () => {
  temporary = await mkdtemp(path.join(os.tmpdir(), 'prism-file-drops-'));
  notebook = path.join(temporary, 'notebook'); profile = path.join(temporary, 'pdf-profile'); errors = [];
  await Promise.all([mkdir(notebook), mkdir(path.join(temporary, 'External 資料')), mkdir(path.join(profile, 'library/documents'), { recursive: true })]);
  research = { id: randomUUID(), name: '研究資料' }; archive = { id: randomUUID(), name: 'Archive' };
  const bytes = fixturePdf();
  existing = { id: randomUUID(), title: 'Saved research', filename: 'Saved research.pdf', size: bytes.length,
    sha256: digest(bytes), importedAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-02T00:00:00.000Z',
    tags: ['Execution', '日本語'], favorite: true, lastOpenedAt: '2026-01-02T00:00:00.000Z', lastPage: 2,
    pageCount: 2, folderId: archive.id, arxivId: '2601.00001v1' };
  sources = new Map([
    ['価格の研究 100%.PDF', Buffer.concat([bytes, Buffer.from('\n% Japanese source\n')])],
    ['Second paper.pdf', Buffer.concat([bytes, Buffer.from('\n% Second source\n')])],
    ['Third paper.pdf', Buffer.concat([bytes, Buffer.from('\n% Third source\n')])],
    ['Fourth paper.pdf', Buffer.concat([bytes, Buffer.from('\n% Fourth source\n')])],
    ['Existing copy.pdf', bytes], ['Notes.txt', Buffer.from('Not a PDF')], ['Broken.pdf', Buffer.from('Invalid PDF header')],
  ]);
  await Promise.all([...sources].map(([filename, content]) => writeFile(sourcePath(filename), content)));
  await writeFile(path.join(profile, 'library/documents', `${existing.id}.pdf`), bytes);
  await writeFile(catalogPath(), JSON.stringify({ version: 2, documents: [existing], folders: [research, archive] }, null, 2) + '\n');
  await writeFile(path.join(notebook, 'Drop notes.md'), original);
  await launch();
});
test.afterEach(async () => { await stop(); await rm(temporary, { recursive: true, force: true }); });

test('imports real disk files into a folder with partial results, unchanged duplicates and retained note undo', async () => {
  await page.getByRole('group', { name: 'Editor mode', exact: true }).getByRole('button', { name: 'Source', exact: true }).click();
  await editor().focus(); await editor().press('ControlOrMeta+End'); await page.keyboard.insertText(draft);
  const editorNode = await editor().elementHandle();
  await visit();
  await dropFiles(folder(research.name), ['価格の研究 100%.PDF', 'Second paper.pdf', 'Existing copy.pdf', 'Notes.txt', 'Broken.pdf']);
  await expect.poll(async () => (await documents()).length).toBe(3);
  await expect(importButton()).toBeEnabled();
  await expect(library().getByRole('heading', { name: research.name, exact: true })).toBeVisible();
  await expect(pdf().getByRole('alert')).toContainText('2 PDFs');
  await expect(pdf().getByRole('alert')).toContainText('already');
  await expect(pdf().getByRole('alert')).toContainText('unchanged');
  await expect(pdf().getByRole('alert')).toContainText('Notes.txt');
  await expect(pdf().getByRole('alert')).toContainText('Broken.pdf');
  expect((await documents()).find(document => document.id === existing.id)).toEqual(existing);
  for (const filename of ['価格の研究 100%.PDF', 'Second paper.pdf']) {
    const document = await byFilename(filename);
    expect(document.folderId).toBe(research.id);
    expect(document.sha256).toBe(digest(sources.get(filename)!));
    expect(await readFile(path.join(profile, 'library/documents', `${document.id}.pdf`))).toEqual(sources.get(filename));
  }
  await expectOriginals();
  await pdf().getByRole('button', { name: 'Open 価格の研究 100%', exact: true }).click();
  await expect(pdf().locator('.pdf-paper canvas[data-page-number="1"]')).toBeVisible();
  await pdf().getByRole('button', { name: 'Next page', exact: true }).click();
  await expect(pdf().locator('.pdf-paper canvas[data-page-number="2"]')).toBeVisible();
  await workspace('Notes').click();
  expect(await editor().evaluate((node, previous) => node === previous, editorNode)).toBe(true);
  await expect(editor()).toContainText(draft);
  await editor().press('ControlOrMeta+z'); await expect(editor()).not.toContainText(draft);
  await editor().press(process.platform === 'win32' ? 'Control+y' : 'ControlOrMeta+Shift+z');
  await expect(editor()).toContainText(draft);
  await editor().press('ControlOrMeta+s');
  await expect.poll(readPublishedNote).toBe(original + draft);
  await expect(page.locator('.statusbar')).toContainText('All changes saved');
  await workspace('PDFs').click();
  await expect(pdf().locator('.pdf-paper canvas[data-page-number="2"]')).toBeVisible();
  await stop(true); await launch(); await visit(); await folder(research.name).click();
  await expect(pdf().getByRole('button', { name: 'Open 価格の研究 100%', exact: true })).toBeVisible();
  await pdf().getByRole('button', { name: 'Open 価格の研究 100%', exact: true }).click();
  await expect(pdf().locator('.pdf-paper canvas[data-page-number="2"]')).toBeVisible();
  expect((await documents()).find(document => document.id === existing.id)).toEqual(existing);
  await expectOriginals(); expect(errors).toEqual([]);
});

test('library drops and keyboard import use the selected folder while default and Unfiled drops stay unfiled', async () => {
  await visit();
  await dropFiles(library(), ['価格の研究 100%.PDF']);
  await expect.poll(async () => (await documents()).length).toBe(2);
  expect((await byFilename('価格の研究 100%.PDF')).folderId).toBeUndefined();
  await expect(importButton()).toBeEnabled();
  await folder(research.name).click();
  await dropFiles(library(), ['Second paper.pdf']);
  await expect.poll(async () => (await byFilename('Second paper.pdf'))?.folderId).toBe(research.id);
  await expect(importButton()).toBeEnabled();
  await expect(library().getByRole('heading', { name: research.name, exact: true })).toBeVisible();
  await desktop!.evaluate(({ dialog }, filename) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [filename] }); }, sourcePath('Third paper.pdf'));
  await importButton().focus(); await page.keyboard.press('ControlOrMeta+o');
  await expect.poll(async () => (await byFilename('Third paper.pdf'))?.folderId).toBe(research.id);
  await expect(importButton()).toBeEnabled();
  await expect(library().getByRole('heading', { name: research.name, exact: true })).toBeVisible();
  await dropFiles(pdf().getByRole('button', { name: 'Unfiled', exact: true }), ['Fourth paper.pdf']);
  await expect.poll(async () => (await documents()).length).toBe(5);
  expect((await byFilename('Fourth paper.pdf')).folderId).toBeUndefined();
  await expect(library().getByRole('heading', { name: 'Unfiled', exact: true })).toBeVisible();
  await expectOriginals(); expect(errors).toEqual([]);
});

test('rejects pathless and unrelated drops and ignores file drops on a reader or while a dialog is open', async () => {
  await visit();
  const before = await readFile(catalogPath(), 'utf8');
  const urlBefore = page.url();
  await folder(research.name).evaluate(element => {
    for (const [type, value] of [['text/uri-list', 'file:///C:/private/paper.pdf'], ['text/plain', 'https://example.org/paper.pdf'], ['application/x-prism-pdf-document', 'spoofed']]) {
      const dataTransfer = new DataTransfer(); dataTransfer.setData(type, value);
      element.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer }));
    }
    const dataTransfer = new DataTransfer();
    dataTransfer.items.add(new File(['%PDF-1.4\n'], 'Synthetic.pdf', { type: 'application/pdf' }));
    element.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer }));
  });
  await expect(pdf().getByRole('alert')).toContainText('file manager');
  await expect(importButton()).toBeEnabled();
  expect(await readFile(catalogPath(), 'utf8')).toBe(before);
  expect(page.url()).toBe(urlBefore);
  await pdf().getByRole('button', { name: 'New folder', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'New folder', exact: true });
  await expect(dialog).toBeVisible();
  await dropFiles(dialog.getByRole('textbox', { name: 'Folder name', exact: true }), ['Second paper.pdf'], false);
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  expect(await readFile(catalogPath(), 'utf8')).toBe(before);
  await folder(archive.name).click();
  await pdf().getByRole('button', { name: 'Open Saved research', exact: true }).click();
  await expect(pdf().locator('.pdf-paper canvas[data-page-number="2"]')).toBeVisible();
  const retained = await pdf().locator('.pdf-paper canvas').elementHandle();
  await dropFiles(pdf().getByLabel('PDF page viewport', { exact: true }), ['Second paper.pdf'], false);
  await expect(pdf().locator('.pdf-paper canvas[data-page-number="2"]')).toBeVisible();
  expect(await pdf().locator('.pdf-paper canvas').evaluate((node, previous) => node === previous, retained)).toBe(true);
  expect(await documents()).toHaveLength(1);
  await expectOriginals(); expect(errors).toEqual([]);
});

test('opens compact navigation during a file drag, clears cancellation, and ignores a second import while busy', async ({}, testInfo) => {
  await page.getByRole('button', { name: 'Window appearance', exact: true }).click();
  const appearance = page.getByRole('dialog', { name: 'Make a little space', exact: true });
  await appearance.getByRole('slider', { name: 'Text size', exact: true }).fill('150');
  await appearance.getByRole('button', { name: 'Done', exact: true }).click();
  await visit(); await page.setViewportSize({ width: 420, height: 900 });
  const navigation = pdf().getByRole('button', { name: 'Library navigation', exact: true });
  await expect(navigation).toHaveAttribute('aria-expanded', 'false');
  const drag = await dragFiles(['価格の研究 100%.PDF']);
  try {
    await drag.enter(navigation); await drag.over(navigation);
    await expect(navigation).toHaveAttribute('aria-expanded', 'true');
    await drag.over(folder(research.name));
    // The first CDP move into a different DOM target dispatches dragenter;
    // continued hover delivers dragover, as a real ongoing drag does.
    await drag.over(folder(research.name));
    await testInfo.attach('Compact native file drop target', { body: await page.screenshot({ path: testInfo.outputPath('compact-file-drop.png') }), contentType: 'image/png' });
    await expect(folder(research.name)).toHaveClass(/pdf-drop-target/);
    await page.keyboard.press('Escape'); await drag.cancel();
    await expect(pdf().locator('.pdf-drop-target')).toHaveCount(0);
  } finally { await drag.session.detach(); }
  expect(await documents()).toHaveLength(1);
  await page.setViewportSize({ width: 1440, height: 1000 }); await folder(research.name).click();
  await desktop!.evaluate(({ dialog }) => {
    dialog.showOpenDialog = () => new Promise(resolve => {
      (globalThis as unknown as { finishDropPicker: (files: string[]) => void }).finishDropPicker = filePaths => resolve({ canceled: false, filePaths });
    });
  });
  await importButton().click();
  await expect(pdf().getByRole('button', { name: 'Importing…', exact: true })).toBeDisabled();
  await dropFiles(folder(archive.name), ['Second paper.pdf'], false);
  expect(await documents()).toHaveLength(1);
  await folder(archive.name).click();
  await desktop!.evaluate((_, filename) => {
    (globalThis as unknown as { finishDropPicker: (files: string[]) => void }).finishDropPicker([filename]);
  }, sourcePath('価格の研究 100%.PDF'));
  await expect(importButton()).toBeEnabled();
  await expect.poll(async () => (await byFilename('価格の研究 100%.PDF'))?.folderId).toBe(research.id);
  await expect(library().getByRole('heading', { name: archive.name, exact: true })).toBeVisible();
  expect(await documents()).toHaveLength(2);
  await expectOriginals(); expect(errors).toEqual([]);
});

test('accepts file drops beside a focused note without taking its selection, undo or save shortcuts', async () => {
  await page.getByRole('group', { name: 'Editor mode', exact: true }).getByRole('button', { name: 'Source', exact: true }).click();
  await editor().focus(); await editor().press('ControlOrMeta+End'); await page.keyboard.insertText(draft);
  await editor().press('Shift+Home');
  await expect.poll(() => page.evaluate(() => window.getSelection()?.toString())).toBe(draft);
  const originalEditor = await editor().elementHandle();
  await page.getByRole('button', { name: 'Read & write', exact: true }).click();
  await expect(page.locator('.app-shell')).toHaveAttribute('data-layout', 'split');
  await expect(page.locator('.pdf-panel')).toBeVisible();
  await expect(importButton()).toBeEnabled();
  await expect(editor()).toBeFocused();
  await expect(page.locator('.app-body')).toHaveAttribute('data-active', 'true');
  await expect(page.locator('.pdf-panel')).toHaveAttribute('data-active', 'false');

  // No click or focus is sent to the PDF pane before either native file drop.
  await dropFiles(library(), ['価格の研究 100%.PDF']);
  await expect.poll(async () => (await documents()).length).toBe(2);
  expect((await byFilename('価格の研究 100%.PDF')).folderId).toBeUndefined();
  await expect(importButton()).toBeEnabled();
  await expect(editor()).toBeFocused();
  await expect.poll(() => page.evaluate(() => window.getSelection()?.toString())).toBe(draft);

  const navigation = pdf().getByRole('button', { name: 'Library navigation', exact: true });
  const drag = await dragFiles(['Second paper.pdf']);
  try {
    await drag.enter(navigation); await drag.over(navigation);
    await expect(navigation).toHaveAttribute('aria-expanded', 'true');
    await expect(editor()).toBeFocused();
    await drag.over(folder(research.name)); await drag.over(folder(research.name));
    await expect(folder(research.name)).toHaveClass(/pdf-drop-target/);
    await drag.drop(folder(research.name));
  } finally { await drag.session.detach(); }
  await expect.poll(async () => (await byFilename('Second paper.pdf'))?.folderId).toBe(research.id);
  await expect(importButton()).toBeEnabled();
  await expect(navigation).toHaveAttribute('aria-expanded', 'false');
  await expect(editor()).toBeFocused();
  await expect(page.locator('.app-body')).toHaveAttribute('data-active', 'true');
  await expect(page.locator('.pdf-panel')).toHaveAttribute('data-active', 'false');
  expect(await editor().evaluate((node, previous) => node === previous, originalEditor)).toBe(true);
  await expect.poll(() => page.evaluate(() => window.getSelection()?.toString())).toBe(draft);
  expect(await readFile(path.join(notebook, 'Drop notes.md'), 'utf8')).toBe(original);

  // Global keyboard input deliberately does not refocus the editor: drop
  // handling must leave the note as shortcut owner throughout the operation.
  await page.keyboard.press('ControlOrMeta+s');
  await expect.poll(readPublishedNote).toBe(original + draft);
  await expect(page.locator('.statusbar')).toContainText('All changes saved');
  await expect(editor()).toBeFocused();
  await page.keyboard.press('ControlOrMeta+z'); await expect(editor()).not.toContainText(draft);
  await page.keyboard.press(process.platform === 'win32' ? 'Control+y' : 'ControlOrMeta+Shift+z');
  await expect(editor()).toContainText(draft);
  await expectOriginals(); expect(errors).toEqual([]);
});
