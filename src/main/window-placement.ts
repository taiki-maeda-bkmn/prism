import { randomUUID } from 'node:crypto';
import { closeSync, constants, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export interface WindowBounds { x: number; y: number; width: number; height: number }
export interface PlacementDisplay { workArea: WindowBounds }
export interface WindowPlacement { bounds: WindowBounds; maximized: boolean }
type PlacementEvent = 'move' | 'resize' | 'maximize' | 'unmaximize' | 'restore' | 'minimize';
interface PlacementWindow {
  isDestroyed(): boolean;
  isMinimized(): boolean;
  isMaximized(): boolean;
  getNormalBounds(): WindowBounds;
  on(event: PlacementEvent, listener: () => void): unknown;
  removeListener(event: PlacementEvent, listener: () => void): unknown;
}
export interface WindowPlacementIO {
  read(filename: string): string;
  write(filename: string, contents: string): void;
}
const maxStateBytes = 4096;
const events: PlacementEvent[] = ['move', 'resize', 'maximize', 'unmaximize', 'restore', 'minimize'];
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);

function validBounds(value: unknown): value is WindowBounds {
  if (!object(value) || Object.keys(value).length !== 4) return false;
  return ['x', 'y', 'width', 'height'].every(key => Number.isSafeInteger(value[key]))
    && Math.abs(value.x as number) <= 10_000_000 && Math.abs(value.y as number) <= 10_000_000
    && (value.width as number) > 0 && (value.width as number) <= 1_000_000
    && (value.height as number) > 0 && (value.height as number) <= 1_000_000;
}

const fileIO: WindowPlacementIO = {
  read(filename) {
    const before = lstatSync(filename);
    if (!before.isFile() || before.size > maxStateBytes) throw new Error('Invalid window placement file.');
    // A regular file can be replaced by a FIFO after lstat. Never wait for a
    // pipe writer before fstat can reject the optional preference file.
    const handle = openSync(filename, constants.O_RDONLY | (constants.O_NOFOLLOW || 0) | (constants.O_NONBLOCK || 0));
    try {
      const stat = fstatSync(handle);
      if (!stat.isFile() || stat.size > maxStateBytes) throw new Error('Invalid window placement file.');
      const bytes = Buffer.alloc(maxStateBytes + 1);
      let length = 0;
      while (length < bytes.length) {
        const count = readSync(handle, bytes, length, bytes.length - length, null);
        if (!count) break;
        length += count;
      }
      if (length > maxStateBytes) throw new Error('Invalid window placement file.');
      return new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, length));
    } finally { closeSync(handle); }
  },
  write(filename, contents) {
    const directory = path.dirname(filename);
    mkdirSync(directory, { recursive: true });
    const temporary = path.join(directory, `.${path.basename(filename)}.${randomUUID()}.tmp`);
    let handle: number | undefined;
    try {
      handle = openSync(temporary, 'wx', 0o600);
      writeFileSync(handle, contents, 'utf8');
      fsyncSync(handle);
      closeSync(handle);
      handle = undefined;
      renameSync(temporary, filename);
    } finally {
      if (handle !== undefined) { try { closeSync(handle); } catch { /* Best effort preferences. */ } }
      try { unlinkSync(temporary); } catch { /* The successful rename already removed it. */ }
    }
  },
};

function overlap(a: WindowBounds, b: WindowBounds): number {
  return Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x))
    * Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));
}
function distance(a: WindowBounds, b: WindowBounds): number {
  return Math.max(0, b.x - a.x - a.width, a.x - b.x - b.width) ** 2
    + Math.max(0, b.y - a.y - a.height, a.y - b.y - b.height) ** 2;
}
function workAreas(displays: readonly PlacementDisplay[], fallback: WindowBounds): WindowBounds[] {
  const valid = displays.map(display => display?.workArea).filter(validBounds);
  return valid.length ? valid : [fallback];
}
function fit(bounds: WindowBounds, areas: readonly WindowBounds[]): WindowBounds {
  // Prefer the monitor containing most of the window. If it was removed,
  // choose the closest remaining work area, including monitors left of zero.
  let target = areas[0];
  for (const area of areas.slice(1)) {
    if (overlap(bounds, area) > overlap(bounds, target)
      || (overlap(bounds, area) === overlap(bounds, target) && distance(bounds, area) < distance(bounds, target))) target = area;
  }
  // Retain usable controls after a corrupt/tiny saved size, without imposing
  // native resize limits or exceeding a genuinely small display.
  const width = Math.min(Math.max(bounds.width, 320), target.width);
  const height = Math.min(Math.max(bounds.height, 240), target.height);
  return {
    x: Math.min(Math.max(bounds.x, target.x), target.x + target.width - width),
    y: Math.min(Math.max(bounds.y, target.y), target.y + target.height - height), width, height,
  };
}

/** Missing or damaged optional preferences never prevent a window opening. */
export function loadWindowPlacement(filename: string, displays: readonly PlacementDisplay[], fallback: WindowBounds, io: WindowPlacementIO = fileIO): WindowPlacement {
  const areas = workAreas(displays, fallback);
  const defaults = { bounds: fit(fallback, areas), maximized: false };
  try {
    const source = io.read(filename);
    if (Buffer.byteLength(source, 'utf8') > maxStateBytes) return defaults;
    const value: unknown = JSON.parse(source);
    if (!object(value) || Object.keys(value).length !== 3 || value.version !== 1
      || !validBounds(value.bounds) || typeof value.maximized !== 'boolean') return defaults;
    return { bounds: fit(value.bounds, areas), maximized: value.maximized };
  } catch { return defaults; }
}

/** Root flushes on an accepted close, then disposes after the window is closed. */
export function trackWindowPlacement(
  window: PlacementWindow,
  filename: string,
  displays: () => readonly PlacementDisplay[],
  initial: WindowPlacement,
  options: { debounceMs?: number; io?: WindowPlacementIO } = {},
): { flush(): void; dispose(): void } {
  let placement: WindowPlacement = { bounds: { ...initial.bounds }, maximized: initial.maximized };
  let timer: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;
  let written: string | undefined;
  const io = options.io ?? fileIO;
  const debounce = Number.isFinite(options.debounceMs) ? Math.max(0, options.debounceMs!) : 250;
  const clear = () => { if (timer !== undefined) clearTimeout(timer); timer = undefined; };
  const capture = () => {
    try {
      // Minimized windows may expose icon coordinates or drop isMaximized;
      // neither describes how the visible window should reopen.
      if (window.isDestroyed() || window.isMinimized()) return;
      const maximized = window.isMaximized();
      const candidate = window.getNormalBounds();
      const areas = workAreas(displays(), placement.bounds);
      // Electron's normal bounds retain restore geometry while maximized.
      // Ignore zero-size, invalid and wholly offscreen transitional geometry.
      const bounds = validBounds(candidate) && areas.some(area => overlap(candidate, area) > 0)
        ? fit(candidate, areas) : placement.bounds;
      placement = { bounds, maximized };
    } catch { /* A disappearing native window must not interrupt close. */ }
  };
  const flush = () => {
    if (disposed) return;
    clear();
    capture();
    try {
      const bounds = fit(placement.bounds, workAreas(displays(), placement.bounds));
      const contents = JSON.stringify({ version: 1, bounds, maximized: placement.maximized }) + '\n';
      if (contents === written) return;
      io.write(filename, contents);
      written = contents;
    } catch { /* Window preferences are optional, including at shutdown. */ }
  };
  const changed = () => {
    if (disposed) return;
    capture();
    clear();
    timer = setTimeout(flush, debounce);
    timer.unref?.();
  };
  for (const event of events) window.on(event, changed);
  return {
    flush,
    dispose() {
      if (disposed) return;
      disposed = true;
      clear();
      for (const event of events) window.removeListener(event, changed);
    },
  };
}
