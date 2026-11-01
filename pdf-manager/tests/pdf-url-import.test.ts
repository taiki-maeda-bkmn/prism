import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import type { PDFURLImportState } from '../src/shared/types';
import { PDFLibraryService } from '../src/main/library-service';
import { PDFURLImportManager } from '../src/main/pdf-url-import';
import type { PDFURLDownloader } from '../src/main/pdf-url-download';
import type { LibraryWriteIO } from '../src/main/library';

const url = 'https://example.com/paper.pdf?signature=private-token';
const pdf = Buffer.from('%PDF-1.7\n1 0 obj\n<< /Type /Catalog >>\nendobj\n%%EOF\n');
const download = { filename: 'Research paper.pdf', bytes: pdf };
type Downloader = Pick<PDFURLDownloader, 'download'>;
function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
async function until(manager: PDFURLImportManager, phase: PDFURLImportState['phase']) {
  for (let attempt = 0; attempt < 500; attempt++) {
    if (manager.get()?.phase === phase) return manager.get()!;
    await new Promise(resolve => setTimeout(resolve, 2));
  }
  assert.fail(`Expected ${phase}, received ${JSON.stringify(manager.get())}`);
}
async function fixture(t: TestContext, downloader: Downloader, io: Partial<LibraryWriteIO> = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'prism-pdf-url-job-'));
  const root = path.join(directory, 'library');
  const service = new PDFLibraryService(root, io);
  const manager = new PDFURLImportManager(service, downloader);
  t.after(async () => {
    try { await manager.close(); await service.close(); }
    finally { await fs.rm(directory, { recursive: true, force: true }); }
  });
  return { directory, root, service, manager, catalog: path.join(root, 'catalog.json') };
}

test('start returns immediately, loads first, reports progress and publishes isolated complete snapshots', async t => {
  const loaded = deferred();
  const result = deferred<typeof download>();
  let progress!: Parameters<PDFURLDownloader['download']>[1]['onProgress'];
  const f = await fixture(t, { download: async (value, options) => {
    assert.equal(value, url);
    await assert.rejects(fs.stat(f.catalog), { code: 'ENOENT' });
    assert.ok((await fs.stat(path.join(f.root, '.prism-library-lock.sqlite'))).isFile());
    progress = options.onProgress;
    loaded.resolve();
    return result.promise;
  } });
  const first = f.manager.start(url);
  assert.equal(first.phase, 'downloading');
  assert.equal(first.receivedBytes, 0);
  assert.equal(first.document, null);
  first.phase = 'error';
  try {
    await loaded.promise;
    progress({ receivedBytes: 12, totalBytes: pdf.length });
    assert.equal(f.manager.get()!.receivedBytes, 12);
    assert.equal(f.manager.get()!.totalBytes, pdf.length);
    assert.equal(f.manager.get()!.phase, 'downloading');
    progress({ receivedBytes: 8, totalBytes: null });
    assert.equal(f.manager.get()!.receivedBytes, 12);
    progress({ receivedBytes: Infinity, totalBytes: -1 });
    assert.equal(f.manager.get()!.receivedBytes, 12);
    assert.throws(() => f.manager.start(url), /current PDF import/);
    result.resolve(download);
    const complete = await until(f.manager, 'complete');
    assert.equal(complete.duplicate, false);
    assert.equal(complete.receivedBytes, pdf.length);
    assert.equal(complete.totalBytes, pdf.length);
    assert.equal(complete.document!.title, 'Research paper');
    assert.equal(JSON.stringify(complete).includes('private-token'), false);
    complete.document!.tags.push('Mutation');
    assert.deepEqual(f.manager.get()!.document!.tags, []);
    progress({ receivedBytes: 1, totalBytes: null });
    assert.equal(f.manager.get()!.receivedBytes, pdf.length);
  } finally { result.resolve(download); }
});

test('invalid URLs fail before loading the library or creating job state', () => {
  const manager = new PDFURLImportManager({ load: async () => { assert.fail('Invalid URL reached library'); }, importDownloaded: async () => { assert.fail('Invalid URL reached saving'); } },
    { download: async () => { assert.fail('Invalid URL reached network'); } });
  for (const value of [null, {}, '', 'http://example.com/a.pdf', 'file:///private.pdf', 'https://localhost/a.pdf', 'https://127.0.0.1/a.pdf', 'https://user:password@example.com/a.pdf']) {
    assert.throws(() => manager.start(value));
  }
  assert.equal(manager.get(), null);
});

test('cancelling before load completion skips download and every PDF mutation, then permits a new job', async () => {
  const gate = deferred();
  let loads = 0;
  let downloads = 0;
  let saves = 0;
  const manager = new PDFURLImportManager({ load: async () => { loads++; await gate.promise; return { documents: [], warnings: [] }; },
    importDownloaded: async () => { saves++; throw new Error('Unexpected save'); } }, { download: async () => { downloads++; return download; } });
  const first = manager.start(url);
  try {
    await Promise.resolve();
    assert.equal(loads, 1);
    assert.equal(manager.cancel(first.id).phase, 'cancelled');
    const drained = manager.cancelActive();
    assert.throws(() => manager.start(url), /current PDF import/);
    gate.resolve();
    await drained;
    assert.equal(downloads, 0);
    assert.equal(saves, 0);
    const next = manager.start(url);
    assert.notEqual(next.id, first.id);
    manager.cancel(next.id);
    await manager.cancelActive();
    assert.equal(loads, 1, 'Cancellation before the run microtask skips even library loading.');
  } finally { gate.resolve(); await manager.close(); }
});

test('cancelling an active download aborts transport and ignores late bytes/progress', async t => {
  const entered = deferred();
  const response = deferred<typeof download>();
  let signal!: AbortSignal;
  let progress!: Parameters<PDFURLDownloader['download']>[1]['onProgress'];
  const f = await fixture(t, { download: async (_value, options) => {
    signal = options.signal;
    progress = options.onProgress;
    entered.resolve();
    return response.promise;
  } });
  const state = f.manager.start(url);
  try {
    await entered.promise;
    assert.throws(() => f.manager.cancel('wrong-id'), /no longer active/);
    progress({ receivedBytes: 10, totalBytes: null });
    assert.equal(f.manager.cancel(state.id).phase, 'cancelled');
    assert.equal(signal.aborted, true);
    progress({ receivedBytes: 20, totalBytes: pdf.length });
    assert.equal(f.manager.get()!.receivedBytes, 10);
    response.resolve(download);
    await f.manager.cancelActive();
    assert.equal(f.manager.get()!.phase, 'cancelled');
    assert.deepEqual((await f.service.load()).documents, []);
    await assert.rejects(fs.stat(f.catalog), { code: 'ENOENT' });
    assert.deepEqual(await fs.readdir(path.join(f.root, 'documents')), []);
  } finally { response.resolve(download); }
});

test('cancel followed by its drain handles asynchronous abort rejection and immediately permits a retry', async t => {
  const entered = deferred();
  const abortFinished = deferred();
  let attempts = 0;
  let oldProgress!: Parameters<PDFURLDownloader['download']>[1]['onProgress'];
  const f = await fixture(t, { download: async (_value, options) => {
    if (++attempts > 1) return download;
    oldProgress = options.onProgress;
    return new Promise((_resolve, reject) => {
      options.signal.addEventListener('abort', () => {
        void abortFinished.promise.then(() => reject(Object.assign(new Error('Underlying failure with ' + url), { name: 'AbortError' })));
      }, { once: true });
      entered.resolve();
    });
  } });
  const first = f.manager.start(url);
  try {
    await entered.promise;
    assert.equal(f.manager.cancel(first.id).phase, 'cancelled');
    const drain = f.manager.cancelActive();
    assert.equal(f.manager.cancelActive(), drain, 'Repeated drains share completion.');
    assert.throws(() => f.manager.start(url), /current PDF import/);
    abortFinished.resolve();
    await assert.doesNotReject(drain);
    assert.equal(f.manager.get()!.error, null);
    const retry = f.manager.start(url);
    oldProgress({ receivedBytes: 999, totalBytes: 999 });
    assert.equal(f.manager.get()!.receivedBytes, 0);
    const complete = await until(f.manager, 'complete');
    assert.equal(complete.id, retry.id);
    assert.equal(complete.document!.title, 'Research paper');
    assert.equal(attempts, 2);
  } finally { abortFinished.resolve(); }
});

test('a drain during failed saving resolves while exposing the publication error as state', async t => {
  const entered = deferred();
  const release = deferred();
  const f = await fixture(t, { download: async () => download }, { rename: async () => {
    entered.resolve(); await release.promise; throw new Error('Simulated save failure');
  } });
  f.manager.start(url);
  try {
    await entered.promise;
    const draining = f.manager.cancelActive();
    assert.equal(f.manager.get()!.phase, 'saving');
    release.resolve();
    await assert.doesNotReject(draining);
    assert.equal(f.manager.get()!.phase, 'error');
    assert.match(f.manager.get()!.error!, /could not be saved/);
    assert.deepEqual((await f.service.load()).documents, []);
  } finally { release.resolve(); }
});

test('saving cannot be cancelled and close drains catalog publication before returning', async t => {
  const entered = deferred();
  const release = deferred();
  const f = await fixture(t, { download: async () => download }, { rename: async (source, target) => {
    entered.resolve(); await release.promise; await fs.rename(source, target);
  } });
  const state = f.manager.start(url);
  let closing: Promise<void> | undefined;
  try {
    await entered.promise;
    assert.equal(f.manager.get()!.phase, 'saving');
    assert.equal(f.manager.cancel(state.id).phase, 'saving');
    let closed = false;
    closing = f.manager.close().then(() => { closed = true; });
    assert.throws(() => f.manager.start(url), /closing/);
    await Promise.resolve();
    assert.equal(closed, false);
    release.resolve();
    await closing;
    assert.equal(f.manager.get()!.phase, 'complete');
    assert.equal((await f.service.load()).documents.length, 1);
    assert.throws(() => f.manager.start(url), /closing/);
  } finally { release.resolve(); await closing; }
});

test('cancelActive drains saving but leaves the manager usable when another window opens', async t => {
  const entered = deferred();
  const release = deferred();
  let pause = true;
  let downloads = 0;
  const f = await fixture(t, { download: async () => { downloads++; return download; } }, { rename: async (source, target) => {
    if (pause) { pause = false; entered.resolve(); await release.promise; }
    await fs.rename(source, target);
  } });
  f.manager.start(url);
  try {
    await entered.promise;
    const draining = f.manager.cancelActive();
    assert.throws(() => f.manager.start(url), /current PDF import/);
    release.resolve();
    await draining;
    const first = f.manager.get()!;
    await f.service.update(first.document!.id, { title: 'Custom name', tags: ['Personal'], favorite: true, lastPage: 2, pageCount: 3 });
    f.manager.start(url);
    const repeated = await until(f.manager, 'complete');
    assert.equal(repeated.document!.id, first.document!.id);
    assert.equal(repeated.document!.title, 'Custom name');
    assert.equal(repeated.document!.lastPage, 2);
    assert.equal(repeated.duplicate, true);
    assert.equal(downloads, 2, 'Generic URLs are deduplicated by bytes rather than retained source URLs.');
    assert.throws(() => f.manager.cancel(first.id), /no longer active/);
  } finally { release.resolve(); }
});

test('library load failures prevent networking and become safe retryable state', async () => {
  let fail = true;
  let downloads = 0;
  const manager = new PDFURLImportManager({ load: async () => {
    if (fail) throw new Error('This PDF library is already open in another Prism window. Close that app, then retry.');
    return { documents: [], warnings: [] };
  }, importDownloaded: async () => { throw new Error('storage ' + url); } }, { download: async () => { downloads++; return download; } });
  try {
    assert.equal(manager.start(url).phase, 'downloading');
    const error = await until(manager, 'error');
    assert.match(error.error!, /already open/);
    assert.equal(downloads, 0);
    fail = false;
    manager.start(url);
    const storageError = await until(manager, 'error');
    assert.match(storageError.error!, /could not be saved/);
    assert.equal(storageError.error!.includes('private-token'), false);
    assert.equal(downloads, 1);
  } finally { await manager.close(); }
});

test('network failures, timeout and publication failures expose no signed link and permit retry', async t => {
  let attempt = 0;
  let failSave = true;
  const f = await fixture(t, { download: async () => {
    attempt++;
    if (attempt === 1) throw new Error('request failed: ' + url);
    if (attempt === 2) throw Object.assign(new Error(url), { name: 'TimeoutError' });
    return download;
  } }, { rename: async (source, target) => {
    if (failSave) throw new Error('write failed: ' + url);
    await fs.rename(source, target);
  } });
  for (const expected of [/could not be downloaded/, /timed out/, /could not be saved/]) {
    f.manager.start(url);
    const state = await until(f.manager, 'error');
    assert.match(state.error!, expected);
    assert.equal(JSON.stringify(state).includes('private-token'), false);
    assert.equal(state.document, null);
  }
  assert.deepEqual((await f.service.load()).documents, []);
  assert.deepEqual(await fs.readdir(path.join(f.root, 'documents')), []);
  failSave = false;
  f.manager.start(url);
  assert.equal((await until(f.manager, 'complete')).duplicate, false);
});

test('closing during download aborts and drains it, while closing idle refuses future jobs', async t => {
  const entered = deferred();
  const f = await fixture(t, { download: async (_value, { signal }) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(Object.assign(new Error('cancelled'), { name: 'AbortError' })), { once: true });
    entered.resolve();
  }) });
  f.manager.start(url);
  await entered.promise;
  await f.manager.close();
  assert.equal(f.manager.get()!.phase, 'cancelled');
  assert.throws(() => f.manager.start(url), /closing/);
  assert.deepEqual((await f.service.load()).documents, []);
  const idle = new PDFURLImportManager(f.service, { download: async () => download });
  await idle.close();
  assert.throws(() => idle.start(url), /closing/);
});
