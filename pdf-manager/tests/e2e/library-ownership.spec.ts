import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { _electron as electron, expect, test, type ElectronApplication } from '@playwright/test';

test('retries competing and damaged libraries, then releases ownership on a normal quit', async ({}, testInfo) => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'prism-pdf-ownership-'));
  const userData = path.join(temporary, 'profile');
  const library = path.join(userData, 'library');
  const lockPath = path.join(library, '.prism-library-lock.sqlite');
  const catalogPath = path.join(library, 'catalog.json');
  let desktop: ElectronApplication | undefined;
  let owner: DatabaseSync | undefined;
  let contender: DatabaseSync | undefined;

  try {
    await mkdir(library, { recursive: true });
    // This process acts as the other launcher. The Electron main process must
    // encounter a real OS-held lock rather than a mocked service failure.
    owner = new DatabaseSync(lockPath);
    owner.exec('BEGIN EXCLUSIVE');
    const originalLock = await stat(lockPath);
    desktop = await electron.launch({
      args: ['--no-sandbox', path.resolve('pdf-manager')],
      cwd: process.cwd(),
      env: { ...process.env, PRISM_PDF_USER_DATA: userData },
    });
    const page = await desktop.firstWindow();
    const rendererErrors: string[] = [];
    page.on('pageerror', error => rendererErrors.push(error.message));
    await expect(page.getByRole('alert')).toContainText('already open in another Prism window');
    await page.getByRole('button', { name: 'Try again', exact: true }).click();
    await expect(page.getByRole('alert')).toContainText('already open in another Prism window');

    owner.close();
    owner = undefined;
    const damaged = '{ damaged catalog, retained for recovery';
    await writeFile(catalogPath, damaged);
    await page.getByRole('button', { name: 'Try again', exact: true }).click();
    await expect(page.getByRole('alert')).toContainText('catalog is damaged or unsupported');
    expect(await readFile(catalogPath, 'utf8')).toBe(damaged);
    contender = new DatabaseSync(lockPath);
    contender.exec('BEGIN EXCLUSIVE');
    contender.close();
    contender = undefined;

    const repaired = JSON.stringify({ version: 1, documents: [] }) + '\n';
    await writeFile(catalogPath, repaired);
    await page.getByRole('button', { name: 'Try again', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'A home for your PDFs.', exact: true })).toBeVisible();
    await expect(page.getByRole('alert')).toHaveCount(0);
    expect(await readFile(catalogPath, 'utf8')).toBe(repaired);
    contender = new DatabaseSync(lockPath);
    assert.throws(() => contender!.exec('BEGIN EXCLUSIVE'), (error: unknown) => {
      const code = (error as { errcode?: number }).errcode;
      return code === 5 || code === 6;
    }, 'The running app must retain exclusive library ownership.');
    contender.close();
    contender = undefined;
    expect(rendererErrors).toEqual([]);

    // Exercise before-quit and its service drain, rather than app.exit().
    const closed = desktop.waitForEvent('close');
    await desktop.evaluate(({ app }) => { setTimeout(() => app.quit(), 0); });
    await closed;
    desktop = undefined;
    contender = new DatabaseSync(lockPath);
    contender.exec('BEGIN EXCLUSIVE');
    const retainedLock = await stat(lockPath);
    expect([retainedLock.dev, retainedLock.ino]).toEqual([originalLock.dev, originalLock.ino]);
    expect(await readFile(catalogPath, 'utf8')).toBe(repaired);
  } catch (error) {
    const page = desktop?.windows()[0];
    if (page && !page.isClosed()) {
      const screenshot = await page.screenshot().catch(() => undefined);
      if (screenshot) await testInfo.attach('PDF ownership failure', { body: screenshot, contentType: 'image/png' });
    }
    throw error;
  } finally {
    contender?.close();
    owner?.close();
    if (desktop) {
      const child = desktop.process();
      const closed = desktop.waitForEvent('close', { timeout: 5_000 }).catch(() => undefined);
      await desktop.evaluate(({ app }) => { setTimeout(() => app.quit(), 0); }).catch(() => undefined);
      await closed;
      if (child.exitCode === null) child.kill();
    }
    await rm(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
