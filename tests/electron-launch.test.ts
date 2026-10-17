import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { electronLaunchArguments } from '../scripts/electron-launch.mjs';

const env = { WSL_DISTRO_NAME: 'Ubuntu', DISPLAY: ':0', WAYLAND_DISPLAY: 'wayland-0', XDG_RUNTIME_DIR: '/mnt/wslg/runtime-dir' };
const options = { platform: 'linux' as const, env, socketExists: () => true };

test('selects native Wayland before the app path only on the local WSLg desktop', () => {
  const args = ['/a path/Prism', '--no-sandbox', '--inspect=0'];
  assert.deepEqual(electronLaunchArguments(args, options), ['--ozone-platform=wayland', ...args]);
  assert.deepEqual(args, ['/a path/Prism', '--no-sandbox', '--inspect=0']);
  for (const DISPLAY of [':0.0', 'unix:0', 'unix:0.0', '']) {
    assert.deepEqual(electronLaunchArguments(args, { ...options, env: { ...env, DISPLAY } }), ['--ozone-platform=wayland', ...args]);
  }
});

test('preserves explicit display backends and legacy X11 preferences', () => {
  for (const flags of [['--ozone-platform=x11'], ['--ozone-platform', 'x11'], ['--ozone-platform=wayland']]) {
    const args = ['.', ...flags];
    assert.deepEqual(electronLaunchArguments(args, options), args);
  }
  assert.deepEqual(electronLaunchArguments(['.', '--ozone-platform-hint=x11'], options), ['--ozone-platform=x11', '.', '--ozone-platform-hint=x11']);
  assert.deepEqual(electronLaunchArguments(['.'], { ...options, env: { ...env, ELECTRON_OZONE_PLATFORM_HINT: 'x11' } }), ['--ozone-platform=x11', '.']);
});

test('leaves other platforms, remote displays, and isolated Xvfb launches unchanged', () => {
  for (const platform of ['win32', 'darwin'] as const) assert.deepEqual(electronLaunchArguments(['.'], { ...options, platform }), ['.']);
  for (const changes of [
    { WSL_DISTRO_NAME: '' }, { WAYLAND_DISPLAY: '' }, { XDG_RUNTIME_DIR: '' },
    { XDG_RUNTIME_DIR: 'relative' }, { DISPLAY: ':95' }, { DISPLAY: 'localhost:10.0' },
    { DISPLAY: '192.0.2.1:0' },
  ]) {
    assert.deepEqual(electronLaunchArguments(['.'], { ...options, env: { ...env, ...changes } }), ['.']);
  }
  assert.deepEqual(electronLaunchArguments(['.'], { ...options, socketExists: () => false }), ['.']);
});

test('resolves relative and absolute Wayland socket paths', () => {
  const sockets: string[] = [];
  const socketExists = (filename: string) => { sockets.push(filename); return true; };
  electronLaunchArguments(['.'], { ...options, socketExists });
  electronLaunchArguments(['.'], { ...options, socketExists, env: { ...env, WAYLAND_DISPLAY: '/custom/wayland', XDG_RUNTIME_DIR: '' } });
  assert.deepEqual(sockets, ['/mnt/wslg/runtime-dir/wayland-0', '/custom/wayland']);
});

test('requires an actual available Wayland socket, not a stale path or regular file', { skip: process.platform === 'win32' }, async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'prism-launch-test-'));
  const socket = path.join(directory, 'wayland-0');
  const launch = () => electronLaunchArguments(['.'], { platform: 'linux', env: { ...env, XDG_RUNTIME_DIR: directory } });
  const server = createServer();
  try {
    assert.deepEqual(launch(), ['.']);
    await writeFile(socket, 'stale socket');
    assert.deepEqual(launch(), ['.']);
    await rm(socket);
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(socket, resolve); });
    assert.deepEqual(launch(), ['--ozone-platform=wayland', '.']);
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    assert.deepEqual(launch(), ['.']);
  } finally {
    if (server.listening) await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});
