import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { electronLaunchArguments } from './electron-launch.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const electronDirectory = path.join(root, 'node_modules', 'electron');
const executable = path.join(electronDirectory, 'dist', readFileSync(path.join(electronDirectory, 'path.txt'), 'utf8').trim());
const env = { ...process.env };
// The desktop shortcut uses Electron's bundled Node runtime for this wrapper;
// its child must start Electron normally, with the display backend already set.
delete env.ELECTRON_RUN_AS_NODE;
const args = electronLaunchArguments([root, ...process.argv.slice(2)]);
const child = spawn(executable, args, { cwd: root, env, stdio: 'inherit' });
const forwardSignal = signal => { if (!child.killed) child.kill(signal); };
const onInterrupt = () => forwardSignal('SIGINT');
const onTerminate = () => forwardSignal('SIGTERM');
process.on('SIGINT', onInterrupt);
process.on('SIGTERM', onTerminate);
child.once('error', error => {
  console.error(`Prism could not start: ${error.message}`);
  process.exitCode = 1;
});
child.once('close', (code, signal) => {
  process.removeListener('SIGINT', onInterrupt);
  process.removeListener('SIGTERM', onTerminate);
  process.exitCode = code ?? (signal ? 128 + os.constants.signals[signal] : 1);
});
