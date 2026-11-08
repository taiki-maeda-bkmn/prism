import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import { _electron as electron, expect } from '@playwright/test';

// Run with Windows Node on an unlocked desktop. Edge must use raw CDP here:
// Playwright's connectOverCDP enables focus emulation and masks native occlusion.
// All windows, media, profiles, and processes below belong to this fixture.
const options = {};
const args = process.argv.slice(2);
for (let i = 0; i < args.length; i += 2) {
  if (!['--release', '--output'].includes(args[i]) || !args[i + 1] || options[args[i]]) {
    throw new Error('Usage: test-background-video-windows.mjs --release C:\\...\\release [--output C:\\...\\evidence.json]');
  }
  options[args[i]] = args[i + 1];
}
const localPath = value => typeof value === 'string' && /^[a-z]:[\\/]/i.test(value);
if (process.platform !== 'win32') throw new Error('Run this harness with Windows Node, not WSL/Linux.');
if (!localPath(options['--release'])) throw new Error('--release must be an absolute local Windows drive path.');
if (options['--output'] && !localPath(options['--output'])) throw new Error('--output must be an absolute local Windows drive path.');
const release = path.resolve(options['--release']);
const manifest = JSON.parse(await readFile(path.join(release, 'release.json'), 'utf8'));
assert.equal(manifest.application, 'Prism');
assert.equal(manifest.platform, 'win32');
assert.equal(manifest.format, 1);
const executable = path.join(release, 'node_modules', 'electron', 'dist', 'electron.exe');
await access(executable);
const edgeCandidates = process.env.PRISM_TEST_EDGE ? [process.env.PRISM_TEST_EDGE] : [
  path.join(process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
  path.join(process.env.ProgramFiles ?? 'C:\\Program Files', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
];
let edgeExecutable;
for (const candidate of edgeCandidates) {
  if (!localPath(candidate)) throw new Error('PRISM_TEST_EDGE must be an absolute local Windows executable path.');
  if (await access(candidate).then(() => true, () => false)) { edgeExecutable = candidate; break; }
}
if (!edgeExecutable) throw new Error('Microsoft Edge was not found. Set PRISM_TEST_EDGE to its executable.');
const temporary = await mkdtemp(path.join(os.tmpdir(), 'prism-background-video-'));
const output = path.resolve(options['--output'] ?? `${temporary}.evidence.json`);
await mkdir(path.dirname(output), { recursive: true });
const token = randomUUID().replaceAll('-', '');
const edgeTitle = `Prism background video ${token}`;
const prismTitle = `Prism video overlay ${token}`;
const notebook = path.join(temporary, 'notebook');
const noteFile = path.join(notebook, 'Video test.md');
const original = '\ufeff# Video test\r\n\r\nBackground video must keep playing while writing.\r\n';
let expectedNote = original;
const evidence = { started: new Date().toISOString(), release, releaseId: manifest.id, temporary, output, phases: [], passed: false };
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const execute = promisify(execFile);
let edge, prism, prismChild, notes, socket, edgePID, prismPID, edgeSession, edgeTarget;
let cdpSequence = 0;
let edgeError;
let owned = [];
const pending = new Map();

async function powershell(script, values = {}) {
  const encoded = Buffer.from(JSON.stringify(values), 'utf8').toString('base64');
  const source = `$ErrorActionPreference='Stop'; $ProgressPreference='SilentlyContinue'; [Console]::OutputEncoding=[Text.Encoding]::UTF8\n` +
    `$inputValues=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encoded}')) | ConvertFrom-Json\n` + script;
  const result = await execute(path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(source, 'utf16le').toString('base64')],
    { encoding: 'utf8', timeout: 15_000, windowsHide: true, maxBuffer: 1_048_576 });
  return JSON.parse(result.stdout.trim());
}

async function rememberProcesses() {
  const roots = [edge?.pid, edgePID, prismChild?.pid, prismPID].filter(Number.isSafeInteger)
    .map(pid => ({ pid, born: owned.find(item => item.pid === pid)?.born }));
  const found = await powershell(`
$all=@(Get-CimInstance Win32_Process)
$ids=[Collections.Generic.HashSet[uint32]]::new()
foreach($root in $inputValues.roots) {
  $item=$all | Where-Object { $_.ProcessId -eq [uint32]$root.pid } | Select-Object -First 1
  if($item -and (-not $root.born -or $item.CreationDate.ToUniversalTime().Ticks.ToString() -ceq $root.born)) {
    [void]$ids.Add([uint32]$root.pid)
  }
}
do {
  $changed=$false
  foreach($item in $all) {
    if($ids.Contains([uint32]$item.ParentProcessId) -and $ids.Add([uint32]$item.ProcessId)) { $changed=$true }
  }
} while($changed)
$selected=@(foreach($item in $all) {
  if($ids.Contains([uint32]$item.ProcessId)) {
    [ordered]@{ pid=[int]$item.ProcessId; born=$item.CreationDate.ToUniversalTime().Ticks.ToString(); executable=$item.ExecutablePath }
  }
})
ConvertTo-Json -InputObject $selected -Compress
`, { roots });
  for (const item of found) if (!owned.some(old => old.pid === item.pid && old.born === item.born)) owned.push(item);
}

async function remainingProcesses(stop = false) {
  if (!owned.length) return [];
  return powershell(`
$remaining=@(foreach($expected in $inputValues.owned) {
  $item=Get-CimInstance Win32_Process -Filter ("ProcessId = " + [int]$expected.pid)
  if($item -and $item.CreationDate.ToUniversalTime().Ticks.ToString() -ceq $expected.born) {
    if($inputValues.stop) { Stop-Process -Id ([int]$item.ProcessId) -Force -ErrorAction SilentlyContinue }
    [int]$item.ProcessId
  }
})
ConvertTo-Json -InputObject $remaining -Compress
`, { owned, stop });
}

async function hostWindows(action = 'observe') {
  assert.ok(Number.isSafeInteger(edgePID) && edgePID > 0);
  return powershell(`
Add-Type @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class PrismVideoTest {
  public delegate bool EnumProc(IntPtr window, IntPtr parameter);
  [StructLayout(LayoutKind.Sequential)] public struct Rect { public int left, top, right, bottom; }
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc callback, IntPtr parameter);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr window, StringBuilder title, int size);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr window, out uint process);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr window);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr window);
  [DllImport("user32.dll")] public static extern bool IsWindowEnabled(IntPtr window);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr window, out Rect rect);
  [DllImport("user32.dll")] public static extern int GetWindowLong(IntPtr window, int index);
  [DllImport("user32.dll")] public static extern bool GetLayeredWindowAttributes(IntPtr window, out uint key, out byte alpha, out uint flags);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr window, IntPtr after, int x, int y, int width, int height, uint flags);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr window);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr value);
  public static uint Owner(IntPtr window) { uint process; GetWindowThreadProcessId(window, out process); return process; }
  public static string Title(IntPtr window) { var text=new StringBuilder(512); GetWindowText(window,text,512); return text.ToString(); }
}
'@
[void][PrismVideoTest]::SetProcessDpiAwarenessContext([IntPtr](-4))
$edgeMatches=[Collections.Generic.List[IntPtr]]::new()
$prismMatches=[Collections.Generic.List[IntPtr]]::new()
$order=@{ index=0; edge=-1; prism=-1 }
[void][PrismVideoTest]::EnumWindows({ param($window,$unused)
  $owner=[PrismVideoTest]::Owner($window)
  $name=[PrismVideoTest]::Title($window)
  if($owner -eq [uint32]$inputValues.edgePID -and $name.StartsWith($inputValues.edgeTitle,[StringComparison]::Ordinal)) { $edgeMatches.Add($window); $order.edge=$order.index }
  if($inputValues.prismPID -and $owner -eq [uint32]$inputValues.prismPID -and $name -ceq $inputValues.prismTitle) { $prismMatches.Add($window); $order.prism=$order.index }
  $order.index++
  return $true
},[IntPtr]::Zero)
if($edgeMatches.Count -ne 1) { throw 'Expected exactly one owned video window.' }
if($inputValues.prismPID -and $prismMatches.Count -ne 1) { throw 'Expected exactly one owned Prism window.' }
$edgeWindow=$edgeMatches[0]
$prismWindow=if($prismMatches.Count) { $prismMatches[0] } else { [IntPtr]::Zero }
if($inputValues.action -eq 'place') {
  $rect=[PrismVideoTest+Rect]::new()
  if(-not [PrismVideoTest]::GetWindowRect($prismWindow,[ref]$rect)) { throw 'Could not read Prism bounds.' }
  $width=[Math]::Min(800,$rect.right-$rect.left-120); $height=[Math]::Min(500,$rect.bottom-$rect.top-160)
  if($width -lt 400 -or $height -lt 250) { throw 'Desktop is too small for the video regression fixture.' }
  if(-not [PrismVideoTest]::SetWindowPos($edgeWindow,[IntPtr](-1),$rect.left+60,$rect.top+80,$width,$height,0x10)) { throw 'Could not place owned video window.' }
}
if($inputValues.action -in @('cover','place','uncover')) {
  # Only these UUID-titled fixture windows become topmost. This prevents an
  # unrelated browser window from invalidating the occlusion measurement.
  if(-not [PrismVideoTest]::SetWindowPos($edgeWindow,[IntPtr](-1),0,0,0,0,0x13)) { throw 'Could not order owned Edge window.' }
  $target=$edgeWindow
  if($inputValues.action -ne 'uncover') {
    if(-not [PrismVideoTest]::SetWindowPos($prismWindow,[IntPtr](-1),0,0,0,0,0x13)) { throw 'Could not order owned Prism window.' }
    $target=$prismWindow
  }
  [void][PrismVideoTest]::SetForegroundWindow($target)
}
if($inputValues.action -eq 'reset') {
  foreach($window in @($edgeWindow,$prismWindow)) {
    if($window -ne [IntPtr]::Zero) { [void][PrismVideoTest]::SetWindowPos($window,[IntPtr](-2),0,0,0,0,0x13) }
  }
}
function Snapshot([IntPtr]$window) {
  if($window -eq [IntPtr]::Zero) { return $null }
  $rect=[PrismVideoTest+Rect]::new(); [void][PrismVideoTest]::GetWindowRect($window,[ref]$rect)
  $alpha=[byte]0; $flags=[uint32]0; $key=[uint32]0
  $layered=[PrismVideoTest]::GetLayeredWindowAttributes($window,[ref]$key,[ref]$alpha,[ref]$flags)
  return [ordered]@{ hwnd=$window.ToInt64().ToString(); pid=[PrismVideoTest]::Owner($window); rect=$rect;
    zOrder=if($window -eq $edgeWindow) { $order.edge } else { $order.prism };
    visible=[PrismVideoTest]::IsWindowVisible($window); enabled=[PrismVideoTest]::IsWindowEnabled($window);
    minimized=[PrismVideoTest]::IsIconic($window); foreground=([PrismVideoTest]::GetForegroundWindow() -eq $window);
    exStyle=[PrismVideoTest]::GetWindowLong($window,-20); hasLayeredAttributes=$layered; alpha=$alpha; alphaFlags=$flags }
}
ConvertTo-Json -InputObject ([ordered]@{ edge=(Snapshot $edgeWindow); prism=(Snapshot $prismWindow) }) -Depth 5 -Compress
`, { edgePID, prismPID, edgeTitle, prismTitle, action });
}

function rejectPending(error) {
  for (const call of pending.values()) { clearTimeout(call.timer); call.reject(error); }
  pending.clear();
}

async function cdp(method, params = {}, sessionId) {
  assert.equal(socket?.readyState, WebSocket.OPEN, 'The owned Edge CDP socket must be open.');
  const id = ++cdpSequence;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); }, 10_000);
    pending.set(id, { resolve, reject, timer });
    socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
  });
}

async function videoEvaluate(fn) {
  const response = await cdp('Runtime.evaluate', { expression: `(${fn.toString()})()`, returnByValue: true, awaitPromise: true }, edgeSession);
  if (response.exceptionDetails) throw new Error(JSON.stringify(response.exceptionDetails));
  return response.result.value;
}

const videoState = () => videoEvaluate(() => {
  const video = document.querySelector('video');
  return { visibility: document.visibilityState, frames: window.videoFrames, paused: video.paused,
    time: video.currentTime, error: window.fixtureError, events: window.visibilityEvents };
});

async function phase(name, visible, covered = true, during) {
  const result = { name };
  evidence.phases.push(result);
  await expect.poll(async () => (await videoState()).visibility, { timeout: 10_000, message: `${name}: native browser visibility` }).toBe(visible ? 'visible' : 'hidden');
  await pause(400);
  result.beforeHost = await hostWindows();
  if (covered) {
    const { edge: background, prism: overlay } = result.beforeHost;
    assert.ok(overlay.visible && overlay.enabled && !overlay.minimized && overlay.foreground, `${name}: owned Prism must be visible and focused`);
    assert.ok(overlay.zOrder >= 0 && overlay.zOrder < background.zOrder, `${name}: Prism must be above the video in native Z order`);
    assert.ok(overlay.rect.left <= background.rect.left && overlay.rect.top <= background.rect.top
      && overlay.rect.right >= background.rect.right && overlay.rect.bottom >= background.rect.bottom,
    `${name}: Prism must cover the entire owned Edge window`);
  }
  result.start = await videoState();
  if (during) await during();
  await pause(1800);
  result.end = await videoState();
  result.afterHost = await hostWindows();
  assert.equal(result.start.error, undefined);
  assert.equal(result.end.visibility, visible ? 'visible' : 'hidden');
  if (covered) {
    assert.equal(result.afterHost.prism.foreground, true, `${name}: focus changed during measurement`);
    assert.ok(result.afterHost.prism.zOrder >= 0 && result.afterHost.prism.zOrder < result.afterHost.edge.zOrder,
      `${name}: Prism must remain above the video during measurement`);
  }
  if (visible) {
    assert.equal(result.end.paused, false, `${name}: video must keep playing`);
    assert.ok(result.end.frames - result.start.frames >= 10, `${name}: presented video frames must advance (got ${result.end.frames - result.start.frames})`);
  } else {
    assert.ok(result.end.frames - result.start.frames <= 2, `${name}: opaque positive control must stop presenting hidden video frames`);
  }
  console.log(JSON.stringify({ phase: name, visibility: result.end.visibility, frames: result.end.frames - result.start.frames }));
}

async function appearance(transparent, opacity) {
  await notes.getByRole('button', { name: 'Window appearance', exact: true }).click();
  const dialog = notes.getByRole('dialog', { name: 'Make a little space', exact: true });
  const toggle = dialog.getByRole('switch', { name: 'Transparent window', exact: true });
  if ((await toggle.getAttribute('aria-checked') === 'true') !== transparent) await toggle.click();
  if (transparent && opacity !== undefined) await dialog.locator('#opacity').fill(String(opacity));
  await dialog.getByRole('button', { name: 'Done', exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(notes.locator('.app-shell')).toHaveAttribute('data-transparent', String(transparent));
}

try {
  await mkdir(notebook);
  await writeFile(noteFile, original);
  const videoFile = path.join(temporary, 'video.html');
  await writeFile(videoFile, `<!doctype html><meta charset="utf-8"><title>${edgeTitle}</title>
<body style="margin:0;background:#135;color:white"><video autoplay muted loop style="width:100%;height:85vh"></video>
<p>Isolated generated video; no account or network</p><script>
window.visibilityEvents=[]; window.videoFrames=0;
document.addEventListener('visibilitychange',()=>visibilityEvents.push({state:document.visibilityState,time:performance.now()}));
(async()=>{
  const canvas=document.createElement('canvas'); canvas.width=800; canvas.height=450;
  const context=canvas.getContext('2d'); let frame=0;
  const draw=setInterval(()=>{ context.fillStyle=frame++%2?'#247':'#a24'; context.fillRect(0,0,800,450);
    context.fillStyle='white'; context.font='80px sans-serif'; context.fillText('Video '+frame,70,220); },40);
  const stream=canvas.captureStream(25); const chunks=[];
  const recorder=new MediaRecorder(stream,{mimeType:'video/webm;codecs=vp8'});
  recorder.ondataavailable=event=>chunks.push(event.data);
  const ended=new Promise((resolve,reject)=>{recorder.onstop=resolve; recorder.onerror=reject;});
  recorder.start(); await new Promise(resolve=>setTimeout(resolve,2000)); recorder.stop(); await ended;
  clearInterval(draw); stream.getTracks().forEach(track=>track.stop());
  const video=document.querySelector('video'); video.src=URL.createObjectURL(new Blob(chunks,{type:'video/webm'}));
  function count(){ window.videoFrames++; video.requestVideoFrameCallback(count); }
  video.requestVideoFrameCallback(count); await video.play(); window.fixtureReady=true;
})().catch(error=>window.fixtureError=String(error));
</script>`);
  const edgeProfile = path.join(temporary, 'edge-profile');
  await mkdir(edgeProfile);
  edge = spawn(edgeExecutable, ['--user-data-dir=' + edgeProfile, '--remote-debugging-port=0', '--no-first-run',
    '--no-default-browser-check', '--disable-extensions', '--disable-sync', '--disable-features=msForceBrowserSignIn',
    '--window-position=100,100', '--window-size=800,500', '--app=' + pathToFileURL(videoFile).href], { stdio: 'ignore' });
  edge.on('error', error => { edgeError = error; });
  let endpoint;
  await expect.poll(async () => {
    if (edgeError) throw edgeError;
    try {
      const [port, route] = (await readFile(path.join(edgeProfile, 'DevToolsActivePort'), 'utf8')).trim().split(/\r?\n/);
      if (/^\d+$/.test(port) && route?.startsWith('/devtools/browser/')) endpoint = `ws://127.0.0.1:${port}${route}`;
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    return !!endpoint;
  }, { timeout: 30_000 }).toBe(true);
  socket = new WebSocket(endpoint);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Edge CDP connection timed out.')), 10_000);
    socket.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
    socket.addEventListener('error', () => { clearTimeout(timer); reject(new Error('Edge CDP connection failed.')); }, { once: true });
  });
  socket.addEventListener('close', () => rejectPending(new Error('Owned Edge closed its CDP connection.')));
  socket.addEventListener('message', event => {
    const message = JSON.parse(event.data);
    const call = pending.get(message.id);
    if (!call) return;
    pending.delete(message.id); clearTimeout(call.timer);
    if (message.error) call.reject(new Error(JSON.stringify(message.error))); else call.resolve(message.result);
  });
  evidence.browser = await cdp('Browser.getVersion');
  edgePID = (await cdp('SystemInfo.getProcessInfo')).processInfo.find(item => item.type === 'browser')?.id;
  assert.ok(Number.isSafeInteger(edgePID));
  await expect.poll(async () => {
    edgeTarget = (await cdp('Target.getTargets')).targetInfos.find(target => target.type === 'page' && target.url === pathToFileURL(videoFile).href);
    return !!edgeTarget;
  }, { timeout: 10_000 }).toBe(true);
  edgeSession = (await cdp('Target.attachToTarget', { targetId: edgeTarget.targetId, flatten: true })).sessionId;
  await hostWindows('uncover');
  await rememberProcesses();
  await expect.poll(() => videoEvaluate(() => window.fixtureError ?? window.fixtureReady), { timeout: 15_000 }).toBe(true);
  await phase('uncovered video baseline', true, false);

  const env = { ...process.env, PRISM_USER_DATA: path.join(temporary, 'notes-profile'),
    PRISM_PDF_USER_DATA: path.join(temporary, 'pdf-profile'), PRISM_WORKSPACE: notebook };
  delete env.ELECTRON_RUN_AS_NODE;
  prism = await electron.launch({ executablePath: executable, args: ['--no-sandbox', release], cwd: release, env, timeout: 30_000 });
  // ElectronApplication.process() cannot be called after its connection closes.
  // Keep the ChildProcess reference for exit polling and cleanup across closure.
  prismChild = prism.process();
  prismPID = await prism.evaluate(() => process.pid);
  notes = await prism.firstWindow();
  notes.setDefaultTimeout(10_000);
  await expect(notes.locator('.note-heading h1')).toHaveText('Video test');
  await expect.poll(() => prism.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible())).toBe(true);
  await prism.evaluate(({ BrowserWindow }, title) => BrowserWindow.getAllWindows()[0].setTitle(title), prismTitle);
  await rememberProcesses();
  await hostWindows('place');
  await notes.getByRole('button', { name: 'Maximize window', exact: true }).click();
  await hostWindows('cover');
  await phase('opaque fully covered positive control', false);
  await appearance(true, 35);
  await phase('transparent 35 percent while already covering video', true);
  await appearance(true, 100);
  await phase('transparent toggle at 100 percent is opaque', false);
  await appearance(true, 35);
  await phase('opacity slider restores background playback', true);
  await appearance(false);
  await phase('transparent mode off restores opaque occlusion', false);
  await appearance(true);
  await phase('transparent mode on restores background playback', true);
  await notes.getByRole('group', { name: 'Editor mode', exact: true }).getByRole('button', { name: 'Source', exact: true }).click();
  await phase('Japanese editing and explicit save keep video playing', true, true, async () => {
    const editor = notes.locator('.app-body .cm-content');
    const text = '日本語で動画を見ながら書く。';
    await editor.focus(); await editor.press('Control+End'); await notes.keyboard.insertText(text);
    await expect(editor).toContainText(text);
    await editor.press('Control+s');
    expectedNote = original + text;
    await expect.poll(async () => {
      try { return await readFile(noteFile, 'utf8'); }
      catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    }, { timeout: 10_000 }).toBe(expectedNote);
    await expect(notes.locator('.statusbar')).toContainText('All changes saved');
  });

  await notes.getByRole('button', { name: 'Restore window', exact: true }).click();
  await phase('restored transparent window still fully covers video', true);
  await notes.getByRole('button', { name: 'Maximize window', exact: true }).click();
  await phase('maximized transparent window keeps playback', true);
  await hostWindows('uncover');
  await phase('video focused above Prism', true, false);
  await hostWindows('cover');
  await phase('Prism regains native foreground', true);
  for (let cycle = 0; cycle < 2; cycle++) {
    await notes.getByRole('button', { name: 'Minimize window', exact: true }).click();
    await expect.poll(() => prism.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isMinimized())).toBe(true);
    await hostWindows('uncover');
    await phase(`Prism minimized ${cycle + 1}`, true, false);
    await prism.evaluate(({ BrowserWindow }) => { const window = BrowserWindow.getAllWindows()[0]; window.restore(); window.show(); window.focus(); });
    await hostWindows('cover');
    await phase(`Prism restored after minimize ${cycle + 1}`, true);
  }
  assert.equal(await readFile(noteFile, 'utf8'), expectedNote, 'Window changes must preserve exact Japanese, BOM, and CRLF notebook bytes.');
  await notes.screenshot({ path: `${output}.png` });
  await rememberProcesses();
  await hostWindows('reset');
  await notes.getByRole('button', { name: 'Close window', exact: true }).click();
  await expect.poll(() => prismChild.exitCode, { timeout: 15_000 }).toBe(0);
  evidence.firstSession = { wrapperPID: prismChild.pid, mainPID: prismPID, exitCode: prismChild.exitCode };
  prism = undefined; prismChild = undefined; prismPID = undefined; notes = undefined;
  await hostWindows('uncover');
  await phase('video keeps playing after Prism closes', true, false);

  // Keep the test browser above unrelated windows, but make this fixture's
  // reopened Prism window cover it from its very first show. Ordering only
  // after launch would miss a brief opaque startup flash that pauses players.
  // The bootstrap loads the real staged main bundle without changing opacity.
  const bootstrap = path.join(temporary, 'startup-overlay.cjs');
  await writeFile(bootstrap, `const { app } = require('electron');\n` +
    `app.on('browser-window-created', (_event, window) => window.setAlwaysOnTop(true));\n` +
    `require(${JSON.stringify(path.join(release, 'dist', 'main.cjs'))});\n`);
  const startupEventIndex = await videoEvaluate(() => window.visibilityEvents.length);
  prism = await electron.launch({ executablePath: executable, args: ['--no-sandbox', bootstrap], cwd: release, env, timeout: 30_000 });
  prismChild = prism.process();
  prismPID = await prism.evaluate(() => process.pid);
  notes = await prism.firstWindow();
  notes.setDefaultTimeout(10_000);
  await expect(notes.locator('.note-heading h1')).toHaveText('Video test');
  await expect.poll(() => prism.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible())).toBe(true);
  await prism.evaluate(({ BrowserWindow }, title) => BrowserWindow.getAllWindows()[0].setTitle(title), prismTitle);
  await expect(notes.locator('.app-shell')).toHaveAttribute('data-transparent', 'true');
  await expect(notes.locator('.app-body .cm-content')).toContainText('日本語で動画を見ながら書く。');
  await rememberProcesses();
  await phase('saved transparency keeps video playing through startup', true);
  evidence.startupVisibilityEvents = (await videoState()).events.slice(startupEventIndex);
  assert.deepEqual(evidence.startupVisibilityEvents.filter(event => event.state === 'hidden'), [],
    'Reopening with saved transparency must never hide the already-playing video.');
  assert.equal(await readFile(noteFile, 'utf8'), expectedNote);
  await rememberProcesses();
  await hostWindows('reset');
  await notes.getByRole('button', { name: 'Close window', exact: true }).click();
  await expect.poll(() => prismChild.exitCode, { timeout: 15_000 }).toBe(0);
  evidence.reopenedSession = { wrapperPID: prismChild.pid, mainPID: prismPID, exitCode: prismChild.exitCode };
  prism = undefined; prismChild = undefined; prismPID = undefined; notes = undefined;
  await cdp('Browser.close').catch(error => { if (socket.readyState === WebSocket.OPEN) throw error; });
  await expect.poll(() => remainingProcesses(), { timeout: 15_000 }).toEqual([]);
  evidence.passed = true;
} catch (error) {
  evidence.error = error.stack ?? String(error);
  process.exitCode = 1;
  evidence.failedVideoState = await videoState().catch(() => undefined);
  if (edgePID) evidence.failedHostWindows = await hostWindows().catch(() => undefined);
  if (notes && !notes.isClosed()) await notes.screenshot({ path: `${output}.failure.png`, timeout: 5000 }).catch(() => {});
} finally {
  // Normal close first. A failed fixture is still cleaned up, but forced cleanup
  // is recorded and never turns a lifecycle failure into a pass.
  await rememberProcesses().catch(() => {});
  if (edgePID) await hostWindows('reset').catch(() => {});
  if (prism && prismChild?.exitCode === null) await prism.close().catch(() => {});
  if (socket?.readyState === WebSocket.OPEN) await cdp('Browser.close').catch(() => {});
  socket?.close();
  rejectPending(new Error('Background video fixture finished.'));
  await pause(500);
  const remaining = await remainingProcesses().catch(error => {
    evidence.cleanupError = String(error); evidence.passed = false; process.exitCode = 1; return [];
  });
  if (remaining.length) {
    evidence.forcedCleanup = remaining;
    evidence.passed = false;
    process.exitCode = 1;
    await remainingProcesses(true).catch(error => { evidence.cleanupError = String(error); });
  }
  edge?.unref();
  evidence.processes = owned;
  evidence.finished = new Date().toISOString();
  await writeFile(output, JSON.stringify(evidence, null, 2) + '\n');
  if (evidence.passed) await rm(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  console.log(JSON.stringify({ passed: evidence.passed, evidence: output, fixture: evidence.passed ? 'removed' : temporary, error: evidence.error }, null, 2));
}
