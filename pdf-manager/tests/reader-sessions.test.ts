import assert from 'node:assert/strict';
import test from 'node:test';
import { retainedPDFReaders } from '../src/renderer/readerSessions';

test('restored PDF tabs stay unloaded until selected and library navigation retains readers', () => {
  const open = ['a', 'b', 'c', 'd'];
  assert.deepEqual(retainedPDFReaders([], open, null), []);
  const selected = retainedPDFReaders([], open, 'c');
  assert.deepEqual(selected, ['c']);
  assert.equal(retainedPDFReaders(selected, open, null), selected);
  assert.equal(retainedPDFReaders(selected, open, 'c'), selected);
});

test('PDF reader retention evicts the least recently selected session at three readers', () => {
  const open = ['a', 'b', 'c', 'd'];
  const recent = retainedPDFReaders(['a', 'b', 'c'], open, 'a');
  assert.deepEqual(recent, ['b', 'c', 'a']);
  assert.deepEqual(retainedPDFReaders(recent, open, 'd'), ['c', 'a', 'd']);
});

test('closed and removed PDF tabs cannot retain or recreate a reader', () => {
  assert.deepEqual(retainedPDFReaders(['a', 'b', 'c'], ['a', 'c'], 'b'), ['a', 'c']);
  assert.deepEqual(retainedPDFReaders(['a', 'b', 'c'], [], null), []);
});
