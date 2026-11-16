import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { act, createElement, StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { JSDOM } from 'jsdom';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import { usePDFTextSearch } from '../src/renderer/usePDFTextSearch';

const dom = new JSDOM('<!doctype html><html><body></body></html>');
Object.defineProperty(globalThis, 'window', { value: dom.window, configurable: true });
Object.defineProperty(globalThis, 'document', { value: dom.window.document, configurable: true });
Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { value: true, configurable: true });
after(() => dom.window.close());

const page = (str: string) => ({ async getTextContent() { return { items: [{ str, hasEOL: false }] }; } });
const proxy = (texts: string[], requests: number[] = []) => ({ numPages: texts.length, async getPage(number: number) {
  requests.push(number); return page(texts[number - 1]);
} }) as unknown as PDFDocumentProxy;

async function until(predicate: () => boolean) {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > 3_000) throw new Error('PDF search did not reach the expected state.');
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 15)); });
  }
}

async function harness(initial: PDFDocumentProxy) {
  let value!: ReturnType<typeof usePDFTextSearch>;
  const snapshots: { count: number; selected: number; request: number }[] = [];
  function Probe({ pdf, visible }: { pdf: PDFDocumentProxy; visible: boolean }) {
    value = usePDFTextSearch(pdf, visible);
    snapshots.push({ count: value.result.matches.length, selected: value.selection.index, request: value.selection.request });
    return null;
  }
  const container = document.createElement('div'); document.body.append(container);
  const root = createRoot(container);
  const render = async (pdf: PDFDocumentProxy, visible = true) => {
    await act(async () => { root.render(createElement(StrictMode, null, createElement(Probe, { pdf, visible }))); });
  };
  await render(initial);
  return {
    get value() { return value; }, snapshots, render,
    async change(action: () => void) { await act(async () => { action(); }); },
    async dispose() { await act(async () => root.unmount()); container.remove(); },
  };
}

test('completed search and selected match survive hiding, closing and reopening without extraction or navigation', async () => {
  const requests: number[] = [], pdf = proxy(['needle needle', 'third needle'], requests);
  const probe = await harness(pdf);
  try {
    await probe.change(() => { probe.value.setQuery('needle'); probe.value.setOpen(true); });
    await until(() => !probe.value.busy && probe.value.result.matches.length === 3);
    await probe.change(() => probe.value.move(1));
    await probe.change(() => probe.value.move(1));
    assert.equal(probe.value.selection.index, 2);
    const selection = probe.value.selection, result = probe.value.result;
    await probe.render(pdf, false);
    assert.equal(probe.value.result, result);
    assert.equal(probe.value.selection, selection);
    await probe.render(pdf, true);
    await probe.change(() => probe.value.setOpen(false));
    await probe.change(() => probe.value.setOpen(true));
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 300)); });
    assert.equal(probe.value.result, result);
    assert.equal(probe.value.selection, selection);
    assert.deepEqual(requests, [1, 2]);
    await probe.change(() => probe.value.setQuery(' NEEDLE  '));
    assert.equal(probe.value.result, result, 'an equivalent normalized query retains the session');
    assert.equal(probe.value.selection, selection);
  } finally { await probe.dispose(); }
});

test('hidden in-progress search cancels and resumes without replacing the selected later match with early results', async () => {
  let release!: (value: ReturnType<typeof page>) => void;
  let oldTextReads = 0;
  const requests: number[] = [];
  const pdf = { numPages: 3, async getPage(number: number) {
    requests.push(number);
    if (number === 3 && requests.length === 3) return new Promise<ReturnType<typeof page>>(resolve => { release = resolve; });
    return page(`needle on page ${number}`);
  } } as unknown as PDFDocumentProxy;
  const probe = await harness(pdf);
  try {
    await probe.change(() => { probe.value.setQuery('needle'); probe.value.setOpen(true); });
    await until(() => requests.length === 3 && probe.value.result.matches.length === 2);
    await probe.change(() => probe.value.move(1));
    const selection = probe.value.selection, result = probe.value.result;
    await probe.render(pdf, false);
    assert.equal(probe.value.busy, false);
    await probe.change(() => release({ async getTextContent() { oldTextReads++; return { items: [{ str: 'stale needle', hasEOL: false }] }; } }));
    assert.equal(oldTextReads, 0, 'cancelled getPage work must not extract its text');
    assert.equal(probe.value.result, result);
    assert.equal(probe.value.selection, selection);
    const historyStart = probe.snapshots.length;
    await probe.render(pdf, true);
    await until(() => !probe.value.busy && probe.value.result.matches.length === 3);
    assert.deepEqual(requests, [1, 2, 3, 1, 2, 3]);
    assert.equal(probe.value.result.matches[probe.value.selection.index].pageNumber, 2);
    assert.equal(probe.value.selection.request, selection.request, 'visibility must not issue a navigation request');
    for (const snapshot of probe.snapshots.slice(historyStart)) {
      assert.ok(snapshot.count >= 2, 'early resumed snapshots must not replace later retained results');
      assert.equal(snapshot.selected, 1);
      assert.equal(snapshot.request, selection.request);
    }
  } finally { await probe.dispose(); }
});

test('a new query or PDF clears the old search while hidden and only searches after it becomes visible', async () => {
  const firstCalls: number[] = [], nextCalls: number[] = [];
  const first = proxy(['needle needle'], firstCalls), next = proxy(['different needle'], nextCalls);
  const probe = await harness(first);
  try {
    await probe.change(() => { probe.value.setQuery('needle'); probe.value.setOpen(true); });
    await until(() => !probe.value.busy && probe.value.result.matches.length === 2);
    await probe.change(() => probe.value.move(1));
    const previousRequest = probe.value.selection.request;
    await probe.render(first, false);
    await probe.change(() => probe.value.setQuery('different'));
    assert.equal(probe.value.result.matches.length, 0);
    assert.equal(probe.value.selection.index, -1);
    assert.ok(probe.value.selection.request > previousRequest);
    await probe.render(next, false);
    assert.equal(probe.value.busy, false);
    assert.deepEqual(nextCalls, []);
    await probe.render(next, true);
    await until(() => !probe.value.busy && probe.value.result.matches.length === 1);
    assert.equal(probe.value.selection.index, 0);
    assert.deepEqual(nextCalls, [1]);
    assert.deepEqual(firstCalls, [1]);
  } finally { await probe.dispose(); }
});

test('a selected occurrence that becomes unavailable during resume does not trigger an automatic jump', async () => {
  let release!: (value: ReturnType<typeof page>) => void;
  const requests: number[] = [];
  const pdf = { numPages: 3, async getPage(number: number) {
    requests.push(number);
    if (number === 3 && requests.length === 3) return new Promise<ReturnType<typeof page>>(resolve => { release = resolve; });
    if (number === 2 && requests.length > 3) throw new Error('The second text stream became unavailable.');
    return page(`needle on page ${number}`);
  } } as unknown as PDFDocumentProxy;
  const probe = await harness(pdf);
  try {
    await probe.change(() => { probe.value.setQuery('needle'); probe.value.setOpen(true); });
    await until(() => requests.length === 3 && probe.value.result.matches.length === 2);
    await probe.change(() => probe.value.move(1));
    const request = probe.value.selection.request;
    await probe.render(pdf, false);
    await probe.change(() => release(page('cancelled needle')));
    await probe.render(pdf, true);
    await until(() => !probe.value.busy && probe.value.result.scannedPages === 3);
    assert.deepEqual(probe.value.result.failedPages, [2]);
    assert.equal(probe.value.selection.index, -1);
    assert.equal(probe.value.selection.request, request);
    await probe.change(() => probe.value.move(1));
    assert.equal(probe.value.selection.index, 0, 'explicit Next selects the first remaining occurrence');
    assert.ok(probe.value.selection.request > request);
  } finally { await probe.dispose(); }
});
