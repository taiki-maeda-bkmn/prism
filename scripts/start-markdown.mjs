import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { electronLaunchArguments } from './electron-launch.mjs';
import { superviseDesktopChild } from './desktop-session.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const electronDirectory = path.join(root, 'node_modules', 'electron');
const executable = path.join(electronDirectory, 'dist', readFileSync(path.join(electronDirectory, 'path.txt'), 'utf8').trim());
const env = { ...process.env };
// The desktop shortcut uses Electron's bundled Node runtime for this wrapper;
// its child must start Electron normally, with the display backend already set.
delete env.ELECTRON_RUN_AS_NODE;
const token = randomBytes(24).toString('hex');
env.PRISM_STARTUP_TOKEN = token;
const args = electronLaunchArguments([root, ...process.argv.slice(2)]);
// An owned POSIX process group lets a failed startup stop its own Chromium
// descendants. It remains referenced: the wrapper still waits/reaps its child.
const processGroup = process.platform !== 'win32';
const child = spawn(executable, args, { cwd: root, env, detached: processGroup, stdio: ['inherit', 'pipe', 'inherit'] });
const result = await superviseDesktopChild(child, { token, processGroup });
process.exitCode = result.exitCode;
