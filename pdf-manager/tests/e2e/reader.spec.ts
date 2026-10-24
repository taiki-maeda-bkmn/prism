import { _electron as electron, expect, test, type ElectronApplication, type Locator, type Page } from '@playwright/test';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { deflateSync } from 'node:zlib';

const passwordPadding = Buffer.from('28bf4e5e4e758a4164004e56fffa01082e2e00b6d0683e802f0ca9fe6453697a', 'hex');
const md5 = (value: Uint8Array) => createHash('md5').update(value).digest();
function paddedPassword(value: string) { return Buffer.concat([Buffer.from(value, 'latin1'), passwordPadding]).subarray(0, 32); }
function rc4(key: Uint8Array, value: Uint8Array) {
  const state = Array.from({ length: 256 }, (_, index) => index);
  let j = 0;
  for (let i = 0; i < 256; i++) { j = (j + state[i] + key[i % key.length]) & 255; [state[i], state[j]] = [state[j], state[i]]; }
  const output = Buffer.alloc(value.length);
  let i = 0; j = 0;
  for (let offset = 0; offset < value.length; offset++) {
    i = (i + 1) & 255; j = (j + state[i]) & 255; [state[i], state[j]] = [state[j], state[i]];
    output[offset] = value[offset] ^ state[(state[i] + state[j]) & 255];
  }
  return output;
}

// A complete, reproducible two-page PDF, with a standard revision-2 encrypted
// variant. Tests exercise the actual parser/worker/canvas, never a mocked reader.
function fixturePdf(password?: string): Buffer {
  const fileId = md5(Buffer.from(`prism-pdf-desktop-fixture-${password ?? 'plain'}`));
  const owner = password ? rc4(md5(paddedPassword('owner-secret')).subarray(0, 5), paddedPassword(password)) : null;
  const permissions = Buffer.alloc(4); permissions.writeInt32LE(-4);
  const key = password && owner ? md5(Buffer.concat([paddedPassword(password), owner, permissions, fileId])).subarray(0, 5) : null;
  const stream = (object: number, content: string) => {
    let bytes = Buffer.from(content, 'ascii');
    if (key) {
      const objectId = Buffer.alloc(5); objectId.writeUIntLE(object, 0, 3);
      bytes = rc4(md5(Buffer.concat([key, objectId])).subarray(0, 10), bytes);
    }
    return Buffer.concat([Buffer.from(`<< /Length ${bytes.length} >>\nstream\n`), bytes, Buffer.from('\nendstream')]);
  };
  const objects: Buffer[] = [
    Buffer.from('<< /Type /Catalog /Pages 2 0 R >>'),
    Buffer.from('<< /Type /Pages /Kids [3 0 R 5 0 R] /Count 2 >>'),
    Buffer.from('<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 7 0 R >> >> /Contents 4 0 R >>'),
    stream(4, '0.9 0.42 0.25 rg 48 520 516 180 re f\n0.13 0.18 0.15 rg BT /F1 30 Tf 48 460 Td (Prism PDF field notes) Tj ET\nBT /F1 16 Tf 48 420 Td (A real local document, page one.) Tj ET\n'),
    Buffer.from('<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 7 0 R >> >> /Contents 6 0 R >>'),
    stream(6, '0.25 0.48 0.4 rg 48 520 516 180 re f\n0.13 0.18 0.15 rg BT /F1 30 Tf 48 460 Td (The next chapter) Tj ET\nBT /F1 16 Tf 48 420 Td (Your reading position is remembered.) Tj ET\n'),
    Buffer.from('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'),
  ];
  if (key && owner) objects.push(Buffer.from(`<< /Filter /Standard /V 1 /R 2 /O <${owner.toString('hex')}> /U <${rc4(key, passwordPadding).toString('hex')}> /P -4 >>`));
  const pieces: Buffer[] = [Buffer.from('%PDF-1.4\n%\x80\x81\x82\x83\n', 'latin1')];
  const offsets = [0];
  for (let index = 0; index < objects.length; index++) {
    offsets.push(pieces.reduce((sum, piece) => sum + piece.length, 0));
    pieces.push(Buffer.from(`${index + 1} 0 obj\n`), objects[index], Buffer.from('\nendobj\n'));
  }
  const startXref = pieces.reduce((sum, piece) => sum + piece.length, 0);
  pieces.push(Buffer.from(`xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R${key ? ` /Encrypt 8 0 R /ID [<${fileId.toString('hex')}> <${fileId.toString('hex')}>]` : ''} >>\nstartxref\n${startXref}\n%%EOF\n`));
  return Buffer.concat(pieces);
}

function largeScanPdf(): Buffer {
  // A real 30 MP image with black and white halves. One-bit pixels keep its
  // decoded fixture at 3.75 MB; Flate compression keeps the PDF below 30 KB.
  const pixels = Buffer.alloc(6000 * 5000 / 8, 255);
  for (let row = 0; row < 5000; row++) pixels.fill(0, row * 750, row * 750 + 375);
  const image = deflateSync(pixels);
  const content = Buffer.from('q 1200 0 0 1500 0 0 cm /Scan Do Q');
  const objects = [
    Buffer.from('<< /Type /Catalog /Pages 2 0 R >>'),
    Buffer.from('<< /Type /Pages /Kids [3 0 R] /Count 1 >>'),
    Buffer.from('<< /Type /Page /Parent 2 0 R /MediaBox [0 0 1200 1500] /Resources << /XObject << /Scan 5 0 R >> >> /Contents 4 0 R >>'),
    Buffer.concat([Buffer.from(`<< /Length ${content.length} >>\nstream\n`), content, Buffer.from('\nendstream')]),
    Buffer.concat([Buffer.from(`<< /Type /XObject /Subtype /Image /Width 6000 /Height 5000 /ColorSpace /DeviceGray /BitsPerComponent 1 /Filter /FlateDecode /Length ${image.length} >>\nstream\n`), image, Buffer.from('\nendstream')]),
  ];
  const pieces = [Buffer.from('%PDF-1.4\n')];
  const offsets: number[] = [];
  for (let index = 0; index < objects.length; index++) {
    offsets.push(pieces.reduce((sum, piece) => sum + piece.length, 0));
    pieces.push(Buffer.from(`${index + 1} 0 obj\n`), objects[index], Buffer.from('\nendobj\n'));
  }
  const startXref = pieces.reduce((sum, piece) => sum + piece.length, 0);
  pieces.push(Buffer.from(`xref\n0 6\n0000000000 65535 f \n${offsets.map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${startXref}\n%%EOF\n`));
  return Buffer.concat(pieces);
}

let temporary: string;
let userData: string;
let desktop: ElectronApplication | undefined;
let page: Page;
let rendererErrors: string[];

async function launch() {
  desktop = await electron.launch({
    args: ['--no-sandbox', path.resolve('pdf-manager')],
    cwd: process.cwd(),
    env: { ...process.env, PRISM_PDF_USER_DATA: userData },
  });
  page = await desktop.firstWindow();
  page.on('pageerror', error => rendererErrors.push(error.message));
  await expect(page.getByRole('heading', { name: 'All documents', exact: true })).toBeVisible();
}

async function close() {
  if (!desktop) return;
  const child = desktop.process();
  const closed = desktop.waitForEvent('close', { timeout: 5_000 }).catch(() => undefined);
  await desktop.evaluate(({ app }) => app.exit(0)).catch(() => undefined);
  await closed;
  if (child.exitCode === null) child.kill();
  desktop = undefined;
}

async function importFiles(files: string[]) {
  // Substitute the OS picker result, leaving native IPC, disk writes, PDF.js,
  // and the user-facing library/reader flow intact.
  await desktop!.evaluate(({ dialog }, filePaths) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths });
  }, files);
  await page.getByRole('button', { name: 'Import PDFs', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Import PDFs', exact: true })).toBeEnabled();
}

async function renderedPage(number: number) {
  const canvas = page.locator(`.pdf-paper canvas[data-page-number="${number}"]`);
  await expect(canvas).toBeVisible();
  // A loaded white canvas is insufficient: check the colored PDF artwork.
  expect(await canvas.evaluate((element: HTMLCanvasElement) => {
    const pixels = element.getContext('2d')!.getImageData(0, 0, element.width, element.height).data;
    let colored = 0;
    for (let offset = 0; offset < pixels.length; offset += 16) if (Math.max(pixels[offset], pixels[offset + 1], pixels[offset + 2]) - Math.min(pixels[offset], pixels[offset + 1], pixels[offset + 2]) > 40) colored++;
    return colored;
  })).toBeGreaterThan(100);
  return canvas;
}

test.beforeEach(async () => {
  temporary = await mkdtemp(path.join(os.tmpdir(), 'prism-pdf-desktop-'));
  userData = path.join(temporary, 'profile');
  rendererErrors = [];
  await mkdir(userData);
  await launch();
});

test.afterEach(async ({}, testInfo) => {
  if (page && !page.isClosed() && testInfo.status !== testInfo.expectedStatus) {
    const screenshot = await page.screenshot().catch(() => undefined);
    if (screenshot) await testInfo.attach('PDF desktop at failure', { body: screenshot, contentType: 'image/png' });
  }
  await close();
  if (temporary) await rm(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

test('imports, organizes, renders, and remembers a real PDF across a restart', async ({}, testInfo) => {
  const source = path.join(temporary, 'Field notes.pdf');
  const sourceBytes = fixturePdf();
  await writeFile(source, sourceBytes);
  await importFiles([source]);
  await expect(page.getByRole('button', { name: 'Open Field notes', exact: true })).toBeVisible();
  await expect(page.locator('.pdf-thumbnail-ready canvas')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Recently opened', exact: true })).toContainText('0');
  await importFiles([source]);
  await expect(page.locator('.document-card')).toHaveCount(1);
  await expect(page.getByRole('status')).toContainText('already in your library');

  await page.getByRole('button', { name: 'Open Field notes', exact: true }).click();
  const firstCanvas = await renderedPage(1);
  await expect(page.getByLabel('Page number', { exact: true })).toHaveValue('1');
  await expect(page.locator('.pdf-page-total')).toHaveText('of 2');
  const initialWidth = await firstCanvas.evaluate((canvas: HTMLCanvasElement) => canvas.getBoundingClientRect().width);
  await page.getByLabel('Page zoom', { exact: true }).selectOption('0.5');
  await renderedPage(1);
  await expect.poll(() => page.locator('.pdf-paper canvas').evaluate(element => element.getBoundingClientRect().width)).toBe(306);
  expect(initialWidth).toBeGreaterThan(306);
  await page.getByRole('button', { name: 'Rotate page clockwise', exact: true }).click();
  await renderedPage(1);
  await expect.poll(() => page.locator('.pdf-paper canvas').evaluate(element => element.getBoundingClientRect().width)).toBe(396);
  await page.getByRole('button', { name: 'Next page', exact: true }).click();
  await renderedPage(2);
  await expect(page.getByRole('button', { name: 'Next page', exact: true })).toBeDisabled();
  await page.getByLabel('Page number', { exact: true }).fill('1');
  await page.getByLabel('Page number', { exact: true }).press('Enter');
  await renderedPage(1);
  // Exercise cancellation when several navigation operations land together.
  await page.getByLabel('PDF page viewport', { exact: true }).focus();
  await page.keyboard.press('End');
  await page.keyboard.press('Home');
  await page.keyboard.press('End');
  await renderedPage(2);
  await page.getByRole('button', { name: 'Back to library', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Recently opened', exact: true })).toContainText('1');
  await page.getByRole('button', { name: 'Favorite Field notes', exact: true }).click();
  await page.getByRole('button', { name: 'Details for Field notes', exact: true }).click();
  await page.getByLabel('Document title', { exact: true }).fill('Reading notes');
  await page.getByLabel('Tags (comma-separated)', { exact: true }).fill('Research, Reading');
  await page.getByRole('button', { name: 'Save changes', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.getByRole('button', { name: 'Favorites', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Open Reading notes', exact: true })).toBeVisible();
  const libraryScreenshot = testInfo.outputPath('prism-pdf-library.png');
  await page.screenshot({ path: libraryScreenshot });
  await testInfo.attach('Local PDF library', { path: libraryScreenshot, contentType: 'image/png' });
  await page.getByLabel('Search library', { exact: true }).fill('research');
  await expect(page.locator('.document-card')).toHaveCount(1);
  await page.getByLabel('Search library', { exact: true }).fill('nonexistent');
  await expect(page.getByRole('heading', { name: 'No matching documents' })).toBeVisible();
  await close();
  await launch();
  await expect(page.getByRole('button', { name: 'Unfavorite Reading notes', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Tag Research', exact: true }).click();
  await page.getByRole('button', { name: 'Open Reading notes', exact: true }).click();
  await renderedPage(2);
  const readerScreenshot = testInfo.outputPath('prism-pdf-reader.png');
  await page.screenshot({ path: readerScreenshot });
  await testInfo.attach('Local PDF reader', { path: readerScreenshot, contentType: 'image/png' });
  await page.getByRole('button', { name: 'Back to library', exact: true }).click();
  await page.getByRole('button', { name: 'Details for Reading notes', exact: true }).click();
  await page.getByRole('button', { name: 'Remove', exact: true }).click();
  await page.getByRole('button', { name: 'Remove document', exact: true }).click();
  await expect(page.locator('.document-card')).toHaveCount(0);
  expect(await readFile(source)).toEqual(sourceBytes);
  expect(rendererErrors).toEqual([]);
});

test('opens an encrypted PDF with a password without persisting the password', async () => {
  const source = path.join(temporary, 'Protected.pdf');
  await writeFile(source, fixturePdf('read-secret'));
  await importFiles([source]);
  await expect(page.getByText('Password protected', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Open Protected', exact: true }).click();
  await page.getByLabel('Document password', { exact: true }).fill('incorrect');
  await page.getByRole('button', { name: 'Unlock PDF', exact: true }).click();
  await expect(page.getByText('That password did not work. Please try again.', { exact: true })).toBeVisible();
  await page.getByLabel('Document password', { exact: true }).fill('read-secret');
  await page.getByRole('button', { name: 'Unlock PDF', exact: true }).click();
  await renderedPage(1);
  await page.getByRole('button', { name: 'Back to library', exact: true }).click();
  await page.getByRole('button', { name: 'Open Protected', exact: true }).click();
  await expect(page.getByLabel('Document password', { exact: true })).toBeVisible();
  const catalog = await readFile(path.join(userData, 'library/catalog.json'), 'utf8');
  expect(catalog).not.toContain('read-secret');
  await page.getByRole('button', { name: 'Back to library', exact: true }).click();
  expect(rendererErrors).toEqual([]);
});

test('keeps the library usable after a damaged PDF fails to render', async () => {
  const source = path.join(temporary, 'Damaged.pdf');
  await writeFile(source, '%PDF-1.4\nThis document has no valid PDF objects.\n%%EOF\n');
  await importFiles([source]);
  await page.getByRole('button', { name: 'Open Damaged', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Unable to display this PDF', exact: true })).toBeVisible();
  await expect(page.getByRole('alert')).toContainText('could not be read as a PDF');
  await page.getByRole('button', { name: 'Back to library', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'All documents', exact: true })).toBeVisible();
  expect(rendererErrors).toEqual([]);
});

test('renders a large scanned image in thumbnails and the bounded reader canvas', async () => {
  const source = path.join(temporary, 'Large scan.pdf');
  const bytes = largeScanPdf();
  expect(bytes.length).toBeLessThan(30_000);
  await writeFile(source, bytes);
  await importFiles([source]);

  async function expectScanPixels(canvas: Locator) {
    await expect(canvas).toBeVisible();
    const sample = await canvas.evaluate((element: HTMLCanvasElement) => {
      const context = element.getContext('2d')!;
      const left = Array.from(context.getImageData(Math.floor(element.width / 4), Math.floor(element.height / 2), 1, 1).data);
      const right = Array.from(context.getImageData(Math.floor(element.width * 3 / 4), Math.floor(element.height / 2), 1, 1).data);
      return { left, right, width: element.width, height: element.height };
    });
    expect(sample.left.slice(0, 3).every(channel => channel < 20)).toBe(true);
    expect(sample.right.slice(0, 3).every(channel => channel > 235)).toBe(true);
    expect(sample.left[3]).toBe(255);
    expect(sample.right[3]).toBe(255);
    return sample;
  }

  const thumbnail = await expectScanPixels(page.locator('.pdf-thumbnail-ready canvas'));
  expect(thumbnail.width).toBeLessThanOrEqual(320);
  expect(thumbnail.height).toBeLessThanOrEqual(440);
  await page.getByRole('button', { name: 'Open Large scan', exact: true }).click();
  await expectScanPixels(page.locator('.pdf-paper canvas[data-page-number="1"]'));
  await page.getByLabel('Page zoom', { exact: true }).selectOption('3');
  // This large page at 300% exceeds both backing-surface limits before scaling.
  await expect.poll(() => page.locator('.pdf-paper canvas').evaluate(element => element.getBoundingClientRect().width)).toBe(3600);
  const reader = await expectScanPixels(page.locator('.pdf-paper canvas'));
  expect(reader.width).toBeLessThanOrEqual(4096);
  expect(reader.height).toBeLessThanOrEqual(4096);
  expect(reader.width * reader.height).toBeLessThanOrEqual(12_000_000);
  await expect(page.getByRole('alert')).toHaveCount(0);
  expect(rendererErrors).toEqual([]);
});

test('uses real window transparency and restores its original bounds', async () => {
  async function alpha() {
    const area = await page.locator('.library-content').boundingBox();
    if (!area) throw new Error('The library surface is not visible.');
    return desktop!.evaluate(async ({ BrowserWindow }, rectangle) => {
      const capture = await BrowserWindow.getAllWindows()[0].webContents.capturePage(rectangle);
      return capture.toBitmap({ scaleFactor: 1 })[3];
    }, { x: Math.round(area.x + 4), y: Math.round(area.y + 4), width: 1, height: 1 });
  }
  // DOM visibility can precede the window manager's initial placement. Capture
  // restore geometry only once the native window is mapped on a display. WSLg
  // can report focus while its initial off-screen placeholder bounds remain.
  await expect.poll(() => desktop!.evaluate(({ BrowserWindow, screen }) => {
    const window = BrowserWindow.getAllWindows()[0];
    const bounds = window.getBounds();
    return window.isVisible() && window.isFocused() && screen.getAllDisplays().some(({ workArea }) =>
      bounds.x < workArea.x + workArea.width && bounds.x + bounds.width > workArea.x
      && bounds.y < workArea.y + workArea.height && bounds.y + bounds.height > workArea.y);
  })).toBe(true);
  const originalBounds = await desktop!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getBounds());
  const expandedBounds = await desktop!.evaluate(({ BrowserWindow, screen }) => screen.getDisplayMatching(BrowserWindow.getAllWindows()[0].getBounds()).workArea);
  await page.getByRole('button', { name: 'Maximize or restore window', exact: true }).click();
  await expect.poll(() => desktop!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getBounds())).toEqual(expandedBounds);
  await page.getByRole('button', { name: 'Maximize or restore window', exact: true }).click();
  await expect.poll(() => desktop!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getBounds())).toEqual(originalBounds);
  await expect.poll(alpha).toBe(255);
  await page.getByRole('button', { name: 'Appearance', exact: true }).click();
  await page.getByRole('switch', { name: 'Transparent window', exact: true }).check();
  const slider = page.getByRole('slider');
  await slider.focus();
  await slider.press('Home');
  for (let index = 0; index < 10; index++) await slider.press('ArrowRight');
  await expect(slider).toHaveValue('35');
  await expect.poll(alpha).toBeGreaterThan(80);
  await expect.poll(alpha).toBeLessThan(100);
  await close();
  await launch();
  await expect(page.locator('.app-shell')).toHaveAttribute('data-transparent', 'true');
  await page.getByRole('button', { name: 'Appearance', exact: true }).click();
  await expect(page.getByRole('switch', { name: 'Transparent window', exact: true })).toBeChecked();
  await expect(page.getByRole('slider')).toHaveValue('35');
  await expect.poll(alpha).toBeGreaterThan(80);
  await expect.poll(alpha).toBeLessThan(100);
  expect(rendererErrors).toEqual([]);
});
