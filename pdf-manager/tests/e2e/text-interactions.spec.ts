import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { electronLaunchArguments } from '../../../scripts/electron-launch.mjs';
import { interactionPdf } from '../../../tests/fixtures/pdf-interactions';

test('standalone PDF reader selects, copies, searches and follows safe links', async ({}, testInfo) => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'prism-pdf-text-standalone-'));
  const source = path.join(temporary, 'Interactive reference.pdf');
  const bytes = interactionPdf();
  const errors: string[] = [];
  const requests: string[] = [];
  let desktop: ElectronApplication | undefined;
  let page: Page | undefined;
  try {
    await writeFile(source, bytes);
    const applicationRoot = path.resolve(process.env.PRISM_TEST_PDF_APP_ROOT || 'pdf-manager');
    const env: Record<string, string> = {
      ...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)),
      PRISM_PDF_USER_DATA: path.join(temporary, 'profile'),
    };
    delete env.ELECTRON_RUN_AS_NODE;
    desktop = await electron.launch({ executablePath: process.env.PRISM_TEST_ELECTRON,
      args: electronLaunchArguments(['--no-sandbox', applicationRoot]), cwd: applicationRoot, env });
    page = await desktop.firstWindow();
    page.on('pageerror', error => errors.push(error.message));
    page.on('request', request => { if (/^https?:/.test(request.url())) requests.push(request.url()); });
    await expect(page.getByRole('heading', { name: 'All documents', exact: true })).toBeVisible();
    await page.setViewportSize({ width: 1440, height: 1000 });
    await desktop.evaluate(async ({ clipboard, dialog, shell }, filename) => {
      // Preserve every clipboard format in memory, including native images.
      const state = { previous: await clipboard.read(), external: [] as string[] };
      Object.assign(globalThis, { standalonePDFTextTest: state });
      shell.openExternal = async url => { state.external.push(url); };
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [filename] });
    }, source);
    await page.getByRole('button', { name: 'Import PDFs', exact: true }).click();
    await page.getByRole('button', { name: 'Open Interactive reference', exact: true }).click();
    const reader = page.locator('.pdf-reader');
    const textLayer = reader.locator('.pdf-text-layer');
    const links = reader.locator('.pdf-link-layer');
    const viewport = reader.getByLabel('PDF page viewport', { exact: true });
    const readingAreaBounds = () => viewport.evaluate(element => {
      const box = element.getBoundingClientRect();
      return { top: box.top, left: box.left, width: box.width, height: box.height };
    });
    async function renderedPage(number: number) {
      await expect(reader.locator('.pdf-paper canvas')).toHaveAttribute('data-page-number', String(number));
      await expect(reader.locator('.pdf-paper')).toHaveAttribute('aria-busy', 'false');
      await expect(textLayer).toBeAttached();
      await expect(reader.locator('.pdf-reader-tools')).toHaveCount(0);
      await expect(reader.getByRole('button', { name: 'Copy selected text', exact: true })).toHaveCount(0);
    }
    await renderedPage(1);
    await expect(reader.getByRole('button', { name: 'Find in PDF', exact: true })).toHaveCount(0);
    await expect(reader.locator('.pdf-find-bar')).toBeHidden();
    const readingArea = await readingAreaBounds();

    const line = textLayer.getByText('Selectable copy text.', { exact: true });
    await expect(line).toBeVisible();
    const bounds = await line.boundingBox();
    if (!bounds) throw new Error('The selectable PDF line has no bounds.');
    await page.mouse.move(bounds.x + 0.5, bounds.y + bounds.height / 2);
    await page.mouse.down();
    await page.mouse.move(bounds.x + bounds.width - 0.5, bounds.y + bounds.height / 2, { steps: 12 });
    await page.mouse.up();
    await expect.poll(() => page!.evaluate(() => window.getSelection()?.toString())).toBe('Selectable copy text.');
    await expect(reader.locator('.pdf-reader-tools')).toHaveCount(0);
    await expect(reader.getByRole('button', { name: 'Copy selected text', exact: true })).toHaveCount(0);
    await page.keyboard.press('ControlOrMeta+c');
    await expect.poll(() => desktop!.evaluate(({ clipboard }) => clipboard.readText())).toBe('Selectable copy text.');
    expect(await readingAreaBounds()).toEqual(readingArea);

    await viewport.focus();
    await page.keyboard.press('F3');
    await expect(reader.locator('.pdf-find-bar')).toBeHidden();
    await page.keyboard.press('ControlOrMeta+f');
    const find = reader.getByLabel('Find text in PDF', { exact: true });
    await expect(find).toBeFocused();
    await find.fill('NEEDLE');
    await expect(reader.locator('.pdf-find-status')).toContainText('1 of 2 matches');
    await expect(reader.locator('.pdf-search-highlight[data-current="true"]')).toHaveCount(1);
    await find.press('Enter');
    await renderedPage(2);
    await expect(reader.locator('.pdf-find-status')).toContainText('2 of 2 matches');
    await expect(reader.locator('.pdf-search-highlight[data-current="true"]')).toHaveCount(1);
    await reader.getByRole('button', { name: 'Previous match', exact: true }).press('Escape');
    await expect(reader.locator('.pdf-find-bar')).toBeHidden();
    await expect(viewport).toBeFocused();
    await page.keyboard.press('F3');
    await expect(reader.locator('.pdf-find-bar')).toBeHidden();
    await page.keyboard.press('ControlOrMeta+f');
    await expect(find).toBeFocused();
    await expect(find).toHaveValue('NEEDLE');
    await expect(reader.locator('.pdf-find-status')).toContainText('2 of 2 matches');
    await renderedPage(2);
    await reader.getByRole('button', { name: 'Close PDF search', exact: true }).click();
    await links.getByRole('link', { name: 'First page', exact: true }).click();
    await renderedPage(1);

    const mainURL = page.url();
    await expect(links.locator('a')).toHaveCount(4);
    await links.getByRole('link', { name: 'https://example.com/prism', exact: true }).click();
    await expect.poll(() => desktop!.evaluate(() =>
      (globalThis as typeof globalThis & { standalonePDFTextTest: { external: string[] } }).standalonePDFTextTest.external,
    )).toEqual(['https://example.com/prism']);
    expect(page.url()).toBe(mainURL);
    await expect(links.locator('a[href^="javascript:"], a[href^="file:"]')).toHaveCount(0);
    await links.getByRole('link', { name: 'Go to ChapterTwo', exact: true }).click();
    await renderedPage(2);
    await expect(textLayer).toContainText('Chapter two');
    await links.getByRole('link', { name: 'Go to linked page', exact: true }).click();
    await renderedPage(3);
    await viewport.focus();
    await page.keyboard.press('ControlOrMeta+f');
    await find.fill('');
    await expect(reader.locator('.pdf-find-status')).toContainText('No selectable text on this page');
    expect(await readFile(source)).toEqual(bytes);
    expect(requests).toEqual([]);
    expect(errors).toEqual([]);
  } catch (error) {
    if (page && !page.isClosed()) {
      const screenshot = await page.screenshot().catch(() => undefined);
      if (screenshot) await testInfo.attach('Standalone PDF text at failure', { body: screenshot, contentType: 'image/png' });
    }
    throw error;
  } finally {
    if (desktop) {
      // Restore clipboard contents before shutting down; never serialize the
      // user's original clipboard into test output or an artifact.
      await desktop.evaluate(async ({ clipboard }) => {
        const state = (globalThis as typeof globalThis & {
          standalonePDFTextTest?: { previous: Electron.ClipboardItem[] };
        }).standalonePDFTextTest;
        if (state?.previous.length) await clipboard.write(state.previous);
        else if (state) await clipboard.clear();
      }).catch(() => undefined);
      const child = desktop.process();
      const closed = desktop.waitForEvent('close', { timeout: 5_000 }).catch(() => undefined);
      await desktop.evaluate(({ app }) => app.exit(0)).catch(() => undefined);
      await closed;
      if (child.exitCode === null) child.kill();
    }
    await rm(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
