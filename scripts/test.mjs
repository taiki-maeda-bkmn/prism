import { build } from 'esbuild';
import { readdir, mkdir, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const tests = (await readdir('tests'))
  .filter((file) => file.endsWith('.test.ts') || file.endsWith('.test.tsx'))
  .sort();

if (!tests.length) throw new Error('No unit tests were found in tests/.');

await rm('dist-test', { recursive: true, force: true });
await mkdir('dist-test', { recursive: true });

await build({
  entryPoints: tests.map((file) => path.join('tests', file)),
  outdir: 'dist-test',
  outExtension: { '.js': '.mjs' },
  bundle: true,
  platform: 'node',
  packages: 'external',
  format: 'esm',
  target: 'node22',
  sourcemap: 'inline',
});

const result = spawnSync(
  process.execPath,
  ['--test', ...tests.map((file) => path.join('dist-test', file.replace(/\.tsx?$/, '.mjs')))],
  { stdio: 'inherit' },
);
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
