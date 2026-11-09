import test from 'node:test';
import assert from 'node:assert/strict';
import {
  defaultMarkdownLayout, markdownLayoutStorageKey, moreWritingSpace, parseMarkdownLayout, serializeMarkdownLayout,
  type MarkdownLayout,
} from '../src/renderer/markdownLayout';

test('missing, damaged, and future settings leave the Markdown controls visible', () => {
  for (const raw of [null, '', '{broken', 'null', '[]', 'false', '7', '{}', '{"version":2,"heading":false}', '{"version":"1","heading":false}']) {
    const result = parseMarkdownLayout(raw);
    assert.deepEqual(result, defaultMarkdownLayout);
    assert.notEqual(result, defaultMarkdownLayout);
  }
});

test('hidden sections and compact spacing survive a preference round trip', () => {
  const layout: MarkdownLayout = {
    heading: false, paneLabels: false, saveNotifications: false, compact: true, topicTools: false,
  };
  const serialized = serializeMarkdownLayout(layout);
  assert.equal(markdownLayoutStorageKey, 'prism.markdown-layout');
  assert.equal(JSON.parse(serialized).version, 1);
  assert.deepEqual(parseMarkdownLayout(serialized), layout);
  assert.deepEqual(parseMarkdownLayout(serializeMarkdownLayout({ ...defaultMarkdownLayout })), defaultMarkdownLayout);
});

test('invalid individual fields fall back independently without coercion', () => {
  for (const invalid of ['false', 'true', 0, 1, null, [], {}]) {
    const result = parseMarkdownLayout(JSON.stringify({
      version: 1, heading: invalid, paneLabels: invalid, saveNotifications: invalid, compact: invalid, topicTools: invalid,
    }));
    assert.deepEqual(result, defaultMarkdownLayout);
  }
  assert.deepEqual(parseMarkdownLayout('{"version":1,"heading":false,"compact":true,"topicTools":"false","unknown":false}'), {
    ...defaultMarkdownLayout, heading: false, compact: true,
  });
  assert.deepEqual(parseMarkdownLayout('{"version":1,"paneLabels":false}'), {
    ...defaultMarkdownLayout, paneLabels: false,
  });
});

test('serialization sanitizes unexpected runtime values and omits unknown fields', () => {
  const malformed = { heading: false, paneLabels: 'false', compact: null, extra: 'discard' } as unknown as MarkdownLayout;
  assert.deepEqual(JSON.parse(serializeMarkdownLayout(malformed)), {
    version: 1, ...defaultMarkdownLayout, heading: false,
  });
});

test('more writing space and reset values do not mutate current or default settings', () => {
  const before = { ...defaultMarkdownLayout };
  const snapshot = { ...before };
  const result = moreWritingSpace(before);
  assert.deepEqual(result, {
    heading: false, paneLabels: false, saveNotifications: false, compact: true, topicTools: false,
  });
  assert.notEqual(result, before);
  assert.deepEqual(before, snapshot);
  assert.deepEqual(parseMarkdownLayout(serializeMarkdownLayout(result)), result);
  const fresh = parseMarkdownLayout(null);
  fresh.heading = false;
  assert.equal(defaultMarkdownLayout.heading, true);
  assert.equal(parseMarkdownLayout(null).heading, true);
  assert.equal(Object.isFrozen(defaultMarkdownLayout), true);
});
