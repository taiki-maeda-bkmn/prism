import { electronLaunchArguments } from '../../scripts/electron-launch.mjs';
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const welcome = '# Snippet practice\n\n';
const diskText = (content: string) => '\ufeff' + content.replace(/\n/g, '\r\n');
let temporary: string;
let notebook: string;
let userData: string;
let desktop: ElectronApplication | undefined;
let page: Page;
let pageErrors: string[];

const sourceEditor = () => page.getByLabel('Markdown source', { exact: true });
const liveEditor = () => page.getByLabel('Live Markdown editor', { exact: true });
const source = async () => (await sourceEditor().locator('.cm-line').allTextContents()).join('\n');
const selectedText = () => page.evaluate(() => window.getSelection()?.toString() ?? '');
const manager = () => page.getByRole('dialog', { name: 'Markdown snippets', exact: true });

async function launch() {
  desktop = await electron.launch({
    args: electronLaunchArguments(['--no-sandbox', '.']), cwd: process.cwd(),
    env: { ...process.env, PRISM_USER_DATA: userData, PRISM_WORKSPACE: notebook },
  });
  page = await desktop.firstWindow();
  pageErrors = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  await expect(page.locator('.note-heading h1')).toHaveText('Snippet practice');
  await expect.poll(() => desktop!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible())).toBe(true);
}

async function closeTestApp() {
  if (!desktop) return;
  // Only the process launched with this test's temporary profile is closed.
  const child = desktop.process();
  const closed = desktop.waitForEvent('close', { timeout: 5_000 }).catch(() => undefined);
  await desktop.evaluate(({ app }) => app.exit(0)).catch(() => undefined);
  await closed;
  if (child.exitCode === null) child.kill();
  desktop = undefined;
}

async function openManager() {
  await page.getByRole('button', { name: 'Snippet help', exact: true }).click();
  await expect(manager()).toBeVisible();
}

async function closeManager() {
  await manager().getByRole('button', { name: 'Done', exact: true }).click();
  await expect(manager()).toHaveCount(0);
}

async function saveNote(content: string) {
  await page.keyboard.press('ControlOrMeta+s');
  await expect(page.locator('.statusbar')).toContainText('All changes saved');
  await expect.poll(() => readFile(path.join(notebook, 'Welcome to Prism.md'), 'utf8')).toBe(diskText(content));
}

test.beforeEach(async () => {
  temporary = await mkdtemp(path.join(os.tmpdir(), 'prism-custom-snippets-test-'));
  notebook = path.join(temporary, 'Notebook');
  userData = path.join(temporary, 'profile');
  await Promise.all([mkdir(notebook), mkdir(userData)]);
  await writeFile(path.join(notebook, 'Welcome to Prism.md'), diskText(welcome));
  await launch();
});

test.afterEach(async ({}, testInfo) => {
  if (page && !page.isClosed() && testInfo.status !== testInfo.expectedStatus) {
    const screenshot = await page.screenshot().catch(() => undefined);
    if (screenshot) await testInfo.attach('Custom snippets at failure', { body: screenshot, contentType: 'image/png' });
  }
  await closeTestApp();
  if (temporary) await rm(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

test('adds Japanese templates without losing drafts and expands fields immediately in Source and Live', async ({}, testInfo) => {
  await page.getByRole('button', { name: 'Source', exact: true }).click();
  await sourceEditor().focus();
  await sourceEditor().press('ControlOrMeta+End');
  const draft = 'Draft kept across snippet settings.';
  await page.keyboard.insertText(draft);
  await openManager();
  await expect(manager().locator('.snippet-catalog dt')).toHaveCount(8);
  await manager().getByRole('button', { name: 'Add snippet', exact: true }).click();
  await manager().getByLabel('Name', { exact: true }).fill('会議のメモ');
  await manager().getByLabel('Shortcut', { exact: true }).fill('/task');
  await manager().getByLabel('Template', { exact: true }).fill('## ${1:議題}\n- [ ] ${2:次の行動}\n${0}');
  await manager().getByLabel('Description (optional)', { exact: true }).fill('議題と次の行動を書く。');
  await expect(manager().getByLabel('Allow inside a sentence', { exact: true })).not.toBeChecked();
  await manager().getByRole('button', { name: 'Save snippet', exact: true }).click();
  await expect(manager().getByRole('alert')).toContainText(/already|built-in|reserved|used/i);
  await expect(manager().getByRole('button', { name: 'Save snippet', exact: true })).toBeVisible();
  await manager().getByLabel('Shortcut', { exact: true }).fill('/meeting');
  await manager().getByRole('button', { name: 'Save snippet', exact: true }).click();
  await expect(manager().getByRole('button', { name: 'Edit /meeting', exact: true })).toBeVisible();
  await closeManager();

  await expect.poll(source).toBe(welcome + draft);
  expect(await readFile(path.join(notebook, 'Welcome to Prism.md'), 'utf8')).toBe(diskText(welcome));
  await sourceEditor().focus();
  await sourceEditor().press('ControlOrMeta+z');
  await expect.poll(source).toBe(welcome);
  await sourceEditor().press('ControlOrMeta+Shift+z');
  await expect.poll(source).toBe(welcome + draft);
  await sourceEditor().press('ControlOrMeta+End');
  await page.keyboard.insertText('\n\n');
  await sourceEditor().pressSequentially('/meeting');
  // A full shortcut must expand before an asynchronous popup has appeared.
  await sourceEditor().press('Tab');
  await expect.poll(selectedText).toBe('議題');
  await page.keyboard.insertText('計画');
  await sourceEditor().press('Tab');
  await expect.poll(selectedText).toBe('次の行動');
  await page.keyboard.insertText('資料を読む');
  await sourceEditor().press('Shift+Tab');
  await expect.poll(selectedText).toBe('計画');
  await page.keyboard.insertText('週の計画');
  await sourceEditor().press('Tab');
  await expect.poll(selectedText).toBe('資料を読む');
  await sourceEditor().press('Tab');
  await page.keyboard.insertText('議事録を残す。');
  const sourceDraft = welcome + draft + '\n\n## 週の計画\n- [ ] 資料を読む\n議事録を残す。';
  await expect.poll(source).toBe(sourceDraft);

  await page.getByRole('button', { name: 'Live', exact: true }).click();
  await liveEditor().focus();
  await liveEditor().press('ControlOrMeta+End');
  await page.keyboard.insertText('\n\n');
  await liveEditor().pressSequentially('/meeting');
  await liveEditor().press('Tab');
  await expect.poll(selectedText).toBe('議題');
  await page.keyboard.insertText('振り返り');
  await liveEditor().press('Tab');
  await expect.poll(selectedText).toBe('次の行動');
  await page.keyboard.insertText('次へ進む');
  await liveEditor().press('Tab');
  await expect(liveEditor().getByRole('checkbox')).toHaveCount(2);
  await testInfo.attach('Custom Japanese snippet in Live', {
    body: await page.screenshot({ path: testInfo.outputPath('custom-snippet-live.png') }), contentType: 'image/png',
  });
  const saved = sourceDraft + '\n\n## 振り返り\n- [ ] 次へ進む\n';
  await saveNote(saved);
  await page.getByRole('button', { name: 'Source', exact: true }).click();
  await expect.poll(source).toBe(saved);
  expect(pageErrors).toEqual([]);
});

test('edits inline shortcuts, remembers them after restart, and removes deleted snippets immediately', async () => {
  await page.getByRole('button', { name: 'Source', exact: true }).click();
  await sourceEditor().focus();
  await sourceEditor().press('ControlOrMeta+End');
  await page.keyboard.insertText('From ');
  await openManager();
  await manager().getByRole('button', { name: 'Add snippet', exact: true }).click();
  await manager().getByLabel('Name', { exact: true }).fill('Signature');
  await manager().getByLabel('Shortcut', { exact: true }).fill('/signature');
  await manager().getByLabel('Template', { exact: true }).fill('${1:署名} — ${2:役割}${0}');
  await manager().getByLabel('Allow inside a sentence', { exact: true }).check();
  await manager().getByRole('button', { name: 'Save snippet', exact: true }).click();
  await manager().getByRole('button', { name: 'Edit /signature', exact: true }).click();
  await expect(manager().getByLabel('Allow inside a sentence', { exact: true })).toBeChecked();
  await manager().getByLabel('Shortcut', { exact: true }).fill('/sign-off');
  await manager().getByLabel('Template', { exact: true }).fill('${1:お名前} (${2:部署})${0}');
  await manager().getByRole('button', { name: 'Save snippet', exact: true }).click();
  await expect(manager().getByRole('button', { name: 'Edit /signature', exact: true })).toHaveCount(0);
  await expect(manager().getByRole('button', { name: 'Edit /sign-off', exact: true })).toBeVisible();
  await closeManager();
  await expect.poll(source).toBe(welcome + 'From ');

  await sourceEditor().focus();
  await sourceEditor().press('ControlOrMeta+End');
  await sourceEditor().pressSequentially('/signature');
  await sourceEditor().press('Tab');
  await expect(sourceEditor()).not.toBeFocused();
  await expect.poll(source).toBe(welcome + 'From /signature');
  // Replace only the old trigger; the note draft remains in the same editor.
  await sourceEditor().focus();
  await sourceEditor().press('ControlOrMeta+End');
  for (let index = 0; index < '/signature'.length; index++) await sourceEditor().press('Backspace');
  await sourceEditor().pressSequentially('/sign-off');
  await sourceEditor().press('Tab');
  await expect.poll(selectedText).toBe('お名前');
  await page.keyboard.insertText('花子');
  await sourceEditor().press('Tab');
  await expect.poll(selectedText).toBe('部署');
  await page.keyboard.insertText('開発');
  await sourceEditor().press('Tab');
  await page.keyboard.insertText('。');
  const saved = welcome + 'From 花子 (開発)。';
  await expect.poll(source).toBe(saved);
  await saveNote(saved);
  expect(pageErrors).toEqual([]);

  await closeTestApp();
  await launch();
  await openManager();
  await expect(manager().getByRole('button', { name: 'Edit /sign-off', exact: true })).toBeVisible();
  await expect(manager().getByRole('button', { name: 'Edit /signature', exact: true })).toHaveCount(0);
  await closeManager();
  await page.getByRole('button', { name: 'Live', exact: true }).click();
  await liveEditor().focus();
  await liveEditor().press('ControlOrMeta+End');
  await page.keyboard.insertText('\n\nTo ');
  await liveEditor().pressSequentially('/sign-off');
  await liveEditor().press('Tab');
  await expect.poll(selectedText).toBe('お名前');
  await page.keyboard.insertText('太郎');
  await liveEditor().press('Tab');
  await expect.poll(selectedText).toBe('部署');
  await page.keyboard.insertText('設計');
  await liveEditor().press('Tab');
  const savedAgain = saved + '\n\nTo 太郎 (設計)';
  await saveNote(savedAgain);

  await openManager();
  await manager().getByRole('button', { name: 'Delete /sign-off', exact: true }).click();
  await manager().getByRole('button', { name: 'Cancel deletion', exact: true }).click();
  await expect(manager().getByRole('button', { name: 'Edit /sign-off', exact: true })).toBeVisible();
  await manager().getByRole('button', { name: 'Delete /sign-off', exact: true }).click();
  await manager().getByRole('button', { name: 'Delete snippet', exact: true }).click();
  await expect(manager().getByRole('button', { name: 'Edit /sign-off', exact: true })).toHaveCount(0);
  await closeManager();
  await liveEditor().focus();
  await liveEditor().press('ControlOrMeta+End');
  await page.keyboard.insertText('\n\n');
  await liveEditor().pressSequentially('/sign-off');
  await liveEditor().press('Tab');
  await expect(liveEditor()).not.toBeFocused();
  await page.getByRole('button', { name: 'Source', exact: true }).click();
  await expect.poll(source).toBe(savedAgain + '\n\n/sign-off');
  expect(pageErrors).toEqual([]);

  await closeTestApp();
  await launch();
  await openManager();
  await expect(manager().getByRole('button', { name: 'Edit /sign-off', exact: true })).toHaveCount(0);
  await expect(manager().locator('.snippet-catalog dt')).toHaveCount(8);
  expect(await readFile(path.join(notebook, 'Welcome to Prism.md'), 'utf8')).toBe(diskText(savedAgain));
  expect(pageErrors).toEqual([]);
});
