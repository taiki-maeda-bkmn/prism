import { electronLaunchArguments } from '../../scripts/electron-launch.mjs';
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const paragraphs = Array.from({ length: 30 }, (_, index) => `Paragraph ${index + 1} leaves room to scroll before the requested section.\n\n`).join('');
const initial = '# Link practice\n\n'
  + '[**Linked section**](Linked%20note.md#target-heading)\n\n'
  + '[Reference section][guide]\n\n'
  + '[[Linked note#Target heading|Wiki section]]\n\n'
  + '| Jump |\n| --- |\n| [Table section](Linked%20note.md#target-heading) |\n\n'
  + '[Same-note section](#local-section)\n\n'
  + '[Web site](https://example.com/one?from=prism#here)\n\n'
  + '[Mail author](mailto:author@example.com?subject=Hello%20Prism)\n\n'
  + '[Protocol site](//example.com/relative)\n\n'
  + '[guide]: Linked%20note.md#target-heading "Referenced target"\n\n'
  + paragraphs + '## Local section\n\nThe same-note destination.\n';
const linked = '# Linked note\n\n' + paragraphs + '## Target heading\n\nThe linked destination.\n';
const diskText = (content: string) => '\ufeff' + content.replace(/\n/g, '\r\n');
let temporary: string;
let notebook: string;
let desktop: ElectronApplication | undefined;
let page: Page;
let pageErrors: string[];

const editor = () => page.getByLabel('Live Markdown editor', { exact: true });
const mode = (name: string) => page.getByRole('group', { name: 'Editor mode', exact: true }).getByRole('button', { name, exact: true });
const link = (name: string) => editor().locator('a.cm-live-link').filter({ hasText: new RegExp(`^${name}$`) });
const linkLine = (name: string) => editor().locator('.cm-line').filter({ has: page.locator('a.cm-live-link').filter({ hasText: new RegExp(`^${name}$`) }) });

async function showLinks() {
  await editor().focus();
  await editor().press('ControlOrMeta+Home');
  await editor().press('ArrowDown');
  await expect(link('Linked section')).toBeVisible();
}

async function returnToWelcome() {
  await page.getByRole('navigation', { name: 'Notes', exact: true }).getByTitle('Welcome to Prism.md', { exact: true }).click();
  await expect(page.locator('.note-heading h1')).toHaveText('Link practice');
  await expect(mode('Live')).toHaveAttribute('aria-pressed', 'true');
  await showLinks();
}

async function expectHeading(title: string) {
  const heading = editor().locator('.cm-live-heading-2').filter({ hasText: title });
  await expect(heading).toBeInViewport();
  await expect.poll(() => page.locator('.editor-host .cm-scroller').evaluate(element => element.scrollTop)).toBeGreaterThan(200);
}

async function saveAndExpect(content: string) {
  // Undo may already have returned to the saved bytes, disabling the button.
  await page.keyboard.press('ControlOrMeta+s');
  await expect(page.locator('.statusbar')).toContainText('All changes saved');
  await expect.poll(async () => {
    try { return await readFile(path.join(notebook, 'Welcome to Prism.md'), 'utf8'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
  }).toBe(diskText(content));
}

test.beforeEach(async () => {
  temporary = await mkdtemp(path.join(os.tmpdir(), 'prism-live-links-test-'));
  notebook = path.join(temporary, 'Notebook');
  const userData = path.join(temporary, 'profile');
  await Promise.all([mkdir(notebook), mkdir(userData)]);
  await Promise.all([
    writeFile(path.join(notebook, 'Welcome to Prism.md'), diskText(initial)),
    writeFile(path.join(notebook, 'Linked note.md'), linked),
  ]);
  desktop = await electron.launch({
    args: electronLaunchArguments(['--no-sandbox', '.']), cwd: process.cwd(),
    env: { ...process.env, PRISM_USER_DATA: userData, PRISM_WORKSPACE: notebook },
  });
  page = await desktop.firstWindow();
  pageErrors = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  await expect(page.locator('.note-heading h1')).toHaveText('Link practice');
  await expect.poll(() => desktop!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible())).toBe(true);
  await mode('Live').click();
  await showLinks();
});

test.afterEach(async ({}, testInfo) => {
  if (page && !page.isClosed() && testInfo.status !== testInfo.expectedStatus) {
    const screenshot = await page.screenshot().catch(() => undefined);
    if (screenshot) await testInfo.attach('Live links at failure', { body: screenshot, contentType: 'image/png' });
  }
  if (desktop) {
    // Only this test's isolated process, profile, and notebook are removed.
    const child = desktop.process();
    const closed = desktop.waitForEvent('close', { timeout: 5_000 }).catch(() => undefined);
    await desktop.evaluate(({ app }) => app.exit(0)).catch(() => undefined);
    await closed;
    if (child.exitCode === null) child.kill();
    desktop = undefined;
  }
  if (temporary) await rm(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

test('renders Markdown, reference, wiki, and table links and follows Ctrl-clicks to note sections', async ({}, testInfo) => {
  await expect(link('Linked section')).toHaveAttribute('href', 'Linked%20note.md#target-heading');
  await expect(link('Reference section')).toHaveAttribute('href', 'Linked%20note.md#target-heading');
  await expect(link('Wiki section')).toBeVisible();
  // The displayed label must not leak the URL, brackets, or emphasis delimiters.
  await expect(linkLine('Linked section')).toHaveText('Linked section');
  await expect(link('Linked section').locator('strong')).toHaveText('Linked section');

  for (const label of ['Linked section', 'Reference section', 'Wiki section', 'Table section']) {
    await link(label).click({ modifiers: ['Control'] });
    await expect(page.locator('.note-heading h1')).toHaveText('Linked note');
    await expect(mode('Live')).toHaveAttribute('aria-pressed', 'true');
    await expectHeading('Target heading');
    await returnToWelcome();
  }
  for (let attempt = 0; attempt < 2; attempt++) {
    await link('Same-note section').click({ modifiers: ['Control'] });
    await expect(page.locator('.note-heading h1')).toHaveText('Link practice');
    await expectHeading('Local section');
    await showLinks();
  }
  await expect(page.locator('.statusbar')).toContainText('All changes saved');
  expect(await readFile(path.join(notebook, 'Welcome to Prism.md'), 'utf8')).toBe(diskText(initial));
  expect(await readFile(path.join(notebook, 'Linked note.md'), 'utf8')).toBe(linked);
  await testInfo.attach('Rendered links in Live mode', {
    body: await page.screenshot({ path: testInfo.outputPath('live-links.png') }), contentType: 'image/png',
  });
  expect(pageErrors).toEqual([]);
});

test('ordinary clicks edit source and links remain correct after preceding edits, mode changes, save, and undo', async () => {
  await link('Linked section').click();
  await expect(page.locator('.note-heading h1')).toHaveText('Link practice');
  const sourceLine = editor().locator('.cm-line').filter({ hasText: '[**Linked section**](Linked%20note.md#target-heading)' });
  await expect(sourceLine).toBeVisible();
  await editor().press('Home');
  await page.keyboard.insertText('Before ');
  const edited = initial.replace('[**Linked section**]', 'Before [**Linked section**]');
  await showLinks();
  await expect(linkLine('Linked section')).toHaveText('Before Linked section');

  // The link must resolve its current position after source text moves it.
  await link('Linked section').click({ modifiers: ['Control'] });
  await expect(page.locator('.note-heading h1')).toHaveText('Linked note');
  await expectHeading('Target heading');
  await returnToWelcome();
  await expect(editor()).toContainText('Before Linked section');
  await saveAndExpect(edited);

  for (const name of ['Source', 'Split', 'Read', 'Live']) {
    await mode(name).click();
    await expect(page.locator('.statusbar')).toContainText('All changes saved');
  }
  await showLinks();
  await expect(link('Linked section')).toHaveAttribute('href', 'Linked%20note.md#target-heading');
  // Navigation destroys a note's editor, so test a fresh local edit for undo.
  // Its undo must never erase or replace the source of a rendered link.
  await showLinks();
  await link('Linked section').click();
  await editor().press('Home');
  await page.keyboard.insertText('Again ');
  await mode('Source').click();
  await mode('Live').click();
  await editor().focus();
  await editor().press('ControlOrMeta+z');
  await showLinks();
  await expect(linkLine('Linked section')).toHaveText('Before Linked section');
  await saveAndExpect(edited);
  expect(pageErrors).toEqual([]);
});

test('Ctrl-click opens web and email links externally while ordinary clicks remain editable', async () => {
  // Keep the renderer, preload bridge, IPC handler, and URL validation real.
  // Intercept only the operating-system handoff in this disposable application.
  const openedDestinations = await desktop!.evaluateHandle(({ shell }) => {
    const destinations: string[] = [];
    shell.openExternal = async (url) => { destinations.push(url); };
    return destinations;
  });
  const initialURL = page.url();
  await link('Web site').click();
  await expect(editor()).toContainText('[Web site](https://example.com/one?from=prism#here)');
  expect(await openedDestinations.jsonValue()).toEqual([]);
  expect(page.url()).toBe(initialURL);
  // Ctrl-click also works while the line is showing editable Markdown source.
  const activeLink = editor().locator('.cm-line').filter({ hasText: '[Web site](https://example.com/one?from=prism#here)' }).locator('a.cm-live-link');
  await activeLink.click({ modifiers: ['Control'] });
  const expected = ['https://example.com/one?from=prism#here'];
  await expect.poll(() => openedDestinations.jsonValue()).toEqual(expected);
  await showLinks();
  for (const destination of [
    { label: 'Web site', url: 'https://example.com/one?from=prism#here' },
    { label: 'Mail author', url: 'mailto:author@example.com?subject=Hello%20Prism' },
    { label: 'Protocol site', url: 'https://example.com/relative' },
  ]) {
    await link(destination.label).click({ modifiers: ['Control'] });
    expected.push(destination.url);
    await expect.poll(() => openedDestinations.jsonValue()).toEqual(expected);
    await expect(page.locator('.note-heading h1')).toHaveText('Link practice');
    await expect(page.locator('.message-banner')).toHaveCount(0);
    expect(page.url()).toBe(initialURL);
  }
  await expect(page.locator('.statusbar')).toContainText('All changes saved');
  expect(await readFile(path.join(notebook, 'Welcome to Prism.md'), 'utf8')).toBe(diskText(initial));
  await openedDestinations.dispose();
  expect(pageErrors).toEqual([]);
});
