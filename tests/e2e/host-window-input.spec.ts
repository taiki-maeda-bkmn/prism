import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { electronLaunchArguments } from '../../scripts/electron-launch.mjs';
import { clickHostWindow, sampleHostWindow } from '../helpers/host-window';

test.skip(process.platform !== 'linux' || !process.env.WSL_INTEROP || process.env.PRISM_TEST_WSLG_HOST !== '1',
  'Set PRISM_TEST_WSLG_HOST=1 on an interactive WSLg desktop to check real Windows mouse routing.');

test('Windows pointer clicks reach the displayed controls after a saved-position restart', async ({}, testInfo) => {
  test.setTimeout(120_000);
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'prism-host-input-'));
  const profile = path.join(temporary, 'profile');
  const notebook = path.join(temporary, 'notebook');
  const title = `Prism host geometry ${randomUUID().replaceAll('-', '')}`;
  const evidence: unknown[] = [];
  let desktop: ElectronApplication | undefined;
  let page!: Page;

  async function launch() {
    desktop = await electron.launch({
      args: electronLaunchArguments(['--no-sandbox', '.']), cwd: process.cwd(),
      env: { ...process.env, PRISM_USER_DATA: profile, PRISM_WORKSPACE: notebook, PRISM_PDF_USER_DATA: path.join(temporary, 'pdf-profile') },
    });
    page = await desktop.firstWindow();
    await expect(page.locator('.note-heading h1')).toHaveText('Pointer check');
    await expect.poll(() => desktop!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getTitle()), { timeout: 20_000 }).toBe('Prism');
    expect(await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isEnabled())).toBe(true);
    await expect(page.locator('dialog[open]')).toHaveCount(0);
    await page.evaluate(value => { document.title = value; }, title);
    await desktop.evaluate(({ BrowserWindow }, value) => BrowserWindow.getAllWindows()[0].setTitle(value), title);
    await expect.poll(async () => (await sampleHostWindow(title, 'observe')).found).toBe(true);
  }
  async function click(phase: string) {
    const target = await page.evaluate(() => {
      const button = document.createElement('button');
      button.id = 'host-pointer-check';
      button.textContent = 'Mouse input check';
      button.style.cssText = 'position:fixed;left:80px;top:180px;width:220px;height:70px;z-index:2147483647;background:#fff;color:#000;-webkit-app-region:no-drag';
      button.dataset.clicked = 'no';
      button.onclick = () => { button.dataset.clicked = 'yes'; };
      document.body.append(button);
      const events: { x: number; y: number; target: string }[] = [];
      (window as unknown as { pointerEvidence: typeof events }).pointerEvidence = events;
      document.addEventListener('pointerdown', event => {
        events.push({ x: event.clientX, y: event.clientY, target: (event.target as HTMLElement)?.id });
      }, { once: true });
      const rectangle = button.getBoundingClientRect();
      return { x: (rectangle.left + rectangle.width / 2) / innerWidth, y: (rectangle.top + rectangle.height / 2) / innerHeight };
    });
    const host = await clickHostWindow(title, target);
    expect(host.clicked, host.clickFailure).toBe(true);
    try { await expect(page.locator('#host-pointer-check')).toHaveAttribute('data-clicked', 'yes', { timeout: 3000 }); }
    finally {
      evidence.push({ phase, host, target, received: await page.evaluate(() => (window as unknown as { pointerEvidence: unknown }).pointerEvidence) });
      await page.evaluate(() => document.getElementById('host-pointer-check')?.remove());
    }
  }
  async function close() {
    const closing = desktop!;
    const closed = closing.waitForEvent('close');
    await closing.evaluate(({ app }) => app.quit());
    await closed; desktop = undefined;
  }
  async function chooseWorkspace(name: 'Notes' | 'PDFs') {
    const button = page.getByRole('navigation', { name: 'Workspaces', exact: true }).getByRole('button', { name, exact: true });
    const point = await button.evaluate(element => {
      const rect = element.getBoundingClientRect();
      return { x: (rect.left + rect.width / 2) / innerWidth, y: (rect.top + rect.height / 2) / innerHeight };
    });
    const result = await clickHostWindow(title, point);
    expect(result.clicked, result.clickFailure).toBe(true);
    await expect(button).toHaveAttribute('aria-pressed', 'true');
  }
  try {
    await mkdir(notebook); await mkdir(profile);
    await writeFile(path.join(notebook, 'Pointer check.md'), '# Pointer check\n\nAn isolated input test.\n');
    await launch(); await click('fresh profile');
    const initial = await sampleHostWindow(title, 'observe');
    await close();
    // A prior Windows placement differs from the compositor's launch origin.
    // Do not move or read a real user's window or copy their application data.
    const oldPlacement = JSON.stringify({
      version: 1, space: 'windows-physical-screen', bounds: {
        x: initial.workArea!.left + 120, y: initial.workArea!.top + 100,
        width: initial.rect!.right - initial.rect!.left, height: initial.rect!.bottom - initial.rect!.top,
      },
    });
    await writeFile(path.join(profile, 'window-placement-wslg.json'), oldPlacement);
    await launch(); await click('saved-position restart');
    await chooseWorkspace('PDFs'); await expect(page.locator('.pdf-workspace')).toBeVisible();
    await chooseWorkspace('Notes');
    await desktop!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].minimize());
    await expect.poll(async () => (await sampleHostWindow(title, 'observe')).minimized).toBe(true);
    await sampleHostWindow(title, 'restore');
    await expect.poll(() => desktop!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isMinimized())).toBe(false);
    await click('after host restore');
    expect(await readFile(path.join(notebook, 'Pointer check.md'), 'utf8')).toBe('# Pointer check\n\nAn isolated input test.\n');
    await close();
    expect(await readFile(path.join(profile, 'window-placement-wslg.json'), 'utf8')).toBe(oldPlacement);
  } finally {
    await mkdir(testInfo.outputDir, { recursive: true });
    await writeFile(testInfo.outputPath('host-input.json'), JSON.stringify(evidence, null, 2));
    if (desktop) {
      const child = desktop.process();
      const closed = desktop.waitForEvent('close', { timeout: 5000 }).catch(() => undefined);
      await desktop.evaluate(({ app }) => app.exit(0)).catch(() => undefined); await closed;
      if (child.exitCode === null) child.kill();
    }
    await rm(temporary, { recursive: true, force: true });
  }
});
