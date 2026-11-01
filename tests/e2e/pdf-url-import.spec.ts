import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { electronLaunchArguments } from '../../scripts/electron-launch.mjs';
import { installURLFixture, releaseURLFixture } from '../fixtures/pdf-url';
import type { PDFDocument } from '../../pdf-manager/src/shared/types';

let temporary: string, notebook: string, profile: string;
let desktop: ElectronApplication | undefined, page: Page;
let errors: string[], remote: string[];
const original = '\ufeff# Welcome to Prism\r\n\r\nResearch notes.\r\n';
const draft = '約定についての未保存メモ。';
const modal = () => page.getByRole('dialog', { name: 'Import from URL', exact: true });
const workspace = (name: 'Notes' | 'PDFs') => page.getByRole('navigation', { name: 'Workspaces', exact: true }).getByRole('button', { name, exact: true });
const editor = () => page.locator('.app-body .cm-content');
const catalog = async (): Promise<PDFDocument[]> => {
  try { return (JSON.parse(await readFile(path.join(profile, 'library/catalog.json'), 'utf8')) as { documents: PDFDocument[] }).documents; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
};

async function launch() {
  desktop = await electron.launch({ args: electronLaunchArguments(['--no-sandbox', '.']), cwd: process.cwd(),
    env: { ...process.env, PRISM_USER_DATA: path.join(temporary, 'notes-profile'), PRISM_WORKSPACE: notebook, PRISM_PDF_USER_DATA: profile } });
  page = await desktop.firstWindow();
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => { if (/^https?:/.test(request.url())) remote.push(request.url()); });
  await expect(page.locator('.note-heading h1')).toBeVisible();
  await page.setViewportSize({ width: 1440, height: 1000 });
  await installURLFixture(desktop);
}
async function stop() {
  const application = desktop;
  if (!application) return;
  const child = application.process();
  const closed = application.waitForEvent('close', { timeout: 5000 }).catch(() => undefined);
  await application.evaluate(({ app }) => app.exit(0)).catch(() => undefined);
  await closed;
  if (child.exitCode === null) child.kill();
  desktop = undefined;
}
async function open() {
  await workspace('PDFs').click();
  const back = page.getByRole('button', { name: 'Back to library', exact: true });
  if (await back.isVisible()) await back.click();
  await page.getByRole('button', { name: 'Import from URL', exact: true }).click();
  await expect(modal().getByRole('textbox', { name: 'PDF URL' })).toBeEnabled();
}
async function download(route: string) {
  await modal().getByRole('textbox', { name: 'PDF URL' }).fill(route.startsWith('http') ? route : `https://papers.example.org${route}`);
  await modal().getByRole('button', { name: 'Download PDF', exact: true }).click();
}
async function addDraft() {
  await page.getByRole('group', { name: 'Editor mode', exact: true }).getByRole('button', { name: 'Source', exact: true }).click();
  await editor().click(); await editor().press('ControlOrMeta+End'); await editor().press('End'); await editor().pressSequentially(draft);
}
test.beforeEach(async () => {
  errors = []; remote = [];
  temporary = await mkdtemp(path.join(os.tmpdir(), 'prism-url-native-'));
  notebook = path.join(temporary, 'notebook'); profile = path.join(temporary, 'pdf-profile');
  await mkdir(notebook); await writeFile(path.join(notebook, 'Welcome to Prism.md'), original);
  await launch();
});
test.afterEach(async () => { await stop(); await rm(temporary, { recursive: true, force: true }); });

test('redirect download renders locally, preserves drafts and duplicates, and survives restart', async () => {
  await addDraft(); await open(); await download('/redirect');
  await expect(modal().getByRole('progressbar', { name: 'Download progress' })).toHaveAttribute('value', /[1-9]/);
  await expect(modal()).toContainText('64 B');
  await releaseURLFixture(desktop!);
  await expect(modal()).toContainText('PDF added to your library');
  const imported = (await catalog())[0];
  expect(imported.filename).toBe('約定資料.pdf');
  await modal().getByRole('button', { name: 'Open PDF', exact: true }).click();
  await expect(page.locator('.pdf-paper canvas[data-page-number="1"]')).toBeVisible();
  await workspace('Notes').click();
  await expect(editor()).toContainText(draft);
  await editor().press('ControlOrMeta+z'); await expect(editor()).not.toContainText(draft);
  expect(await readFile(path.join(notebook, 'Welcome to Prism.md'), 'utf8')).toBe(original);
  await page.evaluate(async id => { await window.prismPdf.updateDocument(id, { title: 'My saved title', tags: ['Execution'], favorite: true, pageCount: 2, lastPage: 2 }); }, imported.id);
  await open(); await download('/duplicate.pdf');
  await expect(modal()).toContainText('Already in your library');
  expect(await catalog()).toHaveLength(1);
  expect((await catalog())[0]).toMatchObject({ id: imported.id, title: 'My saved title', tags: ['Execution'], favorite: true, lastPage: 2 });
  await modal().getByRole('button', { name: 'Close URL import' }).click();
  await page.getByRole('button', { name: 'Import from URL', exact: true }).click();
  await expect(modal().getByRole('textbox', { name: 'PDF URL' })).toHaveValue('');
  await expect(modal().getByText('Already in your library')).toHaveCount(0);
  await modal().getByRole('button', { name: 'Close URL import' }).click();
  const closed = desktop!.waitForEvent('close');
  await desktop!.evaluate(({ app }) => app.quit()); await closed; desktop = undefined;
  await launch(); await workspace('PDFs').click();
  await page.getByRole('button', { name: 'Open My saved title', exact: true }).click();
  await expect(page.locator('.pdf-paper canvas[data-page-number="2"]')).toBeVisible();
  expect(errors).toEqual([]); expect(remote).toEqual([]);
});

test('unknown-size progress, cancellation, immediate retry, and public-PDF errors do not add partial files', async () => {
  await open(); await download('/unknown');
  await expect(modal()).toContainText('64 B downloaded');
  await expect(modal().getByRole('progressbar')).not.toHaveAttribute('value');
  await modal().getByRole('button', { name: 'Cancel download' }).click();
  await expect(modal()).toContainText('Download cancelled');
  expect(await catalog()).toHaveLength(0);
  expect(await readdir(path.join(profile, 'library/documents'))).toEqual([]);
  await download('/unknown'); await expect(modal()).toContainText('64 B downloaded');
  await modal().press('Escape'); await expect(modal()).toHaveCount(0);
  expect((await page.evaluate(() => window.prismPdf.getURLImport()))?.phase).toBe('cancelled');
  await open();
  for (const [route, message] of [
    ['http://papers.example.org/pdf', 'Enter a public HTTPS'],
    ['https://private.example.org/pdf', 'Only public websites'],
    ['/html', 'did not return a PDF'], ['/login', 'requires sign-in'], ['/huge', '100 MB'],
  ]) {
    await download(route); await expect(modal().getByRole('alert')).toContainText(message);
  }
  expect(await catalog()).toHaveLength(0);
  await download('/success.pdf'); await expect(modal()).toContainText('PDF added to your library');
  expect(await catalog()).toHaveLength(1);
  expect(errors).toEqual([]); expect(remote).toEqual([]);
});

test('renderer reload resumes progress and accepted dirty close cancels while Cancel keeps downloading', async () => {
  await open(); await download('/unknown'); await expect(modal()).toContainText('64 B downloaded');
  await page.reload(); await expect(page.locator('.note-heading h1')).toBeVisible();
  await addDraft();
  await workspace('PDFs').click();
  await page.getByRole('button', { name: 'Import from URL', exact: true }).click();
  await expect(modal()).toContainText('64 B downloaded');
  await page.evaluate(() => window.prism.windowControl('close'));
  const prompt = page.getByRole('dialog', { name: 'Keep your latest thoughts?', exact: true });
  await expect(prompt).toBeVisible(); await prompt.getByRole('button', { name: 'Cancel', exact: true }).click();
  expect((await page.evaluate(() => window.prismPdf.getURLImport()))?.phase).toBe('downloading');
  await page.evaluate(() => window.prism.windowControl('close'));
  await expect(prompt).toBeVisible();
  const closed = desktop!.waitForEvent('close');
  await prompt.getByRole('button', { name: 'Save & continue', exact: true }).click();
  await closed; desktop = undefined;
  expect(await catalog()).toHaveLength(0);
  expect(await readdir(path.join(profile, 'library/documents'))).toEqual([]);
  expect(await readFile(path.join(notebook, 'Welcome to Prism.md'), 'utf8')).toContain(draft);
  await launch(); await open(); await download('/success.pdf');
  await expect(modal()).toContainText('PDF added to your library');
  expect(errors).toEqual([]); expect(remote).toEqual([]);
});

test('URL dialog remains usable in narrow panes with large text', async ({}, testInfo) => {
  for (const theme of ['Prism', 'Paper', 'Sci-fi']) {
    await page.setViewportSize({ width: 1440, height: 1000 });
    await workspace('Notes').click();
    await page.getByRole('button', { name: 'Window appearance', exact: true }).click();
    const appearance = page.getByRole('dialog', { name: 'Make a little space', exact: true });
    await appearance.getByRole('radio', { name: `${theme} theme`, exact: true }).check();
    await appearance.getByRole('slider', { name: 'Text size', exact: true }).fill('150');
    await appearance.getByRole('button', { name: 'Done', exact: true }).click();
    await page.setViewportSize({ width: 420, height: 850 });
    await open(); await download('/html');
    await expect(modal().getByRole('alert')).toContainText('did not return a PDF');
    expect(await modal().evaluate(dialog => dialog.scrollWidth <= dialog.clientWidth + 1)).toBe(true);
    await download('/success.pdf');
    await expect(modal()).toContainText(theme === 'Prism' ? 'PDF added to your library' : 'Already in your library');
    expect(await modal().evaluate(dialog => dialog.scrollWidth <= dialog.clientWidth + 1)).toBe(true);
    await testInfo.attach(`URL import at 150 percent in ${theme}`, {
      body: await page.screenshot({ path: testInfo.outputPath(`url-import-${theme}.png`) }), contentType: 'image/png',
    });
    await modal().getByRole('button', { name: 'Open PDF', exact: true }).click();
    await expect(page.locator('.pdf-paper canvas')).toBeVisible();
  }
  expect(errors).toEqual([]);
});
