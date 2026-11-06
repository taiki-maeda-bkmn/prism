import { electronLaunchArguments } from '../../scripts/electron-launch.mjs';
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const firstFile = 'Welcome to Prism.md';
const secondFile = 'Second note.md';
const first = '# First note\n\nFollow [[Second note]].\n\nFirst saved paragraph.\n';
const second = '# Second note\n\nReturn to [[Welcome to Prism]].\n\nSecond saved paragraph.\n';
const long = '# Long note\n\n' + Array.from({ length: 350 }, (_, index) => `Paragraph ${index + 1}: retained position in a long note.\n\n`).join('');
const profile = '# Navigation profile\n\n' + Array.from({ length: 42 }, (_, index) => [
  `## 計算 ${index + 1}`, '',
  '確率変数の期待値と分散を求め、計算の過程と結果を比較します。 '.repeat(3),
  'A paragraph with **reasoning**, $E[X] = \\mu$, and [[Second note]].', '',
  '$$', '\\begin{aligned}', `E[X_${index + 1}] &= \\int_0^1 x^2(1-x)\\,dx = \\frac{1}{12} \\\\`,
  '\\operatorname{Var}(X) &= E[X^2]-E[X]^2', '\\end{aligned}', '$$', '',
  '| 条件 | 期待値 |', '| :--- | ---: |', '| 比較 | $\\frac{1}{2}$ |', '',
].join('\n')).join('\n');
const firstDraft = '日本語の一つ目の下書き。';
const secondDraft = 'A separate second-note draft.';
const diskFirst = (text: string) => '\ufeff' + text.replace(/\n/g, '\r\n');
const applicationRoot = path.resolve(process.env.PRISM_TEST_APP_ROOT || process.cwd());
const executablePath = process.env.PRISM_TEST_ELECTRON || undefined;
let temporary: string;
let notebook: string;
let nextNotebook: string;
let userData: string;
let desktop: ElectronApplication | undefined;
let page: Page;
let pageErrors: string[];

const editor = () => page.locator('.app-body .cm-content');
const source = async () => (await editor().locator('.cm-line').allTextContents()).join('\n');
const status = () => page.locator('.statusbar');
const mode = (name: string) => page.getByRole('group', { name: 'Editor mode', exact: true }).getByRole('button', { name, exact: true });
const prompt = () => page.getByRole('dialog', { name: 'Keep your latest thoughts?', exact: true });
const graph = () => page.locator('.graph-view:not(.graph-compact) .graph-canvas');

async function openNote(filename: string) {
  // Titles stay stable even when the accessible name includes the dirty dot.
  await page.getByRole('navigation', { name: 'Notes', exact: true }).getByTitle(filename, { exact: true }).click();
  await expect(editor()).toBeVisible();
}

async function append(text: string) {
  await editor().focus();
  await editor().press('ControlOrMeta+End');
  await page.keyboard.insertText(text);
  if (text.trim()) await expect(editor()).toContainText(text);
}

async function undo() {
  await editor().focus();
  await editor().press('ControlOrMeta+z');
}

async function redo() {
  await editor().focus();
  await editor().press(process.platform === 'win32' ? 'Control+y' : 'ControlOrMeta+Shift+z');
}

async function readPublished(filename: string, directory = notebook) {
  try { return await readFile(path.join(directory, filename), 'utf8'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
}

async function saveFirst(expected: string) {
  await editor().press('ControlOrMeta+s');
  await expect.poll(() => readPublished(firstFile)).toBe(diskFirst(expected));
  // Atomic publication precedes the renderer acknowledgement. Wait until the
  // editor is no longer inert before entering or navigating another draft.
  await expect(status()).not.toContainText('Working…');
  await expect(page.locator('.save-button')).toBeDisabled();
  await expect(page.locator('.save-button .spin')).toHaveCount(0);
}

async function openGraph() {
  await page.getByRole('button', { name: 'Graph view', exact: true }).click();
  await expect(graph()).toBeVisible();
  await expect(editor()).toHaveCount(0);
}

async function expectNoHistory(content: string) {
  await expect.poll(source).toBe(content);
  await undo();
  await expect.poll(source).toBe(content);
  await redo();
  await expect.poll(source).toBe(content);
}

async function launch() {
  const env: Record<string, string> = {
    ...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)),
    PRISM_USER_DATA: userData, PRISM_WORKSPACE: notebook,
    PRISM_PDF_USER_DATA: path.join(temporary, 'pdf-profile'),
  };
  delete env.ELECTRON_RUN_AS_NODE;
  desktop = await electron.launch({ executablePath,
    args: electronLaunchArguments(['--no-sandbox', applicationRoot]), cwd: applicationRoot, env,
  });
  page = await desktop.firstWindow();
  pageErrors = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  await expect(page.locator('.note-heading h1')).toHaveText('First note');
  await expect.poll(() => desktop!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible())).toBe(true);
  await mode('Source').click();
  await expect(editor()).toHaveAttribute('aria-label', 'Markdown source');
}

async function stop() {
  if (!desktop) return;
  // This application owns only this test's fresh notebook and both profiles.
  const child = desktop.process();
  const closed = desktop.waitForEvent('close', { timeout: 5_000 }).catch(() => undefined);
  await desktop.evaluate(({ app }) => app.exit(0)).catch(() => undefined);
  await closed;
  if (child.exitCode === null) child.kill();
  desktop = undefined;
}

test.beforeEach(async () => {
  temporary = await mkdtemp(path.join(os.tmpdir(), 'prism-editor-history-'));
  notebook = path.join(temporary, 'First notebook');
  nextNotebook = path.join(temporary, 'Identical notebook');
  userData = path.join(temporary, 'notes-profile');
  await Promise.all([mkdir(notebook), mkdir(nextNotebook), mkdir(userData)]);
  for (const directory of [notebook, nextNotebook]) {
    await Promise.all([
      writeFile(path.join(directory, firstFile), diskFirst(first)),
      writeFile(path.join(directory, secondFile), second),
      writeFile(path.join(directory, 'Long note.md'), long),
      writeFile(path.join(directory, 'Navigation profile.md'), profile),
    ]);
  }
  await launch();
});

test.afterEach(async ({}, testInfo) => {
  if (page && !page.isClosed() && testInfo.status !== testInfo.expectedStatus) {
    const screenshot = await page.screenshot().catch(() => undefined);
    if (screenshot) await testInfo.attach('Editor history at failure', { body: screenshot, contentType: 'image/png' });
  }
  await stop();
  if (temporary) await rm(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

test('keeps independent note undo and redo through saves and full-graph navigation', async () => {
  await append(firstDraft);
  await openNote(secondFile);
  await append(secondDraft);
  await openNote(firstFile);
  await expect.poll(source).toBe(first + firstDraft);
  await undo();
  await expect.poll(source).toBe(first);

  // The redo-only state must survive a different note and then a graph mount.
  await openNote(secondFile);
  await expect.poll(source).toBe(second + secondDraft);
  await undo();
  await expect.poll(source).toBe(second);
  await redo();
  await openGraph();
  await graph().getByRole('button', { name: 'Open First note', exact: true }).click();
  await redo();
  await expect.poll(source).toBe(first + firstDraft);
  await saveFirst(first + firstDraft);
  await expect(status()).toContainText('1 unsaved note');

  await openGraph();
  await page.getByRole('button', { name: 'Back to note', exact: true }).click();
  await undo();
  await expect.poll(source).toBe(first);
  expect(await readPublished(firstFile)).toBe(diskFirst(first + firstDraft));
  await redo();
  await expect.poll(source).toBe(first + firstDraft);
  await openNote(secondFile);
  await undo();
  await expect.poll(source).toBe(second);
  await expect(status()).toContainText('All changes saved');
  expect(await readPublished(secondFile)).toBe(second);
  expect(pageErrors).toEqual([]);
});

test('cancel keeps both histories and accepted discard clears active and inactive histories', async () => {
  await append(firstDraft);
  await openNote(secondFile);
  await append(secondDraft);
  await page.getByRole('button', { name: 'Refresh notebook', exact: true }).click();
  await prompt().getByRole('button', { name: 'Cancel', exact: true }).click();
  await undo();
  await expect.poll(source).toBe(second);
  await redo();
  await expect.poll(source).toBe(second + secondDraft);
  await openNote(firstFile);
  await undo();
  await expect.poll(source).toBe(first);
  await redo();
  await expect.poll(source).toBe(first + firstDraft);

  // Same path and identical saved bytes are still a deliberate reset boundary.
  await page.getByRole('button', { name: 'Refresh notebook', exact: true }).click();
  await prompt().getByRole('button', { name: 'Discard changes', exact: true }).click();
  await expect(prompt()).toHaveCount(0);
  await expect(status()).toContainText('All changes saved');
  await expectNoHistory(first);
  await openNote(secondFile);
  await expectNoHistory(second);
  await openGraph();
  await page.getByRole('button', { name: 'Back to note', exact: true }).click();
  await expectNoHistory(second);
  expect(await readPublished(firstFile)).toBe(diskFirst(first));
  expect(await readPublished(secondFile)).toBe(second);
  expect(pageErrors).toEqual([]);
});

test('notebook replacement with identical paths and bytes cannot inherit inactive redo', async () => {
  await append(firstDraft);
  await undo();
  await expect.poll(source).toBe(first);
  await openNote(secondFile);
  await append(secondDraft);
  await undo();
  await expect.poll(source).toBe(second);
  await expect(status()).toContainText('All changes saved');

  await desktop!.evaluate(({ dialog }, directory) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [directory] });
  }, nextNotebook);
  await page.getByRole('button', { name: 'Open notebook', exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.prism.loadWorkspace().then(workspace => workspace.path))).toBe(nextNotebook);
  await expect(page.getByRole('button', { name: 'Open notebook', exact: true })).toHaveAttribute('title', nextNotebook);
  await expectNoHistory(second);
  await openNote(firstFile);
  await expectNoHistory(first);
  await expect(status()).toContainText('All changes saved');
  expect(await readPublished(firstFile)).toBe(diskFirst(first));
  expect(await readPublished(secondFile)).toBe(second);
  expect(await readPublished(firstFile, nextNotebook)).toBe(diskFirst(first));
  expect(pageErrors).toEqual([]);
});

test('ordinary saves retain undo, while accepted refresh and application restart reset it', async () => {
  await append(firstDraft);
  await saveFirst(first + firstDraft);
  await openNote(secondFile);
  await openNote(firstFile);
  await undo();
  await expect.poll(source).toBe(first);
  await redo();
  await expect.poll(source).toBe(first + firstDraft);

  // A clean refresh has no prompt but must reset the current saved undo stack.
  await page.getByRole('button', { name: 'Refresh notebook', exact: true }).click();
  await expect(status()).not.toContainText('Working…');
  await expectNoHistory(first + firstDraft);
  await append(' Another saved edit.');
  await saveFirst(first + firstDraft + ' Another saved edit.');
  await stop();
  await launch();
  await expectNoHistory(first + firstDraft + ' Another saved edit.');
  await expect(status()).toContainText('All changes saved');
  expect(pageErrors).toEqual([]);
});

test('restores long-note selection and scroll after note and graph round trips', async () => {
  await openNote('Long note.md');
  await append(firstDraft);
  await editor().press('Shift+Home');
  await expect.poll(() => page.evaluate(() => window.getSelection()?.toString())).toBe(firstDraft);
  const scroll = () => page.locator('.editor-host .cm-scroller').evaluate(element => element.scrollTop);
  await expect.poll(scroll).toBeGreaterThan(1_000);
  const rememberedScroll = await scroll();
  const cursor = await status().locator('span').filter({ hasText: /^Ln \d+, Col \d+$/ }).innerText();

  for (const destination of ['note', 'graph', 'read-graph']) {
    if (destination === 'note') {
      await openNote(secondFile);
      await openNote('Long note.md');
    } else {
      if (destination === 'read-graph') {
        await mode('Read').click();
        await expect(editor()).toBeHidden();
      }
      await openGraph();
      await page.getByRole('button', { name: 'Back to note', exact: true }).click();
      if (destination === 'read-graph') {
        // The old editor is hidden while captured and its replacement starts
        // hidden too. Showing Source must restore the earlier visible state.
        await expect(mode('Read')).toHaveAttribute('aria-pressed', 'true');
        await expect(editor()).toBeHidden();
        await mode('Source').click();
      }
    }
    // Check restoration before focus can influence scrolling. App workspace
    // focus restoration uses preventScroll, as does CodeMirror's focus API.
    await expect.poll(async () => Math.abs(await scroll() - rememberedScroll)).toBeLessThan(3);
    await editor().evaluate(element => element.focus({ preventScroll: true }));
    await expect.poll(() => page.evaluate(() => window.getSelection()?.toString())).toBe(firstDraft);
    await expect(status()).toContainText(cursor);
    await expect.poll(async () => Math.abs(await scroll() - rememberedScroll)).toBeLessThan(3);
  }
  await undo();
  await expect(editor()).not.toContainText(firstDraft);
  await expect(status()).toContainText('All changes saved');
  expect(await readPublished('Long note.md')).toBe(long);
  expect(pageErrors).toEqual([]);
});

test('restored editors use current Live mode, theme, snippets and note-link callbacks', async () => {
  await append(firstDraft);
  await openNote(secondFile);
  await mode('Live').click();
  await page.getByRole('button', { name: 'Window appearance', exact: true }).click();
  const appearance = page.getByRole('dialog', { name: 'Make a little space', exact: true });
  await appearance.getByRole('radio', { name: 'Paper theme', exact: true }).check();
  await appearance.getByRole('slider', { name: 'Text size', exact: true }).fill('150');
  await appearance.getByRole('button', { name: 'Done', exact: true }).click();
  await page.getByRole('button', { name: 'Snippet help', exact: true }).click();
  const snippets = page.getByRole('dialog', { name: 'Markdown snippets', exact: true });
  await snippets.getByRole('button', { name: 'Add snippet', exact: true }).click();
  await snippets.getByLabel('Name', { exact: true }).fill('Restored session');
  await snippets.getByLabel('Shortcut', { exact: true }).fill('/retained');
  await snippets.getByLabel('Template', { exact: true }).fill('${1:現在の設定}${0}');
  await snippets.getByRole('button', { name: 'Save snippet', exact: true }).click();
  await snippets.getByRole('button', { name: 'Done', exact: true }).click();
  await openNote(firstFile);
  await expect(editor()).toHaveAttribute('aria-label', 'Live Markdown editor');
  await expect(page.locator('.app-shell')).toHaveAttribute('data-theme', 'paper');
  await expect.poll(() => editor().evaluate(element => parseFloat(getComputedStyle(element).fontSize))).toBe(21);
  await undo();
  await expect(editor()).not.toContainText(firstDraft);
  await redo();
  await expect(editor()).toContainText(firstDraft);
  await append('\n\n');
  await editor().pressSequentially('/retained');
  await editor().press('Tab');
  await expect.poll(() => page.evaluate(() => window.getSelection()?.toString())).toBe('現在の設定');
  await page.keyboard.insertText('復元後の編集');
  await editor().press('Tab');
  await expect(editor()).toContainText('復元後の編集');
  await editor().press('ControlOrMeta+Home');
  await editor().press('ArrowDown');
  const link = editor().locator('a.cm-live-link').filter({ hasText: /^Second note$/ });
  await expect(link).toBeVisible();
  await link.click({ modifiers: ['Control'] });
  await expect(page.locator('.note-heading h1')).toHaveText('Second note');
  await openNote(firstFile);
  await expect(editor()).toContainText('復元後の編集');
  await undo();
  await expect(editor()).toContainText('現在の設定');
  expect(await readPublished(firstFile)).toBe(diskFirst(first));
  expect(await readPublished(secondFile)).toBe(second);
  expect(pageErrors).toEqual([]);
});

test('records restored Japanese/math navigation cost without a timing threshold', async ({}, testInfo) => {
  const timings: { mode: string; destination: string; milliseconds: number }[] = [];
  await page.evaluate(() => {
    const state = { tasks: [] as number[], observer: undefined as PerformanceObserver | undefined };
    state.observer = new PerformanceObserver(list => {
      for (const entry of list.getEntries()) state.tasks.push(entry.duration);
    });
    state.observer.observe({ type: 'longtask', buffered: false });
    (window as unknown as { historyNavigationProbe: typeof state }).historyNavigationProbe = state;
  });
  for (const presentation of ['Source', 'Live']) {
    await mode(presentation).click();
    await openNote('Navigation profile.md');
    await append('Navigation draft remains available.');
    await openNote(secondFile);
    for (let cycle = 0; cycle < 4; cycle++) {
      for (const destination of ['Navigation profile.md', secondFile]) {
        const started = await page.evaluate(() => performance.now());
        await openNote(destination);
        await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
        const finished = await page.evaluate(() => performance.now());
        timings.push({ mode: presentation, destination, milliseconds: finished - started });
      }
    }
    await openNote('Navigation profile.md');
    await editor().focus();
    await editor().press('ControlOrMeta+End');
    await expect(editor()).toContainText('Navigation draft remains available.');
    await undo();
    if (presentation === 'Source') await expect(editor()).not.toContainText('Navigation draft remains available.');
    await openNote(secondFile);
  }
  const longTasks = await page.evaluate(() => {
    const state = (window as unknown as { historyNavigationProbe: { tasks: number[]; observer: PerformanceObserver } }).historyNavigationProbe;
    state.observer.disconnect();
    return state.tasks;
  });
  await testInfo.attach('Japanese math navigation timings', { contentType: 'application/json', body: JSON.stringify({
    fixtureBytes: Buffer.byteLength(profile), fixtureLines: profile.split('\n').length,
    timings, rendererTasksOver50ms: longTasks,
    limitations: 'Synthetic disposable note. Timings include automation, navigation, parsing, and rendering; no wall-clock assertion or physical input claim.',
  }, null, 2) });
  expect(await readPublished('Navigation profile.md')).toBe(profile);
  expect(pageErrors).toEqual([]);
});
