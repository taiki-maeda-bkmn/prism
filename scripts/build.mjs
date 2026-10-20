import { build } from 'esbuild';
import { copyFile, mkdir, readFile, rm } from 'node:fs/promises';
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
    plugins: [{
      name: 'japanese-glyph-font',
      setup(plugin) {
        plugin.onLoad({ filter: /@fontsource-variable[\\/]noto-sans-jp[\\/]index\.css$/ }, async (args) => ({
          contents: japaneseFontCSS(await readFile(args.path, 'utf8')),
          loader: 'css', resolveDir: path.dirname(args.path),
        }));
      },
    }],
    outfile: 'dist/renderer/app.js',
    bundle: true,
    platform: 'browser',
    format: 'iife',
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
await copyFile('node_modules/@fontsource-variable/noto-sans-jp/LICENSE', 'dist/noto-sans-jp-OFL.txt');
console.log('Prism built in dist/.');
