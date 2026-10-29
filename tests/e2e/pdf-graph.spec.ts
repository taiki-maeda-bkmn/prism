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
const unusedId = 'f743c4fa-834e-4cac-882c-5b427b741d05';
const welcomePath = 'Welcome to Prism.md';
const reference = (id: string, page: number, label = '資料') => `[${label}](prism-pdf://v1/documents/${id}?page=${page})`;
const originalNotes: Record<string, string> = {
  [welcomePath]: '# Graph notes\n\n[[Companion]]\n\n' + reference(firstId, 2) + '\n\n' + reference(firstId, 2, '同じページ') + '\n\n' + reference(secondId, 2) + '\n\n',
  'Companion.md': '# Companion\n\n' + reference(firstId, 1) + '\n',
  'Examples.md': '# Examples\n\n```md\n' + reference(unusedId, 1) + '\n```\n',
};
const diskText = (value: string) => '\ufeff' + value.replace(/\n/g, '\r\n');
const redoKey = process.platform === 'darwin' ? 'Meta+Shift+Z' : 'Control+y';
interface Point { x: number; y: number }
let temporary: string;
let notebook: string;
let secondNotebook: string;
let userData: string;
let pdfProfile: string;
let desktop: ElectronApplication | undefined;
let page: Page;
let rendererErrors: string[];
let remoteRequests: string[];
const pdf = () => page.locator('.pdf-workspace');
const graphPage = () => page.locator('.graph-page');
const graph = () => graphPage().locator('.graph-canvas');
const pdfNode = (id: string) => graph().locator(`.graph-node[data-pdf-id="${id}"]`);
const noteNode = (name: string) => graph().getByRole('button', { name: `Open ${name}`, exact: true });
const showPDFs = () => graphPage().getByRole('checkbox', { name: 'Show PDFs', exact: true });
const editor = () => page.locator('.app-body .cm-content');
const workspace = (name: 'Notes' | 'PDFs') => page.getByRole('navigation', { name: 'Workspaces', exact: true }).getByRole('button', { name, exact: true });
const catalogFile = () => path.join(pdfProfile, 'library', 'catalog.json');
const noteFile = (name = welcomePath, directory = notebook) => path.join(directory, name);
const distance = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);

function entry(id: string, title: string, filename: string, bytes: Buffer): PDFDocument {
  return {
    id, title, filename, size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'),
    importedAt: '2025-08-09T10:11:12.000Z', updatedAt: '2025-09-10T11:12:13.000Z',
    tags: ['Research'], favorite: false, lastOpenedAt: null, lastPage: 2, pageCount: 2,
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
  await expect(page.locator('.note-heading h1')).toHaveText('Graph notes');
  await expect.poll(() => desktop!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible())).toBe(true);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.getByRole('group', { name: 'Editor mode', exact: true }).getByRole('button', { name: 'Source', exact: true }).click();
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

async function openGraph() {
  await workspace('Notes').click();
  if (!await graph().isVisible()) await page.getByRole('button', { name: 'Graph view', exact: true }).click();
  await expect(graph()).toBeVisible();
}

async function loadedGraph() {
  await openGraph();
  await expect(pdfNode(firstId)).toHaveAccessibleName('Open PDF Shared title');
  await expect(pdfNode(secondId)).toHaveAccessibleName('Open PDF Shared title');
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
    const pixels = element.getContext('2d')!.getImageData(0, 0, element.width, element.height).data;
    let colored = 0;
    for (let offset = 0; offset < pixels.length; offset += 16) {
      if (Math.max(pixels[offset], pixels[offset + 1], pixels[offset + 2]) - Math.min(pixels[offset], pixels[offset + 1], pixels[offset + 2]) > 40) colored++;
    }
    return colored;
  })).toBeGreaterThan(100);
}

async function point(target: Locator, space: 'screen' | 'graph' = 'graph'): Promise<Point> {
  return target.evaluate((element, coordinateSpace) => {
    const graphics = element as SVGGraphicsElement;
    const matrix = coordinateSpace === 'screen' ? graphics.getScreenCTM() : graphics.transform.baseVal.consolidate()?.matrix;
    if (!matrix) throw new Error('The graph node has no rendered transform.');
    const position = new DOMPoint(0, 0).matrixTransform(matrix);
    return { x: position.x, y: position.y };
  }, space);
}

async function expectPoint(target: Locator, expected: Point, space: 'screen' | 'graph' = 'graph') {
  await expect.poll(async () => distance(await point(target, space), expected)).toBeLessThan(1.5);
}

async function expectInsidePane(control: Locator, panel: Locator) {
  await expect(control).toBeVisible();
  const box = await control.boundingBox();
  const bounds = await panel.boundingBox();
  if (!box || !bounds) throw new Error('A pane or its control is not visible.');
  expect(box.x).toBeGreaterThanOrEqual(bounds.x);
  expect(box.x + box.width).toBeLessThanOrEqual(bounds.x + bounds.width + 1);
  expect(box.y).toBeGreaterThanOrEqual(bounds.y);
  expect(box.y + box.height).toBeLessThanOrEqual(bounds.y + bounds.height + 1);
}

async function expectPDFEdgesAttached(id: string) {
  const expected = await point(pdfNode(id));
  const key = `pdf:${id}`;
  const endpoints = await graph().locator('.graph-edge-pdf').evaluateAll((elements, nodeId) => elements.flatMap(element => {
    const line = element as SVGLineElement;
    if (line.dataset.source === nodeId) return [{ x: line.x1.baseVal.value, y: line.y1.baseVal.value }];
    if (line.dataset.target === nodeId) return [{ x: line.x2.baseVal.value, y: line.y2.baseVal.value }];
    return [];
  }), key);
  expect(endpoints.length).toBeGreaterThan(0);
  for (const endpoint of endpoints) expect(distance(endpoint, expected)).toBeLessThan(1.5);
}

async function expectOriginalNotes() {
  for (const [name, content] of Object.entries(originalNotes)) expect(await readFile(noteFile(name), 'utf8')).toBe(diskText(content));
}

test.beforeEach(async () => {
  temporary = await mkdtemp(path.join(os.tmpdir(), 'prism-pdf-graph-'));
  notebook = path.join(temporary, 'First notebook');
  secondNotebook = path.join(temporary, 'Second notebook');
  userData = path.join(temporary, 'notes-profile');
  pdfProfile = path.join(temporary, 'pdf-profile');
  rendererErrors = []; remoteRequests = [];
  await Promise.all([mkdir(notebook), mkdir(secondNotebook), mkdir(userData), mkdir(path.join(pdfProfile, 'library', 'documents'), { recursive: true })]);
  await Promise.all(Object.entries(originalNotes).map(([name, content]) => writeFile(noteFile(name), diskText(content))));
  const files = [
    { id: firstId, title: 'Shared title', filename: 'First source.pdf', bytes: fixturePdf() },
    { id: secondId, title: 'Shared title', filename: 'Second source.pdf', bytes: fixturePdf('second-secret') },
    { id: unusedId, title: 'Uncited PDF', filename: 'Uncited.pdf', bytes: fixturePdf('unused-secret') },
  ];
  await writeFile(catalogFile(), JSON.stringify({ version: 1, documents: files.map(file => entry(file.id, file.title, file.filename, file.bytes)) }) + '\n');
  await Promise.all(files.map(file => writeFile(path.join(pdfProfile, 'library', 'documents', `${file.id}.pdf`), file.bytes)));
});

test.afterEach(async ({}, testInfo) => {
  if (page && !page.isClosed() && testInfo.status !== testInfo.expectedStatus) {
    const screenshot = await page.screenshot({ path: testInfo.outputPath('pdf-graph-failure.png') }).catch(() => undefined);
    if (screenshot) await testInfo.attach('PDF graph at failure', { body: screenshot, contentType: 'image/png' });
  }
  await stop();
  if (temporary) await rm(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

test('loads graph metadata without the reader, follows the lowest cited page, and retains an unsaved Japanese reference', async () => {
  const originalCatalog = await readFile(catalogFile(), 'utf8');
  await launch();
  await loadedGraph();
  await expect(showPDFs()).toBeChecked();
  await expect(graph().locator('[data-node-kind="pdf"]')).toHaveCount(2);
  await expect(pdfNode(unusedId)).toHaveCount(0);
  await expect(graph().locator('.graph-edge-pdf')).toHaveCount(3);
  await expect(graph().locator('.graph-edge:not(.graph-edge-pdf)')).toHaveCount(1);
  await assertNoReaderLoaded();
  expect(await readFile(catalogFile(), 'utf8')).toBe(originalCatalog);
  await noteNode('Graph notes').click();
  await editor().focus();
  await editor().press('ControlOrMeta+End');
  const draft = reference(unusedId, 1, '新しい読書のつながり');
  await page.keyboard.insertText(draft);
  await editor().press('ControlOrMeta+z');
  await expect(editor()).not.toContainText(draft);
  await editor().press(redoKey);
  await expect(editor()).toContainText(draft);
  await openGraph();
  await expect(graph().locator('[data-node-kind="pdf"]')).toHaveCount(3);
  await expect(pdfNode(unusedId)).toHaveAccessibleName('Open PDF Uncited PDF');
  await assertNoReaderLoaded();
  expect(await readFile(noteFile(), 'utf8')).toBe(diskText(originalNotes[welcomePath]));
  await pdfNode(firstId).focus();
  await pdfNode(firstId).press('Enter');
  // The saved reading position was page 2, but the notebook cites pages 1 and 2.
  await renderedPage(1);
  await page.getByRole('button', { name: 'Read & write', exact: true }).click();
  await pdf().getByRole('button', { name: 'Linked notes', exact: true }).click();
  await pdf().getByRole('button', { name: `Open note ${welcomePath}`, exact: true }).click();
  await expect(editor()).toContainText(draft);
  await expect(editor()).toBeFocused();
  await expect(pdf()).toBeVisible();
  await editor().press('ControlOrMeta+s');
  await expect.poll(() => readFile(noteFile(), 'utf8')).toBe(diskText(originalNotes[welcomePath] + draft));
  expect(rendererErrors).toEqual([]);
  expect(remoteRequests).toEqual([]);
});

test('moves PDF nodes and their edges with keyboard and mouse, retains filters and layouts, and returns to current-note PDF connections', async ({}, testInfo) => {
  await launch();
  await loadedGraph();
  const originalPDF = await point(pdfNode(firstId));
  const originalNote = await point(noteNode('Companion'));
  await pdfNode(firstId).focus();
  await pdfNode(firstId).press('ArrowRight');
  await pdfNode(firstId).press('Shift+ArrowDown');
  const movedPDF = { x: originalPDF.x + 10, y: originalPDF.y + 40 };
  await expectPoint(pdfNode(firstId), movedPDF);
  await expectPDFEdgesAttached(firstId);
  await noteNode('Companion').focus();
  await noteNode('Companion').press('ArrowLeft');
  const movedNote = { x: originalNote.x - 10, y: originalNote.y };
  await expectPoint(noteNode('Companion'), movedNote);
  await graphPage().getByRole('button', { name: 'Zoom in', exact: true }).click();
  await graphPage().getByRole('button', { name: 'Zoom in', exact: true }).click();
  // Zoom can put the outer node below the canvas. Pan the background first,
  // using a visible empty point so the gesture cannot accidentally move a node.
  const beforePan = await point(pdfNode(secondId), 'screen');
  const background = await graph().evaluate(element => {
    const bounds = element.getBoundingClientRect();
    for (const y of [0.5, 0.65, 0.8]) for (const x of [0.5, 0.65, 0.35, 0.8]) {
      const candidate = { x: bounds.left + bounds.width * x, y: bounds.top + bounds.height * y };
      const hit = document.elementFromPoint(candidate.x, candidate.y);
      if (hit === element || (hit?.matches('.graph-grid') && element.contains(hit))) return candidate;
    }
    throw new Error('No empty graph background is visible for panning.');
  });
  await page.mouse.move(background.x, background.y);
  await page.mouse.down();
  await page.mouse.move(background.x - 100, background.y - 120, { steps: 6 });
  await page.mouse.up();
  await expectPoint(pdfNode(secondId), { x: beforePan.x - 100, y: beforePan.y - 120 }, 'screen');
  const start = await point(pdfNode(secondId), 'screen');
  expect(await page.evaluate(position => document.elementFromPoint(position.x, position.y)?.closest('[data-pdf-id]')?.getAttribute('data-pdf-id'), start)).toBe(secondId);
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(start.x + 45, start.y + 25, { steps: 6 });
  await page.mouse.up();
  await expect(graph()).toBeVisible();
  await expectPoint(pdfNode(secondId), { x: start.x + 45, y: start.y + 25 }, 'screen');
  const movedSecond = await point(pdfNode(secondId));
  await expectPDFEdgesAttached(secondId);
  await showPDFs().uncheck();
  await expect(graph().locator('[data-node-kind="pdf"]')).toHaveCount(0);
  await expect(graph().locator('.graph-edge-pdf')).toHaveCount(0);
  await expectPoint(noteNode('Companion'), movedNote);
  await showPDFs().check();
  await expectPoint(pdfNode(firstId), movedPDF);
  await expectPoint(pdfNode(secondId), movedSecond);
  await expect(graphPage().getByRole('button', { name: 'Reset graph view', exact: true })).toHaveText('140%');
  await graphPage().getByRole('button', { name: 'Reset graph view', exact: true }).click();
  await expectPoint(pdfNode(secondId), movedSecond);
  await graphPage().getByRole('button', { name: 'Reset graph layout', exact: true }).click();
  await expectPoint(pdfNode(firstId), originalPDF);
  await expectPoint(noteNode('Companion'), originalNote);
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
    await expect(showPDFs()).toBeVisible();
    await expect(graphPage().getByRole('button', { name: 'Refresh PDF titles', exact: true })).toBeVisible();
    expect(await graphPage().evaluate(element => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1);
  }
  await testInfo.attach('PDF graph with 150 percent text and transparency', {
    body: await page.screenshot({ path: testInfo.outputPath('pdf-graph-large-text.png') }), contentType: 'image/png',
  });
  await page.getByRole('button', { name: 'Read & write', exact: true }).click();
  await expect(page.locator('.workspace-area')).toHaveAttribute('data-layout', 'split');
  const notesPane = page.locator('.app-body');
  const divider = page.getByRole('separator', { name: 'Resize note and PDF panes', exact: true });
  await divider.focus();
  for (let count = 0; count < 20; count++) await divider.press('Shift+ArrowLeft');
  await expect.poll(async () => (await notesPane.boundingBox())!.width).toBeGreaterThanOrEqual(420);
  await expect.poll(async () => (await notesPane.boundingBox())!.width).toBeLessThan(430);
  await expectInsidePane(showPDFs(), notesPane);
  await expectInsidePane(graphPage().locator('.graph-filters label'), notesPane);
  for (const name of ['Refresh PDF titles', 'Zoom in', 'Zoom out', 'Reset graph view', 'Reset graph layout']) {
    await expectInsidePane(graphPage().getByRole('button', { name, exact: true }), notesPane);
  }
  for (const container of [notesPane, graphPage(), graphPage().locator('.graph-filters'), graphPage().locator('.graph-controls')]) {
    expect(await container.evaluate(element => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1);
  }
  await testInfo.attach('PDF graph in a 420 pixel Notes pane at 150 percent text', {
    body: await page.screenshot({ path: testInfo.outputPath('pdf-graph-narrow-notes.png') }), contentType: 'image/png',
  });
  await workspace('Notes').click();
  await page.getByRole('button', { name: 'Read & write', exact: true }).click();
  await expect(page.locator('.workspace-area')).toHaveAttribute('data-layout', 'single');
  await expect(pdf()).toBeHidden();
  await noteNode('Graph notes').focus();
  await noteNode('Graph notes').press('Enter');
  await expect(page.locator('.graph-compact')).toBeVisible();
  await expect(page.locator('.graph-compact [data-node-kind="pdf"]')).toHaveCount(2);
  await expectOriginalNotes();
  expect(rendererErrors).toEqual([]);
  expect(remoteRequests).toEqual([]);
});

test('updates renamed titles without moving nodes and preserves missing identity after removal and re-import', async () => {
  await launch();
  await loadedGraph();
  await pdfNode(firstId).focus();
  await pdfNode(firstId).press('ArrowRight');
  const arranged = await point(pdfNode(firstId));
  await pdfNode(firstId).press('Enter');
  await renderedPage(1);
  await pdf().getByRole('button', { name: 'Back to library', exact: true }).click();
  await pdf().getByLabel('Search library', { exact: true }).fill('First source.pdf');
  await pdf().getByRole('button', { name: 'Details for Shared title', exact: true }).click();
  await pdf().getByLabel('Document title', { exact: true }).fill('名前を変更した資料');
  await pdf().getByRole('button', { name: 'Save changes', exact: true }).click();
  await expect(pdf().getByRole('dialog')).toHaveCount(0);
  await openGraph();
  await expect(pdfNode(firstId)).toHaveAccessibleName('Open PDF 名前を変更した資料');
  await expectPoint(pdfNode(firstId), arranged);
  await expect(pdfNode(secondId)).toHaveAccessibleName('Open PDF Shared title');
  await workspace('PDFs').click();
  await pdf().getByRole('button', { name: 'Details for 名前を変更した資料', exact: true }).click();
  await pdf().getByRole('button', { name: 'Remove', exact: true }).click();
  await pdf().getByRole('button', { name: 'Remove document', exact: true }).click();
  await expect(pdf().getByRole('dialog')).toHaveCount(0);
  await openGraph();
  await expect(pdfNode(firstId)).toHaveAccessibleName(`Open missing PDF ${firstId}`);
  await expectPoint(pdfNode(firstId), arranged);
  await pdfNode(firstId).click();
  await expect(pdf().getByRole('alert', { name: 'PDF link unavailable', exact: true })).toBeVisible();
  await pdf().getByRole('button', { name: 'Browse library', exact: true }).click();
  const source = path.join(temporary, 'Replacement.pdf');
  await writeFile(source, fixturePdf());
  await desktop!.evaluate(({ dialog }, filename) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [filename] }); }, source);
  await pdf().getByRole('button', { name: 'Import PDFs', exact: true }).click();
  await expect(pdf().getByRole('button', { name: 'Open Replacement', exact: true })).toBeVisible();
  const catalog = JSON.parse(await readFile(catalogFile(), 'utf8')) as { documents: PDFDocument[] };
  const replacement = catalog.documents.find(document => document.title === 'Replacement')!;
  expect(replacement.id).not.toBe(firstId);
  await openGraph();
  await expect(pdfNode(firstId)).toHaveAccessibleName(`Open missing PDF ${firstId}`);
  await expect(pdfNode(replacement.id)).toHaveCount(0);
  await expect(pdfNode(secondId)).toHaveAccessibleName('Open PDF Shared title');
  await expectOriginalNotes();
  expect(rendererErrors).toEqual([]);
  expect(remoteRequests).toEqual([]);
});

test('recovers catalogue ownership errors without blocking notes and isolates graph citations in another notebook', async () => {
  let owner: DatabaseSync | undefined = new DatabaseSync(path.join(pdfProfile, 'library', '.prism-library-lock.sqlite'));
  owner.exec('BEGIN EXCLUSIVE');
  try {
    await launch();
    await openGraph();
    await expect(graphPage()).toContainText('already open in another Prism window');
    await expect(pdfNode(firstId)).toHaveAccessibleName(`Open PDF ${firstId}`);
    await expect(pdfNode(firstId)).not.toHaveAccessibleName(`Open missing PDF ${firstId}`);
    await noteNode('Companion').click();
    await expect(page.locator('.note-heading h1')).toHaveText('Companion');
    await openGraph();
    await assertNoReaderLoaded();
    owner.close(); owner = undefined;
    await graphPage().getByRole('button', { name: 'Refresh PDF titles', exact: true }).click();
    await expect(pdfNode(firstId)).toHaveAccessibleName('Open PDF Shared title');
    await expect(graphPage()).not.toContainText('already open in another Prism window');
    await pdfNode(secondId).focus();
    for (let count = 0; count < 6; count++) await page.keyboard.press('Shift+ArrowRight');
    const arranged = await point(pdfNode(secondId));
    const secondNotes = {
      [welcomePath]: '# Graph notes\n\n[[Companion]]\n\n' + reference(secondId, 2) + '\n',
      'Companion.md': '# Companion\n\n別のノートブックには別のつながり。\n',
      'Examples.md': originalNotes['Examples.md'],
    };
    await Promise.all(Object.entries(secondNotes).map(([name, content]) => writeFile(noteFile(name, secondNotebook), diskText(content))));
    await desktop!.evaluate(({ dialog }, directory) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [directory] }); }, secondNotebook);
    await page.getByRole('button', { name: 'Open notebook', exact: true }).click();
    await expect(page.locator('.workspace-switch strong')).toHaveText('Second notebook');
    await openGraph();
    await expect(pdfNode(firstId)).toHaveCount(0);
    await expect(pdfNode(unusedId)).toHaveCount(0);
    await expect(graph().locator('.graph-edge-pdf')).toHaveCount(1);
    await expect(pdfNode(secondId)).toHaveAccessibleName('Open PDF Shared title');
    expect(distance(await point(pdfNode(secondId)), arranged)).toBeGreaterThan(2);
    await assertNoReaderLoaded();
    await expectOriginalNotes();
    for (const [name, content] of Object.entries(secondNotes)) expect(await readFile(noteFile(name, secondNotebook), 'utf8')).toBe(diskText(content));
    expect(rendererErrors).toEqual([]);
    expect(remoteRequests).toEqual([]);
  } finally { owner?.close(); }
});
