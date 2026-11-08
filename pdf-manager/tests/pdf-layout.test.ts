import test from 'node:test';
import assert from 'node:assert/strict';
import { defaultPDFLayout, moreReadingSpace, parsePDFLayout, serializePDFLayout } from '../src/renderer/pdfLayout';

test('missing, damaged, and future layout settings keep the PDF workspace usable', () => {
  for (const raw of [null, '', '{broken', 'null', '[]', 'false', '7', '{}', '{"version":2,"toolbar":false}', '{"version":"1","sidebar":false}']) {
    const result = parsePDFLayout(raw);
    assert.deepEqual(result, defaultPDFLayout);
    assert.notEqual(result, defaultPDFLayout);
  }
});

test('saved hidden sections and a custom sidebar width survive a restart', () => {
  const layout = { ...defaultPDFLayout, sidebarWidth: 307, heading: false, footer: false, compact: true };
  assert.deepEqual(parsePDFLayout(serializePDFLayout(layout)), layout);
  assert.equal(JSON.parse(serializePDFLayout(layout)).version, 1);
});

test('invalid individual fields cannot hide controls or introduce unusable widths', () => {
  const result = parsePDFLayout(JSON.stringify({
    version: 1, sidebar: 'false', search: 0, heading: false, toolbar: null,
    backlinks: [], footer: {}, compact: 'true', sidebarWidth: '300', unknown: false,
  }));
  assert.deepEqual(result, { ...defaultPDFLayout, heading: false });
  for (const [sidebarWidth, expected] of [[0, 180], [10000, 420], [307.6, 308], [null, 228]] as const) {
    assert.equal(parsePDFLayout(JSON.stringify({ version: 1, sidebarWidth })).sidebarWidth, expected);
  }
  assert.equal(parsePDFLayout('{"version":1,"sidebarWidth":1e999}').sidebarWidth, 228);
});

test('more reading space preserves preferred width and always retains page controls', () => {
  const before = { ...defaultPDFLayout, sidebarWidth: 333, toolbar: false };
  const snapshot = { ...before };
  const result = moreReadingSpace(before);
  assert.deepEqual(result, {
    sidebar: false, sidebarWidth: 333, search: false, heading: false,
    toolbar: true, backlinks: false, footer: false, compact: true, pageOpacity: 100,
  });
  assert.deepEqual(before, snapshot);
  assert.deepEqual(parsePDFLayout(serializePDFLayout(result)), result);
  const fresh = parsePDFLayout(null);
  fresh.sidebar = false;
  assert.equal(defaultPDFLayout.sidebar, true);
});

test('page opacity migrates old layouts safely and rejects malformed saved values', () => {
  assert.equal(parsePDFLayout('{"version":1,"heading":false}').pageOpacity, 100);
  for (const pageOpacity of ['50', null, true, {}, []]) {
    assert.equal(parsePDFLayout(JSON.stringify({ version: 1, pageOpacity })).pageOpacity, 100);
  }
  assert.equal(parsePDFLayout('{"version":1,"pageOpacity":1e999}').pageOpacity, 100);
  for (const [pageOpacity, expected] of [[0, 25], [101, 100], [57.8, 58]]) {
    assert.equal(parsePDFLayout(JSON.stringify({ version: 1, pageOpacity })).pageOpacity, expected);
  }
  const layout = { ...defaultPDFLayout, pageOpacity: 43 };
  assert.deepEqual(parsePDFLayout(serializePDFLayout(layout)), layout);
  assert.equal(moreReadingSpace(layout).pageOpacity, 43);
});
