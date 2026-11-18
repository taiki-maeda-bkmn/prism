import { _electron as electron, chromium, expect, test, type Browser, type ElectronApplication, type Page } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { electronLaunchArguments } from '../../scripts/electron-launch.mjs';

let temporary: string, notebook: string, userData: string, pdfProfile: string;
let desktop: ElectronApplication | undefined, page: Page;
const noteName = 'Welcome to Prism.md';
const original = '\ufeff# Session notes\r\n\r\nKeep the saved notebook intact.\r\n';
const draft = '閉じる前の未保存メモ。';
const catalogBytes = JSON.stringify({ version: 1, documents: [] }) + '\n';
const catalogFile = () => path.join(pdfProfile, 'library/catalog.json');
const lockFile = () => path.join(pdfProfile, 'library/.prism-library-lock.sqlite');
const editor = () => page.locator('.app-body .cm-content');
const dirtyPrompt = () => page.getByRole('dialog', { name: 'Keep your latest thoughts?', exact: true });
const launchEnv = () => ({ ...process.env, PRISM_USER_DATA: userData, PRISM_WORKSPACE: notebook, PRISM_PDF_USER_DATA: pdfProfile });

function processExit(child: ChildProcess, timeout = 10_000): Promise<number | null> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(child.exitCode);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { cleanup(); reject(new Error(`Electron process ${child.pid} did not exit after closing.`)); }, timeout);
    const cleanup = () => { clearTimeout(timer); child.removeListener('exit', onExit); child.removeListener('error', onError); };
    const onExit = (code: number | null) => { cleanup(); resolve(code); };
    const onError = (error: Error) => { cleanup(); reject(error); };
    child.once('exit', onExit);
    child.once('error', onError);
  });
}

async function launch(standalone = false) {
  desktop = await electron.launch({ args: electronLaunchArguments(['--no-sandbox', standalone ? 'pdf-manager' : '.']),
    cwd: process.cwd(), env: launchEnv() });
  page = await desktop.firstWindow();
  await expect.poll(() => desktop!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.isVisible())).toBe(true);
  if (standalone) await expect(page.getByRole('heading', { name: 'All documents', exact: true })).toBeVisible();
  else {
    await expect(page.locator('.note-heading h1')).toHaveText('Session notes');
    await page.setViewportSize({ width: 1440, height: 1000 });
  }
  // Loading uses the real service and acquires the real cross-process lock.
  await page.evaluate(() => window.prismPdf.loadLibrary());
}

function expectLibraryOwnership(owned: boolean) {
  const connection = new DatabaseSync(lockFile());
  try {
    if (owned) {
      expect(() => connection.exec('BEGIN EXCLUSIVE')).toThrow();
    } else connection.exec('BEGIN EXCLUSIVE');
  } finally { connection.close(); }
}

async function expectNormalExit(trigger: () => Promise<unknown>) {
  const current = desktop!;
  const child = current.process();
  const closed = current.waitForEvent('close', { timeout: 10_000 });
  const exited = processExit(child);
  await trigger();
  const [, code] = await Promise.all([closed, exited]);
  expect(code).toBe(0);
  expect(child.exitCode).toBe(0);
  desktop = undefined;
  expectLibraryOwnership(false);
}

async function closeWindow() {
  await expectNormalExit(() => desktop!.evaluate(({ BrowserWindow }) => {
    setTimeout(() => BrowserWindow.getAllWindows()[0].close(), 0);
  }));
}

async function addDraft() {
  await page.getByRole('group', { name: 'Editor mode', exact: true }).getByRole('button', { name: 'Source', exact: true }).click();
  await editor().focus();
  await editor().press('ControlOrMeta+End');
  await page.keyboard.insertText(draft);
  await expect(editor()).toContainText(draft);
}

test.beforeEach(async () => {
  temporary = await mkdtemp(path.join(os.tmpdir(), 'prism-session-lifecycle-'));
  notebook = path.join(temporary, 'notebook'); userData = path.join(temporary, 'notes-profile'); pdfProfile = path.join(temporary, 'pdf-profile');
  await mkdir(notebook);
  await mkdir(path.join(pdfProfile, 'library/documents'), { recursive: true });
  await writeFile(path.join(notebook, noteName), original);
  await writeFile(catalogFile(), catalogBytes);
});

test.afterEach(async () => {
  if (desktop) {
    const current = desktop;
    const child = current.process();
    const closed = current.waitForEvent('close', { timeout: 5000 }).catch(() => undefined);
    await current.evaluate(({ app }) => app.exit(1)).catch(() => undefined);
    await closed;
    if (child.exitCode === null && child.signalCode === null) child.kill();
    desktop = undefined;
  }
  await rm(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

test('the desktop shortcut wrapper reports a ready editor and exits with its session before the same profile reopens', async () => {
  test.skip(process.platform !== 'linux', 'The WSL desktop wrapper owns a Linux process group.');
  const wrapper = spawn(process.execPath, ['scripts/start-markdown.mjs', '--no-sandbox', '--remote-debugging-port=0'], {
    cwd: process.cwd(), env: launchEnv(), stdio: ['ignore', 'pipe', 'pipe'],
  });
  // Observe exit immediately: closing the window must reap both Electron and
  // the real shortcut wrapper, without Playwright initiating app shutdown.
  const exited = processExit(wrapper, 60_000).then(code => ({ code }), error => ({ error }));
  let stdout = '', stderr = '';
  wrapper.stdout!.on('data', chunk => { stdout = (stdout + chunk.toString()).slice(-65_536); });
  wrapper.stderr!.on('data', chunk => { stderr = (stderr + chunk.toString()).slice(-65_536); });
  const ownedChildren = async () => {
    if (!wrapper.pid || wrapper.exitCode !== null || wrapper.signalCode !== null) return [];
    const children = await readFile(`/proc/${wrapper.pid}/task/${wrapper.pid}/children`, 'utf8').catch(() => '');
    return children.trim().split(/\s+/).filter(Boolean).map(Number);
  };
  let browser: Browser | undefined;
  try {
    await expect.poll(ownedChildren).toHaveLength(1);
    await expect.poll(() => stderr.match(/DevTools listening on (ws:\/\/[^\s]+)/)?.[1], {
      timeout: 35_000, message: 'The owned desktop launch should expose its browser debugging endpoint.',
    }).toBeTruthy();
    browser = await chromium.connectOverCDP(stderr.match(/DevTools listening on (ws:\/\/[^\s]+)/)![1]);
    const context = browser.contexts()[0];
    page = context.pages()[0] ?? await context.waitForEvent('page');
    await expect(page.locator('.note-heading h1')).toHaveText('Session notes');
    await expect(editor()).toBeVisible();
    await expect.poll(() => stdout).toMatch(/(?:^|\n)PRISM_READY:[a-f0-9]{48}\r?\n/);
    await page.evaluate(() => window.prismPdf.loadLibrary());
    expectLibraryOwnership(true);

    await page.getByRole('button', { name: 'Close window', exact: true }).click();
    await expect.poll(() => wrapper.exitCode).toBe(0);
    expect(await exited).toEqual({ code: 0 });
    await expect.poll(() => browser!.isConnected()).toBe(false);
    expectLibraryOwnership(false);
  } finally {
    if (wrapper.exitCode === null && wrapper.signalCode === null) {
      wrapper.kill('SIGTERM');
      await processExit(wrapper, 5000).catch(async () => {
        // The launcher creates a new group for its direct Electron child.
        // Resolve ownership from this exact wrapper before any forced cleanup;
        // never signal another Prism launch or search by executable name.
        for (const pid of await ownedChildren()) {
          try { process.kill(-pid, 'SIGKILL'); }
          catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
        }
        if (wrapper.exitCode === null && wrapper.signalCode === null) wrapper.kill('SIGKILL');
      });
      await processExit(wrapper, 5000);
    }
    await browser?.close().catch(() => undefined);
    wrapper.stdout?.destroy();
    wrapper.stderr?.destroy();
  }
  await launch();
  expectLibraryOwnership(true);
  await closeWindow();
  expect(await readFile(path.join(notebook, noteName), 'utf8')).toBe(original);
  expect(await readFile(catalogFile(), 'utf8')).toBe(catalogBytes);
});

test('relaunch reveals the existing hidden window, and closing releases its process and profile for immediate reuse', async () => {
  await launch();
  const firstPID = desktop!.process().pid;
  expectLibraryOwnership(true);
  await desktop!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].hide());
  await expect.poll(() => desktop!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible())).toBe(false);
  const second = spawn(desktop!.process().spawnfile, electronLaunchArguments(['--no-sandbox', process.cwd()]), {
    cwd: process.cwd(), env: launchEnv(), stdio: 'ignore',
  });
  try {
    expect(await processExit(second)).toBe(0);
    await expect.poll(() => desktop!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible())).toBe(true);
    expect(desktop!.process().pid).toBe(firstPID);
  } finally {
    if (second.exitCode === null && second.signalCode === null) second.kill();
  }
  await closeWindow();
  await launch();
  expect(desktop!.process().pid).not.toBe(firstPID);
  expectLibraryOwnership(true);
  await closeWindow();
  expect(await readFile(path.join(notebook, noteName), 'utf8')).toBe(original);
  expect(await readFile(catalogFile(), 'utf8')).toBe(catalogBytes);
});

test('the standalone PDF window is shown and repeated native closes release the full session', async () => {
  for (let attempt = 0; attempt < 2; attempt++) {
    await launch(true);
    await expect(page.getByRole('heading', { name: 'A home for your PDFs.', exact: true })).toBeVisible();
    expectLibraryOwnership(true);
    await closeWindow();
  }
  expect(await readFile(catalogFile(), 'utf8')).toBe(catalogBytes);
});

test('Cancel keeps a dirty session usable, and a crashed editor can explicitly close through a native prompt', async () => {
  await launch();
  await addDraft();
  await desktop!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
  await expect(dirtyPrompt()).toBeVisible();
  await dirtyPrompt().getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(editor()).toContainText(draft);
  expectLibraryOwnership(true);
  expect((await page.evaluate(() => window.prismPdf.loadLibrary())).documents).toEqual([]);
  await desktop!.evaluate(({ dialog, BrowserWindow }) => {
    const state = { response: 0, calls: [] as string[][] };
    (globalThis as typeof globalThis & { lifecycleDialogs: typeof state }).lifecycleDialogs = state;
    dialog.showMessageBox = (async (...args: unknown[]) => {
      const options = args[args.length - 1] as { buttons?: string[] };
      state.calls.push(options.buttons ?? []);
      return { response: state.response, checkboxChecked: false };
    }) as typeof dialog.showMessageBox;
    setTimeout(() => BrowserWindow.getAllWindows()[0].webContents.forcefullyCrashRenderer(), 0);
  });
  await expect.poll(() => desktop!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.isCrashed())).toBe(true);
  expect(await desktop!.evaluate(() => (globalThis as typeof globalThis & { lifecycleDialogs: { calls: string[][] } }).lifecycleDialogs.calls)).toEqual([]);
  await desktop!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
  await expect.poll(() => desktop!.evaluate(() => (globalThis as typeof globalThis & { lifecycleDialogs: { calls: string[][] } }).lifecycleDialogs.calls)).toEqual([['Keep open', 'Close Prism']]);
  expect(desktop!.process().exitCode).toBeNull();
  expectLibraryOwnership(true);
  await desktop!.evaluate(() => { (globalThis as typeof globalThis & { lifecycleDialogs: { response: number } }).lifecycleDialogs.response = 1; });
  await closeWindow();
  expect(await readFile(path.join(notebook, noteName), 'utf8')).toBe(original);
  await launch();
  await closeWindow();
});

test('accepted dirty close aborts a stalled research download while Cancel keeps it running', async () => {
  await launch();
  const marker = path.join(temporary, 'research-aborted');
  const editionId = '2026-10-28-daily';
  const paper = { arxivId: '2601.00001v2', title: 'Session paper', authors: ['Aiko Researcher'], topics: ['Execution'],
    schedulerRating: 8, schedulerRatingScale: 10, schedulerRank: 1, schedulerSummary: 'Published session commentary.' };
  await desktop!.evaluate((_electron, fixtures) => {
    const state = { started: false, aborted: false };
    (globalThis as typeof globalThis & { lifecycleResearch: typeof state }).lifecycleResearch = state;
    const fs = process.getBuiltinModule('node:fs') as typeof import('node:fs');
    globalThis.fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url === 'https://taiki-maeda-bkmn.github.io/public-page/data/papers.json') return Response.json({ schemaVersion: 1,
        editions: [{ editionId: fixtures.editionId, date: '2026-10-28', kind: 'daily', papers: [fixtures.paper] }] });
      if (url === `https://taiki-maeda-bkmn.github.io/public-page/data/archive/${fixtures.editionId}.json`) return Response.json({ schemaVersion: 2,
        editionId: fixtures.editionId, editionDate: '2026-10-28', editionKind: 'daily', papers: [fixtures.paper], sourceText: '## 1. Session paper\n\nPublished session commentary.\n' });
      if (url === `https://arxiv.org/pdf/${fixtures.paper.arxivId}`) {
        const signal = init?.signal;
        if (!signal) throw new Error('The download must carry a cancellation signal.');
        state.started = true;
        return new Promise<Response>((_resolve, reject) => {
          const abort = () => { state.aborted = true; fs.writeFileSync(fixtures.marker, 'aborted'); reject(signal.reason); };
          if (signal.aborted) abort(); else signal.addEventListener('abort', abort, { once: true });
        });
      }
      throw new Error('Unexpected request in lifecycle test: ' + url);
    };
  }, { marker, editionId, paper });
  await addDraft();
  await page.getByRole('navigation', { name: 'Workspaces', exact: true }).getByRole('button', { name: 'PDFs', exact: true }).click();
  await page.getByRole('button', { name: 'Rates & Execution', exact: true }).click();
  const research = page.getByRole('dialog', { name: 'Rates & Execution', exact: true });
  await research.getByRole('button', { name: 'View review for Session paper (2601.00001)', exact: true }).click();
  await research.getByRole('button', { name: 'Import PDF + review', exact: true }).click();
  await expect.poll(() => desktop!.evaluate(() => (globalThis as typeof globalThis & { lifecycleResearch: { started: boolean } }).lifecycleResearch.started)).toBe(true);
  await desktop!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
  await expect(dirtyPrompt()).toBeVisible();
  await dirtyPrompt().getByRole('button', { name: 'Cancel', exact: true }).click();
  expect(await desktop!.evaluate(() => (globalThis as typeof globalThis & { lifecycleResearch: { aborted: boolean } }).lifecycleResearch.aborted)).toBe(false);
  expectLibraryOwnership(true);
  await desktop!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
  await expect(dirtyPrompt()).toBeVisible();
  await expectNormalExit(() => dirtyPrompt().getByRole('button', { name: 'Discard changes', exact: true }).click());
  expect(await readFile(marker, 'utf8')).toBe('aborted');
  expect(await readFile(path.join(notebook, noteName), 'utf8')).toBe(original);
  expect(await readdir(notebook)).toEqual([noteName]);
  expect(await readFile(catalogFile(), 'utf8')).toBe(catalogBytes);
  expect(await readdir(path.join(pdfProfile, 'library/documents'))).toEqual([]);
  await launch();
  await closeWindow();
});
