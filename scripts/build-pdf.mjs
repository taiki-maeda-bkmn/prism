import { build } from 'esbuild';
import { copyFile, cp, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const app = path.join(root, 'pdf-manager');
const output = path.join(app, 'dist');
const renderer = path.join(output, 'renderer');
const pdfjs = path.join(root, 'node_modules/pdfjs-dist');

await rm(output, { recursive: true, force: true });
await mkdir(renderer, { recursive: true });

await Promise.all([
  ...['main', 'preload'].map((name) => build({
    entryPoints: [path.join(app, `src/main/${name}.ts`)],
    outfile: path.join(output, `${name}.cjs`),
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node22',
    external: ['electron'],
    sourcemap: true,
  })),
  build({
    entryPoints: [path.join(app, 'src/renderer/main.tsx')],
    outfile: path.join(renderer, 'app.js'),
    bundle: true,
    platform: 'browser',
    format: 'esm',
    target: 'chrome132',
    sourcemap: true,
    minify: true,
    define: { 'process.env.NODE_ENV': '"production"' },
    loader: { '.woff2': 'file', '.svg': 'file', '.png': 'file' },
  }),
]);

await Promise.all([
  copyFile(path.join(app, 'src/renderer/index.html'), path.join(renderer, 'index.html')),
  copyFile(path.join(pdfjs, 'build/pdf.worker.mjs'), path.join(renderer, 'pdf.worker.mjs')),
  ...['cmaps', 'standard_fonts', 'wasm'].map((name) => cp(
    path.join(pdfjs, name), path.join(renderer, name), { recursive: true },
  )),
]);

console.log('Prism PDF built in pdf-manager/dist/.');
