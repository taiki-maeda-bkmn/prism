import { build } from 'esbuild';
import { readdir, mkdir, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const testsDirectory = path.join(root, 'pdf-manager/tests');
const output = path.join(root, 'pdf-manager/dist-test');
const tests = (await readdir(testsDirectory))
  .filter((file) => /\.test\.tsx?$/.test(file))
  .sort();

if (!tests.length) throw new Error('No unit tests were found in pdf-manager/tests/.');

await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
await build({
  entryPoints: tests.map((file) => path.join(testsDirectory, file)),
  outdir: output,
  outExtension: { '.js': '.mjs' },
  bundle: true,
  platform: 'node',
  packages: 'external',
  format: 'esm',
  target: 'node22',
  sourcemap: 'inline',
});

const result = spawnSync(process.execPath, [
  '--test', ...tests.map((file) => path.join(output, file.replace(/\.tsx?$/, '.mjs'))),
], { stdio: 'inherit' });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
