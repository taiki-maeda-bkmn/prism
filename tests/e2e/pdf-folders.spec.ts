import { _electron as electron, expect, test, type ElectronApplication, type Locator, type Page } from '@playwright/test';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { electronLaunchArguments } from '../../scripts/electron-launch.mjs';
import { fixturePdf } from '../fixtures/pdf';
import type { PDFDocument, PDFFolder } from '../../pdf-manager/src/shared/types';

let temporary: string, notebook: string, profile: string;
let desktop: ElectronApplication | undefined, page: Page;
let first: PDFDocument, second: PDFDocument, original: string, originalCatalog: string;
let errors: string[];
const bytes = fixturePdf();
const pdf = () => page.locator('.pdf-workspace');
const workspace = (name: 'Notes' | 'PDFs') => page.getByRole('navigation', { name: 'Workspaces', exact: true }).getByRole('button', { name, exact: true });
const card = (id: string) => pdf().locator(`.document-card[data-document-id="${id}"]`);
const folder = (name: string) => pdf().getByRole('button', { name: `Folder ${name}`, exact: true });
const catalogPath = () => path.join(profile, 'library/catalog.json');
const catalog = async (): Promise<{ version: number; documents: PDFDocument[]; folders: PDFFolder[] }> => JSON.parse(await readFile(catalogPath(), 'utf8'));
const findDocument = async (id: string) => (await catalog()).documents.find(document => document.id === id)!;
const noteFile = () => path.join(notebook, 'Working note.md');

async function launch() {
  const applicationRoot = path.resolve(process.env.PRISM_TEST_APP_ROOT || process.cwd());
  desktop = await electron.launch({ executablePath: process.env.PRISM_TEST_ELECTRON,
    args: electronLaunchArguments(['--no-sandbox', applicationRoot]), cwd: applicationRoot,
    env: { ...process.env, PRISM_USER_DATA: path.join(temporary, 'notes-profile'), PRISM_WORKSPACE: notebook, PRISM_PDF_USER_DATA: profile } });
  page = await desktop.firstWindow();
  page.on('pageerror', error => errors.push(error.message));
  await expect(page.locator('.note-heading h1')).toHaveText('Working note');
  await page.setViewportSize({ width: 1440, height: 1000 });
}
async function stop(graceful = false) {
  const application = desktop;
  if (!application) return;
  const child = application.process();
  const closed = application.waitForEvent('close', { timeout: 5000 });
  await application.evaluate(({ app }, normal) => { if (normal) app.quit(); else app.exit(0); }, graceful).catch(() => undefined);
  await closed.catch(() => undefined);
  if (child.exitCode === null) child.kill();
  desktop = undefined;
}
async function visit() { await workspace('PDFs').click(); await expect(pdf().getByRole('button', { name: 'Import PDFs', exact: true })).toBeEnabled(); }
async function createFolder(name: string) {
  await pdf().getByRole('button', { name: 'New folder', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'New folder', exact: true });
  await dialog.getByRole('textbox', { name: 'Folder name', exact: true }).fill(name);
  await dialog.getByRole('button', { name: 'Create folder', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  const navigation = pdf().getByRole('button', { name: 'Library navigation', exact: true });
  if (await navigation.isVisible() && await navigation.getAttribute('aria-expanded') !== 'true') {
    await expect(navigation).toBeFocused();
    await navigation.press('Enter');
  }
  await expect(folder(name)).toBeVisible();
  return (await catalog()).folders.find(item => item.name === name)!;
}
async function editFolder(name: string) {
  await pdf().getByRole('button', { name: `Manage folder ${name}`, exact: true }).click();
  return page.getByRole('dialog', { name: 'Edit folder', exact: true });
}
async function moveWithDetails(document: PDFDocument, target: string) {
  await pdf().getByRole('button', { name: `Details for ${document.title}`, exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Edit document', exact: true });
  await dialog.getByRole('combobox', { name: 'Folder', exact: true }).selectOption({ label: target });
  await dialog.getByRole('button', { name: 'Save changes', exact: true }).click();
  await expect(dialog).toHaveCount(0);
}
async function dragDocument(source: Locator, target: Locator) {
  await source.hover(); await page.mouse.down();
  try {
    // Two moves deliver dragover after dragenter across Chromium/native hosts.
    // See https://playwright.dev/docs/input#drag-and-drop.
    await target.hover(); await target.hover();
    await expect(source).toHaveClass(/pdf-document-dragging/);
    await expect(target).toHaveClass(/pdf-drop-target/);
  } finally { await page.mouse.up(); }
}

test.beforeEach(async () => {
  temporary = await mkdtemp(path.join(os.tmpdir(), 'prism-folders-'));
  notebook = path.join(temporary, 'notebook'); profile = path.join(temporary, 'pdf-profile'); errors = [];
  await mkdir(notebook); await mkdir(path.join(profile, 'library/documents'), { recursive: true });
  const makeDocument = (title: string, content: Buffer): PDFDocument => ({
    id: randomUUID(), title, filename: `${title}.pdf`, size: content.length,
    sha256: createHash('sha256').update(content).digest('hex'), importedAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-02T00:00:00.000Z',
    tags: ['Execution', '日本語'], favorite: true, lastOpenedAt: '2026-01-02T00:00:00.000Z', lastPage: 2, pageCount: 2,
  });
  first = { ...makeDocument('Execution paper', bytes), arxivId: '2601.00001v1' };
  const otherBytes = Buffer.concat([bytes, Buffer.from('\n% Second paper\n')]);
  second = makeDocument('市場の資料', otherBytes);
  await writeFile(path.join(profile, 'library/documents', `${first.id}.pdf`), bytes);
  await writeFile(path.join(profile, 'library/documents', `${second.id}.pdf`), otherBytes);
  originalCatalog = JSON.stringify({ version: 1, documents: [first, second] }, null, 2) + '\n';
  await writeFile(catalogPath(), originalCatalog);
  original = `\ufeff# Working note\r\n\r\n[Research reference](prism-pdf://v1/documents/${first.id}?page=2)\r\n`;
  await writeFile(noteFile(), original);
  await launch();
});
test.afterEach(async () => { await stop(); await rm(temporary, { recursive: true, force: true }); });

test('moves PDFs by dragging in grid/list, persists folders, and keeps draft undo and page links', async () => {
  await page.getByRole('group', { name: 'Editor mode', exact: true }).getByRole('button', { name: 'Source', exact: true }).click();
  const editor = page.getByRole('textbox', { name: 'Markdown source', exact: true });
  await editor.focus(); await editor.press('ControlOrMeta+End'); await page.keyboard.insertText('保存前のメモ');
  const editorNode = await editor.elementHandle();
  await visit();
  expect(await readFile(catalogPath(), 'utf8')).toBe(originalCatalog);
  const research = await createFolder('研究資料');
  const trading = await createFolder('Trading');
  await pdf().getByRole('button', { name: 'All documents', exact: true }).click();
  await dragDocument(card(first.id), folder(research.name));
  await expect.poll(async () => (await findDocument(first.id)).folderId).toBe(research.id);
  await expect(pdf().locator('.pdf-reader')).toHaveCount(0);
  await folder(research.name).click(); await expect(card(first.id)).toBeVisible(); await expect(card(second.id)).toHaveCount(0);
  await pdf().getByRole('button', { name: 'List view', exact: true }).click();
  await dragDocument(card(first.id), folder(trading.name));
  await expect.poll(async () => (await findDocument(first.id)).folderId).toBe(trading.id);
  await expect(card(first.id)).toHaveCount(0);
  await folder(trading.name).click();
  const dialog = await editFolder('Trading');
  await dialog.getByRole('textbox', { name: 'Folder name' }).fill('Execution');
  await dialog.getByRole('button', { name: 'Save folder', exact: true }).click(); await expect(dialog).toHaveCount(0);
  expect((await catalog()).folders.find(item => item.id === trading.id)?.name).toBe('Execution');
  const moved = await findDocument(first.id);
  expect(moved).toMatchObject({ ...first, updatedAt: moved.updatedAt, folderId: trading.id });
  expect(await readFile(path.join(profile, 'library/documents', `${first.id}.pdf`))).toEqual(bytes);
  expect((await readdir(path.join(profile, 'library/documents'))).sort()).toEqual([`${first.id}.pdf`, `${second.id}.pdf`].sort());
  await workspace('Notes').click();
  expect(await editor.evaluate((node, previous) => node === previous, editorNode)).toBe(true);
  await expect(editor).toContainText('保存前のメモ'); await editor.press('ControlOrMeta+z'); await expect(editor).not.toContainText('保存前のメモ');
  expect(await readFile(noteFile(), 'utf8')).toBe(original);
  await stop(true); await launch(); await visit(); await folder('Execution').click();
  await expect(card(first.id)).toBeVisible();
  await workspace('Notes').click();
  await page.getByRole('group', { name: 'Editor mode', exact: true }).getByRole('button', { name: 'Read', exact: true }).click();
  await page.getByRole('link', { name: 'Research reference', exact: true }).click();
  await expect(pdf().locator('.pdf-paper canvas[data-page-number="2"]')).toBeVisible();
  expect(errors).toEqual([]);
});

test('folder details support keyboard moves, duplicate-name errors, and safe removal to Unfiled', async () => {
  await visit(); const target = await createFolder('Research');
  await pdf().getByRole('button', { name: 'All documents', exact: true }).click();
  await moveWithDetails(first, target.name);
  expect((await findDocument(first.id)).folderId).toBe(target.id);
  await pdf().getByRole('button', { name: 'New folder', exact: true }).click();
  const creation = page.getByRole('dialog', { name: 'New folder', exact: true });
  await creation.getByRole('textbox', { name: 'Folder name' }).fill('research');
  await creation.getByRole('button', { name: 'Create folder', exact: true }).click();
  await expect(creation.getByRole('alert')).toBeVisible();
  await creation.press('Escape'); await expect(creation).toHaveCount(0);
  expect((await catalog()).folders).toHaveLength(1);
  await folder(target.name).click();
  await dragDocument(card(first.id), pdf().getByRole('button', { name: 'Unfiled', exact: true }));
  await expect.poll(async () => (await findDocument(first.id)).folderId).toBeUndefined();
  await pdf().getByRole('button', { name: 'Unfiled', exact: true }).click();
  await moveWithDetails(first, target.name);
  const management = await editFolder(target.name);
  await management.getByRole('button', { name: 'Remove folder', exact: true }).click();
  const confirmation = page.getByRole('dialog', { name: 'Remove folder?', exact: true });
  await expect(confirmation).toContainText('Unfiled');
  await confirmation.getByRole('button', { name: 'Remove folder', exact: true }).click();
  await expect(confirmation).toHaveCount(0);
  expect((await catalog()).folders).toEqual([]);
  expect((await findDocument(first.id)).folderId).toBeUndefined();
  expect((await catalog()).documents).toHaveLength(2);
  expect(await readFile(path.join(profile, 'library/documents', `${first.id}.pdf`))).toEqual(bytes);
  await pdf().getByRole('button', { name: 'Unfiled', exact: true }).click();
  await expect(card(first.id)).toBeVisible(); await expect(card(second.id)).toBeVisible();
  expect(errors).toEqual([]);
});

test('failed and unrelated drops keep organization intact, then allow a move to be retried', async () => {
  await visit(); const target = await createFolder('Execution');
  await pdf().getByRole('button', { name: 'All documents', exact: true }).click();
  const before = await readFile(catalogPath(), 'utf8');
  // Escape cancels a real internal drag without moving the document or opening it.
  const source = await card(first.id).boundingBox();
  await page.mouse.move(source!.x + source!.width / 2, source!.y + source!.height / 2);
  await page.mouse.down();
  await page.mouse.move(source!.x + source!.width / 2 + 30, source!.y + source!.height / 2 + 20, { steps: 8 });
  await expect(card(first.id)).toHaveClass(/pdf-document-dragging/);
  await page.keyboard.press('Escape'); await page.mouse.up();
  await expect(card(first.id)).not.toHaveClass(/pdf-document-dragging/);
  expect(await readFile(catalogPath(), 'utf8')).toBe(before);
  await expect(pdf().locator('.pdf-reader')).toHaveCount(0);
  await folder(target.name).evaluate(element => {
    const dataTransfer = new DataTransfer();
    dataTransfer.setData('text/plain', 'https://example.org/paper.pdf');
    dataTransfer.items.add(new File(['%PDF-1.4'], 'External.pdf', { type: 'application/pdf' }));
    element.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer }));
    const spoofed = new DataTransfer();
    spoofed.setData('application/x-prism-pdf-document', 'external-token');
    element.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: spoofed }));
  });
  await expect(pdf().getByRole('alert')).toContainText('file manager');
  await expect(pdf().getByRole('button', { name: 'Import PDFs', exact: true })).toBeEnabled();
  expect(await readFile(catalogPath(), 'utf8')).toBe(before);
  await writeFile(catalogPath(), before + '\n');
  await dragDocument(card(first.id), folder(target.name));
  await expect(pdf().getByRole('alert')).toContainText('changed outside');
  await expect(card(first.id)).toBeVisible();
  expect((await findDocument(first.id)).folderId).toBeUndefined();
  await writeFile(catalogPath(), before);
  await dragDocument(card(first.id), folder(target.name));
  await expect.poll(async () => (await findDocument(first.id)).folderId).toBe(target.id);
  expect(errors).toEqual([]);
});

test('folder creation and moves fit 420px at 150 percent text in every theme', async ({}, testInfo) => {
  for (const theme of ['Prism', 'Paper', 'Sci-fi']) {
    await page.setViewportSize({ width: 1440, height: 1000 }); await workspace('Notes').click();
    await page.getByRole('button', { name: 'Window appearance', exact: true }).click();
    const appearance = page.getByRole('dialog', { name: 'Make a little space', exact: true });
    await appearance.getByRole('radio', { name: `${theme} theme`, exact: true }).check();
    await appearance.getByRole('slider', { name: 'Text size', exact: true }).fill('150');
    await appearance.getByRole('button', { name: 'Done', exact: true }).click();
    await visit(); await page.setViewportSize({ width: 420, height: 900 });
    await pdf().getByRole('button', { name: 'Library navigation', exact: true }).click();
    await createFolder(`参考文献 ${theme}`);
    const libraryButton = pdf().getByRole('button', { name: 'Library navigation', exact: true });
    if (await libraryButton.getAttribute('aria-expanded') !== 'true') await libraryButton.click();
    await pdf().getByRole('button', { name: 'All documents', exact: true }).click();
    await pdf().getByRole('button', { name: `Details for ${first.title}`, exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Edit document', exact: true });
    await dialog.getByRole('combobox', { name: 'Folder', exact: true }).selectOption({ label: `参考文献 ${theme}` });
    expect(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
    await testInfo.attach(`Folder move at 150 percent in ${theme}`, {
      body: await page.screenshot({ path: testInfo.outputPath(`folders-${theme}.png`) }), contentType: 'image/png',
    });
    await dialog.getByRole('button', { name: 'Save changes', exact: true }).click(); await expect(dialog).toHaveCount(0);
  }
  expect(errors).toEqual([]);
});
