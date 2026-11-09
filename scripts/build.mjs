import { build } from 'esbuild';
import { copyFile, cp, mkdir, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { japaneseFontCSS } from './japanese-font.mjs';

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
    // The package's UMD entry passes require through a factory, which leaves
    // relative runtime imports in a bundled app. Bundle its ESM entry instead.
    alias: { 'jsonc-parser': path.resolve('node_modules/jsonc-parser/lib/esm/main.js') },
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
    entryPoints: { app: 'src/renderer/main.tsx' },
    plugins: [{
      name: 'japanese-glyph-font',
      setup(plugin) {
        plugin.onLoad({ filter: /@fontsource-variable[\\/]noto-sans-jp[\\/]index\.css$/ }, async (args) => ({
          contents: japaneseFontCSS(await readFile(args.path, 'utf8')),
          loader: 'css', resolveDir: path.dirname(args.path),
        }));
      },
    }],
    outdir: 'dist/renderer',
    bundle: true,
    platform: 'browser',
    format: 'esm',
    splitting: true,
    // Keep chunks beside app.js so the reader's import.meta.url-relative
    // worker, character maps, fonts, and WASM paths work in both app builds.
    chunkNames: '[name]-[hash]',
    target: 'chrome132',
    sourcemap: true,
    minify: true,
    define: { 'process.env.NODE_ENV': '"production"' },
    loader: { '.woff2': 'file', '.woff': 'file', '.ttf': 'file', '.svg': 'file', '.png': 'file' },
  }),
]);

await copyFile('src/renderer/index.html', 'dist/renderer/index.html');
await copyFile('assets/prism.png', 'dist/icon.png');
await copyFile('node_modules/katex/LICENSE', 'dist/katex-LICENSE.txt');
await copyFile('node_modules/@xmldom/xmldom/LICENSE', 'dist/xmldom-LICENSE.txt');
await copyFile('node_modules/jsonc-parser/LICENSE.md', 'dist/jsonc-parser-LICENSE.txt');
await copyFile('node_modules/@fontsource-variable/noto-sans-jp/LICENSE', 'dist/noto-sans-jp-OFL.txt');
await copyFile('node_modules/pdfjs-dist/LICENSE', 'dist/pdfjs-LICENSE.txt');
await copyFile('node_modules/pdfjs-dist/build/pdf.worker.mjs', 'dist/renderer/pdf.worker.mjs');
await Promise.all(['cmaps', 'standard_fonts', 'wasm'].map(name => cp(
  path.join('node_modules/pdfjs-dist', name), path.join('dist/renderer', name), { recursive: true },
)));
console.log('Prism built in dist/.');
