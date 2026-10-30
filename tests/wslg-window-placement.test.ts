import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PassThrough, Writable } from 'node:stream';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import test from 'node:test';
import { parseHostWindowPlacement, startWslgWindowPlacement, validHostWindowBounds, type HostWindowBounds } from '../src/main/wslg-window-placement';

const original: HostWindowBounds = { x: -1200, y: 80, width: 1100, height: 760 };
const moved: HostWindowBounds = { x: 170, y: 140, width: 1200, height: 820 };
const record = (bounds = original) => ({ version: 1, space: 'windows-physical-screen', bounds });
const pause = (milliseconds: number) => new Promise<void>(resolve => setTimeout(resolve, milliseconds));
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(yes => { resolve = yes; });
  return { promise, resolve };
}

class Helper extends EventEmitter {
  stdout = new PassThrough();
  stderr = new PassThrough();
  commands: string[] = [];
  killed = 0;
  exited = false;
  finalBounds: HostWindowBounds | null = null;
  respondsToStop = true;
  stdin = new Writable({ write: (chunk, _encoding, callback) => {
    this.commands.push(chunk.toString());
    if (chunk.toString() === 'stop\n' && this.respondsToStop) {
      this.message('snapshot', this.finalBounds);
      setImmediate(() => this.close());
    }
    callback();
  } });
  kill() { this.killed++; setImmediate(() => this.close()); return true; }
  message(type: string, normal: HostWindowBounds | null) { this.stdout.write(`${JSON.stringify({ type, normal })}\n`); }
  close() {
    if (this.exited) return;
    this.exited = true;
    this.stdout.end(); this.stderr.end(); this.emit('close', 0, null);
  }
}

async function fixture(t: { after: (fn: () => unknown) => void }, saved?: unknown) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'prism-host-placement-'));
  const target = path.join(directory, 'window-placement-wslg.json');
  if (saved !== undefined) await fs.writeFile(target, JSON.stringify(saved));
  const helper = new Helper();
  const launched = deferred<void>();
  const titles: string[] = [];
  let arguments_: readonly string[] = [];
  const bridge = startWslgWindowPlacement({
    window: { setTitle: title => { titles.push(title); }, isDestroyed: () => false },
    directory, distribution: 'Ubuntu Test', scriptPath: '/tmp/host helper.ps1',
    windowsPath: async () => 'C:\\Temporary Space\\host helper.ps1',
    launch: args => { arguments_ = args; launched.resolve(); return helper as unknown as ChildProcessWithoutNullStreams; },
    startupTimeoutMs: 1000, closeTimeoutMs: 40,
  });
  t.after(async () => { await bridge.flushAndStop(); await fs.rm(directory, { recursive: true, force: true }); });
  await launched.promise;
  return { directory, target, helper, bridge, titles, arguments_ };
}

test('physical placement validation accepts negative monitors but rejects mixed coordinate spaces and corrupt rectangles', () => {
  assert.deepEqual(parseHostWindowPlacement(record()), original);
  const copy = parseHostWindowPlacement(record())!;
  copy.x = 5;
  assert.equal(original.x, -1200);
  for (const value of [null, [], {}, { ...record(), extra: true }, { ...record(), version: 2 }, { ...record(), space: 'electron-dip' },
    record({ ...original, width: 0 }), record({ ...original, x: 1.2 }), record({ ...original, y: Infinity }), record({ ...original, height: 50_001 }),
    record({ ...original, x: -1_000_001 })]) assert.equal(parseHostWindowPlacement(value), null);
  assert.equal(validHostWindowBounds({ ...original, minimized: true }), false);
});

test('binds one random title and structured arguments, then flushes the final snapshot before process exit', async t => {
  const f = await fixture(t, record());
  assert.match(f.bridge.title, /^Prism placement [a-f0-9]{32}$/);
  assert.deepEqual(f.titles, [f.bridge.title]);
  assert.deepEqual(f.arguments_.slice(-4), ['-RestoreX', '-1200', '-RestoreY', '80']);
  assert.ok(f.arguments_.includes('C:\\Temporary Space\\host helper.ps1'));
  assert.ok(f.arguments_.includes('Ubuntu Test'));
  const ready = `${JSON.stringify({ type: 'ready', normal: original })}\r\n`;
  f.helper.stdout.write(ready.slice(0, 15));
  f.helper.stdout.write(ready.slice(15));
  assert.equal(await f.bridge.ready, true);
  f.helper.finalBounds = moved;
  const closing = f.bridge.flushAndStop();
  assert.equal(f.bridge.flushAndStop(), closing);
  await closing;
  assert.equal(f.helper.exited, true);
  assert.deepEqual(f.helper.commands, ['stop\n']);
  assert.deepEqual(JSON.parse(await fs.readFile(f.target, 'utf8')), record(moved));
  assert.deepEqual((await fs.readdir(f.directory)).filter(name => name.endsWith('.tmp')), []);
});

test('minimized/maximized snapshots retain the last known normal host position', async t => {
  const f = await fixture(t);
  f.helper.message('ready', original);
  await f.bridge.ready;
  f.helper.message('placement', moved);
  f.helper.message('placement', null);
  f.helper.finalBounds = null;
  await f.bridge.flushAndStop();
  assert.deepEqual(JSON.parse(await fs.readFile(f.target, 'utf8')), record(moved));
});

test('returning to the already-saved position cancels a newer pending move', async t => {
  const f = await fixture(t);
  f.helper.message('ready', original);
  await f.bridge.ready;
  await pause(350);
  f.helper.message('placement', moved);
  f.helper.message('placement', original);
  await f.bridge.flushAndStop();
  assert.deepEqual(JSON.parse(await fs.readFile(f.target, 'utf8')), record());
});

test('corrupt or oversized settings never become host movement arguments', async t => {
  for (const saved of [{ ...record(), space: 'electron-dip' }, { large: 'x'.repeat(3000) }, record({ ...original, x: 1e12 })]) {
    const f = await fixture(t, saved);
    assert.equal(f.arguments_.includes('-RestoreX'), false);
    f.helper.message('ready', original);
    await f.bridge.ready;
    await f.bridge.flushAndStop();
    assert.deepEqual(JSON.parse(await fs.readFile(f.target, 'utf8')), record());
  }
});

test('invalid helper messages and oversized output fail silently without overwriting valid settings', async t => {
  for (const output of ['not JSON\n', JSON.stringify({ type: 'ready', normal: { ...original, x: NaN } }) + '\n',
    JSON.stringify({ type: 'ready', normal: original, arbitrary: true }) + '\n', 'x'.repeat(4097)]) {
    const f = await fixture(t, record());
    f.helper.stdout.write(output);
    assert.equal(await f.bridge.ready, false);
    await f.bridge.flushAndStop();
    assert.equal(f.helper.killed, 1);
    assert.equal(f.helper.exited, true);
    assert.deepEqual(JSON.parse(await fs.readFile(f.target, 'utf8')), record());
  }
});

test('startup deadline terminates a helper which never finds the owned window', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'prism-host-timeout-'));
  const helper = new Helper();
  const bridge = startWslgWindowPlacement({ window: { setTitle() {}, isDestroyed: () => false }, directory, distribution: 'Ubuntu',
    scriptPath: '/helper.ps1', windowsPath: async () => 'C:\\helper.ps1', launch: () => helper as unknown as ChildProcessWithoutNullStreams,
    startupTimeoutMs: 20, closeTimeoutMs: 20 });
  t.after(async () => { await bridge.flushAndStop(); await fs.rm(directory, { recursive: true, force: true }); });
  assert.equal(await bridge.ready, false);
  await bridge.flushAndStop();
  assert.equal(helper.killed, 1);
  assert.equal(helper.exited, true);
  await assert.rejects(fs.stat(path.join(directory, 'window-placement-wslg.json')), { code: 'ENOENT' });
});

test('close is bounded when the host helper ignores stop, retaining the latest normal snapshot', async t => {
  const f = await fixture(t);
  f.helper.respondsToStop = false;
  f.helper.message('ready', original);
  await f.bridge.ready;
  f.helper.message('placement', moved);
  await f.bridge.flushAndStop();
  await pause(0);
  assert.equal(f.helper.killed, 1);
  assert.equal(f.helper.exited, true);
  assert.deepEqual(JSON.parse(await fs.readFile(f.target, 'utf8')), record(moved));
});

test('stopping during asynchronous setup prevents a late helper from spawning', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'prism-host-cancel-'));
  const entered = deferred<void>();
  const translated = deferred<string>();
  let launches = 0;
  const bridge = startWslgWindowPlacement({ window: { setTitle() {}, isDestroyed: () => false }, directory, distribution: 'Ubuntu', scriptPath: '/helper.ps1',
    windowsPath: async () => { entered.resolve(); return translated.promise; },
    launch: () => { launches++; throw new Error('Must not launch'); }, startupTimeoutMs: 1000 });
  t.after(async () => { await bridge.flushAndStop(); await fs.rm(directory, { recursive: true, force: true }); });
  await entered.promise;
  await bridge.flushAndStop();
  assert.equal(await bridge.ready, false);
  translated.resolve('C:\\helper.ps1');
  await pause(0);
  assert.equal(launches, 0);
});

test('unavailable Windows interop, already-closed windows and helper failures leave the app usable', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'prism-host-unavailable-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  for (const state of ['destroyed', 'no-distribution', 'path-failure', 'spawn-failure']) {
    const bridge = startWslgWindowPlacement({
      window: { setTitle() {}, isDestroyed: () => state === 'destroyed' }, directory,
      distribution: state === 'no-distribution' ? '' : 'Ubuntu', scriptPath: '/helper.ps1',
      windowsPath: async () => { if (state === 'path-failure') throw new Error('Interop unavailable'); return 'C:\\helper.ps1'; },
      launch: () => { throw new Error('Executable unavailable'); }, startupTimeoutMs: 100,
    });
    assert.equal(await bridge.ready, false);
    await bridge.flushAndStop();
  }
  assert.deepEqual(await fs.readdir(directory), []);
});

test('a helper exiting before the handshake settles ready and close without waiting for the deadline', async t => {
  const f = await fixture(t, record());
  f.helper.close();
  assert.equal(await f.bridge.ready, false);
  await f.bridge.flushAndStop();
  assert.equal(f.helper.killed, 0);
  assert.deepEqual(JSON.parse(await fs.readFile(f.target, 'utf8')), record());
});

test('final close retries a transient write failure even without another geometry change', async t => {
  const f = await fixture(t);
  // An unexpected directory blocks publication temporarily; the last accepted
  // geometry must survive the failed debounced write and be retried at close.
  await fs.mkdir(f.target);
  f.helper.message('ready', original);
  await f.bridge.ready;
  await pause(400);
  assert.equal((await fs.stat(f.target)).isDirectory(), true);
  await fs.rmdir(f.target);
  f.helper.finalBounds = null;
  await f.bridge.flushAndStop();
  assert.deepEqual(JSON.parse(await fs.readFile(f.target, 'utf8')), record());
  assert.deepEqual((await fs.readdir(f.directory)).filter(name => name.endsWith('.tmp')), []);
});
