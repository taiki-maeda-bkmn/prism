import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const initialWelcome = '# Welcome to Prism\n\nA quiet place for connected ideas.\n\nExplore [[Garden]] and [[Ideas/Research]].\n';
const savedWelcome = '# Welcome to Prism\n\nA **clearer thought** appears in the live preview.\n\nFollow [[Garden]] to keep growing.\n';

let temporary: string;
let notebook: string;
let userData: string;
let desktop: ElectronApplication | undefined;
let page: Page;

async function launch() {
  desktop = await electron.launch({
    args: ['--no-sandbox', '.'],
    cwd: process.cwd(),
    env: { ...process.env, PRISM_USER_DATA: userData, PRISM_WORKSPACE: notebook },
  });
  page = await desktop.firstWindow();
  await expect(page.locator('.note-heading h1')).toHaveText('Welcome to Prism');
  await expect(page.locator('.message-banner.error')).toHaveCount(0);
}

async function replaceSource(content: string) {
  const editor = page.getByLabel('Markdown source');
  await editor.click();
  await editor.press('ControlOrMeta+A');
  await page.keyboard.insertText(content);
}

async function nativeBackgroundAlpha() {
  const heading = await page.locator('.note-heading').boundingBox();
  if (!heading) throw new Error('The note heading is not visible.');
  // Sample empty padding, so text and controls cannot obscure surface alpha.
  const pixel = { x: Math.round(heading.x + 4), y: Math.round(heading.y + 4), width: 1, height: 1 };
  return desktop!.evaluate(async ({ BrowserWindow }, rectangle) => {
    const image = await BrowserWindow.getAllWindows()[0].webContents.capturePage(rectangle);
    // Native bitmaps use four channels with alpha last on our desktop targets.
    return image.toBitmap({ scaleFactor: 1 })[3];
  }, pixel);
}

test.beforeAll(async () => {
  temporary = await mkdtemp(path.join(os.tmpdir(), 'prism-desktop-test-'));
  notebook = path.join(temporary, 'Test notebook');
  userData = path.join(temporary, 'user-data');
  await mkdir(path.join(notebook, 'Ideas'), { recursive: true });
  await mkdir(userData, { recursive: true });
  await Promise.all([
    writeFile(path.join(notebook, 'Welcome to Prism.md'), initialWelcome),
    writeFile(path.join(notebook, 'Garden.md'), '# Garden\n\nSmall ideas grow here.\n\nReturn to [[Welcome to Prism]].\n'),
    writeFile(path.join(notebook, 'Ideas/Research.md'), '# Research\n\nQuestions to explore in [[Garden]].\n'),
  ]);
  await launch();
});

test.afterAll(async () => {
  if (desktop) {
    // Only this disposable test app is force-closed, including when a failed
    // assertion leaves its unsaved-change dialog open.
    const process = desktop.process();
    const closed = desktop.waitForEvent('close', { timeout: 5_000 }).catch(() => undefined);
    await desktop.evaluate(({ app }) => app.exit(0)).catch(() => undefined);
    await closed;
    if (process.exitCode === null) process.kill();
  }
  if (temporary) await rm(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

test.afterEach(async ({}, testInfo) => {
  if (page && !page.isClosed() && testInfo.status !== testInfo.expectedStatus) {
    const screenshot = await page.screenshot().catch(() => undefined);
    if (screenshot) await testInfo.attach('Desktop at failure', { body: screenshot, contentType: 'image/png' });
  }
});

test('writes, connects, protects drafts, and remembers window appearance', async ({}, testInfo) => {
  await test.step('switch between source, split, and reading modes', async () => {
    await expect(page.getByLabel('Source editor')).toBeVisible();
    await expect(page.getByLabel('Live preview')).toBeVisible();

    await page.getByRole('button', { name: 'Source', exact: true }).click();
    await expect(page.getByLabel('Markdown source')).toBeVisible();
    await expect(page.getByLabel('Live preview')).toHaveCount(0);

    await page.getByRole('button', { name: 'Read', exact: true }).click();
    await expect(page.getByLabel('Source editor')).toHaveCount(0);
    await expect(page.locator('.markdown-body h1')).toHaveText('Welcome to Prism');

    await page.getByRole('button', { name: 'Split', exact: true }).click();
    await expect(page.getByLabel('Source editor')).toBeVisible();
  });

  await test.step('preview edits immediately and save the real Markdown file', async () => {
    await replaceSource(savedWelcome);
    await expect(page.locator('.markdown-body strong')).toHaveText('clearer thought');
    await expect(page.locator('.statusbar')).toContainText('1 unsaved note');
    expect(await readFile(path.join(notebook, 'Welcome to Prism.md'), 'utf8')).toBe(initialWelcome);

    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(page.locator('.statusbar')).toContainText('All changes saved');
    await expect.poll(() => readFile(path.join(notebook, 'Welcome to Prism.md'), 'utf8')).toBe(savedWelcome);
  });

  const draftWelcome = savedWelcome + '\nThis draft must survive note navigation.\n';
  await test.step('retain drafts across note navigation and cancel a native close', async () => {
    await replaceSource(draftWelcome);
    await page.getByRole('navigation', { name: 'Notes', exact: true }).getByRole('button', { name: 'Garden', exact: true }).click();
    await expect(page.locator('.note-heading h1')).toHaveText('Garden');
    await page.getByRole('navigation', { name: 'Notes', exact: true }).getByTitle('Welcome to Prism.md', { exact: true }).click();
    await expect(page.getByLabel('Markdown source')).toContainText('This draft must survive note navigation.');
    expect(await readFile(path.join(notebook, 'Welcome to Prism.md'), 'utf8')).toBe(savedWelcome);

    await desktop!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByRole('heading')).toHaveText('Keep your latest thoughts?');
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await expect(page.getByLabel('Markdown source')).toContainText('This draft must survive note navigation.');

    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(page.locator('.statusbar')).toContainText('All changes saved');
    await expect.poll(() => readFile(path.join(notebook, 'Welcome to Prism.md'), 'utf8')).toBe(draftWelcome);
  });

  await test.step('cancel a dirty refresh, then discard the draft and reload external edits', async () => {
    const unsaved = draftWelcome + '\nDiscard this local-only draft.\n';
    const external = draftWelcome + '\nAn external editor saved this sentence.\n';
    const welcomePath = path.join(notebook, 'Welcome to Prism.md');
    await replaceSource(unsaved);
    await writeFile(welcomePath, external);

    await page.getByRole('button', { name: 'Refresh notebook', exact: true }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toContainText('reloading from disk');
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(page.getByLabel('Markdown source')).toContainText('Discard this local-only draft.');
    expect(await readFile(welcomePath, 'utf8')).toBe(external);

    await page.getByRole('button', { name: 'Refresh notebook', exact: true }).click();
    await dialog.getByRole('button', { name: 'Discard changes', exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await expect(page.getByLabel('Markdown source')).toContainText('An external editor saved this sentence.');
    await expect(page.getByLabel('Markdown source')).not.toContainText('Discard this local-only draft.');
    await expect(page.locator('.statusbar')).toContainText('All changes saved');
    expect(await readFile(welcomePath, 'utf8')).toBe(external);

    await replaceSource(draftWelcome);
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(page.locator('.statusbar')).toContainText('All changes saved');
    await expect.poll(() => readFile(welcomePath, 'utf8')).toBe(draftWelcome);
  });

  await test.step('create and save a note inside a new nested folder', async () => {
    await page.getByRole('button', { name: 'New note', exact: true }).click();
    await page.getByLabel('Note name').fill('Ideas/Seeds/Fresh thought');
    await page.getByRole('button', { name: 'Create note', exact: true }).click();
    await expect(page.locator('.note-heading h1')).toHaveText('Fresh thought');
    const createdPath = path.join(notebook, 'Ideas/Seeds/Fresh thought.md');
    await expect.poll(() => readFile(createdPath, 'utf8')).toBe('# Fresh thought\n\n');

    const content = '# Fresh thought\n\nA new connection to [[Garden]].\n';
    await replaceSource(content);
    await page.keyboard.press('ControlOrMeta+S');
    await expect(page.locator('.statusbar')).toContainText('All changes saved');
    await expect.poll(() => readFile(createdPath, 'utf8')).toBe(content);

    await expect(page.getByLabel('Markdown source')).toBeFocused();
    const continuation = 'Still writing immediately after saving.';
    await page.keyboard.insertText(continuation);
    await expect(page.getByLabel('Markdown source')).toContainText('Still writing immediately after saving.');
    await expect(page.locator('.statusbar')).toContainText('1 unsaved note');
    expect(await readFile(createdPath, 'utf8')).toBe(content);
    await page.keyboard.press('ControlOrMeta+S');
    await expect(page.locator('.statusbar')).toContainText('All changes saved');
    await expect.poll(() => readFile(createdPath, 'utf8')).toBe(content + continuation);
  });

  await test.step('reject invalid and duplicate note names without changing existing files', async () => {
    const createdPath = path.join(notebook, 'Ideas/Seeds/Fresh thought.md');
    const existing = await readFile(createdPath, 'utf8');
    await page.getByRole('button', { name: 'New note', exact: true }).click();
    const dialog = page.getByRole('dialog');
    await page.getByLabel('Note name').fill('../Outside');
    await dialog.getByRole('button', { name: 'Create note', exact: true }).click();
    await expect(dialog.getByRole('alert')).toContainText('leaves the notebook');
    await expect(readFile(path.join(temporary, 'Outside.md'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });

    await page.getByLabel('Note name').fill('Ideas/Seeds/Fresh thought');
    await dialog.getByRole('button', { name: 'Create note', exact: true }).click();
    await expect(dialog.getByRole('alert')).toContainText('already exists');
    expect(await readFile(createdPath, 'utf8')).toBe(existing);
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
    await page.getByRole('button', { name: 'Dismiss error', exact: true }).click();
    await expect(page.locator('.note-heading h1')).toHaveText('Fresh thought');
  });

  await test.step('navigate the graph, follow a backlink, and capture the desktop', async () => {
    await page.getByRole('button', { name: 'Graph view', exact: true }).click();
    const graph = page.getByRole('group', { name: 'Note graph. Select a note to open it. Drag the background to pan.' });
    await expect(graph.getByRole('button')).toHaveCount(4);
    await expect(page.locator('.graph-caption')).toContainText('3 connections');
    await graph.getByRole('button', { name: 'Open Garden', exact: true }).click();
    await expect(page.locator('.note-heading h1')).toHaveText('Garden');
    await expect(page.locator('.backlink')).toHaveCount(3);
    await page.locator('.backlinks-section').getByRole('button', { name: 'Fresh thought', exact: true }).click();
    await expect(page.locator('.note-heading h1')).toHaveText('Fresh thought');

    await page.locator('.markdown-body').getByRole('link', { name: 'Garden', exact: true }).click();
    await expect(page.locator('.note-heading h1')).toHaveText('Garden');
    await mkdir('test-results', { recursive: true });
    const screenshot = path.resolve('test-results/prism-desktop.png');
    await page.screenshot({ path: screenshot });
    await testInfo.attach('Prism desktop', { path: screenshot, contentType: 'image/png' });
  });

  await test.step('persist transparent mode, background opacity, and editor mode after reopening', async () => {
    await page.getByRole('button', { name: 'Read', exact: true }).click();
    await expect.poll(nativeBackgroundAlpha).toBe(255);
    await page.getByRole('button', { name: 'Appearance settings', exact: true }).click();
    const toggle = page.getByRole('switch', { name: 'Transparent window', exact: true });
    await expect(toggle).toHaveAttribute('aria-checked', 'false');
    await toggle.click();
    const slider = page.getByRole('slider', { name: 'Background opacity', exact: true });
    await slider.focus();
    await slider.press('Home');
    for (let index = 0; index < 10; index++) await slider.press('ArrowRight');
    await expect(slider).toHaveValue('35');
    await expect(page.locator('.app-shell')).toHaveAttribute('data-transparent', 'true');
    expect(await page.locator('.app-shell').evaluate(element => getComputedStyle(element).getPropertyValue('--surface-alpha').trim())).toBe('0.35');
    expect(await page.evaluate(() => getComputedStyle(document.body).backgroundColor)).toBe('rgba(0, 0, 0, 0)');
    await page.getByRole('button', { name: 'Done', exact: true }).click();
    await expect.poll(nativeBackgroundAlpha).toBeGreaterThan(80);
    await expect.poll(nativeBackgroundAlpha).toBeLessThan(100);

    await desktop!.close();
    desktop = undefined;
    await launch();
    await expect(page.getByRole('button', { name: 'Read', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByLabel('Source editor')).toHaveCount(0);
    await expect(page.locator('.app-shell')).toHaveAttribute('data-transparent', 'true');
    await page.getByRole('button', { name: 'Appearance settings', exact: true }).click();
    await expect(page.getByRole('switch', { name: 'Transparent window', exact: true })).toHaveAttribute('aria-checked', 'true');
    await expect(page.getByRole('slider', { name: 'Background opacity', exact: true })).toHaveValue('35');
    expect(await readFile(path.join(notebook, 'Welcome to Prism.md'), 'utf8')).toBe(draftWelcome);
  });
});
