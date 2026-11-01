import assert from 'node:assert/strict';
import test from 'node:test';
import type { PDFDocument } from '../src/shared/types';
import { mergeFolderSnapshotDocuments } from '../src/renderer/folderSnapshots';

const pdf = (id: string, patch: Partial<PDFDocument> = {}): PDFDocument => ({
  id, title: id, filename: `${id}.pdf`, size: 10, sha256: id,
  importedAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
  tags: ['Research'], favorite: true, lastOpenedAt: null, lastPage: 4,
  pageCount: 10, ...patch,
});
const none = new Map<string, number>();

test('a late refresh preserves a completed folder move and title, tag, and reading edits', () => {
  const original = pdf('a');
  const moved = pdf('a', { folderId: 'execution', title: '約定資料', tags: ['Rates'], lastPage: 7 });
  const result = mergeFolderSnapshotDocuments([moved], [original], none, new Map([['a', 2]]), new Set(['execution']));
  assert.deepEqual(result, [moved]);
});

test('removing a folder unfiles a PDF while retaining a newer reading edit', () => {
  const reading = pdf('a', { folderId: 'execution', lastPage: 9, lastOpenedAt: '2026-01-02T00:00:00Z' });
  const result = mergeFolderSnapshotDocuments([reading], [pdf('a')], none, new Map([['a', 1]]), new Set());
  assert.deepEqual(result, [pdf('a', { lastPage: 9, lastOpenedAt: reading.lastOpenedAt })]);
  assert.equal(reading.folderId, 'execution', 'does not mutate the prior state');
});

test('an older catalogue cannot resurrect removed folder membership', () => {
  const result = mergeFolderSnapshotDocuments([pdf('a')], [pdf('a', { folderId: 'removed' })], none, none, new Set(['other']));
  assert.equal(result[0].folderId, undefined);
  assert.deepEqual(result[0].tags, ['Research']);
  assert.equal(result[0].favorite, true);
  assert.equal(result[0].lastPage, 4);
});

test('a refresh retains new imports and does not resurrect a removed PDF', () => {
  const result = mergeFolderSnapshotDocuments([pdf('new')], [pdf('removed')], none, new Map([['new', 1], ['removed', 1]]), new Set());
  assert.deepEqual(result, [pdf('new')]);
});

test('a remove response wins over its target edits but retains unrelated changes', () => {
  const current = [pdf('removed', { lastPage: 8 }), pdf('kept', { folderId: 'execution', title: 'New title' })];
  const result = mergeFolderSnapshotDocuments(current, [pdf('removed'), pdf('kept')], none, new Map([['removed', 1], ['kept', 1]]), new Set(['execution']), 'removed');
  assert.deepEqual(result, [current[1]]);
});
