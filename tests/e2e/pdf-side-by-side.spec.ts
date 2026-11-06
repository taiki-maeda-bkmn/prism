import { electronLaunchArguments } from '../../scripts/electron-launch.mjs';
import { _electron as electron, expect, test, type ElectronApplication, type Locator, type Page } from '@playwright/test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fixturePdf } from '../fixtures/pdf';

const welcome = '\ufeff# 読書ノート\r\n\r\n資料を読みながら、気づきを書き留める。\r\n\r\n'
  + Array.from({ length: 65 }, (_, index) => `段落 ${index + 1} — 日本語の文章と PDF を並べて、考えを整理する。\r\n\r\n`).join('');
let temporary: string;
let notebook: string;
let userData: string;
let pdfProfile: string;
let desktop: ElectronApplication | undefined;
let page: Page;
let errors: string[];
let remoteRequests: string[];
const noteFile = () => path.join(notebook, 'Welcome to Prism.md');
const editor = () => page.locator('.app-body .cm-content');
const pdf = () => page.locator('.pdf-workspace');
const notesPanel = () => page.locator('.app-body');
const pdfPanel = () => page.locator('.pdf-panel');
const divider = () => page.getByRole('separator', { name: 'Resize note and PDF panes', exact: true });
const splitToggle = () => page.getByRole('button', { name: 'Read & write', exact: true });
const workspaceButton = (name: 'Notes' | 'PDFs') => page.getByRole('navigation', { name: 'Workspaces', exact: true }).getByRole('button', { name, exact: true });
const modeButton = (name: 'Source' | 'Split' | 'Live' | 'Read') => page.getByRole('group', { name: 'Editor mode', exact: true }).getByRole('button', { name, exact: true });
const viewport = () => pdf().getByLabel('PDF page viewport', { exact: true });

async function readPublishedNote() {
  try { return await readFile(noteFile(), 'utf8'); }
  catch (error) {
    // Publication can briefly remove the destination on Windows. Keep polling
    // for the exact saved bytes; persistent absence still fails the assertion.
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

async function launch() {
  const applicationRoot = path.resolve(process.env.PRISM_TEST_APP_ROOT || process.cwd());
  desktop = await electron.launch({
    executablePath: process.env.PRISM_TEST_ELECTRON,
    args: electronLaunchArguments(['--no-sandbox', applicationRoot]), cwd: applicationRoot,
    env: { ...process.env, PRISM_USER_DATA: userData, PRISM_WORKSPACE: notebook, PRISM_PDF_USER_DATA: pdfProfile },
  });
  page = await desktop.firstWindow();
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => { if (/^https?:/.test(request.url())) remoteRequests.push(request.url()); });
  await expect(page.locator('.note-heading h1')).toHaveText('読書ノート');
  await expect.poll(() => desktop!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible())).toBe(true);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await modeButton('Source').click();
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
  await expect(page.locator('.statusbar')).toContainText('1 unsaved note');
}

async function enterSplit() {
  if (await splitToggle().getAttribute('aria-pressed') !== 'true') await splitToggle().click();
  await expect(page.locator('.workspace-area')).toHaveAttribute('data-layout', 'split');
  await expect(notesPanel()).toBeVisible();
  await expect(pdfPanel()).toBeVisible();
  await expect(divider()).toBeVisible();
}

async function importPDF(name = '日本語の資料', password?: string) {
  const filename = path.join(temporary, `${name}.pdf`);
  await writeFile(filename, fixturePdf(password));
  await desktop!.evaluate(({ dialog }, filename) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [filename] });
  }, filename);
  await workspaceButton('PDFs').click();
  await pdf().getByRole('button', { name: 'Import PDFs', exact: true }).click();
  await expect(pdf().getByRole('button', { name: `Open ${name}`, exact: true })).toBeVisible();
}

async function openPDF(name = '日本語の資料', password?: string) {
  await pdf().getByRole('button', { name: `Open ${name}`, exact: true }).click();
  if (password) {
    await pdf().getByLabel('Document password', { exact: true }).fill(password);
    await pdf().getByRole('button', { name: 'Unlock PDF', exact: true }).click();
  }
  await renderedPage(1);
}

async function renderedPage(number: number) {
  const canvas = pdf().locator(`.pdf-paper canvas[data-page-number="${number}"]`);
  await expect(canvas).toBeVisible();
  await expect.poll(() => canvas.evaluate((element: HTMLCanvasElement) => {
    if (!element.isConnected || !element.width || !element.height) return 0;
    const pixels = element.getContext('2d')!.getImageData(0, 0, element.width, element.height).data;
    let colored = 0;
    for (let offset = 0; offset < pixels.length; offset += 16) {
      if (Math.max(pixels[offset], pixels[offset + 1], pixels[offset + 2]) - Math.min(pixels[offset], pixels[offset + 1], pixels[offset + 2]) > 40) colored++;
    }
    return colored;
  })).toBeGreaterThan(100);
  await expect(pdf().locator('.pdf-paper')).toHaveAttribute('aria-busy', 'false');
}

async function notesWidth() { return (await notesPanel().boundingBox())!.width; }

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

async function dragDivider(delta: number, release = true) {
  const box = await divider().boundingBox();
  if (!box) throw new Error('The workspace divider is not visible.');
  await page.mouse.move(box.x + box.width / 2, box.y + 140);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + delta, box.y + 140, { steps: 8 });
  if (release) await page.mouse.up();
}

test.beforeEach(async () => {
  temporary = await mkdtemp(path.join(os.tmpdir(), 'prism-pdf-side-by-side-'));
  notebook = path.join(temporary, 'Notebook');
  userData = path.join(temporary, 'notes-profile');
  pdfProfile = path.join(temporary, 'pdf-profile');
  errors = []; remoteRequests = [];
  await Promise.all([mkdir(notebook), mkdir(userData)]);
  await writeFile(noteFile(), welcome);
  await writeFile(path.join(notebook, 'Second.md'), '# Another thought\n\nA second local note.\n');
  await launch();
});

test.afterEach(async ({}, testInfo) => {
  if (page && !page.isClosed() && testInfo.status !== testInfo.expectedStatus) {
    const screenshot = await page.screenshot().catch(() => undefined);
    if (screenshot) await testInfo.attach('Read and write at failure', { body: screenshot, contentType: 'image/png' });
  }
  await stop();
  if (temporary) await rm(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

test('retains Japanese selection, undo and the unlocked reader across layouts and note modes with independent scrolling', async ({}, testInfo) => {
  const draft = '本を読みながら、考えをつなぐ。';
  await append(draft);
  await editor().press('Shift+Home');
  expect(await page.evaluate(() => window.getSelection()?.toString())).toBe(draft);
  const originalEditor = await editor().elementHandle();
  await importPDF('日本語の資料', 'session-secret');
  await openPDF('日本語の資料', 'session-secret');
  await pdf().getByRole('button', { name: 'Next page', exact: true }).click();
  await pdf().getByLabel('Page zoom', { exact: true }).selectOption('1.5');
  await renderedPage(2);
  const originalReader = await pdf().locator('.pdf-reader').elementHandle();
  // Open the layout and focus its newly visible editor in one browser task,
  // before the layout's scheduled focus restoration gets a painting frame.
  // The older PDF target must not override this newer Notes focus request.
  const focusAfterLayout = await page.evaluate(async () => {
    document.querySelector<HTMLButtonElement>('button[aria-label="Read & write"]')!.click();
    await Promise.resolve();
    const source = document.querySelector<HTMLElement>('.app-body .cm-content')!;
    if (source.closest('[hidden], [inert]')) throw new Error('Read & write did not expose the note editor.');
    source.focus({ preventScroll: true });
    await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    return {
      editorFocused: document.activeElement === source,
      notesActive: document.querySelector('.app-body')!.getAttribute('data-active'),
    };
  });
  expect(focusAfterLayout).toEqual({ editorFocused: true, notesActive: 'true' });
  await enterSplit();
  await workspaceButton('Notes').click();
  await editor().focus();
  await expect.poll(() => page.evaluate(() => window.getSelection()?.toString())).toBe(draft);
  expect(await editor().evaluate((element, original) => element === original, originalEditor)).toBe(true);

  for (const mode of ['Split', 'Live', 'Read', 'Source'] as const) {
    await modeButton(mode).click();
    await expect(modeButton(mode)).toHaveAttribute('aria-pressed', 'true');
    await expect(pdf().getByLabel('Page number', { exact: true })).toHaveValue('2');
    await expect(pdf().getByLabel('Page zoom', { exact: true })).toHaveValue('1.5');
    await expect(pdf().getByLabel('Document password', { exact: true })).toHaveCount(0);
    expect(await editor().evaluate((element, original) => element === original, originalEditor)).toBe(true);
    expect(await pdf().locator('.pdf-reader').evaluate((element, original) => element === original, originalReader)).toBe(true);
  }

  await editor().focus();
  await editor().press('ControlOrMeta+Home');
  const noteScroll = page.locator('.app-body .cm-scroller');
  // Moving the caret to line one can retain CodeMirror's top padding in view.
  // Establish a zero scroll baseline only after its layout measurement runs.
  await noteScroll.evaluate(element => new Promise<void>(resolve => requestAnimationFrame(() => {
    element.scrollTo(0, 0); resolve();
  })));
  await expect.poll(() => noteScroll.evaluate(element => element.scrollTop)).toBe(0);
  await viewport().evaluate(element => element.scrollTo(0, 0));
  const noteBox = await noteScroll.boundingBox();
  if (!noteBox) throw new Error('The note scroll pane is not visible.');
  await page.mouse.move(noteBox.x + noteBox.width / 2, noteBox.y + noteBox.height / 2);
  await page.mouse.wheel(0, 240);
  await expect.poll(() => noteScroll.evaluate(element => element.scrollTop)).toBeGreaterThan(100);
  expect(await viewport().evaluate(element => element.scrollTop)).toBe(0);
  const notePosition = await noteScroll.evaluate(element => element.scrollTop);
  const pdfBox = await viewport().boundingBox();
  if (!pdfBox) throw new Error('The PDF scroll pane is not visible.');
  await page.mouse.move(pdfBox.x + pdfBox.width / 2, pdfBox.y + pdfBox.height / 2);
  await page.mouse.wheel(0, 240);
  await expect.poll(() => viewport().evaluate(element => element.scrollTop)).toBeGreaterThan(100);
  expect(await noteScroll.evaluate(element => element.scrollTop)).toBe(notePosition);
  const pdfPosition = await viewport().evaluate(element => element.scrollTop);
  await dragDivider(40);
  await renderedPage(2);
  await expect.poll(() => viewport().evaluate(element => element.scrollTop)).toBeCloseTo(pdfPosition, 0);
  expect(await noteScroll.evaluate(element => element.scrollTop)).toBe(notePosition);

  await testInfo.attach('Japanese note beside the unlocked PDF', {
    body: await page.screenshot({ path: testInfo.outputPath('read-and-write.png') }), contentType: 'image/png',
  });
  await workspaceButton('PDFs').click();
  await splitToggle().click();
  await expect(notesPanel()).toBeHidden();
  await expect(pdfPanel()).toBeVisible();
  await enterSplit();
  await renderedPage(2);
  await expect(pdf().getByLabel('Page zoom', { exact: true })).toHaveValue('1.5');
  await editor().focus();
  await editor().press('ControlOrMeta+z');
  await expect(editor()).not.toContainText(draft);
  await expect(page.locator('.statusbar')).toContainText('All changes saved');
  await editor().press(process.platform === 'win32' ? 'Control+y' : 'ControlOrMeta+Shift+z');
  await expect(editor()).toContainText(draft);
  await editor().press('ControlOrMeta+s');
  await expect.poll(readPublishedNote).toBe(welcome + draft);
  expect(errors).toEqual([]);
  expect(remoteRequests).toEqual([]);
});

test('routes shortcuts by the focused pane and keeps both note and library navigation usable', async () => {
  const draft = 'ショートカットは選んだペインで動く。';
  await append(draft);
  await enterSplit();
  const filename = path.join(temporary, 'Keyboard.pdf');
  await writeFile(filename, fixturePdf());
  const pickerCalls = await desktop!.evaluateHandle(({ dialog }, filename) => {
    const calls: string[] = [];
    dialog.showOpenDialog = async (...args: unknown[]) => {
      const options = args[args.length - 1] as { title?: string; properties?: string[] };
      calls.push(options.title ?? '');
      const notebookPicker = options.properties?.includes('openDirectory') ?? false;
      return { canceled: notebookPicker, filePaths: notebookPicker ? [] : [filename] };
    };
    return calls;
  }, filename);

  await pdf().getByLabel('Search library', { exact: true }).click();
  await expect(pdfPanel()).toHaveAttribute('data-active', 'true');
  await page.keyboard.press('ControlOrMeta+o');
  await expect(pdf().getByRole('button', { name: 'Open Keyboard', exact: true })).toBeVisible();
  expect(await pickerCalls.jsonValue()).toEqual(['Add PDFs to your library']);
  await page.keyboard.press('ControlOrMeta+s');
  await page.keyboard.press('ControlOrMeta+4');
  expect(await readFile(noteFile(), 'utf8')).toBe(welcome);
  await expect(modeButton('Source')).toHaveAttribute('aria-pressed', 'true');

  await editor().focus();
  await expect(notesPanel()).toHaveAttribute('data-active', 'true');
  await page.keyboard.press('ControlOrMeta+s');
  await expect.poll(readPublishedNote).toBe(welcome + draft);
  await expect(notesPanel()).toHaveAttribute('aria-busy', 'false');
  await expect(editor()).toBeFocused();
  await page.keyboard.press('ControlOrMeta+o');
  await expect.poll(() => pickerCalls.jsonValue()).toEqual(['Add PDFs to your library', 'Open a notebook']);
  await expect(notesPanel()).toHaveAttribute('aria-busy', 'false');
  await expect(editor()).toBeFocused();
  await page.keyboard.press('ControlOrMeta+p');
  await expect(page.getByLabel('Search notes', { exact: true })).toBeFocused();
  await page.getByLabel('Search notes', { exact: true }).fill('Second');
  await page.getByRole('navigation', { name: 'Notes', exact: true }).getByRole('button', { name: 'Second', exact: true }).click();
  await expect(page.locator('.note-heading h1')).toHaveText('Another thought');
  await expect(page.getByRole('button', { name: 'Show notes', exact: true })).toBeVisible();
  await expect(pdf().getByRole('button', { name: 'Open Keyboard', exact: true })).toBeVisible();

  await page.getByRole('button', { name: 'Show notes', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Hide notes', exact: true })).toHaveAttribute('aria-expanded', 'true');
  await pdf().getByLabel('Search library', { exact: true }).click();
  await page.keyboard.press('Escape');
  await expect(pdf().getByLabel('Search library', { exact: true })).toBeFocused();
  await expect(pdfPanel()).toHaveAttribute('data-active', 'true');
  await expect(page.getByRole('button', { name: 'Hide notes', exact: true })).toHaveAttribute('aria-expanded', 'true');
  await page.getByRole('button', { name: 'Close notes navigation', exact: true }).click();

  await editor().focus();
  for (const [key, mode] of [['2', 'Split'], ['4', 'Live'], ['3', 'Read'], ['1', 'Source']] as const) {
    await page.keyboard.press(`ControlOrMeta+${key}`);
    await expect(modeButton(mode)).toHaveAttribute('aria-pressed', 'true');
    await expect(pdfPanel()).toBeVisible();
  }
  await pdf().getByRole('button', { name: 'Favorite Keyboard', exact: true }).click();
  await pdf().getByRole('button', { name: 'Library navigation', exact: true }).click();
  await expect(pdf().getByRole('button', { name: 'Library navigation', exact: true })).toHaveAttribute('aria-expanded', 'true');
  await pdf().getByRole('button', { name: 'Favorites', exact: true }).click();
  await expect(pdf().getByRole('heading', { name: 'Favorites', exact: true })).toBeVisible();
  await expect(pdf().getByRole('button', { name: 'Library navigation', exact: true })).toHaveAttribute('aria-expanded', 'false');
  await pdf().getByRole('button', { name: 'Open Keyboard', exact: true }).click();
  await renderedPage(1);
  await viewport().focus();
  await page.keyboard.press('PageDown');
  await renderedPage(2);
  await page.keyboard.press('ControlOrMeta+k');
  await expect(pdf().getByLabel('Search library', { exact: true })).toBeFocused();
  await expect(modeButton('Source')).toHaveAttribute('aria-pressed', 'true');
  expect(await readFile(noteFile(), 'utf8')).toBe(welcome + draft);
  expect(errors).toEqual([]);
});

test('resizes with mouse and keyboard, restores the split after narrow windows, and keeps large text and transparency usable', async ({}, testInfo) => {
  await importPDF();
  await openPDF();
  await enterSplit();
  const originalEditor = await editor().elementHandle();
  const initialWidth = await notesWidth();
  await divider().focus();
  await divider().press('ArrowRight');
  await expect.poll(notesWidth).toBeGreaterThan(initialWidth);
  const smallStep = await notesWidth() - initialWidth;
  await divider().press('Shift+ArrowRight');
  await expect.poll(notesWidth).toBeGreaterThan(initialWidth + smallStep * 2);
  await divider().press('Home');
  await expect.poll(notesWidth).toBeCloseTo(initialWidth, 0);
  await dragDivider(90);
  await expect.poll(notesWidth).toBeCloseTo(initialWidth + 90, 0);
  const retainedWidth = await notesWidth();
  await dragDivider(-75, false);
  await expect.poll(notesWidth).toBeLessThan(retainedWidth - 50);
  await page.keyboard.press('Escape');
  await page.mouse.up();
  await expect.poll(notesWidth).toBeCloseTo(retainedWidth, 0);
  await divider().focus();
  for (let count = 0; count < 20; count++) await divider().press('Shift+ArrowLeft');
  await expect.poll(notesWidth).toBeGreaterThanOrEqual(420);
  await expect.poll(notesWidth).toBeLessThan(430);
  expect((await pdfPanel().boundingBox())!.width).toBeGreaterThanOrEqual(420);
  await divider().press('Home');
  await dragDivider(90);

  await workspaceButton('PDFs').click();
  await page.setViewportSize({ width: 850, height: 1000 });
  await expect(page.locator('.workspace-area')).toHaveAttribute('data-layout', 'single');
  await expect(divider()).toBeHidden();
  await expect(notesPanel()).toBeHidden();
  await expect(pdfPanel()).toBeVisible();
  await expect(splitToggle()).toHaveAttribute('aria-pressed', 'true');
  await workspaceButton('Notes').click();
  await expect(notesPanel()).toBeVisible();
  await expect(pdfPanel()).toBeHidden();
  await page.setViewportSize({ width: 1440, height: 1000 });
  await expect(page.locator('.workspace-area')).toHaveAttribute('data-layout', 'split');
  await expect.poll(notesWidth).toBeCloseTo(retainedWidth, 0);
  expect(await editor().evaluate((element, original) => element === original, originalEditor)).toBe(true);
  await renderedPage(1);

  await stop();
  await launch();
  await enterSplit();
  await expect.poll(notesWidth).toBeCloseTo(retainedWidth, 0);
  await workspaceButton('PDFs').click();
  await openPDF();
  await divider().focus();
  await divider().press('Home');
  for (const theme of ['Paper', 'Sci-fi'] as const) {
    await page.getByRole('button', { name: 'Window appearance', exact: true }).click();
    const appearance = page.getByRole('dialog', { name: 'Make a little space', exact: true });
    await appearance.getByRole('radio', { name: `${theme} theme`, exact: true }).check();
    await appearance.getByRole('slider', { name: 'Text size', exact: true }).fill('150');
    if (theme === 'Sci-fi') {
      await appearance.getByRole('switch', { name: 'Transparent window', exact: true }).click();
      await appearance.getByRole('slider', { name: 'Background opacity', exact: true }).fill('35');
    }
    await appearance.getByRole('button', { name: 'Done', exact: true }).click();
    await expect(notesPanel()).toBeVisible();
    await renderedPage(1);
    for (const direction of ['ArrowLeft', 'ArrowRight'] as const) {
      await divider().focus();
      for (let count = 0; count < 20; count++) await divider().press(`Shift+${direction}`);
      const narrowPane = direction === 'ArrowLeft' ? notesPanel() : pdfPanel();
      await expect.poll(async () => (await narrowPane.boundingBox())!.width).toBeGreaterThanOrEqual(420);
      await expect.poll(async () => (await narrowPane.boundingBox())!.width).toBeLessThan(430);
      if (direction === 'ArrowLeft') {
        for (const name of ['Source', 'Split', 'Live', 'Read'] as const) await expectInsidePane(modeButton(name), notesPanel());
        await expectInsidePane(page.locator('.app-body .save-button'), notesPanel());
      } else {
        await expect(pdf()).toHaveAttribute('data-compact', 'true');
        for (const name of ['Previous page', 'Next page', 'Rotate page clockwise', 'Insert page link']) {
          await expectInsidePane(pdf().getByRole('button', { name, exact: true }), pdfPanel());
        }
        await expectInsidePane(pdf().getByLabel('Page zoom', { exact: true }), pdfPanel());
        await expectInsidePane(pdf().getByRole('button', { name: 'Library navigation', exact: true }), pdfPanel());
      }
      for (const panel of [page.locator('.workspace-area'), page.locator('.workspace-main'), pdf()]) {
        expect(await panel.evaluate(element => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1);
      }
    }
    await divider().press('Home');
    await renderedPage(1);
  }
  const paper = await pdf().locator('.pdf-paper').boundingBox();
  const background = await pdf().locator('.pdf-reader-heading').boundingBox();
  if (!paper || !background) throw new Error('The split PDF reader is not visible.');
  const alpha = (x: number, y: number) => desktop!.evaluate(async ({ BrowserWindow }, point) => {
    const image = await BrowserWindow.getAllWindows()[0].webContents.capturePage({ ...point, width: 1, height: 1 });
    return image.toBitmap({ scaleFactor: 1 })[3];
  }, { x: Math.round(x), y: Math.round(y) });
  await expect.poll(() => alpha(background.x + 4, background.y + 4)).toBeGreaterThan(80);
  await expect.poll(() => alpha(background.x + 4, background.y + 4)).toBeLessThan(100);
  expect(await alpha(paper.x + 20, paper.y + 20)).toBe(255);
  await testInfo.attach('Read and write at 150% with transparency', {
    body: await page.screenshot({ path: testInfo.outputPath('read-and-write-large-transparent.png') }), contentType: 'image/png',
  });
  expect(await readFile(noteFile(), 'utf8')).toBe(welcome);
  expect(errors).toEqual([]);
});

test('keeps writing usable beside a password prompt and saves the split draft through native close and restart', async () => {
  await enterSplit();
  await importPDF('Protected', 'close-secret');
  await pdf().getByRole('button', { name: 'Open Protected', exact: true }).click();
  await expect(pdf().getByLabel('Document password', { exact: true })).toBeVisible();
  const draft = '未解除の PDF の横でも、この文章は保存できる。';
  await append(draft);
  await expect(editor()).toBeFocused();
  await expect(pdf().getByLabel('Document password', { exact: true })).toHaveValue('');
  // A pending reader password must not capture typing intended for the visible
  // library search when focus moves from the note to another PDF control.
  await pdf().getByLabel('Search library', { exact: true }).click();
  await expect(pdf().getByLabel('Search library', { exact: true })).toBeFocused();
  await page.keyboard.insertText('Protected');
  await expect(pdf().getByLabel('Search library', { exact: true })).toHaveValue('Protected');
  await expect(pdf().getByLabel('Document password', { exact: true })).toHaveCount(0);
  await pdf().getByRole('button', { name: 'Open Protected', exact: true }).click();
  await expect(pdf().getByLabel('Document password', { exact: true })).toHaveValue('');
  await pdf().getByLabel('Document password', { exact: true }).fill('close-secret');
  await pdf().getByRole('button', { name: 'Unlock PDF', exact: true }).click();
  await renderedPage(1);
  await pdf().getByRole('button', { name: 'Next page', exact: true }).click();
  await renderedPage(2);
  await page.getByRole('button', { name: 'Close window', exact: true }).click();
  const prompt = page.getByRole('dialog', { name: 'Keep your latest thoughts?', exact: true });
  await expect(prompt).toBeVisible();
  await prompt.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(prompt).toHaveCount(0);
  await expect(editor()).toContainText(draft);
  await renderedPage(2);
  expect(await readFile(noteFile(), 'utf8')).toBe(welcome);
  await page.getByRole('button', { name: 'Close window', exact: true }).click();
  await expect(prompt).toBeVisible();
  const closed = desktop!.waitForEvent('close');
  const [click, quit] = await Promise.allSettled([
    prompt.getByRole('button', { name: 'Save & continue', exact: true }).click(), closed,
  ]);
  if (quit.status === 'rejected') throw quit.reason;
  if (click.status === 'rejected' && !(click.reason instanceof Error && /Target page, context or browser has been closed/.test(click.reason.message))) throw click.reason;
  desktop = undefined;
  expect(await readFile(noteFile(), 'utf8')).toBe(welcome + draft);
  await launch();
  await editor().focus();
  await editor().press('ControlOrMeta+End');
  await expect(editor()).toContainText(draft);
  await enterSplit();
  await pdf().getByRole('button', { name: 'Open Protected', exact: true }).click();
  await expect(pdf().getByLabel('Document password', { exact: true })).toHaveValue('');
  await pdf().getByLabel('Document password', { exact: true }).fill('close-secret');
  await pdf().getByRole('button', { name: 'Unlock PDF', exact: true }).click();
  await renderedPage(2);
  expect(await page.evaluate(() => JSON.stringify(localStorage))).not.toContain('close-secret');
  expect(errors).toEqual([]);
  expect(remoteRequests).toEqual([]);
});
