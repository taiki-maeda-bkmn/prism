import { _electron as electron, expect, test, type ElectronApplication } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { electronLaunchArguments } from '../../scripts/electron-launch.mjs';
import { sampleHostWindow, type HostWindowSample } from '../helpers/host-window';

test.skip(process.platform !== 'linux' || !process.env.WSL_INTEROP || process.env.PRISM_TEST_WSLG_HOST !== '1',
  'Set PRISM_TEST_WSLG_HOST=1 on an interactive WSLg desktop to verify the owned host window.');

test('WSLg restores the actual Windows position through normal, maximized, and minimized restarts', async ({}, testInfo) => {
  test.setTimeout(120_000);
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'prism-host-placement-'));
  const notebook = path.join(temporary, 'Notebook');
  const profile = path.join(temporary, 'profile');
  const title = `Prism host geometry ${randomUUID().replaceAll('-', '')}`;
  let desktop: ElectronApplication | undefined;
  const evidence: { phase: string; host: HostWindowSample }[] = [];

  async function launch() {
    desktop = await electron.launch({
      args: electronLaunchArguments(['--no-sandbox', '.']), cwd: process.cwd(),
      env: { ...process.env, PRISM_USER_DATA: profile, PRISM_WORKSPACE: notebook, PRISM_PDF_USER_DATA: path.join(temporary, 'pdf-profile') },
    });
    const page = await desktop.firstWindow();
    await expect(page.locator('.note-heading h1')).toHaveText('Placement');
    expect(await desktop.evaluate(({ app }) => app.commandLine.getSwitchValue('ozone-platform'))).toBe('wayland');
    // The helper first binds its own nonce-bearing title, then Prism resets it.
    await expect.poll(() => desktop!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getTitle()), { timeout: 20_000 }).toBe('Prism');
    await expect.poll(async () => {
      try { return JSON.parse(await readFile(path.join(profile, 'window-placement-wslg.json'), 'utf8')).version; }
      catch { return undefined; }
    }).toBe(1);
    await page.evaluate(value => { document.title = value; }, title);
    await desktop.evaluate(({ BrowserWindow }, value) => BrowserWindow.getAllWindows()[0].setTitle(value), title);
    await expect.poll(async () => (await sampleHostWindow(title, 'observe')).found).toBe(true);
    return page;
  }

  async function close() {
    const app = desktop!;
    const closed = app.waitForEvent('close');
    await app.evaluate(({ app }) => app.quit()).catch(() => undefined);
    await closed;
    desktop = undefined;
  }

  async function sample(phase: string) {
    const host = await sampleHostWindow(title, 'observe');
    evidence.push({ phase, host });
    return host;
  }

  try {
    await mkdir(notebook);
    await writeFile(path.join(notebook, 'Placement.md'), '# Placement\n\nAn isolated window.\n');
    await launch();
    const initial = await sample('initial');
    expect(initial.found).toBe(true);
    const work = initial.workArea!;
    const rectangle = initial.rect!;
    const x = work.left + Math.min(140, Math.max(0, work.right - work.left - (rectangle.right - rectangle.left)));
    const y = work.top + Math.min(90, Math.max(0, work.bottom - work.top - (rectangle.bottom - rectangle.top)));
    await sampleHostWindow(title, 'move', { x, y });
    await expect.poll(async () => {
      const host = await sampleHostWindow(title, 'observe');
      return [host.rect?.left, host.rect?.top];
    }).toEqual([x, y]);
    const moved = (await sample('moved on Windows')).rect!;
    await close();

    let page = await launch();
    await expect.poll(async () => (await sampleHostWindow(title, 'observe')).rect).toEqual(moved);
    await sample('normal restart');
    await page.getByRole('button', { name: 'Maximize window', exact: true }).click();
    await expect.poll(async () => (await sampleHostWindow(title, 'observe')).maximized).toBe(true);
    await close();

    page = await launch();
    await expect.poll(async () => (await sampleHostWindow(title, 'observe')).maximized).toBe(true);
    await sample('maximized restart');
    await page.getByRole('button', { name: 'Restore window', exact: true }).click();
    await expect.poll(async () => (await sampleHostWindow(title, 'observe')).rect).toEqual(moved);

    await page.getByRole('button', { name: 'Maximize window', exact: true }).click();
    await expect.poll(async () => (await sampleHostWindow(title, 'observe')).maximized).toBe(true);
    const nextPosition = { x: x + 60, y: y + 40 };
    await sampleHostWindow(title, 'restore-move', nextPosition);
    await expect.poll(async () => {
      const saved = JSON.parse(await readFile(path.join(profile, 'window-placement-wslg.json'), 'utf8'));
      return { x: saved.bounds.x, y: saved.bounds.y };
    }).toEqual(nextPosition);
    const movedAgain = (await sample('new placement immediately after restore')).rect!;
    expect([movedAgain.left, movedAgain.top]).toEqual([nextPosition.x, nextPosition.y]);
    await page.getByRole('button', { name: 'Minimize window', exact: true }).click();
    await expect.poll(async () => (await sampleHostWindow(title, 'observe')).minimized).toBe(true);
    await close();

    page = await launch();
    const reopened = await sample('restart after minimized quit');
    expect(reopened.minimized).toBe(false);
    expect(reopened.rect).toEqual(movedAgain);
    await page.getByRole('button', { name: 'Source', exact: true }).click();
    await expect(page.getByRole('textbox', { name: 'Markdown source', exact: true })).toContainText('An isolated window.');
    await close();
  } finally {
    await writeFile(testInfo.outputPath('host-placement.json'), JSON.stringify(evidence, null, 2));
    await testInfo.attach('Actual Windows window positions', { body: JSON.stringify(evidence, null, 2), contentType: 'application/json' });
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
