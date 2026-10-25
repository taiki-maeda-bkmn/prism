import { electronLaunchArguments } from '../../scripts/electron-launch.mjs';
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { createHash } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { PDFDocument } from '../../pdf-manager/src/shared/types';
import { fixturePdf } from '../fixtures/pdf';

let temporary: string;
let notebook: string;
let userData: string;
let pdfProfile: string;
let desktop: ElectronApplication | undefined;
let page: Page;
let rendererErrors: string[];
let remoteRequests: string[];
const pdfWorkspace = () => page.locator('.pdf-workspace');
const catalogFile = () => path.join(pdfProfile, 'library', 'catalog.json');
const managedFile = (id: string) => path.join(pdfProfile, 'library', 'documents', `${id}.pdf`);
const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const catalog = async (): Promise<{ version: number; documents: PDFDocument[] }> => JSON.parse(await readFile(catalogFile(), 'utf8'));

function legacyDocument(id: string, filename: string, bytes: Buffer, patch: Partial<PDFDocument> = {}): PDFDocument {
  return {
    id, filename, title: filename.replace(/\.pdf$/i, ''), size: bytes.length, sha256: digest(bytes),
    importedAt: '2025-08-09T10:11:12.000Z', updatedAt: '2025-09-10T11:12:13.000Z',
    tags: [], favorite: false, lastOpenedAt: null, lastPage: 1, pageCount: null, ...patch,
  };
}

async function launch() {
  desktop = await electron.launch({
    args: electronLaunchArguments(['--no-sandbox', '.']), cwd: process.cwd(),
    env: { ...process.env, PRISM_USER_DATA: userData, PRISM_WORKSPACE: notebook, PRISM_PDF_USER_DATA: pdfProfile },
  });
  page = await desktop.firstWindow();
  page.on('pageerror', error => rendererErrors.push(error.message));
  page.on('request', request => { if (/^https?:/.test(request.url())) remoteRequests.push(request.url()); });
  await expect(page.locator('.note-heading h1')).toHaveText('Compatibility note');
  await page.getByRole('navigation', { name: 'Workspaces', exact: true }).getByRole('button', { name: 'PDFs', exact: true }).click();
  await expect(pdfWorkspace().getByRole('heading', { name: 'All documents', exact: true })).toBeVisible();
}

async function quit() {
  if (!desktop) return;
  const closed = desktop.waitForEvent('close');
  // Use the real quit lifecycle to drain accepted PDF metadata writes.
  await desktop.evaluate(({ app }) => { setTimeout(() => app.quit(), 0); });
  await closed;
  desktop = undefined;
}

async function cleanup() {
  if (!desktop) return;
  const child = desktop.process();
  const closed = desktop.waitForEvent('close', { timeout: 5_000 }).catch(() => undefined);
  await desktop.evaluate(({ app }) => app.exit(0)).catch(() => undefined);
  await closed;
  if (child.exitCode === null) child.kill();
  desktop = undefined;
}

async function importFiles(files: string[]) {
  // Only the native file picker is substituted. The bridge, filesystem,
  // metadata writes, PDF worker and canvas rendering are all real.
  await desktop!.evaluate(({ dialog }, filePaths) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths });
  }, files);
  await pdfWorkspace().getByRole('button', { name: 'Import PDFs', exact: true }).click();
  await expect(pdfWorkspace().getByRole('button', { name: 'Import PDFs', exact: true })).toBeEnabled();
}

async function renderedPage(number: number) {
  const canvas = pdfWorkspace().locator(`.pdf-paper canvas[data-page-number="${number}"]`);
  await expect(canvas).toBeVisible();
  await expect.poll(() => canvas.evaluate((element: HTMLCanvasElement) => {
    const pixels = element.getContext('2d')!.getImageData(0, 0, element.width, element.height).data;
    let colored = 0;
    for (let offset = 0; offset < pixels.length; offset += 16) {
      if (Math.max(pixels[offset], pixels[offset + 1], pixels[offset + 2]) - Math.min(pixels[offset], pixels[offset + 1], pixels[offset + 2]) > 40) colored++;
    }
    return colored;
  })).toBeGreaterThan(100);
}

test.beforeEach(async () => {
  temporary = await mkdtemp(path.join(os.tmpdir(), 'prism-pdf-compatibility-'));
  notebook = path.join(temporary, 'Notebook');
  userData = path.join(temporary, 'notes-profile');
  pdfProfile = path.join(temporary, 'pdf-profile');
  rendererErrors = [];
  remoteRequests = [];
  await mkdir(notebook);
  await mkdir(userData);
  await writeFile(path.join(notebook, 'Welcome to Prism.md'), '# Compatibility note\n\nLocal notes remain ordinary Markdown.\n');
});

test.afterEach(async ({}, testInfo) => {
  if (page && !page.isClosed() && testInfo.status !== testInfo.expectedStatus) {
    const screenshot = await page.screenshot().catch(() => undefined);
    if (screenshot) await testInfo.attach('PDF compatibility at failure', { body: screenshot, contentType: 'image/png' });
  }
  await cleanup();
  if (temporary) await rm(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

test('opens a copied legacy library without migration, then retains metadata, duplicates, positions and removal semantics', async () => {
  const plain = fixturePdf();
  const encrypted = fixturePdf('legacy-secret');
  const first = legacyDocument('6a8918f1-f450-465c-a8d8-051e01e786db', '日本語の市場資料.pdf', plain, {
    title: 'Existing market notes', tags: ['quantitative', '日本語'], favorite: true,
    lastOpenedAt: '2025-09-10T11:12:13.000Z', lastPage: 2, pageCount: 2,
  });
  const second = legacyDocument('b258918f-834f-445e-9270-c23d3de1643f', 'Protected reference.pdf', encrypted, { tags: ['Reference'] });
  const originalLibrary = path.join(temporary, 'existing-standalone-library');
  await mkdir(path.join(originalLibrary, 'documents'), { recursive: true });
  // Deliberately use formatting different from the store writer: an accidental
  // load-time rewrite is observable even when all parsed values match.
  const originalCatalog = JSON.stringify({ version: 1, documents: [first, second] }, null, 4) + '\n\n';
  await writeFile(path.join(originalLibrary, 'catalog.json'), originalCatalog);
  await writeFile(path.join(originalLibrary, 'documents', `${first.id}.pdf`), plain);
  await writeFile(path.join(originalLibrary, 'documents', `${second.id}.pdf`), encrypted);
  await cp(originalLibrary, path.join(pdfProfile, 'library'), { recursive: true });
  const source = path.join(temporary, first.filename);
  await writeFile(source, plain);

  await launch();
  await expect(pdfWorkspace().locator('.document-card')).toHaveCount(2);
  await expect(pdfWorkspace().locator('.pdf-thumbnail-ready canvas')).toBeVisible();
  await expect(pdfWorkspace().getByText('Password protected', { exact: true })).toBeVisible();
  await expect(pdfWorkspace().getByRole('button', { name: 'Unfavorite Existing market notes', exact: true })).toBeVisible();
  await pdfWorkspace().getByRole('button', { name: 'Tag 日本語', exact: true }).click();
  await expect(pdfWorkspace().locator('.document-card')).toHaveCount(1);
  await pdfWorkspace().getByRole('button', { name: 'All documents', exact: true }).click();
  expect(await catalog()).toEqual({ version: 1, documents: [first, second] });
  expect(await readFile(catalogFile(), 'utf8')).toBe(originalCatalog);
  expect(digest(await readFile(managedFile(first.id)))).toBe(first.sha256);
  expect(digest(await readFile(managedFile(second.id)))).toBe(second.sha256);

  await importFiles([source]);
  await expect(pdfWorkspace().getByRole('status')).toContainText('1 already in your library.');
  await expect(pdfWorkspace().locator('.document-card')).toHaveCount(2);
  expect(await readFile(catalogFile(), 'utf8')).toBe(originalCatalog);

  await pdfWorkspace().getByRole('button', { name: 'Unfavorite Existing market notes', exact: true }).click();
  await expect(pdfWorkspace().getByRole('button', { name: 'Favorite Existing market notes', exact: true })).toBeVisible();
  await pdfWorkspace().getByRole('button', { name: 'Details for Existing market notes', exact: true }).click();
  await pdfWorkspace().getByLabel('Document title', { exact: true }).fill('市場のメモ');
  await pdfWorkspace().getByLabel('Tags (comma-separated)', { exact: true }).fill('quantitative, Research, research');
  await pdfWorkspace().getByRole('button', { name: 'Save changes', exact: true }).click();
  await expect(pdfWorkspace().getByRole('dialog')).toHaveCount(0);
  await pdfWorkspace().getByRole('button', { name: 'Tag Research', exact: true }).click();
  await pdfWorkspace().getByRole('button', { name: 'Open 市場のメモ', exact: true }).click();
  await renderedPage(2);
  await pdfWorkspace().getByRole('button', { name: 'Previous page', exact: true }).click();
  await renderedPage(1);
  await quit();

  const changed = (await catalog()).documents.find(document => document.id === first.id)!;
  expect(changed).toMatchObject({
    id: first.id, filename: first.filename, sha256: first.sha256, size: first.size,
    importedAt: first.importedAt, title: '市場のメモ', tags: ['quantitative', 'Research'],
    favorite: false, lastPage: 1, pageCount: 2,
  });
  expect(changed.lastOpenedAt).not.toBe(first.lastOpenedAt);
  expect((await catalog()).documents.find(document => document.id === second.id)).toEqual(second);
  await launch();
  await expect(pdfWorkspace().getByRole('button', { name: 'Favorite 市場のメモ', exact: true })).toBeVisible();
  await pdfWorkspace().getByRole('button', { name: 'Tag Research', exact: true }).click();
  await pdfWorkspace().getByRole('button', { name: 'Open 市場のメモ', exact: true }).click();
  await renderedPage(1);
  await pdfWorkspace().getByRole('button', { name: 'Back to library', exact: true }).click();
  await pdfWorkspace().getByRole('button', { name: 'Details for 市場のメモ', exact: true }).click();
  await pdfWorkspace().getByRole('button', { name: 'Remove', exact: true }).click();
  await pdfWorkspace().getByRole('button', { name: 'Remove document', exact: true }).click();
  await expect(pdfWorkspace().getByRole('dialog')).toHaveCount(0);
  await pdfWorkspace().getByRole('button', { name: 'All documents', exact: true }).click();
  await expect(pdfWorkspace().locator('.document-card')).toHaveCount(1);
  expect((await catalog()).documents).toEqual([second]);
  expect(await readFile(managedFile(first.id))).toEqual(plain);
  expect(await readFile(managedFile(second.id))).toEqual(encrypted);
  expect(await readFile(source)).toEqual(plain);
  expect(await readFile(path.join(originalLibrary, 'catalog.json'), 'utf8')).toBe(originalCatalog);
  expect(await readFile(path.join(originalLibrary, 'documents', `${first.id}.pdf`))).toEqual(plain);
  expect(await readFile(path.join(originalLibrary, 'documents', `${second.id}.pdf`))).toEqual(encrypted);
  expect(rendererErrors).toEqual([]);
  expect(remoteRequests).toEqual([]);
});

test('requires a fresh password after restart and resumes the encrypted document at its saved page', async () => {
  const source = path.join(temporary, 'Protected.pdf');
  const bytes = fixturePdf('restart-secret');
  await writeFile(source, bytes);
  await launch();
  await importFiles([source]);
  await pdfWorkspace().getByRole('button', { name: 'Open Protected', exact: true }).click();
  await pdfWorkspace().getByLabel('Document password', { exact: true }).fill('incorrect');
  await pdfWorkspace().getByRole('button', { name: 'Unlock PDF', exact: true }).click();
  await expect(pdfWorkspace().getByText('That password did not work. Please try again.', { exact: true })).toBeVisible();
  await pdfWorkspace().getByLabel('Document password', { exact: true }).fill('restart-secret');
  await pdfWorkspace().getByRole('button', { name: 'Unlock PDF', exact: true }).click();
  await renderedPage(1);
  await pdfWorkspace().getByRole('button', { name: 'Next page', exact: true }).click();
  await renderedPage(2);
  expect(await page.evaluate(() => JSON.stringify(localStorage))).not.toContain('restart-secret');
  await quit();
  const saved = await catalog();
  expect(saved.documents[0]).toMatchObject({ lastPage: 2, pageCount: 2 });
  expect(await readFile(catalogFile(), 'utf8')).not.toContain('restart-secret');

  await launch();
  await pdfWorkspace().getByRole('button', { name: 'Open Protected', exact: true }).click();
  await expect(pdfWorkspace().getByLabel('Document password', { exact: true })).toBeVisible();
  await expect(pdfWorkspace().getByLabel('Document password', { exact: true })).toHaveValue('');
  await expect(pdfWorkspace().locator('.pdf-paper canvas')).toHaveCount(0);
  expect((await catalog()).documents[0]).toEqual(saved.documents[0]);
  await pdfWorkspace().getByLabel('Document password', { exact: true }).fill('restart-secret');
  await pdfWorkspace().getByRole('button', { name: 'Unlock PDF', exact: true }).click();
  await renderedPage(2);
  expect(await readFile(source)).toEqual(bytes);
  expect(await readFile(managedFile(saved.documents[0].id))).toEqual(bytes);
  expect(await page.evaluate(() => JSON.stringify(localStorage))).not.toContain('restart-secret');
  expect(rendererErrors).toEqual([]);
  expect(remoteRequests).toEqual([]);
});

test('recovers a missing managed copy with retry and keeps other documents usable after a damaged PDF', async () => {
  const missingBytes = fixturePdf();
  const damagedBytes = Buffer.from('%PDF-1.4\nThis document has no valid PDF objects.\n%%EOF\n');
  const healthyBytes = Buffer.concat([fixturePdf(), Buffer.from('% distinct healthy fixture\n')]);
  const missing = legacyDocument('1746f19d-10f0-485e-8017-73b73a5c37d5', 'Missing.pdf', missingBytes, { tags: ['Recover'], lastPage: 2, pageCount: 2 });
  const damaged = legacyDocument('11814f12-5df3-418e-9808-3d6656fe3822', 'Damaged.pdf', damagedBytes);
  const healthy = legacyDocument('e8691b04-2b49-4b15-b2d7-3c9c366dbff2', 'Healthy.pdf', healthyBytes);
  await mkdir(path.join(pdfProfile, 'library', 'documents'), { recursive: true });
  await writeFile(catalogFile(), JSON.stringify({ version: 1, documents: [missing, damaged, healthy] }) + '\n');
  await writeFile(managedFile(damaged.id), damagedBytes);
  await writeFile(managedFile(healthy.id), healthyBytes);
  const initialCatalog = await readFile(catalogFile());

  await launch();
  await expect(pdfWorkspace().locator('.warnings summary')).toHaveText('1 library warning');
  await pdfWorkspace().locator('.warnings summary').click();
  await expect(pdfWorkspace().locator('.warnings')).toContainText('Missing.pdf: its managed copy is unavailable.');
  await pdfWorkspace().getByRole('button', { name: 'Open Missing', exact: true }).click();
  await expect(pdfWorkspace().getByRole('heading', { name: 'Unable to display this PDF', exact: true })).toBeVisible();
  expect(await readFile(catalogFile())).toEqual(initialCatalog);
  // Repair only the disposable fixture's missing managed bytes, as a user
  // restoring their backup would. Retry must retain the original document ID.
  await writeFile(managedFile(missing.id), missingBytes);
  await pdfWorkspace().getByRole('button', { name: 'Try again', exact: true }).click();
  await renderedPage(2);
  await pdfWorkspace().getByRole('button', { name: 'Back to library', exact: true }).click();
  await pdfWorkspace().getByRole('button', { name: 'Open Damaged', exact: true }).click();
  await expect(pdfWorkspace().getByRole('heading', { name: 'Unable to display this PDF', exact: true })).toBeVisible();
  await expect(pdfWorkspace().getByRole('alert')).toContainText('could not be read as a PDF');
  expect((await catalog()).documents.find(document => document.id === damaged.id)).toEqual(damaged);
  await pdfWorkspace().getByRole('button', { name: 'Back to library', exact: true }).click();
  await pdfWorkspace().getByRole('button', { name: 'Open Healthy', exact: true }).click();
  await renderedPage(1);
  await quit();
  await launch();
  await expect(pdfWorkspace().locator('.warnings')).toHaveCount(0);
  await expect(pdfWorkspace().locator('.document-card')).toHaveCount(3);
  expect((await catalog()).documents.map(document => document.id)).toEqual([missing.id, damaged.id, healthy.id]);
  expect(await readFile(managedFile(missing.id))).toEqual(missingBytes);
  expect(await readFile(managedFile(damaged.id))).toEqual(damagedBytes);
  expect(await readFile(managedFile(healthy.id))).toEqual(healthyBytes);
  expect(rendererErrors).toEqual([]);
  expect(remoteRequests).toEqual([]);
});
