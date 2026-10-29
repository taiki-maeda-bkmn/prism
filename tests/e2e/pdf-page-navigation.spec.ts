import { electronLaunchArguments } from '../../scripts/electron-launch.mjs';
import { _electron as electron, expect, test, type ElectronApplication, type Locator, type Page } from '@playwright/test';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { PDFDocument } from '../../pdf-manager/src/shared/types';
import { fixturePdf } from '../fixtures/pdf';

const documentId = '1746f19d-10f0-485e-8017-73b73a5c37d5';
const protectedId = '11814f12-5df3-418e-9808-3d6656fe3822';
const initialNote = '# 読書ノート\n\nページをめくりながら、考えを書く。\n\n';
const redoKey = process.platform === 'darwin' ? 'Meta+Shift+Z' : 'Control+y';
let temporary: string;
let notebook: string;
let userData: string;
let pdfProfile: string;
let desktop: ElectronApplication | undefined;
let page: Page;
let rendererErrors: string[];
let remoteRequests: string[];
const pdf = () => page.locator('.pdf-workspace');
const viewport = () => pdf().getByLabel('PDF page viewport', { exact: true });
const navigation = () => pdf().getByRole('navigation', { name: 'Page navigation', exact: true });
const previous = () => navigation().getByRole('button', { name: 'Previous PDF page', exact: true });
const next = () => navigation().getByRole('button', { name: 'Next PDF page', exact: true });
const pageNumber = () => pdf().getByLabel('Page number', { exact: true });
const zoom = () => pdf().getByLabel('Page zoom', { exact: true });
const editor = () => page.locator('.app-body .cm-content');
const noteFile = () => path.join(notebook, 'Welcome to Prism.md');
const catalogFile = () => path.join(pdfProfile, 'library', 'catalog.json');
const workspace = (name: 'Notes' | 'PDFs') => page.getByRole('navigation', { name: 'Workspaces', exact: true }).getByRole('button', { name, exact: true });

function entry(id: string, title: string, bytes: Buffer): PDFDocument {
  return {
    id, title, filename: `${title}.pdf`, size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'),
    importedAt: '2025-08-09T10:11:12.000Z', updatedAt: '2025-09-10T11:12:13.000Z',
    tags: [], favorite: false, lastOpenedAt: null, lastPage: 1, pageCount: null,
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
  await expect(page.locator('.note-heading h1')).toHaveText('読書ノート');
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

async function openDocument(title = 'Field notes') {
  await workspace('PDFs').click();
  await pdf().getByRole('button', { name: `Open ${title}`, exact: true }).click();
}

async function renderedPage(number: number) {
  const canvas = pdf().locator(`.pdf-paper canvas[data-page-number="${number}"]`);
  await expect(canvas).toBeVisible();
  await expect(pageNumber()).toHaveValue(String(number));
  await expect(pdf().locator('.pdf-paper')).toHaveAttribute('aria-busy', 'false');
  await expect(navigation().getByRole('status')).toHaveText(`Page ${number} of 2`);
  await expect.poll(() => canvas.evaluate((element: HTMLCanvasElement) => {
    const pixels = element.getContext('2d')!.getImageData(0, 0, element.width, element.height).data;
    let colored = 0;
    for (let offset = 0; offset < pixels.length; offset += 16) {
      if (Math.max(pixels[offset], pixels[offset + 1], pixels[offset + 2]) - Math.min(pixels[offset], pixels[offset + 1], pixels[offset + 2]) > 40) colored++;
    }
    return colored;
  })).toBeGreaterThan(100);
  return canvas;
}

async function scrollPosition() {
  return viewport().evaluate(element => ({ top: element.scrollTop, bottom: element.scrollHeight - element.clientHeight - element.scrollTop }));
}

async function pointAtPage() {
  const box = await viewport().boundingBox();
  if (!box) throw new Error('The PDF page viewport is not visible.');
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
}

// The reader deliberately requires 250 ms without wheel input and a 350 ms
// cooldown after turning. This pause represents the user starting a new gesture.
async function freshWheel(deltaY: number, deltaX = 0) {
  await page.waitForTimeout(450);
  await pointAtPage();
  await page.mouse.wheel(deltaX, deltaY);
}

async function turnWithMomentum(number: number, deltaY: number) {
  const wheelEvents = await viewport().evaluateHandle(element => {
    const times: number[] = [];
    const record = () => times.push(performance.now());
    element.addEventListener('wheel', record);
    return { times, dispose: () => element.removeEventListener('wheel', record) };
  });
  try {
    await freshWheel(deltaY);
    let renderedPulses = 0;
    // Keep sending real wheel input through rendering and for several frames
    // after it finishes. Waiting for the canvas first would start a new gesture
    // on slow renders and miss momentum moving the newly displayed page.
    for (let pulse = 0; pulse < 60 && renderedPulses < 4; pulse++) {
      await page.mouse.wheel(0, deltaY);
      const ready = await pdf().locator('.pdf-paper').evaluate((element, expectedPage) => (
        element.getAttribute('aria-busy') === 'false'
        && element.querySelector('canvas')?.getAttribute('data-page-number') === String(expectedPage)
      ), number);
      renderedPulses = ready ? renderedPulses + 1 : 0;
      await page.waitForTimeout(40);
    }
    expect(renderedPulses).toBe(4);
    const times = await wheelEvents.evaluate(value => value.times);
    expect(times.length).toBeGreaterThanOrEqual(5);
    for (let index = 1; index < times.length; index++) {
      expect(times[index] - times[index - 1], 'Wheel momentum must remain one gesture').toBeLessThan(250);
    }
    await renderedPage(number);
  } finally {
    await wheelEvents.evaluate(value => value.dispose());
    await wheelEvents.dispose();
  }
}

async function expectInsidePane(control: Locator) {
  await expect(control).toBeVisible();
  const box = await control.boundingBox();
  const bounds = await page.locator('.pdf-panel').boundingBox();
  if (!box || !bounds) throw new Error('The PDF pane or its navigation is not visible.');
  expect(box.x).toBeGreaterThanOrEqual(bounds.x);
  expect(box.x + box.width).toBeLessThanOrEqual(bounds.x + bounds.width + 1);
  expect(box.y).toBeGreaterThanOrEqual(bounds.y);
  expect(box.y + box.height).toBeLessThanOrEqual(bounds.y + bounds.height + 1);
}

test.beforeEach(async () => {
  temporary = await mkdtemp(path.join(os.tmpdir(), 'prism-pdf-page-navigation-'));
  notebook = path.join(temporary, 'Notebook');
  userData = path.join(temporary, 'notes-profile');
  pdfProfile = path.join(temporary, 'pdf-profile');
  rendererErrors = []; remoteRequests = [];
  await Promise.all([mkdir(notebook), mkdir(userData), mkdir(path.join(pdfProfile, 'library', 'documents'), { recursive: true })]);
  await writeFile(noteFile(), initialNote);
  const plain = fixturePdf();
  const protectedBytes = fixturePdf('page-secret');
  await writeFile(catalogFile(), JSON.stringify({ version: 1, documents: [entry(documentId, 'Field notes', plain), entry(protectedId, 'Protected', protectedBytes)] }) + '\n');
  await Promise.all([
    writeFile(path.join(pdfProfile, 'library', 'documents', `${documentId}.pdf`), plain),
    writeFile(path.join(pdfProfile, 'library', 'documents', `${protectedId}.pdf`), protectedBytes),
  ]);
  await launch();
});

test.afterEach(async ({}, testInfo) => {
  if (page && !page.isClosed() && testInfo.status !== testInfo.expectedStatus) {
    const screenshot = await page.screenshot().catch(() => undefined);
    if (screenshot) await testInfo.attach('PDF page navigation at failure', { body: screenshot, contentType: 'image/png' });
  }
  await stop();
  if (temporary) await rm(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

test('turns with a fresh wheel gesture at page edges while preserving zoomed scrolling and reverse landing', async () => {
  await openDocument();
  await renderedPage(1);
  await zoom().selectOption('0.5');
  await renderedPage(1);
  await expect.poll(async () => (await scrollPosition()).bottom).toBeLessThanOrEqual(1);
  await expect(previous()).toBeDisabled();
  await freshWheel(160);
  // Reversing the same wheel gesture must not bounce straight back a page.
  // Send it before waiting for rendering, which may outlast the gesture gap.
  await page.mouse.wheel(0, -160);
  await renderedPage(2);
  await expect(next()).toBeDisabled();
  await freshWheel(-160);
  await renderedPage(1);

  await zoom().selectOption('2');
  await renderedPage(1);
  await freshWheel(360);
  await expect.poll(async () => (await scrollPosition()).top).toBeGreaterThan(100);
  await expect(pageNumber()).toHaveValue('1');
  await page.mouse.wheel(0, 5_000);
  await expect.poll(async () => (await scrollPosition()).bottom).toBeLessThanOrEqual(1);
  // Reaching the edge during a scrolling gesture still needs a release before
  // page turning. A final momentum event must leave the current page in place.
  await page.mouse.wheel(0, 160);
  await expect(pageNumber()).toHaveValue('1');
  await turnWithMomentum(2, 160);
  await expect.poll(async () => (await scrollPosition()).top).toBe(0);
  await turnWithMomentum(1, -160);
  await expect.poll(async () => (await scrollPosition()).bottom).toBeLessThanOrEqual(1);
  await freshWheel(20, 240);
  await expect(pageNumber()).toHaveValue('1');
  await freshWheel(160);
  await renderedPage(2);
  await expect(next()).toBeDisabled();
  await freshWheel(160);
  await expect(pageNumber()).toHaveValue('2');
  expect(rendererErrors).toEqual([]);
  expect(remoteRequests).toEqual([]);
});

test('focuses clicked pages for keys, scrolls with Space, and retains current-page links, note shortcuts and reading position', async () => {
  await page.getByRole('button', { name: 'Read & write', exact: true }).click();
  await editor().focus();
  await editor().press('ControlOrMeta+End');
  await page.keyboard.insertText('読書の下書き。 ');
  await openDocument();
  const canvas = await renderedPage(1);
  await zoom().selectOption('0.5');
  await renderedPage(1);
  await canvas.click({ position: { x: 20, y: 20 } });
  await expect(viewport()).toBeFocused();
  for (const [key, number] of [['ArrowRight', 2], ['ArrowLeft', 1], ['End', 2], ['Home', 1], ['PageDown', 2], ['PageUp', 1]] as const) {
    await page.keyboard.press(key);
    await renderedPage(number);
  }
  await zoom().selectOption('2');
  await renderedPage(1);
  await pdf().locator('.pdf-paper canvas').click({ position: { x: 20, y: 20 } });
  await expect(viewport()).toBeFocused();
  await page.keyboard.press('Space');
  await expect.poll(async () => (await scrollPosition()).top).toBeGreaterThan(100);
  await expect(pageNumber()).toHaveValue('1');
  await viewport().evaluate(element => element.scrollTo(0, element.scrollHeight));
  await expect.poll(async () => (await scrollPosition()).bottom).toBeLessThanOrEqual(1);
  await page.keyboard.press('Space');
  await renderedPage(2);
  await expect.poll(async () => (await scrollPosition()).top).toBe(0);
  await page.keyboard.press('Shift+Space');
  await renderedPage(1);
  await expect.poll(async () => (await scrollPosition()).bottom).toBeLessThanOrEqual(1);
  await page.keyboard.press('End');
  await renderedPage(2);

  await pageNumber().focus();
  await page.keyboard.press('Home');
  await expect(pageNumber()).toHaveValue('2');
  await editor().focus();
  await editor().press('ControlOrMeta+End');
  // Hovering the PDF to turn a page must preserve the note's typing focus.
  await freshWheel(-160);
  await renderedPage(1);
  await expect(editor()).toBeFocused();
  await expect(page.locator('.app-body')).toHaveAttribute('data-active', 'true');
  await freshWheel(160);
  await renderedPage(2);
  await expect(editor()).toBeFocused();
  await expect(page.locator('.app-body')).toHaveAttribute('data-active', 'true');
  await page.keyboard.press('Space');
  await expect(pageNumber()).toHaveValue('2');
  await editor().press('ControlOrMeta+z');
  await expect(editor()).toContainText('読書の下書き。');
  await pdf().getByRole('button', { name: 'Insert page link', exact: true }).click();
  const link = `[Field notes — p. 2](prism-pdf://v1/documents/${documentId}?page=2)`;
  await expect(editor()).toContainText(link);
  await editor().press('ControlOrMeta+z');
  await expect(editor()).not.toContainText(link);
  await expect(editor()).toContainText('読書の下書き。');
  await editor().press(redoKey);
  await expect(editor()).toContainText(link);
  await editor().press('ControlOrMeta+s');
  await expect.poll(() => readFile(noteFile(), 'utf8')).toContain(link);
  await expect.poll(async () => {
    const catalog = JSON.parse(await readFile(catalogFile(), 'utf8')) as { documents: PDFDocument[] };
    return catalog.documents.find(document => document.id === documentId)?.lastPage;
  }).toBe(2);

  await viewport().focus();
  await page.keyboard.press('ControlOrMeta+k');
  const search = pdf().getByLabel('Search library', { exact: true });
  await expect(search).toBeFocused();
  await search.fill('Field');
  await page.keyboard.press('End');
  await page.keyboard.press('Space');
  await expect(search).toHaveValue('Field ');
  await search.fill('');
  await stop();
  await launch();
  await openDocument();
  await renderedPage(2);
  expect(await readFile(noteFile(), 'utf8')).toContain(link);
  expect(rendererErrors).toEqual([]);
  expect(remoteRequests).toEqual([]);
});

test('keeps bottom buttons visible at 420px with large text and transparency, and guards locked PDFs', async ({}, testInfo) => {
  await page.getByRole('button', { name: 'Read & write', exact: true }).click();
  await openDocument('Protected');
  const password = pdf().getByLabel('Document password', { exact: true });
  await expect(password).toBeVisible();
  await expect(previous()).toBeDisabled();
  await expect(next()).toBeDisabled();
  await password.fill('page');
  await page.keyboard.press('End');
  await page.keyboard.press('Space');
  await page.keyboard.press('PageDown');
  await expect(password).toHaveValue('page ');
  await freshWheel(160);
  await expect(password).toBeVisible();
  await expect(next()).toBeDisabled();
  await password.fill('page-secret');
  await pdf().getByRole('button', { name: 'Unlock PDF', exact: true }).click();
  await renderedPage(1);
  const divider = page.getByRole('separator', { name: 'Resize note and PDF panes', exact: true });
  await divider.focus();
  for (let count = 0; count < 20; count++) await divider.press('Shift+ArrowRight');
  await expect.poll(async () => (await page.locator('.pdf-panel').boundingBox())!.width).toBeGreaterThanOrEqual(420);
  await expect.poll(async () => (await page.locator('.pdf-panel').boundingBox())!.width).toBeLessThan(430);
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
    await zoom().selectOption('2');
    await renderedPage(1);
    await viewport().evaluate(element => element.scrollTo(0, element.scrollHeight));
    await expect.poll(async () => (await scrollPosition()).bottom).toBeLessThanOrEqual(1);
    for (const control of [navigation(), previous(), next(), navigation().getByRole('status')]) await expectInsidePane(control);
    const viewportBox = (await viewport().boundingBox())!;
    const navigationBox = (await navigation().boundingBox())!;
    expect(navigationBox.y).toBeGreaterThanOrEqual(viewportBox.y + viewportBox.height - 1);
    expect(await navigation().evaluate(element => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1);
    await expect(previous()).toBeDisabled();
    await next().click();
    await renderedPage(2);
    await expect(next()).toBeDisabled();
    await expect(viewport()).toBeFocused();
    await previous().click();
    await renderedPage(1);
  }
  await testInfo.attach('Compact page navigation at 150% with transparency', {
    body: await page.screenshot({ path: testInfo.outputPath('pdf-page-navigation-compact.png') }), contentType: 'image/png',
  });
  expect(rendererErrors).toEqual([]);
  expect(remoteRequests).toEqual([]);
});
