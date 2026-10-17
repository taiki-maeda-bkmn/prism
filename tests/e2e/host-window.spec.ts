import { _electron as electron, expect, test, type ElectronApplication } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { electronLaunchArguments } from '../../scripts/electron-launch.mjs';
import { sampleHostWindow, type HostWindowSample } from '../helpers/host-window';

// Requires an interactive Windows host. Ordinary Linux/macOS/Windows CI must
// not inspect host desktop pixels or alter the foreground window.
test.skip(process.platform !== 'linux' || !process.env.WSL_INTEROP || process.env.PRISM_TEST_WSLG_HOST !== '1',
  'Set PRISM_TEST_WSLG_HOST=1 in WSLg to check the owned window on its Windows host.');

test('the Windows host displays the entire WSLg surface after maximize and restore', async ({}, testInfo) => {
  test.setTimeout(120_000);
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'prism-host-window-'));
  const notebook = path.join(temporary, 'Notebook');
  const title = `Prism host geometry ${randomUUID().replaceAll('-', '')}`;
  let desktop: ElectronApplication | undefined;
  const evidence: { phase: string; host: HostWindowSample }[] = [];
  try {
    await mkdir(notebook);
    await writeFile(path.join(notebook, 'Host window.md'), '# Host window\n\nA test-owned notebook.\n');
    desktop = await electron.launch({
      args: electronLaunchArguments(['--no-sandbox', '.']), cwd: process.cwd(),
      env: { ...process.env, PRISM_USER_DATA: path.join(temporary, 'profile'), PRISM_WORKSPACE: notebook },
    });
    const page = await desktop.firstWindow();
    await expect(page.locator('.note-heading h1')).toHaveText('Host window');
    await expect.poll(() => desktop!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible())).toBe(true);
    await page.evaluate(ownedTitle => {
      document.title = ownedTitle;
      const overlay = document.createElement('div');
      overlay.id = 'prism-host-test-overlay';
      overlay.style.cssText = 'position:fixed;inset:0;background:#f013ab;z-index:2147483647;pointer-events:none';
      document.body.append(overlay);
    }, title);
    await desktop.evaluate(({ BrowserWindow }, ownedTitle) => {
      const window = BrowserWindow.getAllWindows()[0];
      window.setTitle(ownedTitle);
      window.focus();
    }, title);

    async function verify(phase: string, maximized: boolean) {
      let last: HostWindowSample | undefined;
      try {
        await expect.poll(async () => {
          last = await sampleHostWindow(title);
          const fitsWorkArea = last.rect && last.workArea
            && last.rect.left === last.workArea.left && last.rect.top === last.workArea.top
            && last.rect.right === last.workArea.right && last.rect.bottom === last.workArea.bottom;
          return last.aligned && last.maximized === maximized && (!maximized || Boolean(fitsWorkArea));
        }, {
          timeout: 25_000, intervals: [200, 400, 800],
          message: `${phase}: all four host corners must show the owned overlay, and maximization must fit the host work area`,
        }).toBe(true);
      } finally {
        if (last) evidence.push({ phase, host: last });
      }
      expect(await desktop!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isFullScreen())).toBe(false);
    }

    await verify('normal', false);
    await page.getByRole('button', { name: 'Maximize window', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Restore window', exact: true })).toBeVisible();
    await verify('maximized', true);
    await page.getByRole('button', { name: 'Restore window', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Maximize window', exact: true })).toBeVisible();
    await verify('restored', false);
    await page.getByRole('button', { name: 'Maximize window', exact: true }).click();
    await verify('maximized again', true);
    await page.evaluate(() => document.getElementById('prism-host-test-overlay')?.remove());
    await expect(page.locator('.note-heading h1')).toHaveText('Host window');
  } finally {
    const geometryPath = testInfo.outputPath('host-geometry.json');
    await writeFile(geometryPath, JSON.stringify(evidence, null, 2));
    await testInfo.attach('Owned host window geometry and four pixels', {
      path: geometryPath, contentType: 'application/json',
    });
    if (desktop) {
      const child = desktop.process();
      const closed = desktop.waitForEvent('close', { timeout: 5_000 }).catch(() => undefined);
      await desktop.evaluate(({ app }) => app.exit(0)).catch(() => undefined);
      await closed;
      if (child.exitCode === null) child.kill();
    }
    await rm(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
