import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { isRendererResource } from '../src/main/security';

test('PDF worker and font/image blobs are restricted to the opaque local origin and resource type', async () => {
  const blob = 'blob:null/747ba8bb-3c91-4fa7-8ab8-cc1130dac4b1';
  for (const kind of ['script', 'other', 'font', 'image']) {
    assert.equal(await isRendererResource(blob, '/unused', kind), true, kind);
  }
  for (const kind of [undefined, 'mainFrame', 'subFrame', 'xhr', 'stylesheet', 'ping', 'webSocket']) {
    assert.equal(await isRendererResource(blob, '/unused', kind), false, kind ?? 'unspecified');
  }
  for (const url of ['blob:https://example.com/id', 'blob:file:///tmp/private', 'blob:null', 'https://example.com/pdf.worker.mjs']) {
    assert.equal(await isRendererResource(url, '/unused', 'script'), false, url);
  }
});

test('in-memory PDF data resources allow fonts and images but never scripts, documents or fetches', async () => {
  for (const url of ['data:font/opentype;base64,AA==', 'data:application/font-woff;base64,AA==', 'data:application/x-font-ttf;base64,AA==']) {
    assert.equal(await isRendererResource(url, '/unused', 'font'), true, url);
    assert.equal(await isRendererResource(url, '/unused', 'script'), false, url);
    assert.equal(await isRendererResource(url, '/unused', 'xhr'), false, url);
  }
  assert.equal(await isRendererResource('data:image/png;base64,AA==', '/unused', 'image'), true);
  for (const kind of ['mainFrame', 'subFrame', 'script', 'other', 'xhr', 'font']) {
    assert.equal(await isRendererResource('data:image/png;base64,AA==', '/unused', kind), false, kind);
  }
  for (const url of ['data:text/html,<script>alert(1)</script>', 'data:text/javascript,alert(1)', 'data:application/pdf;base64,AA==']) {
    for (const kind of ['font', 'image', 'script', 'xhr']) assert.equal(await isRendererResource(url, '/unused', kind), false, `${kind}: ${url}`);
  }
});

test('local PDF fetches remain inside the built renderer even when document resources are enabled', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'prism-pdf-resources-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const renderer = path.join(root, 'renderer');
  const relativeFiles = ['pdf.worker.mjs', 'App-PDF123.js', 'cmaps/Identity-H.bcmap', 'standard_fonts/FoxitSans.pfb', 'wasm/openjpeg.wasm'];
  for (const relative of relativeFiles) {
    const filename = path.join(renderer, relative);
    await fs.mkdir(path.dirname(filename), { recursive: true });
    await fs.writeFile(filename, 'bundled asset');
    assert.equal(await isRendererResource(pathToFileURL(filename).href, renderer, relative.endsWith('.js') || relative.endsWith('.mjs') ? 'script' : 'xhr'), true);
  }
  const privatePDF = path.join(root, 'Private.pdf');
  await fs.writeFile(privatePDF, 'private document');
  for (const kind of ['xhr', 'script', 'other', 'image', 'font', 'mainFrame']) {
    assert.equal(await isRendererResource(pathToFileURL(privatePDF).href, renderer, kind), false, kind);
    assert.equal(await isRendererResource('https://example.com/private.pdf', renderer, kind), false, kind);
  }
  if (process.platform !== 'win32') {
    const alias = path.join(renderer, 'wasm', 'escape.wasm');
    await fs.symlink(privatePDF, alias);
    assert.equal(await isRendererResource(pathToFileURL(alias).href, renderer, 'xhr'), false);
  }
});
