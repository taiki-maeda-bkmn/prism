import { _electron as electron, expect, test, type ElectronApplication } from '@playwright/test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { electronLaunchArguments } from '../../../scripts/electron-launch.mjs';
import { installURLFixture, releaseURLFixture } from '../../../tests/fixtures/pdf-url';

test('standalone URL import shares progress, cancellation, managed storage, and the offline reader', async () => {
  const profile = await mkdtemp(path.join(os.tmpdir(), 'prism-pdf-url-'));
  let desktop: ElectronApplication | undefined;
  try {
    desktop = await electron.launch({ args: electronLaunchArguments(['--no-sandbox', 'pdf-manager']), cwd: process.cwd(),
      env: { ...process.env, PRISM_PDF_USER_DATA: profile } });
    const page = await desktop.firstWindow();
    await installURLFixture(desktop);
    await page.getByRole('button', { name: 'Import from URL', exact: true }).click();
    const modal = page.getByRole('dialog', { name: 'Import from URL', exact: true });
    const url = modal.getByRole('textbox', { name: 'PDF URL' });
    await expect(url).toBeEnabled();
    await url.fill('https://papers.example.org/unknown');
    await modal.getByRole('button', { name: 'Download PDF', exact: true }).click();
    await expect(modal).toContainText('64 B downloaded');
    await modal.getByRole('button', { name: 'Cancel download' }).click();
    await expect(modal).toContainText('Download cancelled');
    await url.fill('https://papers.example.org/redirect');
    await modal.getByRole('button', { name: 'Download PDF', exact: true }).click();
    await expect(modal.getByRole('progressbar')).toHaveAttribute('value', /[1-9]/);
    await releaseURLFixture(desktop);
    await expect(modal).toContainText('PDF added to your library');
    const catalog = JSON.parse(await readFile(path.join(profile, 'library/catalog.json'), 'utf8'));
    expect(catalog.documents).toHaveLength(1);
    expect(catalog.documents[0].filename).toBe('約定資料.pdf');
    await modal.getByRole('button', { name: 'Open PDF', exact: true }).click();
    await expect(page.locator('.pdf-paper canvas[data-page-number="1"]')).toBeVisible();
    const closed = desktop.waitForEvent('close');
    await desktop.evaluate(({ app }) => app.quit()); await closed; desktop = undefined;
  } finally {
    if (desktop) await desktop.close();
    await rm(profile, { recursive: true, force: true });
  }
});
