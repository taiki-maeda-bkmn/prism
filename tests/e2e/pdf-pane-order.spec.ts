import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { electronLaunchArguments } from '../../scripts/electron-launch.mjs';
import { fixturePdf } from '../fixtures/pdf';

const original = '\ufeff# 読書ノート\r\n\r\n'
  + Array.from({ length: 45 }, (_, index) => `段落 ${index + 1} — 資料と考えを並べて書き留める。\r\n\r\n`).join('');
let temporary: string, notebook: string, profile: string, pdfProfile: string;
let desktop: ElectronApplication | undefined, page: Page;
let errors: string[];
const noteFile = () => path.join(notebook, 'Reading.md');
const area = () => page.locator('.workspace-area');
const notes = () => page.locator('#notes-workspace');
const pdfs = () => page.locator('#pdfs-workspace');
const editor = () => notes().locator('.cm-content');
const pdf = () => pdfs().locator('.pdf-workspace');
const divider = () => page.getByRole('separator', { name: 'Resize note and PDF panes', exact: true });
const split = () => page.getByRole('button', { name: 'Read & write', exact: true });
const swap = () => page.getByRole('button', { name: 'Swap PDF and Markdown panes', exact: true });
const workspace = (name: 'Notes' | 'PDFs') => page.getByRole('navigation', { name: 'Workspaces', exact: true }).getByRole('button', { name, exact: true });
const notesWidth = async () => (await notes().boundingBox())!.width;

async function launch() {
  desktop = await electron.launch({ args: electronLaunchArguments(['--no-sandbox', '.']), cwd: process.cwd(),
    env: { ...process.env, PRISM_USER_DATA: profile, PRISM_WORKSPACE: notebook, PRISM_PDF_USER_DATA: pdfProfile } });
  page = await desktop.firstWindow();
  page.on('pageerror', error => errors.push(error.message));
  await expect(page.locator('.note-heading h1')).toHaveText('読書ノート');
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.getByRole('group', { name: 'Editor mode', exact: true }).getByRole('button', { name: 'Source', exact: true }).click();
}
async function stop() {
  if (!desktop) return;
  const current = desktop, child = current.process();
  const closed = current.waitForEvent('close', { timeout: 5000 }).catch(() => undefined);
  await current.evaluate(({ app }) => app.exit(0)).catch(() => undefined);
  await closed;
  if (child.exitCode === null) child.kill();
  desktop = undefined;
}
async function enterSplit() {
  if (await split().getAttribute('aria-pressed') !== 'true') await split().click();
  await expect(area()).toHaveAttribute('data-layout', 'split');
  await expect(notes()).toBeVisible(); await expect(pdfs()).toBeVisible();
}
async function expectOrder(side: 'left' | 'right') {
  await expect(area()).toHaveAttribute('data-notes-side', side);
  expect(await area().evaluate(element => [...element.children].map(child => child.id || 'divider')))
    .toEqual(side === 'left' ? ['notes-workspace', 'divider', 'pdfs-workspace'] : ['pdfs-workspace', 'divider', 'notes-workspace']);
  await expect.poll(async () => {
    const note = await notes().boundingBox(), pdf = await pdfs().boundingBox(), bar = await divider().boundingBox();
    if (!note || !pdf || !bar) return false;
    const left = side === 'left' ? note : pdf, right = side === 'left' ? pdf : note;
    return left.x + left.width <= bar.x + 1 && bar.x + bar.width <= right.x + 1;
  }).toBe(true);
}
async function renderedPage(number: number) {
  await expect(pdf().locator(`.pdf-paper canvas[data-page-number="${number}"]`)).toBeVisible();
  await expect(pdf().locator('.pdf-paper')).toHaveAttribute('aria-busy', 'false');
}
async function dragDivider(delta: number, release = true) {
  const bounds = await divider().boundingBox();
  if (!bounds) throw new Error('The divider is not visible.');
  await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + 140);
  await page.mouse.down();
  await page.mouse.move(bounds.x + bounds.width / 2 + delta, bounds.y + 140, { steps: 8 });
  if (release) await page.mouse.up();
}

test.beforeEach(async () => {
  temporary = await mkdtemp(path.join(os.tmpdir(), 'prism-pane-order-'));
  notebook = path.join(temporary, 'Notebook'); profile = path.join(temporary, 'notes-profile'); pdfProfile = path.join(temporary, 'pdf-profile');
  errors = [];
  await mkdir(notebook); await writeFile(noteFile(), original);
  await launch();
});
test.afterEach(async ({}, testInfo) => {
  if (page && !page.isClosed() && testInfo.status !== testInfo.expectedStatus) {
    const screenshot = await page.screenshot().catch(() => undefined);
    if (screenshot) await testInfo.attach('Pane order at failure', { body: screenshot, contentType: 'image/png' });
  }
  await stop(); await rm(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

test('swaps live panes without losing Japanese drafts, selection, undo or the unlocked reader', async ({}, testInfo) => {
  const draft = '左右を入れ替えても、書きかけの考えを保つ。';
  await editor().focus(); await editor().press('ControlOrMeta+End'); await page.keyboard.insertText(draft);
  await editor().press('Shift+Home');
  expect(await page.evaluate(() => window.getSelection()?.toString())).toBe(draft);
  const originalEditor = await editor().elementHandle();
  const filename = path.join(temporary, '参考資料.pdf');
  const bytes = fixturePdf('pane-secret'); await writeFile(filename, bytes);
  await desktop!.evaluate(({ dialog }, filename) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [filename] });
  }, filename);
  await workspace('PDFs').click();
  await pdf().getByRole('button', { name: 'Import PDFs', exact: true }).click();
  await pdf().getByRole('button', { name: 'Open 参考資料', exact: true }).click();
  await pdf().getByLabel('Document password', { exact: true }).fill('pane-secret');
  await pdf().getByRole('button', { name: 'Unlock PDF', exact: true }).click();
  await renderedPage(1);
  await pdf().getByRole('button', { name: 'Next page', exact: true }).click();
  await pdf().getByLabel('Page zoom', { exact: true }).selectOption('1.5'); await renderedPage(2);
  const originalReader = await pdf().locator('.pdf-reader').elementHandle();
  await enterSplit(); await expectOrder('left');
  await dragDivider(80);
  const width = await notesWidth();
  const viewport = pdf().getByLabel('PDF page viewport', { exact: true });
  await viewport.evaluate(element => element.scrollTo(0, 150));
  const scroll = await viewport.evaluate(element => element.scrollTop);

  for (const side of ['right', 'left', 'right'] as const) {
    const noteScroller = notes().locator('.cm-scroller');
    const noteScroll = await noteScroller.evaluate(element => element.scrollTop);
    await swap().click(); await expectOrder(side);
    await expect.poll(notesWidth).toBeCloseTo(width, 0);
    expect(await editor().evaluate((element, previous) => element === previous, originalEditor)).toBe(true);
    expect(await pdf().locator('.pdf-reader').evaluate((element, previous) => element === previous, originalReader)).toBe(true);
    await expect(pdf().getByLabel('Page number', { exact: true })).toHaveValue('2');
    await expect(pdf().getByLabel('Page zoom', { exact: true })).toHaveValue('1.5');
    await expect(pdf().getByLabel('Document password', { exact: true })).toHaveCount(0);
    await expect.poll(() => viewport.evaluate(element => element.scrollTop)).toBeCloseTo(scroll, 0);
    await expect.poll(() => noteScroller.evaluate(element => element.scrollTop)).toBeCloseTo(noteScroll, 0);
    await expect(swap()).toBeFocused();
    await editor().focus();
    await expect.poll(() => page.evaluate(() => window.getSelection()?.toString())).toBe(draft);
  }
  await testInfo.attach('PDF on the left, Japanese writing on the right', {
    body: await page.screenshot({ path: testInfo.outputPath('pdf-left-markdown-right.png') }), contentType: 'image/png',
  });
  await editor().press('ControlOrMeta+z'); await expect(editor()).not.toContainText(draft);
  await editor().press('ControlOrMeta+Shift+z'); await expect(editor()).toContainText(draft);
  await viewport.focus(); await page.keyboard.press('PageUp'); await renderedPage(1);
  await expect(editor()).toContainText(draft);
  expect(await readFile(noteFile(), 'utf8')).toBe(original);
  expect(await readFile(filename)).toEqual(bytes);
  expect(errors).toEqual([]);
});

test('swap and window controls remain reachable with large text and narrow fallback', async ({}, testInfo) => {
  await enterSplit();
  for (const theme of ['Prism', 'Paper', 'Sci-fi']) {
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.getByRole('button', { name: 'Window appearance', exact: true }).click();
    const appearance = page.getByRole('dialog', { name: 'Make a little space', exact: true });
    await appearance.getByRole('radio', { name: `${theme} theme`, exact: true }).check();
    await appearance.getByRole('slider', { name: 'Text size', exact: true }).fill('150');
    await appearance.getByRole('button', { name: 'Done', exact: true }).click();
    for (const width of [960, 420]) {
      await page.setViewportSize({ width, height: 900 });
      for (const control of [swap(), split(), workspace('Notes'), workspace('PDFs'), page.getByRole('button', { name: 'Close window', exact: true })]) {
        const bounds = await control.boundingBox();
        expect(bounds).not.toBeNull();
        expect(bounds!.x).toBeGreaterThanOrEqual(0);
        expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width);
        expect(bounds!.height).toBeLessThanOrEqual(42);
      }
      await swap().click();
      await expect(swap()).toBeFocused();
    }
    await testInfo.attach(`Compact swapped controls in ${theme}`, {
      body: await page.screenshot({ path: testInfo.outputPath(`compact-swap-${theme}.png`) }), contentType: 'image/png',
    });
  }
  expect(errors).toEqual([]);
});

test('reversed resize follows pointer and arrow directions and keeps order and proportions after fallback and restart', async () => {
  await enterSplit(); await swap().click(); await expectOrder('right');
  const initialWidth = await notesWidth();
  const initialDivider = (await divider().boundingBox())!.x;
  await divider().focus(); await divider().press('ArrowRight');
  await expect.poll(notesWidth).toBeCloseTo(initialWidth - 10, 0);
  expect((await divider().boundingBox())!.x).toBeCloseTo(initialDivider + 10, 0);
  await divider().press('Shift+ArrowLeft');
  await expect.poll(notesWidth).toBeCloseTo(initialWidth + 30, 0);
  await divider().press('Home'); await expect.poll(notesWidth).toBeCloseTo(initialWidth, 0);
  await dragDivider(90); await expect.poll(notesWidth).toBeCloseTo(initialWidth - 90, 0);
  const retainedWidth = await notesWidth();
  await dragDivider(-60, false); await expect.poll(notesWidth).toBeCloseTo(retainedWidth + 60, 0);
  await page.keyboard.press('Escape'); await page.mouse.up();
  await expect.poll(notesWidth).toBeCloseTo(retainedWidth, 0);
  await expect(area()).toHaveAttribute('data-resizing', 'false');
  const availableWidth = await area().evaluate(element => element.clientWidth - 10);
  await expect.poll(() => page.evaluate(() => Number(localStorage.getItem('prism.workspace-split'))))
    .toBeCloseTo(retainedWidth / availableWidth, 4);

  await workspace('PDFs').click(); await page.setViewportSize({ width: 850, height: 1000 });
  await expect(area()).toHaveAttribute('data-layout', 'single');
  await expect(notes()).toBeHidden(); await expect(pdfs()).toBeVisible();
  await expect(split()).toHaveAttribute('aria-pressed', 'true');
  await workspace('Notes').click(); await expect(notes()).toBeVisible(); await expect(pdfs()).toBeHidden();
  await page.setViewportSize({ width: 1440, height: 1000 });
  await expectOrder('right'); await expect.poll(notesWidth).toBeCloseTo(retainedWidth, 0);
  await split().click(); await expect(swap()).toHaveCount(0);
  await enterSplit(); await expectOrder('right');
  await stop(); await launch();
  await expect(split()).toHaveAttribute('aria-pressed', 'false');
  await expect(swap()).toHaveCount(0);
  await enterSplit(); await expectOrder('right');
  await expect.poll(notesWidth).toBeCloseTo(retainedWidth, 0);
  await swap().focus(); await swap().press('Enter'); await expectOrder('left');
  await expect.poll(notesWidth).toBeCloseTo(retainedWidth, 0);
  expect(await readFile(noteFile(), 'utf8')).toBe(original);
  expect(errors).toEqual([]);
});
