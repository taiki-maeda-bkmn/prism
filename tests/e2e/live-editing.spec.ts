import { electronLaunchArguments } from '../../scripts/electron-launch.mjs';
import { _electron as electron, expect, test, type ElectronApplication, type Locator, type Page } from '@playwright/test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const welcome = '# Live practice\n\n';
const windows = '\ufeff# Windows note\r\n\r\n';
const longNote = '# Long note\n\n' + Array.from({ length: 2_400 }, (_, index) => `Paragraph ${index + 1} gives this note room to scroll.\n\n`).join('') + '## Far destination\n\nThe last paragraph.\n';
let temporary: string;
let notebook: string;
let userData: string;
let desktop: ElectronApplication | undefined;
let page: Page;

const liveEditor = () => page.getByLabel('Live Markdown editor', { exact: true });
const sourceEditor = () => page.getByLabel('Markdown source', { exact: true });
const cursor = () => page.locator('.statusbar span').filter({ hasText: /^Ln \d+, Col \d+$/ });
// Save publication briefly moves the old note aside before publishing its replacement.
async function readPublishedNote(name: string) {
  try { return await readFile(path.join(notebook, name), 'utf8'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
}

const mode = (name: string) => page.getByRole('group', { name: 'Editor mode', exact: true }).getByRole('button', { name, exact: true });

async function launch() {
  desktop = await electron.launch({
    args: electronLaunchArguments(['--no-sandbox', '.']), cwd: process.cwd(),
    env: { ...process.env, PRISM_USER_DATA: userData, PRISM_WORKSPACE: notebook },
  });
  page = await desktop.firstWindow();
  await expect(page.locator('.note-heading h1')).toBeVisible();
  await expect.poll(() => desktop!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible())).toBe(true);
}

async function closeTestApp() {
  if (!desktop) return;
  // This process owns a temporary profile and never shares the user's notebook.
  const child = desktop.process();
  const closed = desktop.waitForEvent('close', { timeout: 5_000 }).catch(() => undefined);
  await desktop.evaluate(({ app }) => app.exit(0)).catch(() => undefined);
  await closed;
  if (child.exitCode === null) child.kill();
  desktop = undefined;
}

async function clickTextBoundary(line: Locator, offset: number) {
  await line.scrollIntoViewIfNeeded();
  const point = await line.evaluate((element, boundary) => {
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    let remaining = boundary;
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (remaining > node.textContent!.length) { remaining -= node.textContent!.length; continue; }
      const range = document.createRange();
      range.setStart(node, remaining);
      range.collapse(true);
      const rect = range.getBoundingClientRect();
      return { x: rect.x, y: rect.y + rect.height / 2 };
    }
    throw new Error('The rendered text boundary is missing.');
  }, offset);
  await page.mouse.click(point.x, point.y);
}

test.beforeEach(async () => {
  temporary = await mkdtemp(path.join(os.tmpdir(), 'prism-live-editing-test-'));
  notebook = path.join(temporary, 'Notebook');
  userData = path.join(temporary, 'profile');
  await Promise.all([mkdir(notebook), mkdir(userData)]);
  await Promise.all([
    writeFile(path.join(notebook, 'Welcome to Prism.md'), welcome),
    writeFile(path.join(notebook, 'Windows note.md'), windows),
    writeFile(path.join(notebook, 'Long note.md'), longNote),
  ]);
  await launch();
});

test.afterEach(async ({}, testInfo) => {
  if (page && !page.isClosed() && testInfo.status !== testInfo.expectedStatus) {
    const screenshot = await page.screenshot().catch(() => undefined);
    if (screenshot) await testInfo.attach('Live editing at failure', { body: screenshot, contentType: 'image/png' });
  }
  await closeTestApp();
  if (temporary) await rm(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

test('formats while typing, edits rendered text, and retains cursor and undo across every mode', async ({}, testInfo) => {
  await mode('Live').click();
  await expect(liveEditor()).toBeVisible();
  await expect(page.locator('.statusbar')).toContainText('All changes saved');
  await liveEditor().focus();
  await liveEditor().press('ControlOrMeta+A');
  await page.keyboard.insertText('# A title');
  const heading = liveEditor().locator('.cm-live-heading-1');
  await expect(heading).toHaveText('# A title');
  const bodySize = await liveEditor().evaluate(element => parseFloat(getComputedStyle(element).fontSize));
  await expect.poll(() => heading.evaluate(element => parseFloat(getComputedStyle(element).fontSize))).toBeGreaterThan(bodySize * 1.4);

  await page.keyboard.insertText('\n\nBody **bold** and *soft*.\n\nA plain paragraph.');
  await expect(heading).toHaveText('A title');
  await clickTextBoundary(heading, 'A '.length);
  await page.keyboard.insertText('new ');
  await expect(heading).toHaveText('# A new title');
  const saved = '# A new title\n\nBody **bold** and *soft*.\n\nA plain paragraph.';
  await liveEditor().press('ControlOrMeta+s');
  await expect.poll(() => readPublishedNote('Welcome to Prism.md')).toBe(saved);
  await expect(page.locator('.statusbar')).toContainText('All changes saved');
  const position = await cursor().innerText();

  for (const name of ['Source', 'Split', 'Read', 'Live']) {
    await mode(name).click();
    await expect(mode(name)).toHaveAttribute('aria-pressed', 'true');
    await expect(cursor()).toHaveText(position);
    await expect(page.locator('.statusbar')).toContainText('All changes saved');
  }
  await liveEditor().focus();
  await liveEditor().press('ControlOrMeta+z');
  await expect(heading).toHaveText('# A title');
  await liveEditor().press(process.platform === 'darwin' ? 'Meta+Shift+Z' : 'Control+y');
  await expect(heading).toHaveText('# A new title');
  await expect(page.locator('.statusbar')).toContainText('All changes saved');

  await mode('Source').click();
  await expect(sourceEditor().locator('.cm-live-heading-1')).toHaveCount(0);
  await expect.poll(async () => (await sourceEditor().locator('.cm-line').allTextContents()).join('\n')).toBe(saved);
  expect(await sourceEditor().locator('.cm-line').first().evaluate(element => parseFloat(getComputedStyle(element).fontSize))).toBeCloseTo(bodySize, 1);
  await mode('Live').click();
  await liveEditor().press('ControlOrMeta+Home');
  await liveEditor().press('ArrowDown');
  await expect(heading).toHaveText('A new title');
  await expect(liveEditor().locator('.cm-live-strong')).toHaveText('bold');

  for (const theme of ['Paper', 'Sci-fi']) {
    await page.getByRole('button', { name: 'Window appearance', exact: true }).click();
    const appearance = page.getByRole('dialog', { name: 'Make a little space', exact: true });
    await appearance.getByRole('radio', { name: `${theme} theme`, exact: true }).check();
    await appearance.getByRole('button', { name: 'Done', exact: true }).click();
    const plainLine = liveEditor().locator('.cm-line').filter({ hasText: /^A plain paragraph\.$/ });
    await clickTextBoundary(plainLine, 'A plain '.length);
    await page.keyboard.insertText('|');
    await expect(liveEditor()).toContainText('A plain |paragraph.');
    await liveEditor().press('ControlOrMeta+z');
    await expect(plainLine).toBeVisible();
    await expect(page.locator('.statusbar')).toContainText('All changes saved');
  }

  // Exercise composition event handling and Unicode insertion without claiming
  // to automate the operating system's IME candidate window.
  await liveEditor().press('ControlOrMeta+End');
  await liveEditor().evaluate(element => {
    const target = (element as HTMLElement & { editContext?: EventTarget }).editContext ?? element;
    target.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
  });
  await page.keyboard.insertText('\n\n**日本語**');
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  await liveEditor().evaluate(element => {
    const target = (element as HTMLElement & { editContext?: EventTarget }).editContext ?? element;
    target.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '日本語' }));
  });
  await expect(liveEditor().locator('.cm-live-strong').last()).toHaveText('**日本語**');
  await liveEditor().press('ArrowUp');
  await expect(liveEditor().locator('.cm-live-strong').last()).toHaveText('日本語');
  await liveEditor().press('ControlOrMeta+A');
  await expect.poll(() => page.evaluate(() => window.getSelection()?.toString())).toBe(saved + '\n\n**日本語**');
  // A synthetic copy event exercises CodeMirror's clipboard serialization
  // without reading or replacing anything in the user's system clipboard.
  const copied = await liveEditor().evaluate(element => {
    const clipboardData = new DataTransfer();
    element.dispatchEvent(new ClipboardEvent('copy', { bubbles: true, cancelable: true, clipboardData }));
    return clipboardData.getData('text/plain');
  });
  expect(copied).toBe(saved + '\n\n**日本語**');
  await liveEditor().press('ControlOrMeta+z');
  await expect(page.locator('.statusbar')).toContainText('All changes saved');
  await expect(liveEditor()).not.toContainText('日本語');
  expect(await readFile(path.join(notebook, 'Welcome to Prism.md'), 'utf8')).toBe(saved);
  await testInfo.attach('Direct Markdown editing', { body: await page.screenshot({ path: testInfo.outputPath('live-editing.png') }), contentType: 'image/png' });

  await page.setViewportSize({ width: 800, height: 600 });
  await expect.poll(() => page.evaluate(() => ({ width: innerWidth, height: innerHeight }))).toEqual({ width: 800, height: 600 });
  for (const theme of ['Prism', 'Paper', 'Sci-fi']) {
    await page.getByRole('button', { name: 'Window appearance', exact: true }).click();
    const appearance = page.getByRole('dialog', { name: 'Make a little space', exact: true });
    await appearance.getByRole('radio', { name: `${theme} theme`, exact: true }).check();
    if (theme === 'Prism') {
      const textSize = appearance.getByRole('slider', { name: 'Text size', exact: true });
      await textSize.focus();
      await textSize.press('End');
      await expect(textSize).toHaveValue('150');
      await appearance.getByRole('switch', { name: 'Transparent window', exact: true }).click();
      const opacity = appearance.getByRole('slider', { name: 'Background opacity', exact: true });
      await opacity.focus();
      await opacity.press('Home');
      for (let step = 0; step < 10; step++) await opacity.press('ArrowRight');
      await expect(opacity).toHaveValue('35');
    }
    await appearance.getByRole('button', { name: 'Done', exact: true }).click();
    await expect(mode('Live')).toBeInViewport();
    await expect(liveEditor()).toBeInViewport();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    const bounds = await page.locator('.note-heading').boundingBox();
    if (!bounds) throw new Error('The note heading is not visible.');
    const pixel = { x: Math.round(bounds.x + 4), y: Math.round(bounds.y + 4), width: 1, height: 1 };
    const alpha = () => desktop!.evaluate(async ({ BrowserWindow }, rectangle) => {
      const image = await BrowserWindow.getAllWindows()[0].webContents.capturePage(rectangle);
      return image.toBitmap({ scaleFactor: 1 })[3];
    }, pixel);
    await expect.poll(alpha).toBeGreaterThan(80);
    await expect.poll(alpha).toBeLessThan(100);
    await liveEditor().press('ControlOrMeta+Home');
    await liveEditor().press('ArrowDown');
    await testInfo.attach(`${theme} Live editing at 150% in a small window`, {
      body: await page.screenshot({ path: testInfo.outputPath(`${theme.toLowerCase()}-live-small.png`) }), contentType: 'image/png',
    });
  }
  await expect(page.locator('.message-banner.error')).toHaveCount(0);
});

test('expands snippets in Live mode, saves Windows text exactly, and remembers the mode after restart', async () => {
  await page.getByRole('navigation', { name: 'Notes', exact: true }).getByRole('button', { name: 'Windows note', exact: true }).click();
  await page.keyboard.press('ControlOrMeta+4');
  await expect(mode('Live')).toHaveAttribute('aria-pressed', 'true');
  await liveEditor().focus();
  await liveEditor().press('ControlOrMeta+End');
  await liveEditor().pressSequentially('/h1');
  await liveEditor().press('Tab');
  await expect.poll(() => page.evaluate(() => window.getSelection()?.toString())).toBe('Heading');
  await page.keyboard.insertText('Written live');
  await liveEditor().press('Tab');
  await expect(liveEditor().locator('.cm-live-heading-1').last()).toHaveText('Written live');
  await liveEditor().press('ControlOrMeta+s');
  const saved = windows + '# Written live\r\n';
  await expect.poll(() => readPublishedNote('Windows note.md')).toBe(saved);
  await expect(page.locator('.statusbar')).toContainText('All changes saved');
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('prism.preferences')!).mode)).toBe('live');

  await closeTestApp();
  await launch();
  await expect(mode('Live')).toHaveAttribute('aria-pressed', 'true');
  await expect(liveEditor()).toBeVisible();
  await expect(page.locator('.statusbar')).toContainText('All changes saved');
  expect(await readFile(path.join(notebook, 'Windows note.md'), 'utf8')).toBe(saved);
  for (const [shortcut, name] of [['1', 'Source'], ['2', 'Split'], ['3', 'Read'], ['4', 'Live']]) {
    await page.keyboard.press(`ControlOrMeta+${shortcut}`);
    await expect(mode(name)).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('.statusbar')).toContainText('All changes saved');
  }
});

test('outline navigation scrolls a long Live document to its editable heading', async () => {
  await page.getByRole('navigation', { name: 'Notes', exact: true }).getByRole('button', { name: 'Long note', exact: true }).click();
  await mode('Live').click();
  await page.getByRole('navigation', { name: 'Note outline', exact: true }).getByRole('button', { name: 'Far destination', exact: true }).click();
  await expect(mode('Live')).toHaveAttribute('aria-pressed', 'true');
  const target = liveEditor().locator('.cm-live-heading-2').filter({ hasText: 'Far destination' });
  await expect(target).toBeInViewport();
  await expect(page.locator('.statusbar')).toContainText('All changes saved');
  await liveEditor().press('End');
  await page.keyboard.insertText(' updated');
  await liveEditor().press('ControlOrMeta+s');
  await expect.poll(() => readPublishedNote('Long note.md')).toBe(longNote.replace('## Far destination', '## Far destination updated'));
  await expect(page.locator('.message-banner.error')).toHaveCount(0);
});
