import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { electronLaunchArguments } from '../../scripts/electron-launch.mjs';
import { fixturePdf } from '../fixtures/pdf';
import type { PDFDocument } from '../../pdf-manager/src/shared/types';

test('suggests library tags without duplicates, preserves surrounding tags and saves only on request', async ({}, testInfo) => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'prism-tag-suggestions-'));
  const notebook = path.join(temporary, 'notebook');
  const profile = path.join(temporary, 'pdf-profile');
  const catalogPath = path.join(profile, 'library/catalog.json');
  const bytes = fixturePdf();
  const documentBytes = (title: string) => Buffer.concat([bytes, Buffer.from(`\n% ${title}\n`)]);
  const errors: string[] = [];
  let desktop: ElectronApplication | undefined;
  let page!: Page;
  const pdf = () => page.locator('.pdf-workspace');
  const dialog = () => page.getByRole('dialog', { name: 'Edit document', exact: true });
  const input = () => dialog().getByLabel('Tags (comma-separated)', { exact: true });
  const option = (name: string | RegExp) => dialog().getByRole('option', { name, exact: true });
  const catalog = async (): Promise<{ documents: PDFDocument[] }> => JSON.parse(await readFile(catalogPath, 'utf8'));
  const makeDocument = (title: string, tags: string[]): PDFDocument => ({
    id: randomUUID(), title, filename: `${title}.pdf`, tags, size: documentBytes(title).length,
    sha256: createHash('sha256').update(documentBytes(title)).digest('hex'),
    importedAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-02T00:00:00.000Z',
    favorite: false, lastOpenedAt: null, lastPage: 1, pageCount: 2,
  });
  const edited = makeDocument('Working paper', ['Pinned']);
  const documents = [edited, makeDocument('Reference paper', ['Research', 'Reading', '約定', '市場構造']),
    makeDocument('More references', ['research', 'Peer reviewed', ...Array.from({ length: 10 }, (_, i) => `Topic ${i + 1}`)])];

  async function launch() {
    desktop = await electron.launch({ args: electronLaunchArguments(['--no-sandbox', '.']), cwd: process.cwd(),
      env: { ...process.env, PRISM_USER_DATA: path.join(temporary, 'notes-profile'), PRISM_WORKSPACE: notebook, PRISM_PDF_USER_DATA: profile } });
    page = await desktop.firstWindow();
    page.on('pageerror', error => errors.push(error.message));
    await expect(page.locator('.note-heading h1')).toHaveText('Tag suggestions');
    await expect.poll(() => desktop!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible())).toBe(true);
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.getByRole('navigation', { name: 'Workspaces', exact: true }).getByRole('button', { name: 'PDFs', exact: true }).click();
    await expect(pdf().getByRole('heading', { name: 'All documents', exact: true })).toBeVisible();
  }
  async function stop() {
    if (!desktop) return;
    const current = desktop;
    const child = current.process();
    const closed = current.waitForEvent('close', { timeout: 5000 }).catch(() => undefined);
    await current.evaluate(({ app }) => app.exit(0)).catch(() => undefined);
    await closed;
    if (child.exitCode === null) child.kill();
    desktop = undefined;
  }
  async function edit(title = 'Working paper') {
    await pdf().getByRole('button', { name: `Details for ${title}`, exact: true }).click();
    await input().focus();
  }
  try {
    await mkdir(notebook);
    await mkdir(path.join(profile, 'library/documents'), { recursive: true });
    const note = '# Tag suggestions\n\nKeep this note unchanged.\n';
    await writeFile(path.join(notebook, 'Working note.md'), note);
    await writeFile(catalogPath, JSON.stringify({ version: 1, documents }) + '\n');
    for (const document of documents) await writeFile(path.join(profile, 'library/documents', `${document.id}.pdf`), documentBytes(document.title));
    await launch();
    // Suggestions include tags on PDFs hidden by the current library filter.
    await pdf().getByLabel('Search library', { exact: true }).fill('Working paper');
    await edit();
    await input().fill('Pinned, re');
    await expect(option(/^research$/i)).toHaveCount(1);
    await expect(option('Reading')).toBeVisible();
    await option(/^research$/i).click();
    await expect(input()).toHaveValue(/^Pinned, [Rr]esearch, $/);
    await expect(input()).toBeFocused();
    await expect(option(/^research$/i)).toHaveCount(0);
    await expect(option('Pinned')).toHaveCount(0);
    expect((await catalog()).documents.find(document => document.id === edited.id)?.tags).toEqual(['Pinned']);

    await input().fill('Pinned, Research, 約');
    await option('約定').click();
    await expect(input()).toHaveValue('Pinned, Research, 約定, ');
    // Replacing the middle token must not erase its neighboring tags.
    await input().fill('Pinned, read, 約定');
    await input().press('Home');
    for (let offset = 0; offset < 10; offset++) await input().press('ArrowRight');
    await expect(option('Reading')).toBeVisible();
    await input().press('ArrowDown');
    await input().press('Enter');
    await expect(input()).toHaveValue('Pinned, Reading, 約定');
    await expect(dialog()).toBeVisible();

    // IME confirmation must not choose a suggestion or submit the details form.
    await input().fill('Pinned, 市');
    await expect(option('市場構造')).toBeVisible();
    await input().press('ArrowDown');
    await input().dispatchEvent('compositionstart', { data: '市' });
    await input().dispatchEvent('keydown', { key: 'Enter', code: 'Enter', isComposing: true });
    await expect(input()).toHaveValue('Pinned, 市');
    await expect(dialog()).toBeVisible();
    await input().dispatchEvent('compositionend', { data: '市' });
    await input().fill('Pinned, 市');
    await expect(option('市場構造')).toBeVisible();
    await input().press('Escape');
    await expect(dialog().getByRole('listbox')).toHaveCount(0);
    await expect(dialog()).toBeVisible();
    await input().press('Tab');
    await expect(dialog().getByRole('combobox', { name: 'Folder', exact: true })).toBeFocused();
    await dialog().getByRole('button', { name: 'Cancel', exact: true }).click();
    expect((await catalog()).documents.find(document => document.id === edited.id)?.tags).toEqual(['Pinned']);

    await edit();
    await input().fill('Pinned, read');
    await input().press('ArrowDown');
    await input().press('Enter');
    await page.keyboard.insertText('My own tag');
    await dialog().getByRole('button', { name: 'Save changes', exact: true }).click();
    await expect(dialog()).toHaveCount(0);
    await expect.poll(async () => (await catalog()).documents.find(document => document.id === edited.id)?.tags).toEqual(['Pinned', 'Reading', 'My own tag']);
    await stop();
    await launch();
    await pdf().getByRole('button', { name: 'Appearance', exact: true }).click();
    const appearance = page.getByRole('dialog', { name: 'Make a little space', exact: true });
    await appearance.getByRole('radio', { name: 'Sci-fi theme', exact: true }).check();
    await appearance.getByRole('slider', { name: 'Text size', exact: true }).fill('150');
    await appearance.getByRole('button', { name: 'Done', exact: true }).click();
    await page.setViewportSize({ width: 780, height: 900 });
    await edit('Reference paper');
    await input().fill('');
    await expect(option('My own tag')).toBeVisible();
    await expect(option(/^research$/i)).toHaveCount(1);
    expect(await dialog().evaluate(element => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1);
    expect(await dialog().getByRole('listbox').evaluate(element => element.scrollHeight > element.clientHeight)).toBe(true);
    await testInfo.attach('PDF tag suggestions', { body: await page.screenshot({ path: testInfo.outputPath('tag-suggestions.png') }), contentType: 'image/png' });
    await dialog().getByRole('button', { name: 'Cancel', exact: true }).click();
    expect((await catalog()).documents.find(document => document.title === 'Reference paper')?.tags).toEqual(documents[1].tags);
    expect(await readFile(path.join(notebook, 'Working note.md'), 'utf8')).toBe(note);
    for (const document of documents) expect(await readFile(path.join(profile, 'library/documents', `${document.id}.pdf`))).toEqual(documentBytes(document.title));
    expect(errors).toEqual([]);
  } finally {
    await stop();
    await rm(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
