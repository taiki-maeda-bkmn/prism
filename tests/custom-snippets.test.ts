import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CompletionContext, nextSnippetField } from '@codemirror/autocomplete';
import { history, undo } from '@codemirror/commands';
import { markdown } from '@codemirror/lang-markdown';
import { Compartment, EditorState, type Transaction } from '@codemirror/state';
import type { EditorView } from '@codemirror/view';
import { customSnippetLimits, parseCustomSnippets, readCustomSnippets, saveCustomSnippets, validateCustomSnippet } from '../src/renderer/customSnippets';
import { customSnippetConfiguration, markdownSnippets, snippetCompletionSource, type MarkdownSnippet } from '../src/renderer/snippets';

const meeting: MarkdownSnippet = { trigger: '/meeting', title: '会議', description: 'Meeting notes', template: '## ${1:議題}\n\n- ${2:決定}\n${0}', block: true };
const inline: MarkdownSnippet = { trigger: '/sign-off', title: 'Signature', description: '', template: 'Thanks, ${1:名前}${0}', block: false };
const stored = (snippets: unknown[]) => JSON.stringify({ version: 1, snippets });

test('validates usable custom shortcuts and rejects collisions with built-ins or custom snippets', () => {
  for (const trigger of ['/meeting', '/sign-off', '/note_2', '/a' + 'b'.repeat(31)]) {
    assert.equal(validateCustomSnippet({ ...meeting, trigger }, []), null, trigger);
  }
  for (const trigger of ['', '/', 'meeting', '/Meeting', '/2note', '/日本語', '/a b', '/a/b', '/a' + 'b'.repeat(32)]) {
    assert.ok(validateCustomSnippet({ ...meeting, trigger }, []), trigger);
  }
  assert.match(validateCustomSnippet({ ...meeting, trigger: '/task' }, [])!, /already in use/);
  assert.match(validateCustomSnippet(meeting, [meeting])!, /already in use/);
});

test('validates template bounds and inline scope without changing Markdown content', () => {
  assert.equal(validateCustomSnippet(inline, []), null);
  for (const change of [
    { title: '  ' }, { title: 'a'.repeat(81) }, { description: 'a'.repeat(241) },
    { template: '\n ' }, { template: 'a'.repeat(customSnippetLimits.template + 1) },
    { template: 'a\0b' }, { block: false },
  ]) assert.ok(validateCustomSnippet({ ...meeting, ...change }, []), JSON.stringify(change));
  assert.equal(validateCustomSnippet({ ...meeting, template: 'a'.repeat(customSnippetLimits.template) }, []), null);
});

test('recovers usable saved snippets without accepting malformed records or duplicate shortcuts', () => {
  for (const serialized of [null, 'broken', 'null', '[]', '{}', JSON.stringify({ version: 2, snippets: [meeting] })]) {
    assert.deepEqual(parseCustomSnippets(serialized), []);
  }
  assert.deepEqual(parseCustomSnippets(stored([
    null, {}, { ...meeting, block: 'yes' }, { ...meeting, template: 8 },
    { ...meeting, trigger: '/task' }, meeting, { ...meeting, template: 'duplicate' }, inline,
  ])), [meeting, inline]);
  const large = Array.from({ length: 105 }, (_, index) => ({ ...meeting, trigger: `/note${index}` }));
  assert.equal(parseCustomSnippets(stored(large)).length, 100);
});

test('normalizes Windows template newlines while preserving indentation, trailing lines and Japanese', () => {
  const template = '## ${1:議題}\r\n\t- ${2:決定}\r\n\r\n${0}\r\n';
  assert.deepEqual(parseCustomSnippets(stored([{ ...meeting, title: ' 会議 ', description: ' Notes ', template }])), [
    { ...meeting, title: '会議', description: 'Notes', template: template.replace(/\r\n/g, '\n') },
  ]);
});

test('persists changes explicitly and reports failed storage without overwriting the last catalog', () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  let serialized = stored([meeting]);
  let fail = false;
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
    getItem(key: string) { assert.equal(key, 'prism.snippets'); return serialized; },
    setItem(key: string, value: string) {
      assert.equal(key, 'prism.snippets');
      if (fail) throw new Error('Storage full');
      serialized = value;
    },
  } });
  try {
    assert.deepEqual(readCustomSnippets(), [meeting]);
    assert.equal(saveCustomSnippets([meeting, inline]), null);
    assert.deepEqual(readCustomSnippets(), [meeting, inline]);
    assert.match(saveCustomSnippets([meeting, meeting])!, /already in use/);
    assert.deepEqual(readCustomSnippets(), [meeting, inline]);
    fail = true;
    assert.match(saveCustomSnippets([])!, /Could not save/);
    assert.deepEqual(readCustomSnippets(), [meeting, inline]);
    fail = false;
    assert.equal(saveCustomSnippets([]), null);
    assert.deepEqual(readCustomSnippets(), []);
  } finally {
    if (descriptor) Object.defineProperty(globalThis, 'localStorage', descriptor);
    else Reflect.deleteProperty(globalThis, 'localStorage');
  }
});

function stateAt(doc: string) {
  return EditorState.create({ doc, selection: { anchor: doc.length }, extensions: [markdown(), markdownSnippets, customSnippetConfiguration.of([meeting, inline])] });
}
const completions = (state: EditorState) => snippetCompletionSource(new CompletionContext(state, state.selection.main.head, false));

test('custom suggestions share built-in context guards and IME protections', () => {
  assert.equal(completions(stateAt('/'))!.options.length, 10);
  assert.deepEqual(completions(stateAt('/mee'))!.options.map(option => option.label), ['/meeting']);
  assert.deepEqual(completions(stateAt('A sentence /sign-'))!.options.map(option => option.label), ['/sign-off']);
  for (const doc of ['A sentence /meeting', '`/sign-off', '```\n/meeting', '[some /sign-off', '<span title="/sign-off']) {
    assert.equal(completions(stateAt(doc)), null, doc);
  }
  const state = stateAt('/meeting');
  const view = { state, compositionStarted: true, composing: false, dispatch() { assert.fail('Must not edit IME composition'); } } as unknown as EditorView;
  assert.equal(snippetCompletionSource(new CompletionContext(state, state.doc.length, false, view)), null);
  const completion = completions(state)!.options[0];
  assert.equal(typeof completion.apply, 'function');
  if (typeof completion.apply === 'function') completion.apply(view, completion, 0, state.doc.length);
});

test('updated catalogs invalidate stale suggestions while retaining note drafts and undo', () => {
  const catalog = new Compartment();
  let state = EditorState.create({ doc: '/meeting', selection: { anchor: 8 }, extensions: [markdown(), markdownSnippets, history(), catalog.of(customSnippetConfiguration.of([meeting]))] });
  const old = completions(state)!.options[0];
  state = state.update({ changes: { from: 0, insert: 'Draft\n\n' } }).state;
  const before = state;
  state = state.update({ effects: catalog.reconfigure(customSnippetConfiguration.of([{ ...meeting, template: 'Updated ${1:field}${0}' }])) }).state;
  assert.equal(state.doc, before.doc);
  assert.ok(state.selection.eq(before.selection));
  const editor = { get state() { return state; }, dispatch(transaction: Transaction) { state = transaction.state; } } as unknown as EditorView;
  if (typeof old.apply === 'function') old.apply(editor, old, 7, state.doc.length);
  assert.equal(state.doc.toString(), 'Draft\n\n/meeting', 'A suggestion from the old catalog cannot insert its removed template.');
  assert.equal(undo(editor), true);
  assert.equal(state.doc.toString(), '/meeting');
  const updated = completions(state)!.options[0];
  if (typeof updated.apply === 'function') updated.apply(editor, updated, 0, state.doc.length);
  assert.equal(state.doc.toString(), 'Updated field');
  assert.equal(state.sliceDoc(state.selection.main.from, state.selection.main.to), 'field');
  assert.equal(nextSnippetField(editor), true);
  assert.equal(state.selection.main.head, state.doc.length);
  state = state.update({ effects: catalog.reconfigure(customSnippetConfiguration.of([])), changes: { from: 0, to: state.doc.length, insert: '/meeting' }, selection: { anchor: 8 } }).state;
  assert.equal(completions(state), null);
});
