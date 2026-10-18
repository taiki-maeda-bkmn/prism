import { _electron as electron, expect, test, type ElectronApplication } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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

test('host restore resumes painting and editing, and focus repairs a stale minimized state', async ({}, testInfo) => {
  test.setTimeout(120_000);
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'prism-host-restore-'));
  const notebook = path.join(temporary, 'Notebook');
  const title = `Prism host geometry ${randomUUID().replaceAll('-', '')}`;
  const content = '# Restore\n\nKeep this draft';
  let desktop: ElectronApplication | undefined;
  const evidence: { phase: string; host: HostWindowSample }[] = [];
  try {
    await mkdir(notebook);
    await writeFile(path.join(notebook, 'Restore.md'), content);
    desktop = await electron.launch({
      args: electronLaunchArguments(['--no-sandbox', '.']), cwd: process.cwd(),
      env: { ...process.env, PRISM_USER_DATA: path.join(temporary, 'profile'), PRISM_WORKSPACE: notebook },
    });
    const page = await desktop.firstWindow();
    await expect(page.locator('.note-heading h1')).toHaveText('Restore');
    await page.evaluate(ownedTitle => { document.title = ownedTitle; }, title);
    await desktop.evaluate(({ BrowserWindow }, ownedTitle) => BrowserWindow.getAllWindows()[0].setTitle(ownedTitle), title);
    await page.getByRole('button', { name: 'Source', exact: true }).click();
    const editor = page.getByRole('textbox', { name: 'Markdown source', exact: true });
    await editor.focus();
    await editor.press('ControlOrMeta+End');
    await page.keyboard.insertText(' unsaved');
    const originalBounds = await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getBounds());

    for (const maximized of [false, false, true, true]) {
      await desktop.evaluate(({ BrowserWindow }, maximize) => {
        const window = BrowserWindow.getAllWindows()[0];
        if (maximize) window.maximize(); else window.unmaximize();
      }, maximized);
      await expect.poll(() => desktop!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isMaximized())).toBe(maximized);
      await page.evaluate(() => {
        const overlay = document.createElement('div');
        overlay.id = 'prism-host-test-overlay';
        overlay.style.cssText = 'position:fixed;inset:0;background:#f013ab;z-index:2147483647;pointer-events:none';
        document.body.append(overlay);
      });
      await expect.poll(async () => (await sampleHostWindow(title)).aligned).toBe(true);
      await page.getByRole('button', { name: 'Minimize window', exact: true }).click();
      await expect.poll(async () => (await sampleHostWindow(title, 'observe')).minimized).toBe(true);
      evidence.push({ phase: `minimized (maximized=${maximized})`, host: await sampleHostWindow(title, 'observe') });
      // A new DOM color must reach the host after restoring. An old cached
      // screenshot of the previous frame cannot satisfy this check.
      await page.evaluate(() => { document.getElementById('prism-host-test-overlay')!.style.background = '#13abf0'; });
      expect((await sampleHostWindow(title, 'observe')).minimized).toBe(true);
      // Restore through Windows, never through Electron's restore(), which
      // would perform the repair being tested and conceal the original bug.
      await sampleHostWindow(title, 'restore');
      await expect.poll(async () => (await sampleHostWindow(title, 'observe')).minimized).toBe(false);
      await expect.poll(() => desktop!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isMinimized())).toBe(false);
      await expect.poll(() => desktop!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isMaximized())).toBe(maximized);
      let restored: HostWindowSample | undefined;
      try {
        await expect.poll(async () => {
          restored = await sampleHostWindow(title);
          return restored.covered && restored.colors?.length === 4 && restored.colors.every(color => color === 0xf0ab13);
        }, { message: 'The restored host surface must show the new frame, not the pre-minimize pixels.' }).toBe(true);
      } finally {
        if (restored) evidence.push({ phase: `restored (maximized=${maximized})`, host: restored });
      }
      expect(restored!.maximized).toBe(maximized);
      if (maximized) expect(restored!.rect).toEqual(restored!.workArea);
      if (!maximized) {
        expect(await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getBounds())).toEqual(originalBounds);
      }
      await page.evaluate(() => document.getElementById('prism-host-test-overlay')?.remove());
      await expect(editor).toContainText('Keep this draft unsaved');
      await editor.focus();
      await editor.press('ControlOrMeta+End');
      await page.keyboard.insertText(' after restore');
      await expect(editor).toContainText('Keep this draft unsaved after restore');
      await editor.press('ControlOrMeta+z');
      await expect(editor).toContainText('Keep this draft unsaved');
      await expect(editor).not.toContainText('after restore');
      await expect(page.locator('.unsaved-badge')).toBeVisible();
    }
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(page.locator('.statusbar')).toContainText('All changes saved');
    expect(await readFile(path.join(notebook, 'Restore.md'), 'utf8')).toBe(content + ' unsaved');

    // Controlled fault injection, separate from the real host restore cycles:
    // WSLg may deliver keyboard focus without an activated configure, leaving
    // Chromium's native state minimized. No test code calls restore() here.
    await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].maximize());
    await expect.poll(() => desktop!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isMaximized())).toBe(true);
    await page.getByRole('button', { name: 'Minimize window', exact: true }).click();
    await expect.poll(() => desktop!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isMinimized())).toBe(true);
    await expect.poll(async () => (await sampleHostWindow(title, 'observe')).minimized).toBe(true);
    await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].emit('focus'));
    await expect.poll(() => desktop!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isMinimized()), {
      message: 'Focus must clear the stale native minimized state without a host restore notification.',
    }).toBe(false);
    await expect.poll(() => desktop!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isMaximized())).toBe(true);
    await expect.poll(async () => (await sampleHostWindow(title, 'observe')).minimized).toBe(false);
    const recovered = await sampleHostWindow(title, 'observe');
    evidence.push({ phase: 'native state recovered after missing configure', host: recovered });
    expect(recovered.maximized).toBe(true);
    expect(recovered.rect).toEqual(recovered.workArea);
    // An emitted Electron event does not grant Windows foreground activation,
    // so host pixel/interaction checks belong to the real restore cycles above.
    await expect(editor).toContainText('Keep this draft unsaved');
  } finally {
    await writeFile(testInfo.outputPath('host-restore.json'), JSON.stringify(evidence, null, 2));
    await testInfo.attach('Host minimize/restore state and fresh pixels', {
      body: JSON.stringify(evidence, null, 2), contentType: 'application/json',
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
