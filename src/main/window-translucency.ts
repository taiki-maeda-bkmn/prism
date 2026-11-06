import { execFile } from 'node:child_process';
import path from 'node:path';

interface TranslucentWindow {
  isDestroyed(): boolean;
  isVisible(): boolean;
  getOpacity(): number;
  setOpacity(value: number): void;
  getNativeWindowHandle(): Buffer;
  once(event: 'closed', listener: () => void): unknown;
  removeListener(event: 'closed', listener: () => void): unknown;
}

interface NativeSignal { handle: string; processId: number }
interface RunningSignal { cancel(): void }
type SignalRunner = (signal: NativeSignal, complete: (error?: Error | null) => void) => RunningSignal;
interface TranslucencyOptions {
  platform?: string;
  runSignal?: SignalRunner;
  warn?: (message: string) => void;
}

// CSS transparency does not give Windows' native occlusion tracker an alpha.
// One native alpha step preserves legibility while identifying this window as
// translucent to browsers behind it. CSS still controls background opacity.
export const translucentOpacity = 254 / 255;

function signalNativeTranslucency(signal: NativeSignal, complete: (error?: Error | null) => void): RunningSignal {
  // The values come only from this process's BrowserWindow. Never interpolate
  // renderer input into a shell or let a renderer choose a native target.
  if (!/^[1-9]\d{0,18}$/.test(signal.handle) || BigInt(signal.handle) > 0x7fffffffffffffffn
    || !Number.isSafeInteger(signal.processId) || signal.processId <= 0) {
    throw new Error('Invalid native Prism window identity.');
  }
  const source = `$ErrorActionPreference='Stop'; $ProgressPreference='SilentlyContinue'
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class PrismWindowVisibility {
  [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr window);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr window, out uint owner);
  [DllImport("user32.dll")] public static extern void NotifyWinEvent(uint change, IntPtr window, int objectId, int childId);
}
'@
$prismWindow=[IntPtr]([long]${signal.handle})
[uint32]$prismOwner=0
if ([PrismWindowVisibility]::IsWindow($prismWindow)) {
  [void][PrismWindowVisibility]::GetWindowThreadProcessId($prismWindow,[ref]$prismOwner)
  if ($prismOwner -eq ${signal.processId}) {
    [PrismWindowVisibility]::NotifyWinEvent(0x800A,$prismWindow,0,0)
  }
}
`;
  const executable = path.win32.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const child = execFile(executable, ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(source, 'utf16le').toString('base64')],
    { windowsHide: true, timeout: 5000, maxBuffer: 16 * 1024 }, error => complete(error));
  return { cancel: () => { if (child.exitCode === null && child.signalCode === null) child.kill(); } };
}

/** Install once per native window; the host validates each IPC sender first. */
export function installWindowTranslucency(window: TranslucentWindow, options: TranslucencyOptions = {}) {
  const platform = options.platform ?? process.platform;
  if (platform !== 'win32') return { setTranslucent: (_value: unknown) => {}, dispose: () => {} };
  const runSignal = options.runSignal ?? signalNativeTranslucency;
  const warn = options.warn ?? console.warn;
  let disposed = false;
  let pending = false;
  let warned = false;
  let running: { cancel?: () => void } | undefined;

  const failed = () => {
    if (disposed || warned) return;
    warned = true;
    warn('Prism could not refresh Windows background-window visibility. Refocusing the video window can refresh it.');
  };
  const notify = () => {
    if (disposed || running || !pending) return;
    pending = false;
    if (window.isDestroyed() || !window.isVisible()) return;
    const active: { cancel?: () => void } = {};
    running = active;
    const complete = (error?: Error | null) => {
      if (running !== active) return;
      running = undefined;
      if (error) failed();
      notify();
    };
    try {
      const buffer = window.getNativeWindowHandle();
      const handle = buffer.length === 8 ? buffer.readBigUInt64LE() : buffer.length === 4 ? BigInt(buffer.readUInt32LE()) : 0n;
      if (handle === 0n) throw new Error('The native Prism window is unavailable.');
      const task = runSignal({ handle: handle.toString(), processId: process.pid }, complete);
      // An injected runner may complete synchronously. Do not resurrect it.
      if (running === active) active.cancel = () => task.cancel();
    } catch (error) { complete(error instanceof Error ? error : new Error('Native visibility update failed.')); }
  };
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    pending = false;
    const active = running;
    running = undefined;
    active?.cancel?.();
    window.removeListener('closed', dispose);
  };
  window.once('closed', dispose);
  return {
    setTranslucent(value: unknown): void {
      if (disposed || typeof value !== 'boolean') return;
      if (window.isDestroyed()) { dispose(); return; }
      try {
        const opacity = value ? translucentOpacity : 1;
        if (window.getOpacity() === opacity) return;
        window.setOpacity(opacity);
        // A not-yet-shown window will be evaluated when it is shown/focused.
        // Live changes need a state notification; changing alpha alone does
        // not make Chromium recalculate its native occlusion information.
        pending = window.isVisible();
        notify();
      } catch { failed(); }
    },
    dispose,
  };
}
