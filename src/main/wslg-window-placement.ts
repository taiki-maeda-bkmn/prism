import { spawn, execFile, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const powershell = '/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe';
const filename = 'window-placement-wslg.json';
const startupLimit = 8000;
const closeLimit = 2500;
const outputLimit = 4096;

export interface HostWindowBounds { x: number; y: number; width: number; height: number }
interface PlacementWindow { setTitle(title: string): void; isDestroyed(): boolean }
interface PlacementOptions {
  window: PlacementWindow;
  directory: string;
  distribution: string;
  scriptPath?: string;
  /** Process seams keep deterministic tests independent of the Windows desktop. */
  launch?: (arguments_: readonly string[]) => ChildProcessWithoutNullStreams;
  windowsPath?: (filename: string) => Promise<string>;
  startupTimeoutMs?: number;
  closeTimeoutMs?: number;
}
export interface WslgWindowPlacement {
  readonly title: string;
  /** True only after the owned host window was found and its position restored. */
  readonly ready: Promise<boolean>;
  flushAndStop(): Promise<void>;
  dispose(): void;
}

export function validHostWindowBounds(value: unknown): value is HostWindowBounds {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const bounds = value as Record<string, unknown>;
  return Object.keys(bounds).length === 4 && ['x', 'y', 'width', 'height'].every(key => Number.isSafeInteger(bounds[key]))
    && Math.abs(bounds.x as number) <= 1_000_000 && Math.abs(bounds.y as number) <= 1_000_000
    && (bounds.width as number) >= 100 && (bounds.width as number) <= 50_000
    && (bounds.height as number) >= 100 && (bounds.height as number) <= 50_000;
}

export function parseHostWindowPlacement(value: unknown): HostWindowBounds | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  return Object.keys(record).length === 3 && record.version === 1 && record.space === 'windows-physical-screen'
    && validHostWindowBounds(record.bounds) ? { ...record.bounds } : null;
}

async function readPlacement(directory: string): Promise<HostWindowBounds | null> {
  try {
    const target = path.join(directory, filename);
    const info = await fs.lstat(target);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 2048) return null;
    const handle = await fs.open(target, 'r');
    try {
      const current = await handle.stat();
      if (current.ino !== info.ino || current.dev !== info.dev || !current.isFile() || current.size > 2048) return null;
      const bytes = Buffer.alloc(2049);
      const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
      if (bytesRead > 2048) return null;
      return parseHostWindowPlacement(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, bytesRead))));
    } finally { await handle.close(); }
  } catch { return null; }
}

async function writePlacement(directory: string, bounds: HostWindowBounds): Promise<void> {
  const temporary = path.join(directory, `.window-placement-wslg-${randomUUID()}.tmp`);
  try {
    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(temporary, `${JSON.stringify({ version: 1, space: 'windows-physical-screen', bounds })}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx', flush: true });
    await fs.rename(temporary, path.join(directory, filename));
  } finally { await fs.unlink(temporary).catch(() => undefined); }
}

/**
 * Native Wayland exposes no desktop coordinates. This bridge observes only the
 * Windows host window identified by a fresh title token, while Electron retains
 * ownership of native size, maximize/minimize and repaint recovery.
 *
 * Call before showing the window; suppress page-title-updated until ready settles,
 * then restore the ordinary title. Await flushAndStop before destroying the window.
 */
export function startWslgWindowPlacement(options: PlacementOptions): WslgWindowPlacement {
  const title = `Prism placement ${randomUUID().replace(/-/g, '')}`;
  let finishReady!: (found: boolean) => void;
  const ready = new Promise<boolean>(resolve => { finishReady = resolve; });
  let readySettled = false;
  let stopping = false;
  let disposed = false;
  let child: ChildProcessWithoutNullStreams | undefined;
  let childClosed = false;
  let finishClosed!: () => void;
  const closed = new Promise<void>(resolve => { finishClosed = resolve; });
  let stopResult: Promise<void> | undefined;
  let startupTimer: ReturnType<typeof setTimeout> | undefined;
  let saveTimer: ReturnType<typeof setTimeout> | undefined;
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  let buffer = '';
  let latestBounds: HostWindowBounds | undefined;
  let lastWritten = '';
  let writes: Promise<void> = Promise.resolve();
  const startupTimeout = Math.max(1, Math.min(startupLimit, options.startupTimeoutMs ?? startupLimit));
  const closeTimeout = Math.max(1, Math.min(closeLimit, options.closeTimeoutMs ?? closeLimit));

  const settleReady = (found: boolean) => {
    if (readySettled) return;
    readySettled = true;
    clearTimeout(startupTimer);
    finishReady(found);
  };
  const flushWrite = () => {
    clearTimeout(saveTimer);
    saveTimer = undefined;
    if (latestBounds) {
      const bounds = latestBounds;
      const key = JSON.stringify(bounds);
      writes = writes.then(async () => {
        if (lastWritten === key) return;
        await writePlacement(options.directory, bounds);
        lastWritten = key;
      }).catch(() => undefined);
    }
    return writes;
  };
  const save = (bounds: HostWindowBounds) => {
    const key = JSON.stringify(bounds);
    if (latestBounds && JSON.stringify(latestBounds) === key) return;
    latestBounds = { ...bounds };
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => { void flushWrite(); }, 300);
    saveTimer.unref();
  };
  const terminate = () => {
    settleReady(false);
    if (!child || childClosed) return;
    // Ending stdin lets the Windows process exit even if its WSL launcher is
    // terminated. The script also exits when its exact owned HWND disappears.
    try { child.stdin.end(); } catch { /* Already closed. */ }
    try { child.kill(); } catch { /* Already closed. */ }
  };
  const failed = () => {
    disposed = true;
    stopping = true;
    terminate();
  };

  const flushAndStop = (): Promise<void> => {
    if (stopResult) return stopResult;
    stopping = true;
    settleReady(false);
    stopResult = (async () => {
      if (child && !childClosed) {
        try { child.stdin.write('stop\n'); child.stdin.end(); } catch { /* Broken pipe; timeout still bounds cleanup. */ }
        await Promise.race([closed, new Promise<void>(resolve => {
          killTimer = setTimeout(() => { terminate(); resolve(); }, closeTimeout);
        })]);
        clearTimeout(killTimer);
      }
      disposed = true;
      await flushWrite();
    })();
    return stopResult;
  };

  const controller: WslgWindowPlacement = {
    title, ready, flushAndStop,
    dispose: () => { void flushAndStop(); },
  };
  if (!options.distribution || options.distribution.length > 128 || /[\u0000-\u001f\u007f]/.test(options.distribution) || options.window.isDestroyed()) {
    settleReady(false);
    return controller;
  }
  try { options.window.setTitle(title); } catch { settleReady(false); return controller; }
  startupTimer = setTimeout(failed, startupTimeout);
  void (async () => {
    try {
      const saved = await readPlacement(options.directory);
      if (stopping || disposed || options.window.isDestroyed()) { settleReady(false); return; }
      const localScript = options.scriptPath ?? path.join(__dirname, 'wslg-window-placement.ps1');
      const windowsScript = await (options.windowsPath ?? (async local => {
        const result = await execute('wslpath', ['-w', local], { encoding: 'utf8', timeout: 2000, maxBuffer: 8192 });
        return result.stdout.trim();
      }))(localScript);
      if (stopping || disposed || options.window.isDestroyed()) { settleReady(false); return; }
      if (!windowsScript || windowsScript.length > 4096 || /[\u0000\r\n]/.test(windowsScript)) throw new Error('Invalid host helper path.');
      const arguments_ = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', windowsScript,
        '-Title', title, '-Distribution', options.distribution,
        ...(saved ? ['-RestoreX', String(saved.x), '-RestoreY', String(saved.y)] : [])];
      child = (options.launch ?? (args => spawn(powershell, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })))(arguments_);
      child.stdout.setEncoding('utf8');
      child.stderr.resume();
      child.stdin.on('error', () => { /* The exit/close handlers own bridge cleanup. */ });
      child.once('error', failed);
      child.once('close', () => {
        childClosed = true;
        clearTimeout(killTimer);
        settleReady(false);
        finishClosed();
      });
      child.stdout.on('data', (chunk: string) => {
        if (disposed) return;
        buffer += chunk;
        if (buffer.length > outputLimit) { failed(); return; }
        let newline: number;
        while ((newline = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, newline).trim();
          buffer = buffer.slice(newline + 1);
          if (!line) continue;
          try {
            const message: unknown = JSON.parse(line);
            if (!message || typeof message !== 'object' || Array.isArray(message)) throw new Error('Invalid host message.');
            const record = message as Record<string, unknown>;
            if (Object.keys(record).some(key => !['type', 'normal'].includes(key))
              || !['ready', 'placement', 'snapshot'].includes(String(record.type))
              || (record.normal !== null && !validHostWindowBounds(record.normal))) throw new Error('Invalid host message.');
            if (record.normal) save(record.normal as HostWindowBounds);
            if (record.type === 'ready' && !stopping) settleReady(true);
          } catch { failed(); return; }
        }
      });
    } catch { failed(); }
  })();
  return controller;
}
