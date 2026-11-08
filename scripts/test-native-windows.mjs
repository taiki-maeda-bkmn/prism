import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { DatabaseSync } from 'node:sqlite';
import { chromium, expect } from '@playwright/test';

// Run with Windows Node (or Windows Electron with ELECTRON_RUN_AS_NODE=1).
// This deliberately tests the real shortcut wrapper without Playwright's
// Electron loader, a WSLg connection, or the user's notebook/profile.
const execute = promisify(execFile);
const args = process.argv.slice(2);
const options = {};
for (let i = 0; i < args.length; i += 2) {
  if (!['--release', '--output'].includes(args[i]) || !args[i + 1] || options[args[i]]) {
    throw new Error('Usage: test-native-windows.mjs --release C:\\...\\release [--output C:\\...\\evidence.json]');
  }
  options[args[i]] = args[i + 1];
}
if (process.platform !== 'win32') throw new Error('Run this harness with Windows Node, not a WSL/Linux runtime.');
const localPath = value => typeof value === 'string' && /^[a-z]:[\\/]/i.test(value);
if (!localPath(options['--release'])) throw new Error('--release must be an absolute local Windows drive path.');
if (options['--output'] && !localPath(options['--output'])) throw new Error('--output must be an absolute local Windows drive path.');
const release = path.resolve(options['--release']);
const manifest = JSON.parse(await readFile(path.join(release, 'release.json'), 'utf8'));
assert.equal(manifest.application, 'Prism');
assert.equal(manifest.platform, 'win32');
assert.equal(manifest.format, 1);
const executable = path.join(release, 'node_modules', 'electron', 'dist', 'electron.exe');
const wrapper = path.join(release, 'scripts', 'start-markdown.mjs');
const temporary = await mkdtemp(path.join(os.tmpdir(), 'prism-native-regression-'));
const output = path.resolve(options['--output'] ?? `${temporary}.evidence.json`);
const notebook = path.join(temporary, 'notebook');
const profile = path.join(temporary, 'notes-profile');
const pdfProfile = path.join(temporary, 'pdf-profile');
const noteFile = path.join(notebook, 'Native session.md');
const title = `Prism host geometry ${randomUUID().replaceAll('-', '')}`;
const original = '\ufeff# Native session\r\n\r\nKeep the saved notebook intact.\r\n';
const savedText = '日本語の保存テスト。';
const draft = ' 再起動前の未保存メモ。';
const catalog = '{"version":1,"documents":[]}\n';
const evidence = { started: new Date().toISOString(), release, releaseId: manifest.id, temporary, output, phases: [], sessions: [], passed: false };
const sessions = [];
let current;

async function powershell(script, values = {}) {
  const encodedValues = Buffer.from(JSON.stringify(values), 'utf8').toString('base64');
  const source = `$ErrorActionPreference='Stop'; $ProgressPreference='SilentlyContinue'; [Console]::OutputEncoding=[Text.Encoding]::UTF8\n` +
    `$inputValues=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encodedValues}')) | ConvertFrom-Json\n` + script;
  const result = await execute(path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(source, 'utf16le').toString('base64')],
    { encoding: 'utf8', timeout: 15_000, windowsHide: true, maxBuffer: 1_048_576 });
  return JSON.parse(result.stdout.trim());
}

async function processTree(rootPID) {
  return powershell(`
$all=@(Get-CimInstance Win32_Process)
$selected=[Collections.Generic.List[object]]::new()
$ids=[Collections.Generic.HashSet[uint32]]::new()
[void]$ids.Add([uint32]$inputValues.pid)
do {
  $changed=$false
  foreach($item in $all) {
    if($ids.Contains([uint32]$item.ParentProcessId) -and $ids.Add([uint32]$item.ProcessId)) { $changed=$true }
  }
} while($changed)
foreach($item in $all) {
  if($ids.Contains([uint32]$item.ProcessId)) {
    $selected.Add([ordered]@{ pid=[int]$item.ProcessId; parent=[int]$item.ParentProcessId; born=$item.CreationDate.ToUniversalTime().Ticks.ToString(); executable=$item.ExecutablePath; command=$item.CommandLine })
  }
}
ConvertTo-Json -InputObject @($selected.ToArray()) -Depth 4 -Compress
`, { pid: rootPID });
}

async function remainingProcesses(owned) {
  return powershell(`
$remaining=@(foreach($expected in $inputValues.owned) {
  $item=Get-CimInstance Win32_Process -Filter ("ProcessId = " + [int]$expected.pid)
  if($item -and $item.CreationDate.ToUniversalTime().Ticks.ToString() -ceq $expected.born) { [int]$item.ProcessId }
})
ConvertTo-Json -InputObject $remaining -Compress
`, { owned });
}

async function hostWindow(session, click = false) {
  // Both the OS PID and the exact UUID title must match before observing or
  // clicking. Unlike a WSLg surface, this HWND belongs to native Electron.
  assert.ok(Number.isSafeInteger(session.mainPID) && session.mainPID > 0);
  assert.match(title, /^Prism host geometry [a-f0-9]{32}$/);
  return powershell(`
Add-Type @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class PrismNativeTest {
  public delegate bool EnumProc(IntPtr window, IntPtr parameter);
  [StructLayout(LayoutKind.Sequential)] public struct Rect { public int left, top, right, bottom; }
  [StructLayout(LayoutKind.Sequential)] public struct Point { public int x, y; }
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc callback, IntPtr parameter);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr window, StringBuilder title, int size);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr window, out uint process);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr window);
  [DllImport("user32.dll")] public static extern bool IsWindowEnabled(IntPtr window);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr window);
  [DllImport("user32.dll")] public static extern bool IsZoomed(IntPtr window);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr window, out Rect rect);
  [DllImport("user32.dll")] public static extern bool GetClientRect(IntPtr window, out Rect rect);
  [DllImport("user32.dll")] public static extern bool ClientToScreen(IntPtr window, ref Point point);
  [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr value);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr window);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(Point point);
  [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr window, uint flags);
  [DllImport("user32.dll")] public static extern bool GetCursorPos(out Point point);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern short GetAsyncKeyState(int key);
  [DllImport("user32.dll")] private static extern void mouse_event(uint flags, uint x, uint y, uint data, UIntPtr extra);
  public static uint Owner(IntPtr window) { uint process; GetWindowThreadProcessId(window,out process); return process; }
  static bool Owns(IntPtr window, uint process, string title, Point target) {
    var actual=new StringBuilder(512); GetWindowText(window,actual,512);
    return Owner(window)==process && actual.ToString()==title && IsWindowVisible(window) && IsWindowEnabled(window)
      && !IsIconic(window) && GetForegroundWindow()==window && GetAncestor(WindowFromPoint(target),2)==window;
  }
  public static bool Click(IntPtr window, uint process, string title) {
    Rect client; if(!GetClientRect(window,out client)) return false;
    Point target=new Point { x=(client.right-client.left)/2, y=(client.bottom-client.top)/2 };
    if(!ClientToScreen(window,ref target)) return false;
    SetForegroundWindow(window);
    if(!Owns(window,process,title,target)) return false;
    if((GetAsyncKeyState(1)&0x8000)!=0 || (GetAsyncKeyState(2)&0x8000)!=0) return false;
    Point previous; if(!GetCursorPos(out previous)) return false;
    try {
      if(!SetCursorPos(target.x,target.y) || !Owns(window,process,title,target)) return false;
      mouse_event(0x0002,0,0,0,UIntPtr.Zero); mouse_event(0x0004,0,0,0,UIntPtr.Zero);
      return true;
    } finally {
      Point current; if(GetCursorPos(out current) && current.x==target.x && current.y==target.y) SetCursorPos(previous.x,previous.y);
    }
  }
}
'@
[void][PrismNativeTest]::SetProcessDpiAwarenessContext([IntPtr](-4))
$matches=[Collections.Generic.List[IntPtr]]::new()
[void][PrismNativeTest]::EnumWindows({ param($window,$unused)
  if([PrismNativeTest]::Owner($window) -eq [uint32]$inputValues.pid) {
    $name=[Text.StringBuilder]::new(512)
    [void][PrismNativeTest]::GetWindowText($window,$name,512)
    if($name.ToString() -ceq $inputValues.title) { $matches.Add($window) }
  }
  return $true
},[IntPtr]::Zero)
$result=[ordered]@{ count=$matches.Count; found=($matches.Count -eq 1) }
if($matches.Count -eq 1) {
  $window=$matches[0]
  $rect=[PrismNativeTest+Rect]::new()
  [void][PrismNativeTest]::GetWindowRect($window,[ref]$rect)
  $result.handle=$window.ToInt64().ToString(); $result.pid=[PrismNativeTest]::Owner($window)
  $result.visible=[PrismNativeTest]::IsWindowVisible($window); $result.enabled=[PrismNativeTest]::IsWindowEnabled($window)
  $result.minimized=[PrismNativeTest]::IsIconic($window); $result.maximized=[PrismNativeTest]::IsZoomed($window); $result.rect=$rect
  if($inputValues.click) { $result.clicked=[PrismNativeTest]::Click($window,[uint32]$inputValues.pid,$inputValues.title) }
}
ConvertTo-Json -InputObject $result -Depth 4 -Compress
`, { pid: session.mainPID, title, click });
}

function start() {
  const child = spawn(executable, [wrapper, '--remote-debugging-port=0'], {
    cwd: release, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', PRISM_USER_DATA: profile, PRISM_WORKSPACE: notebook, PRISM_PDF_USER_DATA: pdfProfile },
  });
  const session = { child, stdout: '', stderr: '', owned: [] };
  child.stdout.on('data', chunk => { session.stdout = (session.stdout + chunk).slice(-131_072); });
  child.stderr.on('data', chunk => { session.stderr = (session.stderr + chunk).slice(-131_072); });
  child.on('error', error => { session.error = error.message; });
  sessions.push(session);
  return session;
}

async function launch() {
  const session = start(); current = session;
  await expect.poll(() => session.error ?? session.stderr.match(/DevTools listening on (ws:\/\/[^\s]+)/)?.[1], { timeout: 35_000 }).toMatch(/^ws:\/\//);
  const endpoint = session.stderr.match(/DevTools listening on (ws:\/\/[^\s]+)/)[1];
  assert.equal(new URL(endpoint).hostname, '127.0.0.1');
  session.browser = await chromium.connectOverCDP(endpoint, { timeout: 15_000 });
  const context = session.browser.contexts()[0];
  session.page = context.pages()[0] ?? await context.waitForEvent('page');
  const page = session.page;
  await expect(page.locator('.note-heading h1')).toHaveText('Native session');
  assert.equal(await page.evaluate(() => window.prism.platform), 'win32');
  if (process.env.PRISM_TEST_TRANSPARENT === '1') {
    await page.getByRole('button', { name: 'Window appearance', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Make a little space', exact: true });
    const toggle = dialog.getByRole('switch', { name: 'Transparent window', exact: true });
    if (await toggle.getAttribute('aria-checked') !== 'true') await toggle.click();
    await dialog.locator('#opacity').fill('35');
    await dialog.getByRole('button', { name: 'Done', exact: true }).click();
  }
  await expect.poll(() => session.stdout).toMatch(/(?:^|\n)PRISM_READY:[a-f0-9]{48}\r?\n/);
  session.owned = await processTree(session.child.pid);
  const mains = session.owned.filter(item => item.parent === session.child.pid && item.executable?.toLowerCase() === executable.toLowerCase());
  assert.equal(mains.length, 1, 'The native wrapper must own exactly one Electron main process.');
  session.mainPID = mains[0].pid;
  await page.evaluate(value => { document.title = value; window.nativeRegressionSentinel = value; }, title);
  await expect.poll(async () => {
    const host = await hostWindow(session);
    return host.found && host.visible && host.enabled && !host.minimized;
  }).toBe(true);
  await page.evaluate(() => window.prismPdf.loadLibrary());
  evidence.phases.push({ phase: 'native ready', wrapperPID: session.child.pid, host: await hostWindow(session), processes: session.owned });
  return session;
}

async function nativePointer(session) {
  await session.page.evaluate(() => {
    window.nativePointerEvents = [];
    window.addEventListener('pointerdown', event => window.nativePointerEvents.push({
      x: event.clientX, y: event.clientY, target: event.target?.id,
    }), { capture: true, once: true });
    const button = document.createElement('button');
    button.id = 'native-host-pointer'; button.textContent = 'Native input check'; button.dataset.clicked = 'no';
    button.style.cssText = 'position:fixed;left:calc(50% - 140px);top:calc(50% - 50px);width:280px;height:100px;z-index:2147483647;background:white;color:black;-webkit-app-region:no-drag';
    button.onclick = () => { button.dataset.clicked = 'yes'; };
    document.body.append(button);
  });
  try {
    const host = await hostWindow(session, true);
    assert.equal(host.clicked, true, 'A guarded native Windows pointer click must reach the owned HWND.');
    await expect(session.page.locator('#native-host-pointer')).toHaveAttribute('data-clicked', 'yes');
    evidence.phases.push({ phase: 'native pointer', host });
  } finally {
    evidence.phases.push({ phase: 'native pointer geometry', observation: await session.page.evaluate(() => ({
      width: innerWidth, height: innerHeight, scale: devicePixelRatio,
      target: document.getElementById('native-host-pointer')?.getBoundingClientRect().toJSON(), events: window.nativePointerEvents,
    })) });
    await session.page.evaluate(() => document.getElementById('native-host-pointer')?.remove());
  }
}

function libraryAvailable() {
  const database = new DatabaseSync(path.join(pdfProfile, 'library', '.prism-library-lock.sqlite'));
  try { database.exec('BEGIN EXCLUSIVE'); } finally { database.close(); }
}

async function expectExit(session) {
  await expect.poll(() => session.child.exitCode, { timeout: 20_000 }).toBe(0);
  if (session.browser) await expect.poll(() => session.browser.isConnected()).toBe(false);
  await expect.poll(() => remainingProcesses(session.owned), { timeout: 15_000 }).toEqual([]);
  session.child.stdout.destroy(); session.child.stderr.destroy();
  libraryAvailable();
  evidence.phases.push({ phase: 'clean native exit', wrapperPID: session.child.pid, mainPID: session.mainPID });
}

async function verifyPowerShellLauncher() {
  const logDirectory = path.join(temporary, 'shortcut-logs');
  const launcher = path.join(release, 'scripts', 'native-windows-launch.ps1');
  const child = spawn(path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', launcher,
      '-LogDirectory', logDirectory], {
      cwd: release, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, PRISM_USER_DATA: profile, PRISM_WORKSPACE: notebook, PRISM_PDF_USER_DATA: pdfProfile },
    });
  const session = { child, stdout: '', stderr: '', owned: [], launcher: 'PowerShell' };
  child.stdout.on('data', chunk => { session.stdout = (session.stdout + chunk).slice(-131_072); });
  child.stderr.on('data', chunk => { session.stderr = (session.stderr + chunk).slice(-131_072); });
  child.on('error', error => { session.error = error.message; });
  sessions.push(session); current = session;
  let main;

  async function windowState(close = false) {
    // The actual shortcut does not enable CDP, so it keeps the normal Prism
    // title. Match its freshly owned PID, creation timestamp and executable
    // before looking up or closing this specific disposable fixture window.
    assert.ok(main && Number.isSafeInteger(main.pid));
    return powershell(`
$item=Get-CimInstance Win32_Process -Filter ("ProcessId = " + [int]$inputValues.pid)
if(-not $item -or $item.CreationDate.ToUniversalTime().Ticks.ToString() -cne $inputValues.born -or $item.ExecutablePath -ine $inputValues.executable) {
  throw 'The owned native launcher process identity changed.'
}
Add-Type @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class PrismShortcutTest {
  public delegate bool EnumProc(IntPtr window, IntPtr parameter);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc callback, IntPtr parameter);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr window, StringBuilder title, int size);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr window, out uint process);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr window);
  [DllImport("user32.dll")] public static extern bool IsWindowEnabled(IntPtr window);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr window);
  public static uint Owner(IntPtr window) { uint process; GetWindowThreadProcessId(window,out process); return process; }
}
'@
$matches=[Collections.Generic.List[IntPtr]]::new()
[void][PrismShortcutTest]::EnumWindows({ param($window,$unused)
  if([PrismShortcutTest]::Owner($window) -eq [uint32]$inputValues.pid) {
    $name=[Text.StringBuilder]::new(512)
    [void][PrismShortcutTest]::GetWindowText($window,$name,512)
    if($name.ToString() -ceq 'Prism') { $matches.Add($window) }
  }
  return $true
},[IntPtr]::Zero)
$result=[ordered]@{ count=$matches.Count; found=($matches.Count -eq 1); pid=[int]$inputValues.pid }
if($matches.Count -eq 1) {
  $window=$matches[0]
  $result.handle=$window.ToInt64().ToString(); $result.visible=[PrismShortcutTest]::IsWindowVisible($window)
  $result.enabled=[PrismShortcutTest]::IsWindowEnabled($window); $result.minimized=[PrismShortcutTest]::IsIconic($window)
  if($inputValues.close) {
    $target=Get-Process -Id ([int]$inputValues.pid)
    # CloseMainWindow sends the normal close message; no termination/reload.
    if($target.MainWindowHandle -ne $window -or [PrismShortcutTest]::Owner($window) -ne [uint32]$inputValues.pid) {
      throw 'The owned shortcut window changed before close.'
    }
    $result.closeRequested=$target.CloseMainWindow()
  }
}
ConvertTo-Json -InputObject $result -Depth 3 -Compress
`, { pid: main.pid, born: main.born, executable, close });
  }

  try {
    await expect.poll(async () => {
      if (session.error) throw new Error(session.error);
      session.owned = await processTree(child.pid);
      const supervisors = session.owned.filter(item => item.parent === child.pid && item.executable?.toLowerCase() === executable.toLowerCase());
      if (supervisors.length !== 1) return false;
      const mains = session.owned.filter(item => item.parent === supervisors[0].pid && item.executable?.toLowerCase() === executable.toLowerCase());
      if (mains.length !== 1) return false;
      main = mains[0]; session.mainPID = main.pid; session.supervisorPID = supervisors[0].pid;
      return true;
    }, { timeout: 35_000 }).toBe(true);
    await expect.poll(async () => {
      const host = await windowState();
      return host.found && host.visible && host.enabled && !host.minimized;
    }, { timeout: 35_000 }).toBe(true);
    // Record the real launcher path with no debugging flags or loader hooks.
    evidence.phases.push({ phase: 'PowerShell shortcut native ready', powershellPID: child.pid,
      supervisorPID: session.supervisorPID, host: await windowState(), processes: session.owned });
    session.owned = await processTree(child.pid);
    const closing = await windowState(true);
    assert.equal(closing.closeRequested, true);
    await expectExit(session);
    assert.equal(await readFile(noteFile, 'utf8'), original + savedText + draft);
  } finally {
    if (child.exitCode === null && main) await windowState(true).catch(() => {});
    // Startup logs are part of the evidence even if the launcher reports an
    // error. They are restricted to this fresh fixture's logging directory.
    const { readdir } = await import('node:fs/promises');
    session.logs = {};
    for (const name of await readdir(logDirectory).catch(() => [])) {
      if (/^[0-9]{8}-[0-9]{6}-[0-9]{3}-[a-f0-9]{8}\.(stdout|stderr)\.log$/.test(name)) {
        session.logs[name] = (await readFile(path.join(logDirectory, name), 'utf8')).slice(-131_072);
      }
    }
    if (child.exitCode === 0) assert.match(Object.values(session.logs).join('\n'), /PRISM_READY:[a-f0-9]{48}/);
  }
}

try {
  await mkdir(notebook); await mkdir(path.join(pdfProfile, 'library', 'documents'), { recursive: true });
  await writeFile(noteFile, original);
  await writeFile(path.join(pdfProfile, 'library', 'catalog.json'), catalog);
  const first = await launch();
  const page = first.page;
  const editor = page.locator('.app-body .cm-content');
  const dialog = page.getByRole('dialog', { name: 'Keep your latest thoughts?', exact: true });
  await nativePointer(first);
  await page.getByRole('group', { name: 'Editor mode', exact: true }).getByRole('button', { name: 'Source', exact: true }).click();
  await editor.focus(); await editor.press('Control+End'); await page.keyboard.insertText(savedText);
  await expect(editor).toContainText(savedText);
  await editor.press('Control+s');
  await expect.poll(() => readFile(noteFile, 'utf8')).toBe(original + savedText);
  // The atomic rename precedes the renderer's save acknowledgement. The
  // editor is inert until that acknowledgement; do not inject the next draft
  // into a deliberately disabled input and mistake it for a lost draft.
  await expect(page.locator('.statusbar')).toContainText('All changes saved');
  evidence.phases.push({ phase: 'Japanese keyboard save', preservedBOM: true, preservedCRLF: true });
  await editor.press('Control+End'); await page.keyboard.insertText(draft);
  await expect(editor).toContainText(draft);
  await page.getByRole('button', { name: 'Close window', exact: true }).click();
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(editor).toContainText(draft);
  assert.equal(await readFile(noteFile, 'utf8'), original + savedText);
  evidence.phases.push({ phase: 'dirty close cancelled', host: await hostWindow(first) });

  for (let cycle = 0; cycle < 2; cycle++) {
    await page.getByRole('button', { name: 'Minimize window', exact: true }).click();
    await expect.poll(async () => (await hostWindow(first)).minimized).toBe(true);
    const duplicate = start();
    await expect.poll(() => duplicate.child.exitCode, { timeout: 15_000 }).toBe(0);
    duplicate.child.stdout.destroy(); duplicate.child.stderr.destroy();
    await expect.poll(async () => {
      const host = await hostWindow(first);
      return host.found && host.pid === first.mainPID && host.visible && host.enabled && !host.minimized;
    }).toBe(true);
    assert.equal(await page.evaluate(() => window.nativeRegressionSentinel), title, 'Explicit relaunch must keep the existing renderer.');
    await expect(editor).toContainText(draft);
    assert.equal(await readFile(noteFile, 'utf8'), original + savedText);
    await nativePointer(first);
    evidence.phases.push({ phase: 'second launch restored existing session', cycle, duplicatePID: duplicate.child.pid, host: await hostWindow(first) });
  }
  first.owned = await processTree(first.child.pid);
  await page.getByRole('button', { name: 'Close window', exact: true }).click();
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'Save & continue', exact: true }).click();
  await expectExit(first);
  assert.equal(await readFile(noteFile, 'utf8'), original + savedText + draft);
  const reopened = await launch();
  assert.notEqual(reopened.mainPID, first.mainPID);
  await expect(reopened.page.locator('.app-body .cm-content')).toContainText(savedText + draft);
  await nativePointer(reopened);
  reopened.owned = await processTree(reopened.child.pid);
  await reopened.page.getByRole('button', { name: 'Close window', exact: true }).click();
  await expectExit(reopened);
  assert.equal(await readFile(noteFile, 'utf8'), original + savedText + draft);
  assert.equal(await readFile(path.join(pdfProfile, 'library', 'catalog.json'), 'utf8'), catalog);
  await verifyPowerShellLauncher();
  evidence.passed = true;
} catch (error) {
  evidence.error = error.stack ?? String(error);
  process.exitCode = 1;
  // Attempt a normal close of this disposable fixture only. Do not conceal a
  // lifecycle failure with an implicit taskkill or touch another Prism launch.
  if (current?.page && !current.page.isClosed()) {
    await current.page.screenshot({ path: `${output}.failure.png` }).catch(() => {});
    await current.page.evaluate(() => window.prism.windowControl('close')).catch(() => {});
    const prompt = current.page.getByRole('dialog', { name: 'Keep your latest thoughts?', exact: true });
    if (await prompt.isVisible().catch(() => false)) await prompt.getByRole('button', { name: 'Save & continue', exact: true }).click().catch(() => {});
  }
} finally {
  for (const session of sessions) {
    evidence.sessions.push({ wrapperPID: session.child.pid, mainPID: session.mainPID, launcher: session.launcher,
      supervisorPID: session.supervisorPID, exitCode: session.child.exitCode, stdout: session.stdout, stderr: session.stderr,
      launcherLogs: session.logs, error: session.error });
    // A CDP disconnect is not an application quit. Leave any failed owned
    // process identifiable in evidence instead of silently killing it.
    await session.browser?.close().catch(() => {});
    session.child.stdout?.destroy(); session.child.stderr?.destroy(); session.child.unref();
  }
  evidence.finished = new Date().toISOString();
  await mkdir(path.dirname(output), { recursive: true });
  await writeFile(output, JSON.stringify(evidence, null, 2) + '\n');
  if (evidence.passed) await rm(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  console.log(JSON.stringify({ passed: evidence.passed, evidence: output, fixture: evidence.passed ? 'removed' : temporary, error: evidence.error }, null, 2));
}
