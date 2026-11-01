import { electronLaunchArguments } from '../../scripts/electron-launch.mjs';
import { _electron as electron, expect, test, type ElectronApplication, type Locator, type Page } from '@playwright/test';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import os from 'node:os';
import path from 'node:path';
import type { PDFDocument } from '../../pdf-manager/src/shared/types';
import { fixturePdf } from '../fixtures/pdf';

const firstId = '1746f19d-10f0-485e-8017-73b73a5c37d5';
const secondId = '11814f12-5df3-418e-9808-3d6656fe3822';
const thirdId = 'f743c4fa-834e-4cac-882c-5b427b741d05';
const neighborId = '297a4c1f-7061-4e70-a3bc-75cf6dedfa47';
const missingId = '88888888-8888-4888-8888-888888888888';
const welcomePath = 'Welcome to Prism.md';
const reference = (id: string, number: number, label = '資料') => `[${label}](prism-pdf://v1/documents/${id}?page=${number})`;
const initial = '# Compact reading\n\n[[Companion]]\n\n' + reference(firstId, 2) + '\n\n';
const companion = '# Companion\n\n[[Welcome to Prism]]\n\n' + reference(firstId, 1) + '\n';
const diskText = (value: string) => '\ufeff' + value.replace(/\n/g, '\r\n');
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
const inspector = () => page.getByRole('complementary', { name: 'In this note', exact: true });
const connections = () => inspector().locator('.connections-section');
const compact = () => connections().locator('.graph-compact');
const compactPDF = (id: string) => compact().locator(`[data-pdf-id="${id}"]`);
const compactNote = (title: string) => compact().getByRole('button', { name: `Open ${title}`, exact: true });
const fullGraph = () => page.locator('.graph-page');
const fullPDF = (id: string) => fullGraph().locator(`[data-pdf-id="${id}"]`);
const pdf = () => page.locator('.pdf-workspace');
const editor = () => page.locator('.app-body .cm-content');
const linkedNotes = () => pdf().getByRole('region', { name: 'Linked notes for this PDF', exact: true });
const workspace = (name: 'Notes' | 'PDFs') => page.getByRole('navigation', { name: 'Workspaces', exact: true }).getByRole('button', { name, exact: true });
const noteFile = (name = welcomePath, directory = notebook) => path.join(directory, name);
const catalogFile = () => path.join(pdfProfile, 'library', 'catalog.json');

function entry(id: string, title: string, bytes: Buffer): PDFDocument {
  return {
    id, title, filename: `${id}.pdf`, size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'),
    importedAt: '2025-08-09T10:11:12.000Z', updatedAt: '2025-09-10T11:12:13.000Z',
    tags: ['Reading'], favorite: false, lastOpenedAt: null, lastPage: 1, pageCount: 2,
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
  await expect(page.locator('.note-heading h1')).toHaveText('Compact reading');
  await expect.poll(() => desktop!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible())).toBe(true);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.getByRole('group', { name: 'Editor mode', exact: true }).getByRole('button', { name: 'Source', exact: true }).click();
  await expect(compact()).toBeVisible();
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

async function append(value: string) {
  await editor().focus();
  await editor().press('ControlOrMeta+End');
  await page.keyboard.insertText(value);
}

async function assertNoReaderLoaded() {
  await expect(pdf()).toHaveCount(0);
  expect(page.workers()).toHaveLength(0);
  const resources = await page.evaluate(() => performance.getEntriesByType('resource').map(entry => entry.name));
  expect(resources.filter(url => /PDFWorkspace-|pdf\.worker\.mjs|\/cmaps\/|\/standard_fonts\/|\/wasm\//.test(url))).toEqual([]);
}

async function renderedPage(number: number) {
  const canvas = pdf().locator(`.pdf-paper canvas[data-page-number="${number}"]`);
  await expect(canvas).toBeVisible();
  await expect(pdf().getByLabel('Page number', { exact: true })).toHaveValue(String(number));
  await expect(pdf().locator('.pdf-paper')).toHaveAttribute('aria-busy', 'false');
  await expect.poll(() => canvas.evaluate((element: HTMLCanvasElement) => {
    if (!element.isConnected || !element.width || !element.height) return 0;
    const pixels = element.getContext('2d')!.getImageData(0, 0, element.width, element.height).data;
    let colored = 0;
    for (let offset = 0; offset < pixels.length; offset += 16) {
      if (Math.max(pixels[offset], pixels[offset + 1], pixels[offset + 2]) - Math.min(pixels[offset], pixels[offset + 1], pixels[offset + 2]) > 40) colored++;
    }
    return colored;
  })).toBeGreaterThan(100);
}

async function openLinkedNote(name: string) {
  const toggle = pdf().getByRole('button', { name: 'Linked notes', exact: true });
  if (await toggle.getAttribute('aria-expanded') !== 'true') await toggle.click();
  await linkedNotes().getByRole('button', { name: `Open note ${name}`, exact: true }).click();
  await expect(workspace('Notes')).toHaveAttribute('aria-pressed', 'true');
  await expect(editor()).toBeFocused();
}

async function expectInside(control: Locator, panel: Locator) {
  await control.scrollIntoViewIfNeeded();
  await expect(control).toBeVisible();
  const box = (await control.boundingBox())!;
  const bounds = (await panel.boundingBox())!;
  expect(box.x).toBeGreaterThanOrEqual(bounds.x - 1);
  expect(box.x + box.width).toBeLessThanOrEqual(bounds.x + bounds.width + 1);
  expect(box.y).toBeGreaterThanOrEqual(bounds.y - 1);
  expect(box.y + box.height).toBeLessThanOrEqual(bounds.y + bounds.height + 1);
}

test.beforeEach(async () => {
  temporary = await mkdtemp(path.join(os.tmpdir(), 'prism-pdf-compact-'));
  notebook = path.join(temporary, 'First notebook');
  secondNotebook = path.join(temporary, 'Second notebook');
  userData = path.join(temporary, 'notes-profile');
  pdfProfile = path.join(temporary, 'pdf-profile');
  rendererErrors = []; remoteRequests = [];
  await Promise.all([mkdir(notebook), mkdir(secondNotebook), mkdir(userData), mkdir(path.join(pdfProfile, 'library', 'documents'), { recursive: true })]);
  await Promise.all([writeFile(noteFile(), diskText(initial)), writeFile(noteFile('Companion.md'), diskText(companion))]);
  const files = [[firstId, 'Field notes'], [secondId, 'Other reading'], [thirdId, 'Third reading'], [neighborId, 'Neighbor only']]
    // Distinct trailing PDF comments preserve valid xref offsets and avoid
    // constructing a catalogue with duplicate document hashes.
    .map(([id, title]) => ({ id, title, bytes: Buffer.concat([fixturePdf(), Buffer.from(`\n% ${id}\n`)]) }));
  await writeFile(catalogFile(), JSON.stringify({ version: 1, documents: files.map(({ id, title, bytes }) => entry(id, title, bytes)) }) + '\n');
  await Promise.all(files.map(({ id, bytes }) => writeFile(path.join(pdfProfile, 'library', 'documents', `${id}.pdf`), bytes)));
});

test.afterEach(async ({}, testInfo) => {
  if (page && !page.isClosed() && testInfo.status !== testInfo.expectedStatus) {
    const screenshot = await page.screenshot({ path: testInfo.outputPath('pdf-compact-failure.png') }).catch(() => undefined);
    if (screenshot) await testInfo.attach('Compact PDF graph at failure', { body: screenshot, contentType: 'image/png' });
  }
  await stop();
  if (temporary) await rm(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

test('retains drafts through compact PDF, linked note and full graph navigation, with same-note PDF undo and exact saves after restart', async () => {
  const originalCatalog = await readFile(catalogFile(), 'utf8');
  await launch();
  await expect(compactPDF(firstId)).toHaveAccessibleName(`Open PDF ${firstId}`);
  await assertNoReaderLoaded();
  const draft = reference(secondId, 2, '保存前の日本語のつながり');
  await append(draft);
  await expect(compactPDF(secondId)).toBeVisible();
  await editor().press('ControlOrMeta+z');
  await expect(compactPDF(secondId)).toHaveCount(0);
  await editor().press(redoKey);
  await expect(compactPDF(secondId)).toBeVisible();
  expect(await readFile(noteFile(), 'utf8')).toBe(diskText(initial));
  await connections().getByRole('button', { name: 'Load PDF titles', exact: true }).click();
  await expect(compactPDF(firstId)).toHaveAccessibleName('Open PDF Field notes');
  await expect(compactPDF(secondId)).toHaveAccessibleName('Open PDF Other reading');
  await assertNoReaderLoaded();
  expect(await readFile(catalogFile(), 'utf8')).toBe(originalCatalog);
  await compactPDF(firstId).focus();
  await compactPDF(firstId).press('Enter');
  await renderedPage(2); // Companion cites page 1, but this note cites only page 2.
  await openLinkedNote(welcomePath);
  // A PDF round trip retains this editor and its undo history. Navigating to
  // another note or Graph retains drafts but currently recreates the editor.
  await expect(editor()).toContainText(draft);
  await editor().press('ControlOrMeta+z');
  await expect(compactPDF(secondId)).toHaveCount(0);
  await editor().press(redoKey);
  await expect(compactPDF(secondId)).toBeVisible();
  await compactPDF(firstId).focus();
  await compactPDF(firstId).press('Enter');
  await renderedPage(2);
  await openLinkedNote('Companion.md');
  await expect(page.locator('.note-heading h1')).toHaveText('Companion');
  await expect(compactPDF(secondId)).toHaveCount(0);
  await compactPDF(firstId).focus();
  await compactPDF(firstId).press('Space');
  await renderedPage(1);
  await openLinkedNote(welcomePath);
  await expect(editor()).toContainText(draft);
  await expect(compactPDF(secondId)).toBeVisible();
  await connections().getByRole('button', { name: 'Expand graph', exact: true }).click();
  await expect(fullGraph()).toBeVisible();
  await fullPDF(firstId).focus();
  await fullPDF(firstId).press('Enter');
  await renderedPage(1); // The full graph uses the lowest page in the notebook.
  await openLinkedNote(welcomePath);
  await expect(editor()).toContainText(draft);
  await editor().press('ControlOrMeta+s');
  const expected = diskText(initial + draft);
  await expect.poll(() => readFile(noteFile(), 'utf8')).toBe(expected);
  await stop();
  await launch();
  await expect(compactPDF(secondId)).toBeVisible();
  await compactPDF(firstId).focus();
  await compactPDF(firstId).press('Enter');
  await renderedPage(2);
  expect(await readFile(noteFile(), 'utf8')).toBe(expected);
  expect(await readFile(noteFile('Companion.md'), 'utf8')).toBe(diskText(companion));
  expect(rendererErrors).toEqual([]);
  expect(remoteRequests).toEqual([]);
});

test('bounds mixed neighbors, expands hidden connections with PDFs enabled, and keeps controls readable at large text and resized inspector widths', async ({}, testInfo) => {
  const crowded = initial + '[[A]] [[B]] [[C]]\n\n' + reference(secondId, 1) + '\n\n' + reference(thirdId, 2);
  await Promise.all([
    writeFile(noteFile(), diskText(crowded)),
    ...['A', 'B', 'C'].map(title => writeFile(noteFile(`${title}.md`), diskText(`# ${title}\n`))),
    writeFile(noteFile('Companion.md'), diskText(companion + '\n' + reference(neighborId, 1))),
  ]);
  await launch();
  await expect(compact().locator('[data-graph-node]')).toHaveCount(5);
  await expect(compact().locator('[data-node-kind="note"]')).toHaveCount(3);
  await expect(compact().locator('[data-node-kind="pdf"]')).toHaveCount(2);
  await expect(compactPDF(neighborId)).toHaveCount(0);
  const overflow = () => compact().getByRole('button', { name: '+3 more connections', exact: true });
  await overflow().focus();
  await overflow().press('Enter');
  const showPDFs = () => fullGraph().getByRole('checkbox', { name: 'Show PDFs', exact: true });
  await expect(showPDFs()).toBeChecked();
  await expect(showPDFs()).toBeFocused();
  await expect(fullGraph().locator('[data-node-kind="pdf"]')).toHaveCount(4);
  await showPDFs().uncheck();
  await fullGraph().getByRole('button', { name: 'Back to note', exact: true }).click();
  await expect(compact().locator('[data-node-kind="pdf"]')).toHaveCount(2);
  await overflow().focus();
  await overflow().press('Enter');
  await expect(showPDFs()).toBeChecked();
  await expect(showPDFs()).toBeFocused();
  await fullGraph().getByRole('button', { name: 'Back to note', exact: true }).click();
  await assertNoReaderLoaded();
  for (const theme of ['Prism', 'Paper', 'Sci-fi'] as const) {
    await page.getByRole('button', { name: 'Window appearance', exact: true }).click();
    const appearance = page.getByRole('dialog', { name: 'Make a little space', exact: true });
    await appearance.getByRole('radio', { name: `${theme} theme`, exact: true }).check();
    await appearance.getByRole('slider', { name: 'Text size', exact: true }).fill('150');
    if (theme === 'Sci-fi') {
      await appearance.getByRole('switch', { name: 'Transparent window', exact: true }).click();
      await appearance.getByRole('slider', { name: 'Background opacity', exact: true }).fill('35');
    }
    await appearance.getByRole('button', { name: 'Done', exact: true }).click();
    await expectInside(overflow(), inspector());
    await expectInside(connections().getByRole('button', { name: 'Refresh PDF titles', exact: true }), inspector());
    for (const container of [inspector(), connections(), compact()]) {
      expect(await container.evaluate(element => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1);
    }
    // Every rendered label must remain inside the compact canvas, even if its
    // complete accessible name requires a visually shortened label.
    await expect(compact().locator('.graph-compact-label-box')).toHaveCount(5);
    for (const label of await compact().locator('.graph-compact-label-box').all()) await expectInside(label, compact().locator('.graph-canvas'));
  }
  await testInfo.attach('Compact PDF graph at 150 percent text', {
    body: await page.screenshot({ path: testInfo.outputPath('pdf-compact-large-text.png') }), contentType: 'image/png',
  });
  const divider = page.getByRole('separator', { name: 'Resize note inspector', exact: true });
  await divider.focus();
  for (let count = 0; count < 5; count++) await divider.press('Shift+ArrowLeft');
  await expect(divider).toHaveAttribute('aria-valuenow', '426');
  await expectInside(overflow(), inspector());
  await testInfo.attach('Expanded compact PDF graph', {
    body: await page.screenshot({ path: testInfo.outputPath('pdf-compact-expanded.png') }), contentType: 'image/png',
  });
  await divider.press('Home');
  await expect(divider).toHaveAttribute('aria-valuenow', '226');
  for (let count = 0; count < 3; count++) await divider.press('Shift+ArrowRight');
  await expect(divider).toHaveAttribute('aria-valuenow', '198');
  await expectInside(overflow(), inspector());
  await expect(compact().locator('.graph-compact-label-box')).toHaveCount(5);
  for (const label of await compact().locator('.graph-compact-label-box').all()) await expectInside(label, compact().locator('.graph-canvas'));
  await testInfo.attach('Compact PDF graph at minimum inspector width', {
    body: await page.screenshot({ path: testInfo.outputPath('pdf-compact-minimum.png') }), contentType: 'image/png',
  });
  // The visible foreignObject label belongs to the node's click target too.
  // Click its actual screen position rather than dispatching a synthetic event.
  const label = compactPDF(firstId).locator('.graph-compact-label');
  await label.scrollIntoViewIfNeeded();
  const labelBox = (await label.boundingBox())!;
  const click = { x: labelBox.x + labelBox.width / 2, y: labelBox.y + labelBox.height / 2 };
  expect(await page.evaluate(point => document.elementFromPoint(point.x, point.y)?.closest('[data-pdf-id]')?.getAttribute('data-pdf-id'), click)).toBe(firstId);
  await page.mouse.click(click.x, click.y);
  await renderedPage(2);
  expect(await readFile(noteFile(), 'utf8')).toBe(diskText(crowded));
  expect(rendererErrors).toEqual([]);
  expect(remoteRequests).toEqual([]);
});

test('acquires titles only on request, recovers ownership and missing IDs, and replaces compact references when switching notebooks', async () => {
  const withMissing = initial + reference(missingId, 1) + '\n';
  await writeFile(noteFile(), diskText(withMissing));
  const nextNotebook = '# Compact reading\n\n' + reference(secondId, 2) + '\n';
  await Promise.all([
    writeFile(noteFile(welcomePath, secondNotebook), diskText(nextNotebook)),
    writeFile(noteFile('Companion.md', secondNotebook), diskText('# Companion\n\n別のノート。\n')),
  ]);
  let owner: DatabaseSync | undefined = new DatabaseSync(path.join(pdfProfile, 'library', '.prism-library-lock.sqlite'));
  owner.exec('BEGIN EXCLUSIVE');
  try {
    await launch();
    await expect(connections()).not.toContainText('already open in another Prism window');
    await expect(compactPDF(missingId)).toHaveAccessibleName(`Open PDF ${missingId}`);
    await connections().getByRole('button', { name: 'Load PDF titles', exact: true }).click();
    await expect(connections()).toContainText('already open in another Prism window');
    await expect(compactPDF(missingId)).toHaveAccessibleName(`Open PDF ${missingId}`);
    await compactNote('Companion').click();
    await expect(page.locator('.note-heading h1')).toHaveText('Companion');
    await compactNote('Compact reading').click();
    await assertNoReaderLoaded();
    owner.close(); owner = undefined;
    await connections().getByRole('button', { name: 'Refresh PDF titles', exact: true }).click();
    await expect(compactPDF(firstId)).toHaveAccessibleName('Open PDF Field notes');
    await expect(compactPDF(missingId)).toHaveAccessibleName(`Open missing PDF ${missingId}`);
    await expect(connections()).not.toContainText('already open in another Prism window');
    await compactPDF(missingId).focus();
    await compactPDF(missingId).press('Enter');
    await expect(pdf().getByRole('alert', { name: 'PDF link unavailable', exact: true })).toBeVisible();
    await workspace('Notes').click();
    await append(reference(secondId, 1, '未保存のつながり'));
    await expect(compactPDF(secondId)).toBeVisible();
    await desktop!.evaluate(({ dialog }, directory) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [directory] }); }, secondNotebook);
    await page.getByRole('button', { name: 'Open notebook', exact: true }).click();
    const prompt = page.getByRole('dialog', { name: 'Keep your latest thoughts?', exact: true });
    await prompt.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(compactPDF(missingId)).toBeVisible();
    await expect(compactPDF(secondId)).toBeVisible();
    await page.getByRole('button', { name: 'Open notebook', exact: true }).click();
    await prompt.getByRole('button', { name: 'Discard changes', exact: true }).click();
    await expect(page.locator('.workspace-switch strong')).toHaveText('Second notebook');
    await expect(compact().locator('[data-node-kind="pdf"]')).toHaveCount(1);
    await expect(compactPDF(firstId)).toHaveCount(0);
    await expect(compactPDF(missingId)).toHaveCount(0);
    await expect(compactPDF(secondId)).toHaveAccessibleName('Open PDF Other reading');
    await editor().focus();
    await editor().press('ControlOrMeta+z');
    await expect(compactPDF(firstId)).toHaveCount(0);
    await compactPDF(secondId).focus();
    await compactPDF(secondId).press('Enter');
    await renderedPage(2);
    const toggle = pdf().getByRole('button', { name: 'Linked notes', exact: true });
    if (await toggle.getAttribute('aria-expanded') !== 'true') await toggle.click();
    await expect(linkedNotes().locator('.pdf-backlink')).toHaveCount(1);
    expect(await readFile(noteFile(), 'utf8')).toBe(diskText(withMissing));
    expect(await readFile(noteFile(welcomePath, secondNotebook), 'utf8')).toBe(diskText(nextNotebook));
    expect(rendererErrors).toEqual([]);
    expect(remoteRequests).toEqual([]);
  } finally { owner?.close(); }
});
