import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const powershell = '/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe';
const script = fileURLToPath(new URL('./host-window.ps1', import.meta.url));
let windowsScript: Promise<string> | undefined;

export interface HostWindowSample {
  found: boolean;
  foreground: boolean;
  covered: boolean;
  aligned: boolean;
  minimized?: boolean;
  maximized?: boolean;
  rect?: { left: number; top: number; right: number; bottom: number };
  workArea?: { left: number; top: number; right: number; bottom: number };
  colors?: number[];
  ownedCorners?: boolean[];
}

export type HostWindowAction = 'sample' | 'observe' | 'restore';

/** Inspects only the uniquely titled test window; observe never changes focus or samples pixels. */
export async function sampleHostWindow(title: string, action: HostWindowAction = 'sample'): Promise<HostWindowSample> {
  if (!/^Prism host geometry [a-f0-9]{32}$/.test(title)) throw new Error('A unique test-window title is required.');
  if (!['sample', 'observe', 'restore'].includes(action)) throw new Error('A supported host-window action is required.');
  const distribution = process.env.WSL_DISTRO_NAME;
  if (!distribution || distribution.length > 128) throw new Error('The WSL distribution name is required.');
  windowsScript ??= execute('wslpath', ['-w', script], { encoding: 'utf8' }).then(result => result.stdout.trim());
  const result = await execute(powershell, [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-File', await windowsScript, '-Title', title, '-Distribution', distribution, '-Action', action,
  ], { encoding: 'utf8', timeout: 10_000, maxBuffer: 16_384 });
  return JSON.parse(result.stdout.trim()) as HostWindowSample;
}
