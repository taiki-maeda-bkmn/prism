import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { installWindowTranslucency } from '../src/main/window-translucency';

class WindowStub extends EventEmitter {
  destroyed = false;
  visible = true;
  opacity = 1;
  updates: number[] = [];
  handle = Buffer.from([0x34, 0x12, 0, 0, 0, 0, 0, 0]);
  isDestroyed() { return this.destroyed; }
  isVisible() { return this.visible; }
  getOpacity() { return this.opacity; }
  setOpacity(value: number) { this.opacity = value; this.updates.push(value); }
  getNativeWindowHandle() { return this.handle; }
}

function fixture() {
  const window = new WindowStub();
  const calls: { signal: { handle: string; processId: number }; done: (error?: Error | null) => void; cancelled: boolean }[] = [];
  const warnings: string[] = [];
  const controller = installWindowTranslucency(window, { platform: 'win32', warn: message => warnings.push(message),
    runSignal(signal, done) {
      const call = { signal, done, cancelled: false };
      calls.push(call);
      return { cancel: () => { call.cancelled = true; } };
    },
  });
  return { window, controller, calls, warnings };
}

test('native translucency accepts only booleans and changes no Linux or macOS windows', () => {
  for (const platform of ['linux', 'darwin']) {
    const window = new WindowStub();
    const controller = installWindowTranslucency(window, { platform, runSignal: () => { throw new Error('Must not run.'); } });
    controller.setTranslucent(true);
    controller.dispose();
    assert.deepEqual(window.updates, []);
    assert.equal(window.listenerCount('closed'), 0);
  }
  const f = fixture();
  for (const input of [null, undefined, 'true', 1, {}, [], 0.1]) f.controller.setTranslucent(input);
  assert.deepEqual(f.window.updates, []);
  assert.equal(f.calls.length, 0);
});

test('native alpha preserves existing CSS opacity and uses only the owned window identity', () => {
  const f = fixture();
  f.controller.setTranslucent(false);
  assert.equal(f.calls.length, 0);
  f.controller.setTranslucent(true);
  assert.deepEqual(f.window.updates, [254 / 255]);
  assert.deepEqual(f.calls[0].signal, { handle: '4660', processId: process.pid });
  f.calls[0].done();
  f.controller.setTranslucent(true);
  assert.equal(f.calls.length, 1, 'slider changes within translucent mode do not spawn more helpers');
  f.controller.setTranslucent(false);
  assert.deepEqual(f.window.updates, [254 / 255, 1]);
  assert.equal(f.calls.length, 2);
});

test('initial hidden windows set native alpha without starting a notifier', () => {
  const f = fixture();
  f.window.visible = false;
  f.controller.setTranslucent(true);
  assert.equal(f.window.opacity, 254 / 255);
  assert.equal(f.calls.length, 0);
  f.window.visible = true;
  f.controller.setTranslucent(false);
  assert.equal(f.calls.length, 1);
});

test('a window born translucent keeps saved transparency or restores an opaque preference before show', () => {
  const f = fixture();
  f.window.visible = false;
  f.window.opacity = 254 / 255;
  f.controller.setTranslucent(true);
  assert.deepEqual(f.window.updates, [], 'saved transparency never passes through native opaque alpha');
  f.controller.setTranslucent(false);
  assert.equal(f.window.opacity, 1);
  assert.deepEqual(f.window.updates, [1]);
  assert.equal(f.calls.length, 0, 'the first native show observes the resolved appearance');
});

test('rapid live changes serialize helpers and coalesce their pending notification', () => {
  const f = fixture();
  f.controller.setTranslucent(true);
  f.controller.setTranslucent(false);
  f.controller.setTranslucent(true);
  f.controller.setTranslucent(false);
  assert.equal(f.calls.length, 1);
  assert.equal(f.window.opacity, 1, 'native appearance changes immediately');
  f.calls[0].done();
  assert.equal(f.calls.length, 2, 'one final event observes the latest native alpha');
  f.calls[1].done();
  assert.equal(f.calls.length, 2);
});

test('closing cancels the owned helper, drops queued work, and ignores late completion', () => {
  const f = fixture();
  f.controller.setTranslucent(true);
  f.controller.setTranslucent(false);
  f.window.destroyed = true;
  f.window.emit('closed');
  assert.equal(f.calls[0].cancelled, true);
  f.calls[0].done(new Error('Cancelled'));
  f.controller.setTranslucent(true);
  f.controller.dispose();
  assert.equal(f.calls.length, 1);
  assert.deepEqual(f.warnings, []);
  assert.equal(f.window.listenerCount('closed'), 0);
});

test('helper failures are bounded, do not crash the editor, and permit a later change', () => {
  const f = fixture();
  f.controller.setTranslucent(true);
  f.calls[0].done(new Error('PowerShell unavailable'));
  assert.equal(f.warnings.length, 1);
  f.controller.setTranslucent(false);
  f.calls[1].done(new Error('PowerShell unavailable'));
  assert.equal(f.warnings.length, 1, 'do not repeatedly log helper diagnostics');
  assert.equal(f.window.opacity, 1);
});

test('synchronous completion, invalid handles, and destroyed windows leave no stale task', () => {
  const window = new WindowStub();
  let calls = 0;
  const controller = installWindowTranslucency(window, { platform: 'win32', runSignal: (_signal, done) => {
    calls++; done(); return { cancel: () => { throw new Error('Completed task must not be cancelled.'); } };
  } });
  controller.setTranslucent(true);
  controller.setTranslucent(false);
  controller.dispose();
  assert.equal(calls, 2);
  const f = fixture();
  f.window.handle = Buffer.alloc(3);
  f.controller.setTranslucent(true);
  assert.equal(f.calls.length, 0);
  assert.equal(f.warnings.length, 1);
  f.window.destroyed = true;
  f.controller.setTranslucent(false);
  assert.equal(f.window.listenerCount('closed'), 0);
});
