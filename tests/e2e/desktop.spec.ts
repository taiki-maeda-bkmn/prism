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
    writeFile(path.join(notebook, 'Garden.md'), '\ufeff# Garden\n\nSmall ideas grow here.\n\nReturn to [[Welcome to Prism]].\n'),
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
    await expect(page.locator('.markdown-body h1')).toHaveText('Garden');
    await expect(page.getByRole('navigation', { name: 'Note outline', exact: true }).getByRole('button', { name: 'Garden', exact: true })).toBeVisible();
    expect((await page.getByLabel('Markdown source').textContent())?.startsWith('# Garden')).toBe(true);
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

test('retries loading the starter notebook after a filesystem error is repaired', async ({}, testInfo) => {
  const retryDirectory = await mkdtemp(path.join(os.tmpdir(), 'prism-startup-retry-'));
  const retryUserData = path.join(retryDirectory, 'user-data');
  const blockedNotebook = path.join(retryUserData, 'Prism notebook');
  let retryApp: ElectronApplication | undefined;
  let retryPage: Page | undefined;
  try {
    await mkdir(retryUserData, { recursive: true });
    await writeFile(blockedNotebook, 'A file temporarily blocks the starter notebook folder.');
    const retryEnvironment = Object.fromEntries(Object.entries(process.env)
      .filter((entry): entry is [string, string] => entry[1] !== undefined && entry[0] !== 'PRISM_WORKSPACE'));
    retryEnvironment.PRISM_USER_DATA = retryUserData;
    retryApp = await electron.launch({ args: ['--no-sandbox', '.'], cwd: process.cwd(), env: retryEnvironment });
    retryPage = await retryApp.firstWindow();
    await expect(retryPage.locator('.message-banner.error')).toBeVisible();
    await expect(retryPage.getByRole('button', { name: 'Try again', exact: true })).toBeVisible();

    await rm(blockedNotebook);
    await retryPage.getByRole('button', { name: 'Try again', exact: true }).click();
    await expect(retryPage.locator('.note-heading h1')).toHaveText('Welcome to Prism');
    await expect(retryPage.locator('.note-tree .note-item')).toHaveCount(4);
    await expect(retryPage.locator('.message-banner.error')).toHaveCount(0);
    expect(await readFile(path.join(blockedNotebook, 'Welcome to Prism.md'), 'utf8')).toContain('# Welcome to Prism');
  } catch (error) {
    if (retryPage && !retryPage.isClosed()) {
      const screenshot = await retryPage.screenshot().catch(() => undefined);
      if (screenshot) await testInfo.attach('Starter notebook retry failure', { body: screenshot, contentType: 'image/png' });
    }
    throw error;
  } finally {
    if (retryApp) {
      const child = retryApp.process();
      const closed = retryApp.waitForEvent('close', { timeout: 5_000 }).catch(() => undefined);
      await retryApp.evaluate(({ app }) => app.exit(0)).catch(() => undefined);
      await closed;
      if (child.exitCode === null) child.kill();
    }
    await rm(retryDirectory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test('remembers the starter without symlinks before allowing edits and reopens saved notes', async () => {
  test.skip(process.platform === 'win32', 'Windows starter publication does not use symlinks.');
  const fallbackDirectory = await mkdtemp(path.join(os.tmpdir(), 'prism-starter-fallback-'));
  const fallbackUserData = path.join(fallbackDirectory, 'user-data');
  const blockedNotebook = path.join(fallbackUserData, 'Prism notebook');
  const blockedSettings = path.join(fallbackUserData, 'notebook.json.tmp');
  const fallbackEnvironment = Object.fromEntries(Object.entries(process.env)
    .filter((entry): entry is [string, string] => entry[1] !== undefined && entry[0] !== 'PRISM_WORKSPACE'));
  fallbackEnvironment.PRISM_USER_DATA = fallbackUserData;
  let fallbackApp: ElectronApplication | undefined;
  const closeFallback = async () => {
    if (!fallbackApp) return;
    const child = fallbackApp.process();
    const closed = fallbackApp.waitForEvent('close', { timeout: 5_000 }).catch(() => undefined);
    await fallbackApp.evaluate(({ app }) => app.exit(0)).catch(() => undefined);
    await closed;
    if (child.exitCode === null) child.kill();
    fallbackApp = undefined;
  };
  try {
    await mkdir(fallbackUserData, { recursive: true });
    await writeFile(blockedNotebook, 'Block startup until the filesystem fault is installed.');
    fallbackApp = await electron.launch({ args: ['--no-sandbox', '.'], cwd: process.cwd(), env: fallbackEnvironment });
    let fallbackPage = await fallbackApp.firstWindow();
    await expect(fallbackPage.locator('.message-banner.error')).toBeVisible();
    // Inject only the unsupported filesystem operation in this disposable process.
    await fallbackApp.evaluate(() => {
      const fs = process.getBuiltinModule('node:fs/promises') as typeof import('node:fs/promises');
      fs.symlink = async () => { throw Object.assign(new Error('Symlinks unsupported'), { code: 'EOPNOTSUPP' }); };
    });
    await rm(blockedNotebook);
    await mkdir(blockedSettings);
    await fallbackPage.getByRole('button', { name: 'Try again', exact: true }).click();
    await expect(fallbackPage.locator('.message-banner.error')).toContainText('notebook.json.tmp');
    await expect(fallbackPage.getByLabel('Markdown source')).toHaveCount(0);

    await rm(blockedSettings, { recursive: true });
    await fallbackPage.getByRole('button', { name: 'Try again', exact: true }).click();
    await expect(fallbackPage.locator('.note-heading h1')).toHaveText('Welcome to Prism');
    await expect(fallbackPage.locator('.note-tree .note-item')).toHaveCount(4);
    const remembered = JSON.parse(await readFile(path.join(fallbackUserData, 'notebook.json'), 'utf8')) as { path: string };
    expect(remembered.path).not.toBe(blockedNotebook);
    await expect(fallbackPage.locator('.sidebar-bottom button').first()).toHaveAttribute('title', remembered.path);
    const source = fallbackPage.getByLabel('Markdown source');
    await source.click();
    await source.press('ControlOrMeta+A');
    await fallbackPage.keyboard.insertText('# Remembered fallback\n\nMy saved thought.\n');
    await fallbackPage.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(fallbackPage.locator('.statusbar')).toContainText('All changes saved');
    expect(await readFile(path.join(remembered.path, 'Welcome to Prism.md'), 'utf8')).toContain('My saved thought.');

    await closeFallback();
    fallbackApp = await electron.launch({ args: ['--no-sandbox', '.'], cwd: process.cwd(), env: fallbackEnvironment });
    fallbackPage = await fallbackApp.firstWindow();
    await expect(fallbackPage.locator('.note-heading h1')).toHaveText('Remembered fallback');
    await expect(fallbackPage.getByLabel('Markdown source')).toContainText('My saved thought.');
    await expect(fallbackPage.locator('.note-tree .note-item')).toHaveCount(4);
    await expect(fallbackPage.locator('.message-banner.error')).toHaveCount(0);
    await expect(fallbackPage.locator('.sidebar-bottom button').first()).toHaveAttribute('title', remembered.path);
  } finally {
    await closeFallback();
    await rm(fallbackDirectory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test('opens percent-containing filenames consistently in previews, graphs, and backlinks', async ({}, testInfo) => {
  const linkDirectory = await mkdtemp(path.join(os.tmpdir(), 'prism-percent-links-'));
  const linkNotebook = path.join(linkDirectory, 'notebook');
  const linkUserData = path.join(linkDirectory, 'user-data');
  let linkApp: ElectronApplication | undefined;
  let linkPage: Page | undefined;
  try {
    await mkdir(linkNotebook, { recursive: true });
    await mkdir(linkUserData, { recursive: true });
    const fixtures: Record<string, string> = {
      'Welcome to Prism.md': '# Welcome to Prism\n\n[[Percent%25]]\n\n[Extensionless](Percent%2525)\n\n[URI note](Space%2520.md)\n',
      'Percent%25.md': '# Literal percent25 target\n',
      'Percent%.md': '# Percent collision\n',
      'Space%20.md': '# Encoded space target\n',
      'Space .md': '# Space collision\n',
    };
    await Promise.all(Object.entries(fixtures).map(([name, content]) => writeFile(path.join(linkNotebook, name), content)));
    linkApp = await electron.launch({
      args: ['--no-sandbox', '.'], cwd: process.cwd(),
      env: { ...process.env, PRISM_USER_DATA: linkUserData, PRISM_WORKSPACE: linkNotebook },
    });
    linkPage = await linkApp.firstWindow();
    await expect(linkPage.locator('.note-heading h1')).toHaveText('Welcome to Prism');
    await expect(linkPage.locator('.note-tree .note-item')).toHaveCount(5);
    const graph = linkPage.getByRole('group', { name: 'Note graph. Select a note to open it. Drag the background to pan.' });

    for (const target of [
      { label: 'Percent%25', title: 'Literal percent25 target', collision: 'Percent collision' },
      { label: 'Extensionless', title: 'Literal percent25 target', collision: 'Percent collision' },
      { label: 'URI note', title: 'Encoded space target', collision: 'Space collision' },
    ]) {
      await linkPage.getByRole('navigation', { name: 'Notes', exact: true }).getByTitle('Welcome to Prism.md', { exact: true }).click();
      await linkPage.locator('.markdown-body').getByRole('link', { name: target.label, exact: true }).click();
      await expect(linkPage.locator('.note-heading h1')).toHaveText(target.title);
      await expect(linkPage.locator('.backlink')).toHaveCount(1);
      await expect(linkPage.locator('.backlinks-section').getByRole('button', { name: 'Welcome to Prism', exact: true })).toBeVisible();

      await linkPage.getByRole('button', { name: 'Graph view', exact: true }).click();
      await expect(graph.getByRole('button')).toHaveCount(5);
      await expect(linkPage.locator('.graph-caption')).toContainText('2 connections');
      await expect(graph.locator('.graph-edge-highlight')).toHaveCount(1);
      await expect(graph.getByRole('button', { name: 'Open Welcome to Prism', exact: true })).toHaveClass(/graph-node-connected/);
      await expect(graph.getByRole('button', { name: `Open ${target.collision}`, exact: true })).not.toHaveClass(/graph-node-connected/);

      await graph.getByRole('button', { name: `Open ${target.collision}`, exact: true }).click();
      await expect(linkPage.locator('.note-heading h1')).toHaveText(target.collision);
      await expect(linkPage.locator('.backlink')).toHaveCount(0);
      await linkPage.getByRole('button', { name: 'Graph view', exact: true }).click();
      await expect(graph.locator('.graph-edge-highlight')).toHaveCount(0);
    }
    await expect(linkPage.locator('.message-banner.error')).toHaveCount(0);
  } catch (error) {
    if (linkPage && !linkPage.isClosed()) {
      const screenshot = await linkPage.screenshot().catch(() => undefined);
      if (screenshot) await testInfo.attach('Percent filename link failure', { body: screenshot, contentType: 'image/png' });
    }
    throw error;
  } finally {
    if (linkApp) {
      const child = linkApp.process();
      const closed = linkApp.waitForEvent('close', { timeout: 5_000 }).catch(() => undefined);
      await linkApp.evaluate(({ app }) => app.exit(0)).catch(() => undefined);
      await closed;
      if (child.exitCode === null) child.kill();
    }
    await rm(linkDirectory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test('scrolls to linked headings after note navigation and preserves literal hash filenames', async ({}, testInfo) => {
  const headingDirectory = await mkdtemp(path.join(os.tmpdir(), 'prism-heading-links-'));
  const headingNotebook = path.join(headingDirectory, 'notebook');
  const headingUserData = path.join(headingDirectory, 'user-data');
  let headingApp: ElectronApplication | undefined;
  let headingPage: Page | undefined;
  const paragraphs = Array.from({ length: 35 }, (_, index) => `Paragraph ${index + 1} keeps the destination section below the initial preview viewport.`).join('\n\n');
  const longNote = (title: string) => `# ${title}\n\n${paragraphs}\n\n## Target heading\n\nThe requested destination is here.\n\n${paragraphs}\n`;
  try {
    await mkdir(headingNotebook, { recursive: true });
    await mkdir(headingUserData, { recursive: true });
    const fixtures: Record<string, string> = {
      'Welcome to Prism.md': `# Welcome to Prism\n\n[Markdown section](Markdown%20note.md#target-heading)\n\n[[Wiki note#Target heading|Wiki section]]\n\n[[Hash note#Target heading|Literal hash filename]]\n\n[[#Welcome section|Same-note section]]\n\n${paragraphs}\n\n## Welcome section\n\nThe same-note destination is here.\n\n${paragraphs}\n`,
      'Markdown note.md': longNote('Markdown destination'),
      'Wiki note.md': longNote('Wiki destination'),
      'Hash note.md': longNote('Hash fallback'),
      'Hash note#Target heading.md': longNote('Literal hash filename destination'),
    };
    await Promise.all(Object.entries(fixtures).map(([name, content]) => writeFile(path.join(headingNotebook, name), content)));
    headingApp = await electron.launch({
      args: ['--no-sandbox', '.'], cwd: process.cwd(),
      env: { ...process.env, PRISM_USER_DATA: headingUserData, PRISM_WORKSPACE: headingNotebook },
    });
    headingPage = await headingApp.firstWindow();
    await expect(headingPage.locator('.note-heading h1')).toHaveText('Welcome to Prism');

    async function headingIsInViewport(id: string): Promise<boolean> {
      return headingPage!.locator('.markdown-body').evaluate((preview, headingId) => {
        const heading = preview.querySelector(`[id="${CSS.escape(headingId)}"]`);
        if (!heading) return false;
        const viewport = preview.getBoundingClientRect();
        const box = heading.getBoundingClientRect();
        return box.top >= viewport.top && box.bottom <= viewport.bottom;
      }, id);
    }

    async function expectScrolledTo(id: string) {
      await expect.poll(() => headingIsInViewport(id)).toBe(true);
      await expect.poll(() => headingPage!.locator('.markdown-body').evaluate(preview => preview.scrollTop)).toBeGreaterThan(200);
    }

    for (const destination of [
      { label: 'Markdown section', title: 'Markdown destination', mode: 'Read' },
      { label: 'Wiki section', title: 'Wiki destination', mode: 'Split' },
    ]) {
      await headingPage.getByRole('navigation', { name: 'Notes', exact: true }).getByTitle('Welcome to Prism.md', { exact: true }).click();
      await headingPage.getByRole('button', { name: destination.mode, exact: true }).click();
      await headingPage.locator('.markdown-body').getByRole('link', { name: destination.label, exact: true }).click();
      await expect(headingPage.locator('.note-heading h1')).toHaveText(destination.title);
      await expectScrolledTo('target-heading');
    }

    await headingPage.getByRole('navigation', { name: 'Notes', exact: true }).getByTitle('Welcome to Prism.md', { exact: true }).click();
    await headingPage.locator('.markdown-body').getByRole('link', { name: 'Literal hash filename', exact: true }).click();
    await expect(headingPage.locator('.note-heading h1')).toHaveText('Literal hash filename destination');

    await headingPage.getByRole('navigation', { name: 'Notes', exact: true }).getByTitle('Welcome to Prism.md', { exact: true }).click();
    await headingPage.getByRole('button', { name: 'Read', exact: true }).click();
    for (let attempt = 0; attempt < 2; attempt++) {
      await headingPage.locator('.markdown-body').evaluate(preview => { preview.scrollTop = 0; });
      await expect.poll(() => headingIsInViewport('welcome-section')).toBe(false);
      await headingPage.locator('.markdown-body').getByRole('link', { name: 'Same-note section', exact: true }).click();
      await expect(headingPage.locator('.note-heading h1')).toHaveText('Welcome to Prism');
      await expectScrolledTo('welcome-section');
    }
    await expect(headingPage.locator('.message-banner.error')).toHaveCount(0);
  } catch (error) {
    if (headingPage && !headingPage.isClosed()) {
      const screenshot = await headingPage.screenshot().catch(() => undefined);
      if (screenshot) await testInfo.attach('Heading link navigation failure', { body: screenshot, contentType: 'image/png' });
    }
    throw error;
  } finally {
    if (headingApp) {
      const child = headingApp.process();
      const closed = headingApp.waitForEvent('close', { timeout: 5_000 }).catch(() => undefined);
      await headingApp.evaluate(({ app }) => app.exit(0)).catch(() => undefined);
      await closed;
      if (child.exitCode === null) child.kill();
    }
    await rm(headingDirectory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test('opens protocol-relative, HTTPS, and email preview links externally', async ({}, testInfo) => {
  const externalDirectory = await mkdtemp(path.join(os.tmpdir(), 'prism-external-links-'));
  const externalNotebook = path.join(externalDirectory, 'notebook');
  const externalUserData = path.join(externalDirectory, 'user-data');
  let externalApp: ElectronApplication | undefined;
  let externalPage: Page | undefined;
  try {
    await mkdir(externalNotebook, { recursive: true });
    await mkdir(externalUserData, { recursive: true });
    await writeFile(path.join(externalNotebook, 'Welcome to Prism.md'), '# Welcome to Prism\n\n[Protocol-relative site](//example.com/page)\n\n[HTTPS site](https://example.com/secure?from=prism#section)\n\n[Email author](mailto:author@example.com?subject=Hello%20Prism)\n');
    externalApp = await electron.launch({
      args: ['--no-sandbox', '.'], cwd: process.cwd(),
      env: { ...process.env, PRISM_USER_DATA: externalUserData, PRISM_WORKSPACE: externalNotebook },
    });
    // Keep the renderer, preload bridge, IPC handler, and URL validation real;
    // intercept only the final operating-system handoff in this disposable app.
    const openedDestinations = await externalApp.evaluateHandle(({ shell }) => {
      const destinations: string[] = [];
      shell.openExternal = async (url) => { destinations.push(url); };
      return destinations;
    });
    externalPage = await externalApp.firstWindow();
    await expect(externalPage.locator('.note-heading h1')).toHaveText('Welcome to Prism');
    const initialURL = externalPage.url();
    const expectedDestinations: string[] = [];
    for (const destination of [
      { label: 'Protocol-relative site', url: 'https://example.com/page' },
      { label: 'HTTPS site', url: 'https://example.com/secure?from=prism#section' },
      { label: 'Email author', url: 'mailto:author@example.com?subject=Hello%20Prism' },
    ]) {
      await externalPage.locator('.markdown-body').getByRole('link', { name: destination.label, exact: true }).click();
      expectedDestinations.push(destination.url);
      await expect.poll(() => openedDestinations.jsonValue()).toEqual(expectedDestinations);
      await expect(externalPage.locator('.message-banner')).toHaveCount(0);
      await expect(externalPage.locator('.note-heading h1')).toHaveText('Welcome to Prism');
      expect(externalPage.url()).toBe(initialURL);
    }
    await openedDestinations.dispose();
  } catch (error) {
    if (externalPage && !externalPage.isClosed()) {
      const screenshot = await externalPage.screenshot().catch(() => undefined);
      if (screenshot) await testInfo.attach('External preview link failure', { body: screenshot, contentType: 'image/png' });
    }
    throw error;
  } finally {
    if (externalApp) {
      const child = externalApp.process();
      const closed = externalApp.waitForEvent('close', { timeout: 5_000 }).catch(() => undefined);
      await externalApp.evaluate(({ app }) => app.exit(0)).catch(() => undefined);
      await closed;
      if (child.exitCode === null) child.kill();
    }
    await rm(externalDirectory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
