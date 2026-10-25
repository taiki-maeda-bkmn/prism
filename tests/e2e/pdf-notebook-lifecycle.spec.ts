import { electronLaunchArguments } from '../../scripts/electron-launch.mjs';
import { _electron as electron, expect, test, type ElectronApplication, type ElementHandle, type Page } from '@playwright/test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fixturePdf } from '../fixtures/pdf';

const original = '# Working note\n\nOriginal notebook text.\n';
const draft = '# Working note\n\nAn unsaved thought beside the reader.\n';
const external = '# Working note\n\nAn external revision to reload.\n';
let temporary: string;
let notebook: string;
let nextNotebook: string;
let desktop: ElectronApplication | undefined;
let page: Page;
let errors: string[];
let readerCanvas: ElementHandle<SVGElement | HTMLElement>;

const editor = () => page.getByLabel('Markdown source', { exact: true });
const pdf = () => page.locator('.pdf-workspace');
const prompt = () => page.getByRole('dialog', { name: 'Keep your latest thoughts?', exact: true });
const noteFile = (directory = notebook) => path.join(directory, 'Welcome to Prism.md');
const workspaceButton = (name: 'Notes' | 'PDFs') => page.getByRole('navigation', { name: 'Workspaces', exact: true }).getByRole('button', { name, exact: true });

async function replaceSource(value: string) {
  await editor().focus();
  await editor().press('ControlOrMeta+A');
  await page.keyboard.insertText(value);
}

async function expectReaderRetained() {
  await workspaceButton('PDFs').click();
  await expect(pdf().getByLabel('Document password', { exact: true })).toHaveCount(0);
  await expect(pdf().getByLabel('Page number', { exact: true })).toHaveValue('2');
  const canvas = pdf().locator('.pdf-paper canvas[data-page-number="2"]');
  await expect(canvas).toBeVisible();
  expect(await canvas.evaluate((element, originalCanvas) => element === originalCanvas, readerCanvas)).toBe(true);
  await expect.poll(() => canvas.evaluate((element: HTMLCanvasElement) => {
    const pixels = element.getContext('2d')!.getImageData(0, 0, element.width, element.height).data;
    let colored = 0;
    for (let offset = 0; offset < pixels.length; offset += 16) {
      if (Math.max(pixels[offset], pixels[offset + 1], pixels[offset + 2]) - Math.min(pixels[offset], pixels[offset + 1], pixels[offset + 2]) > 40) colored++;
    }
    return colored;
  })).toBeGreaterThan(100);
  await workspaceButton('Notes').click();
}

async function cancelIntent(button: 'Refresh notebook' | 'Open notebook') {
  await replaceSource(draft);
  await expect(page.locator('.statusbar')).toContainText('1 unsaved note');
  await expectReaderRetained();
  await page.getByRole('button', { name: button, exact: true }).click();
  await expect(prompt()).toBeVisible();
  await prompt().getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(prompt()).toHaveCount(0);
  await expect(editor()).toContainText('An unsaved thought beside the reader.');
  expect(await readFile(noteFile(), 'utf8')).toBe(original);
  await editor().focus();
  await editor().press('ControlOrMeta+z');
  await expect(editor()).toContainText('Original notebook text.');
  await expect(page.locator('.statusbar')).toContainText('All changes saved');
  await editor().press('ControlOrMeta+Shift+z');
  await expect(editor()).toContainText('An unsaved thought beside the reader.');
  await expect(page.locator('.statusbar')).toContainText('1 unsaved note');
  await expectReaderRetained();
}

async function expectEmptyUndo(expectedParagraph: string) {
  await editor().focus();
  await editor().press('ControlOrMeta+z');
  await expect(editor()).toContainText(expectedParagraph);
  await expect(page.locator('.statusbar')).toContainText('All changes saved');
  await editor().press('ControlOrMeta+Shift+z');
  await expect(editor()).toContainText(expectedParagraph);
  await expect(page.locator('.statusbar')).toContainText('All changes saved');
}

test.beforeEach(async () => {
  temporary = await mkdtemp(path.join(os.tmpdir(), 'prism-pdf-notebook-lifecycle-'));
  notebook = path.join(temporary, 'First notebook');
  nextNotebook = path.join(temporary, 'Second notebook');
  const userData = path.join(temporary, 'notes-profile');
  const pdfProfile = path.join(temporary, 'pdf-profile');
  errors = [];
  await Promise.all([mkdir(notebook), mkdir(nextNotebook), mkdir(userData)]);
  await writeFile(noteFile(), original);
  desktop = await electron.launch({
    args: electronLaunchArguments(['--no-sandbox', '.']), cwd: process.cwd(),
    env: { ...process.env, PRISM_USER_DATA: userData, PRISM_WORKSPACE: notebook, PRISM_PDF_USER_DATA: pdfProfile },
  });
  page = await desktop.firstWindow();
  page.on('pageerror', error => errors.push(error.message));
  await expect(page.locator('.note-heading h1')).toHaveText('Working note');
  await page.getByRole('group', { name: 'Editor mode', exact: true }).getByRole('button', { name: 'Source', exact: true }).click();
  const source = path.join(temporary, 'Companion.pdf');
  await writeFile(source, fixturePdf('session-only-secret'));
  await desktop.evaluate(({ dialog }, filename) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [filename] });
  }, source);
  await workspaceButton('PDFs').click();
  await pdf().getByRole('button', { name: 'Import PDFs', exact: true }).click();
  await pdf().getByRole('button', { name: 'Open Companion', exact: true }).click();
  await pdf().getByLabel('Document password', { exact: true }).fill('session-only-secret');
  await pdf().getByRole('button', { name: 'Unlock PDF', exact: true }).click();
  await expect(pdf().locator('.pdf-paper canvas[data-page-number="1"]')).toBeVisible();
  await pdf().getByRole('button', { name: 'Next page', exact: true }).click();
  const canvas = pdf().locator('.pdf-paper canvas[data-page-number="2"]');
  await expect(canvas).toBeVisible();
  readerCanvas = (await canvas.elementHandle())!;
  await workspaceButton('Notes').click();
});

test.afterEach(async ({}, testInfo) => {
  if (page && !page.isClosed() && testInfo.status !== testInfo.expectedStatus) {
    const screenshot = await page.screenshot().catch(() => undefined);
    if (screenshot) await testInfo.attach('Notebook lifecycle at failure', { body: screenshot, contentType: 'image/png' });
  }
  if (desktop) {
    const child = desktop.process();
    const closed = desktop.waitForEvent('close', { timeout: 5_000 }).catch(() => undefined);
    await desktop.evaluate(({ app }) => app.exit(0)).catch(() => undefined);
    await closed;
    if (child.exitCode === null) child.kill();
    desktop = undefined;
  }
  if (temporary) await rm(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

for (const action of ['Save & continue', 'Discard changes'] as const) {
  test(`refresh protects the draft and retains the reader through Cancel and ${action}`, async () => {
    await cancelIntent('Refresh notebook');
    if (action === 'Discard changes') await writeFile(noteFile(), external);
    await page.getByRole('button', { name: 'Refresh notebook', exact: true }).click();
    await expect(prompt()).toContainText('reloading from disk');
    await prompt().getByRole('button', { name: action, exact: true }).click();
    await expect(prompt()).toHaveCount(0);
    const expected = action === 'Save & continue' ? draft : external;
    const paragraph = action === 'Save & continue' ? 'An unsaved thought beside the reader.' : 'An external revision to reload.';
    await expect(editor()).toContainText(paragraph);
    await expect(page.locator('.statusbar')).toContainText('All changes saved');
    expect(await readFile(noteFile(), 'utf8')).toBe(expected);
    await expectEmptyUndo(paragraph);
    await expectReaderRetained();
    expect(errors).toEqual([]);
  });

  test(`notebook replacement protects the draft and retains the reader through Cancel and ${action}`, async () => {
    const nextContent = action === 'Save & continue' ? draft : original;
    // Matching paths/content catch accidental reuse of the previous notebook's
    // CodeMirror history even when the new note looks exactly the same.
    await writeFile(noteFile(nextNotebook), nextContent);
    await desktop!.evaluate(({ dialog }, directory) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [directory] });
    }, nextNotebook);
    await cancelIntent('Open notebook');
    await expect(page.locator('.workspace-switch strong')).toHaveText('First notebook');
    await page.getByRole('button', { name: 'Open notebook', exact: true }).click();
    await expect(prompt()).toContainText('opening another notebook');
    await prompt().getByRole('button', { name: action, exact: true }).click();
    await expect(prompt()).toHaveCount(0);
    await expect(page.locator('.workspace-switch strong')).toHaveText('Second notebook');
    await expect(page.locator('.statusbar')).toContainText('All changes saved');
    expect(await readFile(noteFile(), 'utf8')).toBe(action === 'Save & continue' ? draft : original);
    expect(await readFile(noteFile(nextNotebook), 'utf8')).toBe(nextContent);
    await expectEmptyUndo(action === 'Save & continue' ? 'An unsaved thought beside the reader.' : 'Original notebook text.');
    await expectReaderRetained();
    expect(errors).toEqual([]);
  });
}
