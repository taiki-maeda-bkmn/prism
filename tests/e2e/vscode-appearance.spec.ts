import { electronLaunchArguments } from '../../scripts/electron-launch.mjs';
import { _electron as electron, expect, test, type ElectronApplication, type Locator, type Page } from '@playwright/test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fixturePdf } from '../fixtures/pdf';

const original = '\ufeff# Appearance notebook\r\n\r\n色を変えても、日本語の下書きを保持する。\r\n';
const draft = '追記：テーマの読み込み前に書いた内容。';
const imported = { accent: '#48a0c7', background: '#121314', text: '#bbbebf' };
let temporary: string;
let notebook: string;
let userData: string;
let noteFile: string;
let themeFile: string;
let desktop: ElectronApplication | undefined;
let page: Page;
let errors: string[];

const editor = () => page.locator('.app-body .cm-content');
const appearance = () => page.getByRole('dialog', { name: 'Make a little space', exact: true });
const importer = () => appearance().getByRole('group', { name: 'Import from VS Code', exact: true });
const preview = () => importer().getByRole('region', { name: 'VS Code theme preview', exact: true });
const pdf = () => page.locator('.pdf-workspace');
const canvas = () => pdf().locator('.pdf-paper canvas');
const workspace = (name: 'Notes' | 'PDFs') => page.getByRole('navigation', { name: 'Workspaces', exact: true }).getByRole('button', { name, exact: true });

async function launch() {
  const applicationRoot = path.resolve(process.env.PRISM_TEST_APP_ROOT || process.cwd());
  const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
  delete env.ELECTRON_RUN_AS_NODE;
  desktop = await electron.launch({
    executablePath: process.env.PRISM_TEST_ELECTRON,
    args: electronLaunchArguments(['--no-sandbox', applicationRoot]), cwd: applicationRoot,
    env: { ...env, PRISM_USER_DATA: userData, PRISM_WORKSPACE: notebook, PRISM_PDF_USER_DATA: path.join(temporary, 'pdf-profile') },
  });
  page = await desktop.firstWindow();
  page.on('pageerror', error => errors.push(error.message));
  await expect(page.locator('.note-heading h1')).toHaveText('Appearance notebook');
  await expect.poll(() => desktop!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible())).toBe(true);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.getByRole('group', { name: 'Editor mode', exact: true }).getByRole('button', { name: 'Source', exact: true }).click();
}

async function stop() {
  if (!desktop) return;
  const child = desktop.process();
  const closed = desktop.waitForEvent('close', { timeout: 5000 }).catch(() => undefined);
  await desktop.evaluate(({ app }) => app.exit(0)).catch(() => undefined);
  await closed;
  if (child.exitCode === null) child.kill();
  desktop = undefined;
}

async function openAppearance() {
  await page.locator('.statusbar').getByRole('button').click();
  await expect(appearance()).toBeVisible();
}

async function closeAppearance() {
  await appearance().getByRole('button', { name: 'Done', exact: true }).click();
  await expect(appearance()).toBeHidden();
}

async function pick(filename: string | null) {
  await desktop!.evaluate(({ dialog }, selected) => {
    dialog.showOpenDialog = async () => ({ canceled: selected === null, filePaths: selected === null ? [] : [selected] });
  }, filename);
}

async function chooseTheme(filename: string | null) {
  await pick(filename);
  await importer().getByRole('button', { name: 'Choose theme file…', exact: true }).click();
  await expect(importer().getByRole('button', { name: 'Choose theme file…', exact: true })).toBeEnabled();
}

async function colors(expected: { accent: string; background: string; text: string }) {
  await expect(appearance().getByRole('textbox', { name: 'Accent hex', exact: true })).toHaveValue(expected.accent);
  await expect(appearance().getByRole('textbox', { name: 'Page background hex', exact: true })).toHaveValue(expected.background);
  await expect(appearance().getByRole('textbox', { name: 'Text hex', exact: true })).toHaveValue(expected.text);
}

async function fitsHorizontally(control: Locator) {
  await control.scrollIntoViewIfNeeded();
  const bounds = await appearance().boundingBox();
  const box = await control.boundingBox();
  if (!bounds || !box) throw new Error('The appearance control is not visible.');
  expect(box.x).toBeGreaterThanOrEqual(bounds.x);
  expect(box.x + box.width).toBeLessThanOrEqual(bounds.x + bounds.width + 1);
}

test.beforeEach(async () => {
  temporary = await mkdtemp(path.join(os.tmpdir(), 'prism-vscode-appearance-'));
  notebook = path.join(temporary, 'Notebook');
  userData = path.join(temporary, 'notes-profile');
  noteFile = path.join(notebook, 'Welcome to Prism.md');
  themeFile = path.join(temporary, 'Fixture dusk.jsonc');
  errors = [];
  await Promise.all([mkdir(notebook), mkdir(userData)]);
  await Promise.all([
    writeFile(noteFile, original),
    writeFile(path.join(temporary, 'base.json'), '{"colors":{"editor.background":"#121314","editor.foreground":"#bbbebf","textLink.foreground":"#123"}}'),
    writeFile(themeFile, '\ufeff{\n// A theme with inherited colors and a trailing comma.\n"name":"Fixture dusk",\n"include":"./base.json",\n"colors":{"textLink.foreground":"#48a0c7cc",},\n}\n'),
  ]);
  await launch();
});

test.afterEach(async ({}, testInfo) => {
  if (page && !page.isClosed() && testInfo.status !== testInfo.expectedStatus) {
    const screenshot = await page.screenshot().catch(() => undefined);
    if (screenshot) await testInfo.attach('VS Code appearance at failure', { body: screenshot, contentType: 'image/png' });
  }
  await stop();
  if (temporary) await rm(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

test('previews inherited VS Code colors, preserves Japanese drafts and the PDF reader, and remembers the imported palette', async ({}, testInfo) => {
  const sourceBytes = await readFile(themeFile);
  await editor().focus();
  await editor().press('ControlOrMeta+End');
  await page.keyboard.insertText(draft);
  const originalEditor = await editor().elementHandle();
  const pdfFile = path.join(temporary, 'Appearance companion.pdf');
  await writeFile(pdfFile, fixturePdf('appearance-secret'));
  await pick(pdfFile);
  await workspace('PDFs').click();
  await pdf().getByRole('button', { name: 'Import PDFs', exact: true }).click();
  await pdf().getByRole('button', { name: 'Open Appearance companion', exact: true }).click();
  await pdf().getByLabel('Document password', { exact: true }).fill('appearance-secret');
  await pdf().getByRole('button', { name: 'Unlock PDF', exact: true }).click();
  await expect(canvas()).toHaveAttribute('data-page-number', '1');
  await pdf().getByRole('button', { name: 'Next page', exact: true }).click();
  await pdf().getByLabel('Page zoom', { exact: true }).selectOption('2');
  await expect(canvas()).toHaveAttribute('data-page-number', '2');
  await expect(canvas()).toHaveCSS('width', '1224px');
  await expect(pdf().locator('.pdf-paper')).toHaveAttribute('aria-busy', 'false');
  await page.getByRole('button', { name: 'Read & write', exact: true }).click();
  await expect(page.locator('.workspace-area')).toHaveAttribute('data-layout', 'split');
  await openAppearance();
  await appearance().getByRole('slider', { name: 'Text size', exact: true }).fill('125');
  await appearance().getByRole('switch', { name: 'Transparent window', exact: true }).click();
  await appearance().getByRole('slider', { name: 'Background opacity', exact: true }).fill('65');
  await closeAppearance();
  const originalCanvas = await canvas().elementHandle();
  await pdf().getByLabel('PDF page viewport', { exact: true }).evaluate(element => element.scrollTo(0, 160));

  await openAppearance();
  await chooseTheme(themeFile);
  await expect(preview()).toContainText('Fixture dusk');
  await expect(preview()).toContainText(imported.background);
  await colors({ accent: '#3e6242', background: '#faf9f5', text: '#344640' });
  await chooseTheme(null);
  await expect(preview()).toContainText('Fixture dusk');
  await preview().getByRole('button', { name: 'Apply imported colors', exact: true }).click();
  await expect(preview()).toBeHidden();
  await colors(imported);
  await expect(importer().getByRole('status')).toContainText('Imported Fixture dusk colors into Prism.');
  await expect(appearance().getByRole('slider', { name: 'Text size', exact: true })).toHaveValue('125');
  await expect(appearance().getByRole('slider', { name: 'Background opacity', exact: true })).toHaveValue('65');
  await expect(appearance().getByRole('switch', { name: 'Transparent window', exact: true })).toHaveAttribute('aria-checked', 'true');
  await appearance().getByRole('radio', { name: 'Paper theme', exact: true }).check();
  await colors({ accent: '#8a5438', background: '#fbf5e8', text: '#40362a' });
  await appearance().getByRole('radio', { name: 'Prism theme', exact: true }).check();
  await colors(imported);
  await closeAppearance();
  await expect(page.locator('.workspace-main')).toHaveCSS('background-color', 'rgba(18, 19, 20, 0.65)');
  await expect(page.locator('.cm-editor')).toHaveCSS('color', 'rgb(187, 190, 191)');
  expect(await editor().evaluate((element, original) => element === original, originalEditor)).toBe(true);
  expect(await canvas().evaluate((element, original) => element === original, originalCanvas)).toBe(true);
  await expect(canvas()).toHaveAttribute('data-page-number', '2');
  await expect(pdf().getByLabel('Document password', { exact: true })).toHaveCount(0);
  await expect.poll(() => pdf().getByLabel('PDF page viewport', { exact: true }).evaluate(element => element.scrollTop)).toBe(160);
  await expect(editor()).toContainText(draft);
  expect(await readFile(noteFile, 'utf8')).toBe(original);
  expect(await readFile(themeFile)).toEqual(sourceBytes);
  await editor().focus();
  await editor().press('ControlOrMeta+z');
  await expect(editor()).not.toContainText(draft);
  await editor().press(process.platform === 'win32' ? 'Control+y' : 'ControlOrMeta+Shift+z');
  await expect(editor()).toContainText(draft);
  await editor().press('ControlOrMeta+s');
  await expect.poll(() => readFile(noteFile, 'utf8')).toBe(original + draft);
  await expect(page.locator('.statusbar')).toContainText('All changes saved');
  await testInfo.attach('Imported VS Code palette beside the retained PDF reader', {
    body: await page.screenshot({ path: testInfo.outputPath('vscode-appearance.png') }), contentType: 'image/png',
  });
  const closed = desktop!.waitForEvent('close');
  await page.getByRole('button', { name: 'Close window', exact: true }).click();
  await closed;
  desktop = undefined;
  await launch();
  await openAppearance();
  await colors(imported);
  await expect(appearance().getByRole('slider', { name: 'Text size', exact: true })).toHaveValue('125');
  await expect(appearance().getByRole('slider', { name: 'Background opacity', exact: true })).toHaveValue('65');
  await expect(appearance().getByRole('switch', { name: 'Transparent window', exact: true })).toHaveAttribute('aria-checked', 'true');
  expect(await readFile(noteFile, 'utf8')).toBe(original + draft);
  expect(errors).toEqual([]);
});

test('cancellation and invalid themes retain the palette, with reachable import controls at 150% text', async ({}, testInfo) => {
  const existing = { accent: '#912345', background: '#fbf5e8', text: '#40362a' };
  await openAppearance();
  await appearance().getByRole('radio', { name: 'Paper theme', exact: true }).check();
  await appearance().getByRole('textbox', { name: 'Accent hex', exact: true }).fill(existing.accent);
  await appearance().getByRole('slider', { name: 'Text size', exact: true }).fill('150');
  await page.setViewportSize({ width: 420, height: 900 });
  await fitsHorizontally(importer().getByRole('button', { name: 'Load from VS Code', exact: true }));
  await fitsHorizontally(importer().getByRole('button', { name: 'Choose theme file…', exact: true }));
  await chooseTheme(themeFile);
  await expect(preview()).toBeVisible();
  await colors(existing);
  await fitsHorizontally(preview().getByRole('button', { name: 'Apply imported colors', exact: true }));
  await fitsHorizontally(preview().getByRole('button', { name: 'Cancel import', exact: true }));
  expect(await appearance().evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
  await testInfo.attach('Theme import preview at 150% text in a narrow window', {
    body: await page.screenshot({ path: testInfo.outputPath('vscode-appearance-large-text.png') }), contentType: 'image/png',
  });
  await preview().getByRole('button', { name: 'Cancel import', exact: true }).click();
  await expect(preview()).toBeHidden();
  await chooseTheme(null);
  await expect(preview()).toBeHidden();
  await colors(existing);
  const invalid = path.join(temporary, 'broken.json');
  await writeFile(invalid, '{"colors":{"editor.background":"#123456"');
  await chooseTheme(invalid);
  await expect(importer().getByRole('alert')).toBeVisible();
  await expect(preview()).toBeHidden();
  await colors(existing);
  const unsupported = path.join(temporary, 'unrelated.json');
  await writeFile(unsupported, '{"colors":{"editor.background":"url(https://example.invalid/image)"},"command":"ignored"}');
  await chooseTheme(unsupported);
  await expect(importer().getByRole('alert')).toContainText('no supported');
  await colors(existing);
  expect(await page.evaluate(async () => {
    try { await window.prism.importVSCodeAppearance('invalid' as 'file'); return ''; }
    catch (error) { return error instanceof Error ? error.message : String(error); }
  })).toContain('Choose VS Code or a theme file');
  await chooseTheme(themeFile);
  await appearance().getByRole('radio', { name: 'Sci-fi theme', exact: true }).check();
  await expect(preview()).toContainText('Applies to the Sci-fi theme.');
  await preview().getByRole('button', { name: 'Apply imported colors', exact: true }).click();
  await colors(imported);
  await appearance().getByRole('radio', { name: 'Paper theme', exact: true }).check();
  await colors(existing);
  await closeAppearance();
  expect(await readFile(noteFile, 'utf8')).toBe(original);
  expect(errors).toEqual([]);
});
