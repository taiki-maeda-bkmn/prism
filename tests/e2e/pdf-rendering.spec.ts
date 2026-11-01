import { _electron as electron, expect, test, type ElectronApplication, type ElementHandle, type Page } from '@playwright/test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { electronLaunchArguments } from '../../scripts/electron-launch.mjs';
import { performancePdf, type PerformancePDFKind } from '../fixtures/pdf-performance';

let temporary: string, notebook: string;
let desktop: ElectronApplication | undefined, page: Page;
let errors: string[];
const original = '\ufeff# Rendering notes\r\n\r\n描画中もノートをそのまま保つ。\r\n';
const pdf = () => page.locator('.pdf-workspace');
const paper = () => pdf().locator('.pdf-paper');
const canvas = () => paper().locator('canvas');
const viewport = () => pdf().getByLabel('PDF page viewport', { exact: true });
const divider = () => page.getByRole('separator', { name: 'Resize note and PDF panes', exact: true });
type CanvasHandle = ElementHandle<HTMLCanvasElement>;
type RenderCounts = { contexts: number; published: number };

async function stop() {
  if (!desktop) return;
  const current = desktop, child = current.process();
  const closed = current.waitForEvent('close', { timeout: 5000 }).catch(() => undefined);
  await current.evaluate(({ app }) => app.exit(0)).catch(() => undefined);
  await closed;
  if (child.exitCode === null) child.kill();
  desktop = undefined;
}

async function renderedPage(number: number) {
  await expect(canvas()).toHaveAttribute('data-page-number', String(number));
  await expect(paper()).toHaveAttribute('aria-busy', 'false');
  await expect(canvas()).toBeVisible();
}

async function currentCanvas(): Promise<CanvasHandle> {
  const element = await canvas().elementHandle();
  if (!element) throw new Error('The rendered page is missing.');
  return element as CanvasHandle;
}

async function retired(element: CanvasHandle) {
  await expect.poll(() => element.evaluate(value => ({ connected: value.isConnected, width: value.width, height: value.height })))
    .toEqual({ connected: false, width: 0, height: 0 });
}

async function importPDF(kind: PerformancePDFKind) {
  const bytes = performancePdf(kind);
  const filename = path.join(temporary, `${kind}.pdf`);
  await writeFile(filename, bytes);
  await desktop!.evaluate(({ dialog }, filename) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [filename] });
  }, filename);
  await page.getByRole('navigation', { name: 'Workspaces', exact: true }).getByRole('button', { name: 'PDFs', exact: true }).click();
  await pdf().getByRole('button', { name: 'Import PDFs', exact: true }).click();
  await pdf().getByRole('button', { name: `Open ${kind}`, exact: true }).click();
  await renderedPage(1);
  return { filename, bytes };
}

async function observeRendering() {
  await page.evaluate(() => {
    const counts: RenderCounts = { contexts: 0, published: 0 };
    const known = new WeakSet(document.querySelectorAll<HTMLCanvasElement>('canvas'));
    const originalGetContext = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (this: HTMLCanvasElement, ...args: unknown[]) {
      if (args[0] === '2d' && !known.has(this)) { known.add(this); counts.contexts++; }
      return Reflect.apply(originalGetContext, this, args);
    } as HTMLCanvasElement['getContext'];
    const observer = new MutationObserver(records => {
      for (const record of records) {
        for (const node of record.addedNodes) if (node instanceof HTMLCanvasElement) counts.published++;
      }
    });
    observer.observe(document.querySelector('.pdf-paper')!, { childList: true });
    (window as typeof window & { pdfRenderCounts: RenderCounts }).pdfRenderCounts = counts;
  });
}

async function counts() {
  return page.evaluate(() => ({ ...(window as typeof window & { pdfRenderCounts: RenderCounts }).pdfRenderCounts }));
}

async function resetCounts() {
  await page.evaluate(() => {
    const counts = (window as typeof window & { pdfRenderCounts: RenderCounts }).pdfRenderCounts;
    counts.contexts = 0; counts.published = 0;
  });
}

async function dragContinuously(delta: number, retained: CanvasHandle) {
  const bounds = await divider().boundingBox();
  if (!bounds) throw new Error('The divider is not visible.');
  const x = bounds.x + bounds.width / 2, y = bounds.y + 140;
  await page.mouse.move(x, y); await page.mouse.down();
  for (let step = 1; step <= 12; step++) {
    await page.mouse.move(x + delta * step / 12, y);
    // This delay models a continuous drag, rather than measuring machine speed.
    await page.waitForTimeout(35);
    expect(await canvas().evaluate((element, previous) => element === previous, retained)).toBe(true);
  }
  await page.mouse.up();
}

test.beforeEach(async () => {
  temporary = await mkdtemp(path.join(os.tmpdir(), 'prism-pdf-rendering-'));
  notebook = path.join(temporary, 'Notebook'); errors = [];
  await mkdir(notebook); await writeFile(path.join(notebook, 'Rendering.md'), original);
  desktop = await electron.launch({ args: electronLaunchArguments(['--no-sandbox', '.']), cwd: process.cwd(),
    env: { ...process.env, PRISM_USER_DATA: path.join(temporary, 'notes-profile'), PRISM_WORKSPACE: notebook,
      PRISM_PDF_USER_DATA: path.join(temporary, 'pdf-profile') } });
  page = await desktop.firstWindow();
  page.on('pageerror', error => errors.push(error.message));
  await expect(page.locator('.note-heading h1')).toHaveText('Rendering notes');
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.getByRole('group', { name: 'Editor mode', exact: true }).getByRole('button', { name: 'Source', exact: true }).click();
});
test.afterEach(async () => {
  await stop();
  await rm(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

test('fixed zoom avoids resize rasterization and fit width retains its page until the drag settles', async () => {
  const source = await importPDF('vector');
  await page.getByRole('button', { name: 'Read & write', exact: true }).click();
  await expect(divider()).toBeVisible();
  await pdf().getByLabel('Page zoom', { exact: true }).selectOption('1.5');
  await expect.poll(() => canvas().evaluate(element => parseFloat(element.style.width))).toBe(918);
  await renderedPage(1);
  const fixedCanvas = await currentCanvas();
  await viewport().evaluate(element => { element.scrollTop = 150; element.scrollLeft = 80; });
  const scroll = await viewport().evaluate(element => ({ top: element.scrollTop, left: element.scrollLeft }));
  expect(scroll.top).toBeGreaterThan(0); expect(scroll.left).toBeGreaterThan(0);
  await observeRendering();
  const initialNotesWidth = (await page.locator('#notes-workspace').boundingBox())!.width;
  await dragContinuously(120, fixedCanvas);
  // Observe beyond the resize settling interval to catch unnecessary late work.
  await page.waitForTimeout(250);
  expect((await page.locator('#notes-workspace').boundingBox())!.width).toBeCloseTo(initialNotesWidth + 120, 0);
  expect(await counts()).toEqual({ contexts: 0, published: 0 });
  expect(await canvas().evaluate((element, previous) => element === previous, fixedCanvas)).toBe(true);
  expect(await viewport().evaluate(element => ({ top: element.scrollTop, left: element.scrollLeft }))).toEqual(scroll);

  await pdf().getByLabel('Page zoom', { exact: true }).selectOption('fit');
  await expect.poll(() => canvas().evaluate((element, previous) => element !== previous, fixedCanvas)).toBe(true);
  await renderedPage(1);
  const fittedCanvas = await currentCanvas();
  const fittedWidth = await canvas().evaluate(element => parseFloat(element.style.width));
  await retired(fixedCanvas); await resetCounts();
  await dragContinuously(-120, fittedCanvas);
  await expect.poll(() => canvas().evaluate((element, previous) => element !== previous, fittedCanvas)).toBe(true);
  await renderedPage(1);
  await page.waitForTimeout(250);
  const fitCounts = await counts();
  expect(fitCounts.published).toBeGreaterThanOrEqual(1);
  expect(fitCounts.published).toBeLessThanOrEqual(2);
  expect(await canvas().evaluate(element => parseFloat(element.style.width))).toBeCloseTo(fittedWidth + 120, 0);
  await retired(fittedCanvas);
  expect(await readFile(source.filename)).toEqual(source.bytes);
  expect(await readFile(path.join(notebook, 'Rendering.md'), 'utf8')).toBe(original);
  expect(errors).toEqual([]);
});

test('page changes release retired canvases and rapid navigation renders the latest page, rotation and zoom', async () => {
  const vector = await importPDF('vector');
  const first = await currentCanvas();
  await pdf().getByRole('button', { name: 'Next page', exact: true }).click(); await renderedPage(2);
  await retired(first);
  const second = await currentCanvas();
  await pdf().getByRole('button', { name: 'Previous page', exact: true }).click(); await renderedPage(1);
  await retired(second);
  const beforeRapidNavigation = await currentCanvas();

  // Do not wait for intermediate page paints: only the newest request may win.
  await pdf().getByRole('button', { name: 'Next page', exact: true }).click();
  await pdf().getByRole('button', { name: 'Next page', exact: true }).click();
  await pdf().getByRole('button', { name: 'Previous page', exact: true }).click();
  await pdf().getByRole('button', { name: 'Rotate page clockwise', exact: true }).click();
  await pdf().getByLabel('Page zoom', { exact: true }).selectOption('1.25');
  await pdf().getByLabel('Page number', { exact: true }).fill('5');
  await pdf().getByLabel('Page number', { exact: true }).press('Enter');
  await renderedPage(5);
  await expect(canvas()).toHaveAttribute('aria-label', 'Page 5 of 8');
  expect(await canvas().evaluate(element => ({ width: parseFloat(element.style.width), height: parseFloat(element.style.height) })))
    .toEqual({ width: 990, height: 765 });
  await retired(beforeRapidNavigation);
  const lastVector = await currentCanvas();
  await pdf().getByRole('button', { name: 'Back to library', exact: true }).click();
  await retired(lastVector);

  const scan = await importPDF('scan');
  await pdf().getByLabel('Page zoom', { exact: true }).selectOption('3');
  await expect.poll(() => canvas().evaluate(element => parseFloat(element.style.width))).toBe(1800);
  await renderedPage(1);
  const scanPixels = await canvas().evaluate((element: HTMLCanvasElement) => {
    const pixels = element.getContext('2d')!.getImageData(0, 0, element.width, element.height).data;
    let darkest = 255, lightest = 0;
    for (let offset = 0; offset < pixels.length; offset += 256) {
      darkest = Math.min(darkest, pixels[offset]); lightest = Math.max(lightest, pixels[offset]);
    }
    return { darkest, lightest, width: element.width, height: element.height };
  });
  expect(scanPixels.darkest).toBeLessThan(40); expect(scanPixels.lightest).toBeGreaterThan(240);
  expect(scanPixels.width).toBeLessThanOrEqual(4096); expect(scanPixels.height).toBeLessThanOrEqual(4096);
  expect(scanPixels.width * scanPixels.height).toBeLessThanOrEqual(12_000_000);
  const firstScan = await currentCanvas();
  await pdf().getByRole('button', { name: 'Next page', exact: true }).click(); await renderedPage(2);
  await retired(firstScan);
  expect(await readFile(vector.filename)).toEqual(vector.bytes);
  expect(await readFile(scan.filename)).toEqual(scan.bytes);
  expect(await readFile(path.join(notebook, 'Rendering.md'), 'utf8')).toBe(original);
  expect(errors).toEqual([]);
});
