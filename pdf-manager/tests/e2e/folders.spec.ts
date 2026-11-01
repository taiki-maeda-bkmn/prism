import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { electronLaunchArguments } from '../../../scripts/electron-launch.mjs';
import { fixturePdf } from '../../../tests/fixtures/pdf';
import type { PDFDocument, PDFFolder } from '../../src/shared/types';

test('standalone folders preserve documents, metadata and reading positions through a restart', async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'prism-pdf-folders-'));
  const profile = path.join(temporary, 'profile');
  const source = path.join(temporary, 'Execution notes.pdf');
  const bytes = fixturePdf();
  const errors: string[] = [];
  let desktop: ElectronApplication | undefined;
  let page!: Page;
  const catalog = async (): Promise<{ version: number; documents: PDFDocument[]; folders?: PDFFolder[] }> =>
    JSON.parse(await readFile(path.join(profile, 'library/catalog.json'), 'utf8'));
  const folder = () => page.getByRole('button', { name: 'Folder 参考資料', exact: true });

  async function launch() {
    desktop = await electron.launch({
      args: electronLaunchArguments(['--no-sandbox', 'pdf-manager']), cwd: process.cwd(),
      env: { ...process.env, PRISM_PDF_USER_DATA: profile },
    });
    page = await desktop.firstWindow();
    page.on('pageerror', error => errors.push(error.message));
    await expect(page.getByRole('heading', { name: 'All documents', exact: true })).toBeVisible();
  }
  async function close() {
    if (!desktop) return;
    const current = desktop;
    const closed = current.waitForEvent('close');
    await current.evaluate(({ app }) => app.quit());
    await closed;
    desktop = undefined;
  }
  try {
    await writeFile(source, bytes);
    await launch();
    await desktop!.evaluate(({ dialog }, filename) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [filename] });
    }, source);
    await page.getByRole('button', { name: 'Import PDFs', exact: true }).click();
    await page.getByRole('button', { name: 'Open Execution notes', exact: true }).click();
    await expect(page.locator('.pdf-paper canvas[data-page-number="1"]')).toBeVisible();
    await page.getByRole('button', { name: 'Next page', exact: true }).click();
    await expect(page.locator('.pdf-paper canvas[data-page-number="2"]')).toBeVisible();
    await page.getByRole('button', { name: 'Back to library', exact: true }).click();
    await page.getByRole('button', { name: 'Favorite Execution notes', exact: true }).click();
    await page.getByRole('button', { name: 'Details for Execution notes', exact: true }).click();
    await page.getByLabel('Tags (comma-separated)', { exact: true }).fill('Research, 約定');
    await page.getByRole('button', { name: 'Save changes', exact: true }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    const before = await catalog();
    expect(before.version).toBe(1);
    const document = before.documents[0];
    expect(document).toMatchObject({ lastPage: 2, pageCount: 2, favorite: true, tags: ['Research', '約定'] });

    await page.getByRole('button', { name: 'New folder', exact: true }).click();
    const create = page.getByRole('dialog', { name: 'New folder', exact: true });
    await create.getByLabel('Folder name', { exact: true }).fill('参考資料');
    await create.getByRole('button', { name: 'Create folder', exact: true }).click();
    await expect(create).toHaveCount(0);
    const created = await catalog();
    expect(created.version).toBe(2);
    const folderId = created.folders!.find(item => item.name === '参考資料')!.id;
    await page.getByRole('button', { name: 'All documents', exact: true }).click();
    await page.getByRole('button', { name: 'Details for Execution notes', exact: true }).click();
    const details = page.getByRole('dialog', { name: 'Edit document', exact: true });
    await details.getByRole('combobox', { name: 'Folder', exact: true }).selectOption(folderId);
    await details.getByRole('button', { name: 'Save changes', exact: true }).click();
    await expect(details).toHaveCount(0);
    await folder().click();
    await expect(page.getByRole('button', { name: 'Open Execution notes', exact: true })).toBeVisible();
    const moved = (await catalog()).documents[0];
    expect(moved).toMatchObject({ ...document, folderId, updatedAt: moved.updatedAt });
    expect(await readFile(path.join(profile, 'library/documents', `${document.id}.pdf`))).toEqual(bytes);
    await close();

    await launch();
    await folder().click();
    await page.getByRole('button', { name: 'Open Execution notes', exact: true }).click();
    await expect(page.locator('.pdf-paper canvas[data-page-number="2"]')).toBeVisible();
    await page.getByRole('button', { name: 'Back to library', exact: true }).click();
    await page.getByRole('button', { name: 'Details for Execution notes', exact: true }).click();
    await page.getByRole('combobox', { name: 'Folder', exact: true }).selectOption({ label: 'Unfiled' });
    await page.getByRole('button', { name: 'Save changes', exact: true }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await page.getByRole('button', { name: 'Unfiled', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Open Execution notes', exact: true })).toBeVisible();
    const unfiled = await catalog();
    expect(unfiled.version).toBe(2);
    expect(unfiled.documents).toHaveLength(1);
    expect(unfiled.documents[0].id).toBe(document.id);
    expect(unfiled.documents[0].folderId).toBeUndefined();
    expect(unfiled.documents[0].tags).toEqual(['Research', '約定']);
    expect(unfiled.folders).toEqual(created.folders);
    expect(await readFile(source)).toEqual(bytes);
    expect(errors).toEqual([]);
    await close();
  } finally {
    if (desktop) {
      const child = desktop.process();
      const closed = desktop.waitForEvent('close', { timeout: 5000 }).catch(() => undefined);
      await desktop.evaluate(({ app }) => app.exit(0)).catch(() => undefined);
      await closed;
      if (child.exitCode === null) child.kill();
    }
    await rm(temporary, { recursive: true, force: true });
  }
});
