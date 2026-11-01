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
  enabled?: boolean;
  clicked?: boolean;
  clickTarget?: { x: number; y: number };
  clickFailure?: string;
}

export type HostWindowAction = 'sample' | 'observe' | 'restore' | 'move' | 'restore-move' | 'click';
export interface HostWindowPointer { x: number; y: number }

/** Uses the real Windows pointer route, rather than Chromium's injected input. */
export function clickHostWindow(title: string, pointer: HostWindowPointer): Promise<HostWindowSample> {
  return sampleHostWindow(title, 'click', undefined, pointer);
}

/** Inspects only the uniquely titled test window; observe never changes focus or samples pixels. */
export async function sampleHostWindow(title: string, action: HostWindowAction = 'sample', position?: { x: number; y: number }, pointer?: HostWindowPointer): Promise<HostWindowSample> {
  if (!/^Prism host geometry [a-f0-9]{32}$/.test(title)) throw new Error('A unique test-window title is required.');
  if (!['sample', 'observe', 'restore', 'move', 'restore-move', 'click'].includes(action)) throw new Error('A supported host-window action is required.');
  const moving = action === 'move' || action === 'restore-move';
  if (moving && (!position || !Number.isSafeInteger(position.x) || !Number.isSafeInteger(position.y))) {
    throw new Error('A whole-pixel host position is required.');
  }
  if (action === 'click' && (!pointer || ![pointer.x, pointer.y].every(value => Number.isFinite(value) && value >= 0 && value <= 1))) {
    throw new Error('A normalized test-window pointer position between zero and one is required.');
  }
  const distribution = process.env.WSL_DISTRO_NAME;
  if (!distribution || distribution.length > 128) throw new Error('The WSL distribution name is required.');
  windowsScript ??= execute('wslpath', ['-w', script], { encoding: 'utf8' }).then(result => result.stdout.trim());
  const result = await execute(powershell, [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-File', await windowsScript, '-Title', title, '-Distribution', distribution, '-Action', action,
    ...(moving ? ['-PositionX', String(position!.x), '-PositionY', String(position!.y)] : []),
    ...(action === 'click' ? ['-PointerX', String(pointer!.x), '-PointerY', String(pointer!.y)] : []),
  ], { encoding: 'utf8', timeout: 10_000, maxBuffer: 16_384 });
  return JSON.parse(result.stdout.trim()) as HostWindowSample;
}
