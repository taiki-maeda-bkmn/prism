import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { pathToFileURL } from 'node:url';
import { loadWindowPlacement, trackWindowPlacement, type PlacementDisplay, type WindowBounds, type WindowPlacement, type WindowPlacementIO } from '../src/main/window-placement';

const fallback = { x: 200, y: 100, width: 1200, height: 800 };
const primary = { workArea: { x: 0, y: 30, width: 1920, height: 1050 } };
const left = { workArea: { x: -1600, y: -200, width: 1600, height: 900 } };
const initial: WindowPlacement = { bounds: fallback, maximized: false };
const source = (bounds = fallback, maximized = false) => JSON.stringify({ version: 1, bounds, maximized });

function memoryIO(value = source()) {
  const state = { value, writes: 0, failing: false };
  const io: WindowPlacementIO = {
    read: () => state.value,
    write: (_filename, contents) => {
      if (state.failing) throw new Error('Disk is unavailable.');
      state.value = contents;
      state.writes++;
    },
  };
  return { state, io, saved: () => JSON.parse(state.value) as WindowPlacement & { version: number } };
}
function temporary(t: TestContext) {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'prism-window-placement-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return { directory, filename: path.join(directory, 'profile', 'window-placement.json') };
}
class WindowStub extends EventEmitter {
  bounds = { ...fallback };
  minimized = false;
  maximized = false;
  destroyed = false;
  queried = 0;
  throwing = false;
  isDestroyed() { return this.destroyed; }
  isMinimized() { if (this.throwing) throw new Error('Native window unavailable.'); return this.minimized; }
  isMaximized() { return this.maximized; }
  getNormalBounds() { assert.equal(this.destroyed, false); this.queried++; return { ...this.bounds }; }
}

test('restores valid normal bounds and maximized state without changing negative monitor coordinates', () => {
  const bounds = { x: -1450, y: -120, width: 1100, height: 700 };
  const memory = memoryIO(source(bounds, true));
  assert.deepEqual(loadWindowPlacement('ignored', [primary, left], fallback, memory.io), { bounds, maximized: true });
  assert.equal(memory.state.writes, 0);
});

test('clamps crossing, removed-monitor and oversized placements inside the best available work area', () => {
  const cases: { saved: WindowBounds; displays: PlacementDisplay[]; expected: WindowBounds }[] = [
    { saved: { x: -1000, y: -150, width: 1400, height: 850 }, displays: [primary, left], expected: { x: -1400, y: -150, width: 1400, height: 850 } },
    { saved: { x: 2200, y: 50, width: 1100, height: 700 }, displays: [primary], expected: { x: 820, y: 50, width: 1100, height: 700 } },
    { saved: { x: -3400, y: -100, width: 1000, height: 700 }, displays: [primary, left], expected: { x: -1600, y: -100, width: 1000, height: 700 } },
    { saved: { x: 200, y: -500, width: 1600, height: 1000 }, displays: [{ workArea: { x: 20, y: 40, width: 800, height: 600 } }], expected: { x: 20, y: 40, width: 800, height: 600 } },
  ];
  for (const item of cases) assert.deepEqual(loadWindowPlacement('ignored', item.displays, fallback, memoryIO(source(item.saved)).io).bounds, item.expected);
});

test('missing, malformed, future, noninteger and oversized state safely use the fallback', t => {
  const f = temporary(t);
  assert.deepEqual(loadWindowPlacement(f.filename, [primary], fallback), initial);
  const invalid: unknown[] = [null, [], {}, { version: 2, bounds: fallback, maximized: true },
    { version: 1, bounds: fallback, maximized: 'yes' }, { version: 1, bounds: fallback, maximized: false, extra: 1 },
    ...[{ width: 0 }, { height: -1 }, { x: 1.5 }, { y: 10_000_001 }, { width: null }, { other: 1 }]
      .map(patch => ({ version: 1, bounds: { ...fallback, ...patch }, maximized: true })),
  ];
  for (const value of invalid) assert.deepEqual(loadWindowPlacement('ignored', [primary], fallback, memoryIO(JSON.stringify(value)).io), initial);
  for (const value of ['{not JSON', 'x'.repeat(4097), source().replace('1200', '1e999')]) {
    assert.deepEqual(loadWindowPlacement('ignored', [primary], fallback, memoryIO(value).io), initial);
  }
  mkdirSync(path.dirname(f.filename));
  writeFileSync(f.filename, Buffer.alloc(8192, 65));
  assert.deepEqual(loadWindowPlacement(f.filename, [primary], fallback), initial);
  assert.equal(statSync(f.filename).size, 8192, 'Loading does not rewrite invalid preferences.');
});

test('named-pipe preferences, including a replacement after the file check, cannot block startup', t => {
  if (process.platform === 'win32') { t.skip('Named pipes use different APIs on Windows.'); return; }
  const f = temporary(t);
  const pipe = path.join(f.directory, 'named-pipe');
  const created = spawnSync('mkfifo', [pipe], { encoding: 'utf8', timeout: 3000 });
  if ((created.error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT') { t.skip('mkfifo is unavailable.'); return; }
  assert.equal(created.status, 0, created.stderr || String(created.error || 'mkfifo failed'));
  mkdirSync(path.dirname(f.filename));
  writeFileSync(f.filename, source());
  // Keep a regression bounded even if opening the FIFO becomes blocking.
  // The child also replaces a checked regular file immediately before open,
  // exercising O_NONBLOCK rather than only the initial special-file check.
  const result = spawnSync(process.execPath, ['--experimental-strip-types', '--input-type=module', '-e', `
    import fs from 'node:fs';
    import { syncBuiltinESMExports } from 'node:module';
    const { loadWindowPlacement } = await import(process.argv[1]);
    const fallback = { x: 200, y: 100, width: 1200, height: 800 };
    const displays = [{ workArea: { x: 0, y: 30, width: 1920, height: 1050 } }];
    const direct = loadWindowPlacement(process.argv[3], displays, fallback);
    const lstat = fs.lstatSync;
    fs.lstatSync = filename => {
      const info = lstat(filename);
      if (filename === process.argv[2]) fs.renameSync(process.argv[3], filename);
      return info;
    };
    syncBuiltinESMExports();
    const replaced = loadWindowPlacement(process.argv[2], displays, fallback);
    process.stdout.write(JSON.stringify([direct, replaced]));
  `, pathToFileURL(path.resolve('src/main/window-placement.ts')).href, f.filename, pipe], { encoding: 'utf8', timeout: 5000 });
  assert.equal(result.status, 0, result.stderr || String(result.error || 'The preference read did not finish.'));
  assert.deepEqual(JSON.parse(result.stdout), [initial, initial]);
  assert.equal(statSync(f.filename).isFIFO(), true, 'Fallback must leave the special file untouched.');
});

test('invalid display entries are ignored and an unavailable display list uses fallback bounds', () => {
  const memory = memoryIO(source({ x: -9000, y: 9000, width: 2000, height: 1000 }));
  assert.deepEqual(loadWindowPlacement('ignored', [], fallback, memory.io).bounds, fallback);
  assert.deepEqual(loadWindowPlacement('ignored', [{ workArea: { ...fallback, width: 0 } }, primary], fallback, memory.io).bounds,
    { x: 0, y: 80, width: 1920, height: 1000 });
});

test('tiny preferences reopen with usable controls and still fit displays smaller than the preferred minimum', () => {
  const tiny = memoryIO(source({ x: 1919, y: 1079, width: 1, height: 1 }));
  assert.deepEqual(loadWindowPlacement('ignored', [primary], fallback, tiny.io).bounds,
    { x: 1600, y: 840, width: 320, height: 240 });
  const smallDisplay = { workArea: { x: -200, y: 10, width: 200, height: 180 } };
  assert.deepEqual(loadWindowPlacement('ignored', [smallDisplay], fallback, tiny.io).bounds, smallDisplay.workArea);
  const window = new WindowStub();
  window.bounds = { x: 1919, y: 1079, width: 1, height: 1 };
  const tracker = trackWindowPlacement(window, 'ignored', () => [primary], initial, { io: tiny.io });
  try {
    tracker.flush();
    assert.deepEqual(tiny.saved().bounds, { x: 1600, y: 840, width: 320, height: 240 });
  } finally { tracker.dispose(); }
});

test('move and resize bursts debounce one save while explicit close flush saves immediately', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const window = new WindowStub();
  const memory = memoryIO();
  const tracker = trackWindowPlacement(window, 'ignored', () => [primary], initial, { io: memory.io });
  t.after(() => tracker.dispose());
  window.bounds = { x: 340, y: 160, width: 1000, height: 700 };
  window.emit('move');
  t.mock.timers.tick(200);
  window.bounds.width = 1050;
  window.emit('resize');
  t.mock.timers.tick(249);
  assert.equal(memory.state.writes, 0);
  t.mock.timers.tick(1);
  assert.equal(memory.state.writes, 1);
  assert.deepEqual(memory.saved().bounds, window.bounds);
  window.bounds.x = 450;
  window.emit('move');
  tracker.flush();
  assert.equal(memory.state.writes, 2);
  assert.deepEqual(memory.saved().bounds, window.bounds);
  t.mock.timers.tick(1000);
  assert.equal(memory.state.writes, 2, 'Flushing cancels the pending duplicate write.');
});

test('immediate maximized close saves restore bounds, and minimizing preserves that maximized state', () => {
  const window = new WindowStub();
  const memory = memoryIO();
  const tracker = trackWindowPlacement(window, 'ignored', () => [primary], initial, { io: memory.io });
  try {
    window.bounds = { x: 410, y: 180, width: 1000, height: 750 };
    window.emit('move');
    window.maximized = true;
    window.emit('maximize');
    tracker.flush();
    assert.deepEqual(memory.saved(), { version: 1, bounds: window.bounds, maximized: true });
    const normal = { ...window.bounds };
    window.minimized = true;
    window.maximized = false;
    window.bounds = { x: -32000, y: -32000, width: 160, height: 28 };
    window.emit('minimize');
    window.emit('move');
    tracker.flush();
    assert.deepEqual(memory.saved(), { version: 1, bounds: normal, maximized: true });
    window.minimized = false;
    window.bounds = normal;
    window.emit('restore');
    window.emit('unmaximize');
    tracker.flush();
    assert.deepEqual(memory.saved(), { version: 1, bounds: normal, maximized: false });
  } finally { tracker.dispose(); }
});

test('minimizing before a debounced normal-window save retains the last visible move', () => {
  const window = new WindowStub();
  const memory = memoryIO();
  const tracker = trackWindowPlacement(window, 'ignored', () => [primary], initial, { io: memory.io });
  try {
    const moved = { x: 600, y: 220, width: 950, height: 650 };
    window.bounds = moved;
    window.emit('move');
    assert.equal(memory.state.writes, 0);
    window.minimized = true;
    window.bounds = { x: -32000, y: -32000, width: 160, height: 28 };
    window.emit('minimize');
    tracker.flush();
    assert.deepEqual(memory.saved(), { version: 1, bounds: moved, maximized: false });
  } finally { tracker.dispose(); }
});

test('invalid or transient native geometry cannot replace the last visible placement', () => {
  const window = new WindowStub();
  const memory = memoryIO();
  const tracker = trackWindowPlacement(window, 'ignored', () => [primary], initial, { io: memory.io });
  try {
    for (const bounds of [{ ...fallback, width: 0 }, { ...fallback, height: NaN }, { x: -32000, y: -32000, width: 160, height: 28 }]) {
      window.bounds = bounds;
      window.emit('resize');
      tracker.flush();
      assert.deepEqual(memory.saved().bounds, fallback);
    }
    window.throwing = true;
    assert.doesNotThrow(() => tracker.flush());
    assert.deepEqual(memory.saved().bounds, fallback);
  } finally { tracker.dispose(); }
});

test('a removed monitor is clamped at close and late destroyed-window events are harmless', () => {
  const window = new WindowStub();
  window.bounds = { x: -1400, y: -100, width: 1100, height: 700 };
  const memory = memoryIO();
  let displays = [primary, left];
  const tracker = trackWindowPlacement(window, 'ignored', () => displays, { bounds: window.bounds, maximized: false }, { io: memory.io });
  try {
    window.emit('move');
    displays = [primary];
    window.destroyed = true;
    const queries = window.queried;
    window.emit('resize');
    tracker.flush();
    assert.equal(window.queried, queries);
    assert.deepEqual(memory.saved().bounds, { x: 0, y: 30, width: 1100, height: 700 });
  } finally { tracker.dispose(); }
});

test('preference write failures are swallowed and a later save can retry', () => {
  const window = new WindowStub();
  const memory = memoryIO();
  memory.state.failing = true;
  const tracker = trackWindowPlacement(window, 'ignored', () => [primary], initial, { io: memory.io });
  try {
    window.bounds.x = 300;
    assert.doesNotThrow(() => { window.emit('move'); tracker.flush(); });
    assert.equal(memory.state.writes, 0);
    memory.state.failing = false;
    tracker.flush();
    assert.deepEqual(memory.saved().bounds, window.bounds);
  } finally { tracker.dispose(); }
});

test('disposal cancels delayed writes and removes listeners without flushing a rejected close', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const window = new WindowStub();
  const memory = memoryIO();
  const tracker = trackWindowPlacement(window, 'ignored', () => [primary], initial, { io: memory.io });
  window.emit('move');
  tracker.dispose();
  tracker.dispose();
  tracker.flush();
  t.mock.timers.tick(1000);
  assert.equal(memory.state.writes, 0);
  assert.deepEqual(window.eventNames(), []);
});

test('atomic file persistence survives restart and cleans temporary files when publication fails', t => {
  const f = temporary(t);
  const window = new WindowStub();
  const tracker = trackWindowPlacement(window, f.filename, () => [primary], initial);
  try {
    window.bounds = { x: 400, y: 80, width: 900, height: 680 };
    window.maximized = true;
    tracker.flush();
    assert.deepEqual(loadWindowPlacement(f.filename, [primary], fallback), { bounds: window.bounds, maximized: true });
    assert.deepEqual(readdirSync(path.dirname(f.filename)), ['window-placement.json']);
    assert.ok(readFileSync(f.filename, 'utf8').endsWith('\n'));
    if (process.platform !== 'win32') assert.equal(statSync(f.filename).mode & 0o777, 0o600);
  } finally { tracker.dispose(); }
  rmSync(f.filename);
  mkdirSync(f.filename);
  writeFileSync(path.join(f.filename, 'keep.txt'), 'Existing contents');
  const failed = trackWindowPlacement(window, f.filename, () => [primary], initial);
  try { assert.doesNotThrow(() => failed.flush()); }
  finally { failed.dispose(); }
  assert.equal(readFileSync(path.join(f.filename, 'keep.txt'), 'utf8'), 'Existing contents');
  assert.deepEqual(readdirSync(path.dirname(f.filename)), ['window-placement.json']);
});
