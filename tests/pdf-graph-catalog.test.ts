import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { act, createElement, StrictMode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { JSDOM } from 'jsdom';
import type { PDFGraphDocument } from '../src/shared/pdfGraph';
import { PDFGraphCatalogController, usePDFGraphCatalog } from '../src/renderer/usePDFGraphCatalog';

type Snapshot = { documents: readonly PDFGraphDocument[] };
function deferred() {
  let resolve!: (snapshot: Snapshot) => void;
  let reject!: (failure: unknown) => void;
  const promise = new Promise<Snapshot>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const settle = async () => { await Promise.resolve(); await Promise.resolve(); };
const original = { id: 'a', title: 'Original' };
const renamed = { id: 'a', title: '変更後' };

test('metadata loads only when enabled, coalesces concurrent requests, and keeps successful snapshots', async () => {
  const pending = deferred();
  let calls = 0;
  const controller = new PDFGraphCatalogController(() => { calls++; return pending.promise; });
  controller.ensureLoaded();
  assert.equal(calls, 0, 'an inactive controller cannot acquire the library');
  controller.activate();
  assert.equal(calls, 0);
  controller.ensureLoaded(); controller.ensureLoaded(); controller.refresh();
  assert.equal(calls, 1);
  assert.equal(controller.getSnapshot().status, 'loading');
  pending.resolve({ documents: [original] });
  await settle();
  const ready = controller.getSnapshot();
  assert.deepEqual(ready, { status: 'ready', documents: [original] });
  controller.ensureLoaded();
  controller.deactivate(); controller.activate(); controller.ensureLoaded();
  assert.equal(calls, 1);
  assert.equal(controller.getSnapshot(), ready);
});

test('library publications supersede old loads and cannot be replaced by stale titles or removed documents', async () => {
  for (const documents of [[renamed], []]) {
    const pending = deferred();
    const controller = new PDFGraphCatalogController(() => pending.promise);
    controller.activate(); controller.ensureLoaded();
    controller.updateDocuments(documents);
    const published = controller.getSnapshot();
    pending.resolve({ documents: [original] });
    await settle();
    assert.equal(controller.getSnapshot(), published);
    assert.deepEqual(controller.getSnapshot(), { status: 'ready', documents });
  }
});

test('unchanged publications invalidate refreshes and metadata-only updates preserve snapshot identity', async () => {
  const pending = deferred();
  const controller = new PDFGraphCatalogController(() => pending.promise);
  controller.activate();
  const full = { ...original, lastPage: 1, favorite: false };
  controller.updateDocuments([full, { id: 'b', title: 'Second' }]);
  const initial = controller.getSnapshot();
  const readingUpdate = { ...full, lastPage: 9 };
  controller.updateDocuments([{ id: 'b', title: 'Second' }, readingUpdate]);
  assert.equal(controller.getSnapshot(), initial);
  assert.deepEqual(initial.documents, [original, { id: 'b', title: 'Second' }], 'only IDs and titles enter the graph');
  controller.refresh();
  controller.updateDocuments(initial.documents);
  const current = controller.getSnapshot();
  pending.reject(new Error('Obsolete load failure'));
  await settle();
  assert.equal(controller.getSnapshot(), current);
  assert.equal(controller.getSnapshot().status, 'ready');
});

test('failures retain unknown status until explicit retry succeeds and strip the Electron error wrapper', async () => {
  const first = deferred(); const retry = deferred();
  let calls = 0;
  const controller = new PDFGraphCatalogController(() => (++calls === 1 ? first : retry).promise);
  controller.activate(); controller.ensureLoaded();
  first.reject(new Error("Error invoking remote method 'pdf:load-library': Error: Library is already open"));
  await settle();
  assert.deepEqual(controller.getSnapshot(), { status: 'error', documents: [], error: 'Library is already open' });
  controller.ensureLoaded();
  assert.equal(calls, 1, 'a render or visibility change must not create a retry loop');
  controller.refresh();
  assert.equal(controller.getSnapshot().status, 'loading');
  retry.resolve({ documents: [] });
  await settle();
  assert.deepEqual(controller.getSnapshot(), { status: 'ready', documents: [] });
});

test('unmount invalidates pending work and effect remount can safely start a fresh load', async () => {
  const first = deferred(); const second = deferred();
  let calls = 0; let notifications = 0;
  const controller = new PDFGraphCatalogController(() => (++calls === 1 ? first : second).promise);
  controller.activate();
  const unsubscribe = controller.subscribe(() => notifications++);
  controller.ensureLoaded();
  controller.deactivate(); unsubscribe();
  controller.updateDocuments([renamed]);
  assert.equal(controller.getSnapshot().status, 'idle');
  controller.activate(); controller.ensureLoaded();
  first.resolve({ documents: [original] });
  await settle();
  assert.equal(notifications, 1, 'no publication is sent after unmount');
  assert.equal(controller.getSnapshot().status, 'loading', 'old work cannot finish the replacement load');
  controller.refresh();
  assert.equal(calls, 2, 'old completion cannot clear the new request guard');
  second.resolve({ documents: [renamed] });
  await settle();
  assert.deepEqual(controller.getSnapshot(), { status: 'ready', documents: [renamed] });
});

const dom = new JSDOM('<!doctype html><html><body></body></html>');
Object.defineProperty(globalThis, 'window', { value: dom.window, configurable: true });
Object.defineProperty(globalThis, 'document', { value: dom.window.document, configurable: true });
Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { value: true, configurable: true });
after(() => dom.window.close());

test('React adapter keeps callbacks stable and never requests bytes when enabling or revisiting the graph', async () => {
  let calls = 0;
  const pending = deferred();
  Object.defineProperty(dom.window, 'prismPdf', { configurable: true, value: {
    loadLibrary: () => { calls++; return pending.promise; },
    readDocument: () => { throw new Error('The graph must never read PDF bytes'); },
  } });
  let value!: ReturnType<typeof usePDFGraphCatalog>;
  function Probe({ enabled }: { enabled: boolean }) { value = usePDFGraphCatalog(enabled); return null; }
  const container = document.createElement('div');
  document.body.append(container);
  const root: Root = createRoot(container);
  try {
    await act(async () => { root.render(createElement(StrictMode, null, createElement(Probe, { enabled: false }))); });
    assert.equal(calls, 0);
    const refresh = value.refresh; const updateDocuments = value.updateDocuments;
    await act(async () => { root.render(createElement(StrictMode, null, createElement(Probe, { enabled: true }))); });
    assert.equal(calls, 1);
    assert.equal(value.catalog.status, 'loading');
    await act(async () => { pending.resolve({ documents: [original] }); await settle(); });
    assert.equal(value.catalog.status, 'ready');
    await act(async () => { root.render(createElement(StrictMode, null, createElement(Probe, { enabled: false }))); });
    await act(async () => { root.render(createElement(StrictMode, null, createElement(Probe, { enabled: true }))); });
    assert.equal(calls, 1);
    assert.equal(value.refresh, refresh);
    assert.equal(value.updateDocuments, updateDocuments);
    await act(async () => { value.updateDocuments([renamed]); });
    assert.deepEqual(value.catalog.documents, [renamed]);
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});
