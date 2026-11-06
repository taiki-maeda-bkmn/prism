import assert from 'node:assert/strict';
import test from 'node:test';
import { EditorSelection, EditorState, StateEffect, Transaction, type StateCommand } from '@codemirror/state';
import { history, isolateHistory, redo, redoDepth, undo, undoDepth } from '@codemirror/commands';
import { EditorSessions, editorHistoryFields } from '../src/renderer/editorSessions';

const extensions = [history(), EditorState.allowMultipleSelections.of(true)];
const stateFor = (content: string) => EditorState.create({ doc: content, extensions });
const text = (state: EditorState, lineEnding = '\n') => state.doc.sliceString(0, state.doc.length, lineEnding);
const replace = (state: EditorState, content: string) => state.update({
  changes: { from: 0, to: state.doc.length, insert: content },
  annotations: [Transaction.userEvent.of('input'), isolateHistory.of('full')],
}).state;
function run(state: EditorState, command: StateCommand): EditorState {
  let result = state;
  assert.equal(command({ state, dispatch: transaction => { result = transaction.state; } }), true);
  return result;
}
function restore(sessions: EditorSessions, path: string, content: string) {
  const snapshot = sessions.restore(path, sessions.generation, content);
  assert.ok(snapshot, 'An unchanged note has a cached editing session.');
  return { snapshot, state: EditorState.fromJSON(snapshot.json, { extensions }, editorHistoryFields) };
}

test('different notes retain independent undo, redo, multiple selections, and scroll targets', () => {
  const sessions = new EditorSessions();
  const initialA = stateFor('First note');
  let a = replace(initialA, '日本語の first draft');
  a = replace(a, '日本語の second draft');
  a = run(a, undo);
  a = a.update({ selection: EditorSelection.create([EditorSelection.range(0, 3), EditorSelection.cursor(8)], 1) }).state;
  const b = replace(stateFor('Second note'), 'Another draft');
  const scroll = StateEffect.define<number>().of(170);
  assert.equal(sessions.capture('A.md', 0, a, '\n', scroll), true);
  assert.equal(sessions.capture('B.md', 0, b, '\n'), true);
  const restoredA = restore(sessions, 'A.md', text(a));
  assert.equal(restoredA.snapshot.scrollTo, scroll);
  assert.deepEqual(restoredA.state.selection.toJSON(), a.selection.toJSON());
  assert.equal(undoDepth(restoredA.state), 1);
  assert.equal(redoDepth(restoredA.state), 1);
  assert.equal(text(run(restoredA.state, redo)), '日本語の second draft');
  assert.equal(text(run(restoredA.state, undo)), 'First note');
  assert.equal(text(run(restore(sessions, 'B.md', text(b)).state, undo)), 'Second note');
  assert.equal(sessions.size, 0, 'Restoring consumes inactive entries.');
  assert.equal(sessions.retainedBytes, 0);
});

test('redo survives a return to the exact original text and saved drafts remain undoable', () => {
  const sessions = new EditorSessions();
  const changed = replace(stateFor('Original'), 'Saved draft');
  assert.equal(sessions.capture('Saved.md', 0, changed, '\n'), true);
  const saved = restore(sessions, 'Saved.md', 'Saved draft').state;
  assert.equal(text(run(saved, undo)), 'Original');
  const reverted = run(changed, undo);
  assert.equal(sessions.capture('Redo.md', 0, reverted, '\n'), true);
  const restored = restore(sessions, 'Redo.md', 'Original').state;
  assert.equal(undoDepth(restored), 0);
  assert.equal(text(run(restored, redo)), 'Saved draft');
});

test('accepted refresh or notebook replacement clears both histories and rejects late cleanup', () => {
  const sessions = new EditorSessions();
  const originalGeneration = sessions.generation;
  const changed = replace(stateFor('Same content'), 'Draft');
  sessions.capture('Same.md', originalGeneration, changed, '\n');
  sessions.capture('Redo.md', originalGeneration, run(changed, undo), '\n');
  sessions.clear();
  assert.equal(sessions.generation, originalGeneration + 1);
  assert.equal(sessions.size, 0);
  assert.equal(sessions.retainedBytes, 0);
  assert.equal(sessions.restore('Same.md', sessions.generation, 'Draft'), undefined);
  assert.equal(sessions.restore('Redo.md', sessions.generation, 'Same content'), undefined);
  const newNote = replace(stateFor('New notebook'), 'Draft');
  sessions.capture('Same.md', sessions.generation, newNote, '\n');
  assert.equal(sessions.capture('Same.md', originalGeneration, changed, '\n'), false);
  assert.equal(sessions.restore('Same.md', originalGeneration, 'Draft'), undefined);
  assert.equal(text(run(restore(sessions, 'Same.md', 'Draft').state, undo)), 'New notebook');
});

test('external content, BOM, or newline changes invalidate a cached session permanently', () => {
  for (const different of ['External revision\r\n', 'Same\ntext\n', '\ufeffSame\r\ntext\r\n']) {
    const sessions = new EditorSessions();
    const current = replace(stateFor('Before'), 'Same\r\ntext\r\n');
    sessions.capture('Note.md', 0, current, '\r\n');
    assert.equal(sessions.restore('Note.md', 0, different), undefined);
    assert.equal(sessions.restore('Note.md', 0, 'Same\r\ntext\r\n'), undefined);
    assert.equal(sessions.retainedBytes, 0);
  }
});

test('Japanese BOM/CRLF content and the newline convention survive a draft without line breaks', () => {
  const sessions = new EditorSessions();
  const original = '\ufeff# 日本語\r\n\r\n元の内容\r\n';
  const oneLine = replace(stateFor(original), '\ufeff一行の下書き');
  assert.equal(sessions.capture('日本語.md', 0, oneLine, '\r\n'), true);
  const restored = restore(sessions, '日本語.md', '\ufeff一行の下書き');
  assert.equal(restored.snapshot.lineEnding, '\r\n');
  assert.equal(text(run(restored.state, undo), restored.snapshot.lineEnding), original);
  const withNewLine = restored.state.update({ changes: { from: restored.state.doc.length, insert: '\n追加' } }).state;
  assert.equal(text(withNewLine, restored.snapshot.lineEnding), '\ufeff一行の下書き\r\n追加');
});

test('recently returned notes survive entry eviction without changing authoritative drafts', () => {
  const sessions = new EditorSessions({ entries: 2, bytes: 64_000, entryBytes: 32_000 });
  const drafts = { 'A.md': 'Draft A', 'B.md': 'Draft B', 'C.md': 'Draft C' };
  for (const path of ['A.md', 'B.md'] as const) sessions.capture(path, 0, replace(stateFor(path), drafts[path]), '\n');
  const a = restore(sessions, 'A.md', drafts['A.md']).state;
  sessions.capture('A.md', 0, a, '\n');
  sessions.capture('C.md', 0, replace(stateFor('C.md'), drafts['C.md']), '\n');
  assert.equal(sessions.size, 2);
  assert.equal(sessions.restore('B.md', 0, drafts['B.md']), undefined);
  assert.equal(text(run(restore(sessions, 'A.md', drafts['A.md']).state, undo)), 'A.md');
  assert.equal(text(run(restore(sessions, 'C.md', drafts['C.md']).state, undo)), 'C.md');
  assert.deepEqual(drafts, { 'A.md': 'Draft A', 'B.md': 'Draft B', 'C.md': 'Draft C' });
});

test('aggregate payload budget evicts oldest entries independently of the note-count limit', () => {
  const state = replace(stateFor('Original'), 'Draft '.repeat(100));
  const measured = new EditorSessions();
  measured.capture('A.md', 0, state, '\n');
  const entryBytes = measured.retainedBytes;
  const sessions = new EditorSessions({ entries: 20, bytes: entryBytes * 2 + 10, entryBytes: entryBytes * 2 + 10 });
  for (const path of ['A.md', 'B.md', 'C.md']) assert.equal(sessions.capture(path, 0, state, '\n'), true);
  assert.equal(sessions.size, 2);
  assert.ok(sessions.retainedBytes <= entryBytes * 2 + 10);
  assert.equal(sessions.restore('A.md', 0, text(state)), undefined);
  assert.ok(sessions.restore('B.md', 0, text(state)));
  assert.ok(sessions.restore('C.md', 0, text(state)));
  assert.equal(sessions.retainedBytes, 0);
});

test('oversized current documents skip serialization and oversized hidden undo payloads are not retained', () => {
  const sessions = new EditorSessions({ entries: 20, bytes: 8_000, entryBytes: 4_000 });
  const huge = stateFor('大'.repeat(10_000));
  let serialized = false;
  Object.defineProperty(huge, 'toJSON', { value() { serialized = true; throw new Error('Should be skipped before serialization'); } });
  assert.equal(sessions.capture('Large.md', 0, huge, '\n'), false);
  assert.equal(serialized, false);
  const compact = replace(stateFor('大'.repeat(10_000)), 'Small current draft');
  assert.equal(sessions.capture('Small.md', 0, compact, '\n'), false);
  assert.equal(text(compact), 'Small current draft');
  assert.equal(undoDepth(compact), 1, 'Evicting an inactive snapshot does not change active state.');
  assert.equal(sessions.retainedBytes, 0);
});

test('JSON escape expansion is bounded and replacing an oversized entry removes its previous snapshot', () => {
  const sessions = new EditorSessions({ entries: 20, bytes: 8_000, entryBytes: 4_000 });
  sessions.capture('Same.md', 0, stateFor('First'), '\n');
  assert.equal(sessions.capture('Same.md', 0, stateFor('\0'.repeat(1000)), '\n'), false);
  assert.equal(sessions.restore('Same.md', 0, 'First'), undefined);
  assert.equal(sessions.retainedBytes, 0);
});
