import { build } from 'esbuild';
import { copyFile, mkdir, rm } from 'node:fs/promises';

await rm('dist', { recursive: true, force: true });
await mkdir('dist/renderer', { recursive: true });

await Promise.all([
  build({
    entryPoints: ['src/main/main.ts'],
    outfile: 'dist/main.cjs',
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node22',
    external: ['electron'],
    sourcemap: true,
  }),
  build({
    entryPoints: ['src/main/preload.ts'],
    outfile: 'dist/preload.cjs',
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node22',
    external: ['electron'],
    sourcemap: true,
  }),
  build({
    entryPoints: ['src/renderer/main.tsx'],
    outfile: 'dist/renderer/app.js',
    bundle: true,
    platform: 'browser',
    format: 'iife',
    target: 'chrome132',
    sourcemap: true,
    minify: true,
    define: { 'process.env.NODE_ENV': '"production"' },
    loader: { '.woff2': 'file', '.svg': 'file', '.png': 'file' },
  }),
]);

await copyFile('src/renderer/index.html', 'dist/renderer/index.html');
await copyFile('assets/prism.png', 'dist/icon.png');
console.log('Prism built in dist/.');
