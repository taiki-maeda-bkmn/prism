import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { superviseDesktopChild } from '../scripts/desktop-session.mjs';

const token = 'a'.repeat(48);
class Child extends EventEmitter {
  pid: number | undefined = 12345;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  killed = false;
  stdout = new PassThrough();
  signals: NodeJS.Signals[] = [];
  kill(signal: NodeJS.Signals) { this.killed = true; this.signals.push(signal); return true; }
  exit(code = 0, signal: NodeJS.Signals | null = null) {
    this.exitCode = code; this.signalCode = signal; this.emit('exit', code, signal);
  }
}
function fixture(processGroup = true) {
  const child = new Child();
  const signals = new EventEmitter();
  const logs: string[] = [];
  const diagnostics: string[] = [];
  const groups: { pid: number; signal: NodeJS.Signals }[] = [];
  const done = superviseDesktopChild(child as unknown as ChildProcess, {
    token, signalSource: signals, startupTimeoutMs: 1000, terminateGraceMs: 100,
    processGroup, signalGroup: (pid, signal) => { groups.push({ pid, signal }); },
    writeStdout: chunk => logs.push(chunk.toString()), reportError: message => diagnostics.push(message),
  });
  return { child, signals, logs, diagnostics, groups, done };
}

test('a matching ready marker split across stdout writes disarms only the startup deadline', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture();
  f.child.stdout.write('Normal diagnostic\nPRISM_RE');
  f.child.stdout.write(`ADY:${token}\n`);
  t.mock.timers.tick(5000);
  assert.deepEqual(f.groups, []);
  f.child.exit(0);
  assert.deepEqual(await f.done, { exitCode: 0, ready: true, timedOut: false });
  assert.deepEqual(f.groups, [{ pid: 12345, signal: 'SIGKILL' }]);
  assert.match(f.logs.join(''), /Normal diagnostic/);
});

test('wrong or embedded markers do not mask startup failure and escalation targets only the owned group', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture();
  f.child.stdout.write(`PRISM_READY:${'b'.repeat(48)}\nlog PRISM_READY:${token}\n`);
  t.mock.timers.tick(1000);
  assert.deepEqual(f.groups, [{ pid: 12345, signal: 'SIGTERM' }]);
  t.mock.timers.tick(100);
  assert.deepEqual(f.groups[1], { pid: 12345, signal: 'SIGKILL' });
  assert.match(f.diagnostics[0], /did not open a window/);
  f.child.exit(0);
  assert.deepEqual(await f.done, { exitCode: 1, ready: false, timedOut: true });
  assert.equal(f.groups.length, 2, 'a previous group SIGKILL is not repeated after exit');
});

test('direct child exit finishes without a close event even when descendants retain stdout', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture();
  f.child.exit(0);
  assert.deepEqual(await f.done, { exitCode: 0, ready: false, timedOut: false });
  assert.equal(f.child.stdout.destroyed, true);
  assert.equal(f.signals.listenerCount('SIGTERM'), 0);
  t.mock.timers.tick(5000);
  assert.deepEqual(f.groups, [{ pid: 12345, signal: 'SIGKILL' }]);
});

test('successful SIGTERM delivery does not suppress a later signal to a still-running child', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture();
  f.signals.emit('SIGTERM');
  assert.equal(f.child.killed, true);
  f.signals.emit('SIGINT');
  assert.deepEqual(f.child.signals, ['SIGTERM', 'SIGINT']);
  f.child.exit(0);
  await f.done;
  f.signals.emit('SIGTERM');
  assert.deepEqual(f.child.signals, ['SIGTERM', 'SIGINT']);
});

test('exit during startup termination cleans up once and cancels every later signal', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture();
  t.mock.timers.tick(1000);
  f.child.exit(1);
  await f.done;
  t.mock.timers.tick(10000);
  assert.deepEqual(f.groups, [
    { pid: 12345, signal: 'SIGTERM' },
    { pid: 12345, signal: 'SIGKILL' },
  ]);
});

test('late readiness cancels escalation rather than force-closing a now-visible editor', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture();
  t.mock.timers.tick(1000);
  f.child.stdout.write(`PRISM_READY:${token}\n`);
  t.mock.timers.tick(1000);
  assert.deepEqual(f.groups, [{ pid: 12345, signal: 'SIGTERM' }]);
  f.child.exit(0);
  assert.deepEqual(await f.done, { exitCode: 0, ready: true, timedOut: true });
});

test('spawn failure resolves without waiting for an exit event', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture();
  f.child.pid = undefined;
  f.child.emit('error', new Error('Executable missing'));
  assert.deepEqual(await f.done, { exitCode: 1, ready: false, timedOut: false });
  assert.match(f.diagnostics[0], /Executable missing/);
  t.mock.timers.tick(5000);
  assert.deepEqual(f.groups, []);
});

test('exit never signals an inherited process group that the launcher does not own', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture(false);
  f.child.stdout.write(`PRISM_READY:${token}\n`);
  f.child.exit(0);
  await f.done;
  t.mock.timers.tick(5000);
  assert.deepEqual(f.groups, []);
  assert.deepEqual(f.child.signals, []);
});

test('a group that already exited is a normal cleanup outcome', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const child = new Child();
  const diagnostics: string[] = [];
  const done = superviseDesktopChild(child as unknown as ChildProcess, {
    token, processGroup: true, signalSource: new EventEmitter(),
    signalGroup: () => { throw Object.assign(new Error('No such process'), { code: 'ESRCH' }); },
    reportError: message => diagnostics.push(message), writeStdout: () => {},
  });
  child.exit(0);
  assert.deepEqual(await done, { exitCode: 0, ready: false, timedOut: false });
  assert.deepEqual(diagnostics, []);
});
