import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CompletionContext, nextSnippetField, prevSnippetField, snippet } from '@codemirror/autocomplete';
import { markdown } from '@codemirror/lang-markdown';
import { EditorSelection, EditorState, type Transaction } from '@codemirror/state';
import type { EditorView } from '@codemirror/view';
import { dismissSnippets, expandSnippet, findSnippetContext, markdownSnippets, snippetCatalog, snippetCompletionSource } from '../src/renderer/snippets';

function stateAt(marked: string) {
  const anchor = marked.replace(/\r\n?/g, '\n').indexOf('¦');
  assert.notEqual(anchor, -1, 'Test input needs a cursor marker.');
  return EditorState.create({
    doc: marked.replace('¦', ''),
    selection: { anchor },
    extensions: [markdown(), markdownSnippets, EditorState.allowMultipleSelections.of(true)],
  });
}

function completions(state: EditorState) {
  return snippetCompletionSource(new CompletionContext(state, state.selection.main.head, false));
}

test('offers the built-in Markdown catalog and narrows slash prefixes', () => {
  assert.deepEqual(snippetCatalog.map(item => item.trigger).sort(), ['/code', '/h1', '/h2', '/link', '/quote', '/table', '/task', '/wiki']);
  assert.equal(new Set(snippetCatalog.map(item => item.trigger)).size, snippetCatalog.length);
  assert.deepEqual(completions(stateAt('/¦'))?.options.map(item => item.label).sort(), snippetCatalog.map(item => item.trigger).sort());
  assert.deepEqual(completions(stateAt('/h¦'))?.options.map(item => item.label).sort(), ['/h1', '/h2']);
  assert.deepEqual(completions(stateAt('/ta¦'))?.options.map(item => item.label).sort(), ['/table', '/task']);
  assert.equal(completions(stateAt('/unknown¦')), null);
  assert.equal(completions(stateAt('ordinary text¦')), null);
});

test('allows block snippets only on otherwise blank lines with up to three leading spaces', () => {
  for (const indentation of ['', ' ', '  ', '   ']) {
    const state = stateAt(`# A note\n\n${indentation}/h1¦`);
    const context = findSnippetContext(state);
    assert.ok(context, JSON.stringify(indentation));
    assert.equal(context.block, true);
    assert.equal(state.sliceDoc(context.from, context.to), '/h1');
    assert.deepEqual(completions(state)?.options.map(item => item.label), ['/h1']);
  }
  for (const input of ['Text /h1¦', '- /h1¦', '> /h1¦', '    /h1¦', '\t/h1¦', '/h1¦ existing text']) {
    assert.equal(completions(stateAt(input)), null, input);
  }
});

test('allows link and wiki snippets at whitespace boundaries in prose', () => {
  for (const trigger of ['/link', '/wiki']) {
    const state = stateAt(`A sentence ${trigger}¦ with more text.`);
    const context = findSnippetContext(state);
    assert.ok(context);
    assert.equal(context.block, false);
    assert.deepEqual(completions(state)?.options.map(item => item.label), [trigger]);
  }
  assert.deepEqual(completions(stateAt('A sentence /¦'))?.options.map(item => item.label).sort(), ['/link', '/wiki']);
  for (const input of [
    'Some <span title=">">text</span> /link¦',
    "Some <span title='>'>text</span> /link¦",
    'Some <!-- > comment --> /link¦',
    'Some <![CDATA[ > text ]]> /link¦',
    'Some <? > instruction ?> /link¦',
    'Some ``a`b`` /link¦',
  ]) {
    assert.deepEqual(completions(stateAt(input))?.options.map(item => item.label), ['/link'], input);
  }
});

test('does not interpret snippets inside code, links, HTML, escaped text, or words', () => {
  const guarded = [
    '```md\n/h1¦\n```',
    '```\n/link¦',
    '~~~\n/wiki¦\n~~~',
    '    /link¦',
    '`/link¦`',
    '`unfinished /wiki¦',
    '[label /link¦](target.md)',
    '[unfinished /link¦',
    '[label](target /wiki¦)',
    '![image /link¦](image.png)',
    '[[Some /wiki¦]]',
    '[[unfinished /link¦',
    '<span title="/link¦">text</span>',
    '<span title="some /link¦',
    'Some <span title="> /link¦',
    "Some <span title='> /link¦",
    'Some <!-- > /link¦',
    'Some <![CDATA[ > /link¦',
    'Some <? > /link¦',
    '<!-- /wiki¦ -->',
    '<div>\n/link¦\n</div>',
    'word/link¦',
    'https://example.com/link¦',
    '\\/link¦',
    '/link¦er',
    '/li¦nk',
  ];
  for (const input of guarded) {
    assert.equal(completions(stateAt(input)), null, input);
  }
});

test('never replaces selected text or expands at multiple cursors', () => {
  const original = stateAt('/h1¦\n/link');
  const selected = original.update({ selection: EditorSelection.single(0, 3) }).state;
  const multiple = original.update({ selection: EditorSelection.create([
    EditorSelection.cursor(3), EditorSelection.cursor(original.doc.length),
  ]) }).state;
  assert.equal(findSnippetContext(selected), null);
  assert.equal(completions(selected), null);
  assert.equal(findSnippetContext(multiple), null);
  assert.equal(completions(multiple), null);
});

test('leaves IME composition untouched before and after composition text arrives', () => {
  const state = stateAt('/link¦');
  const completion = completions(state)!.options[0];
  assert.equal(typeof completion.apply, 'function');
  for (const phase of [
    { compositionStarted: true, composing: false },
    { compositionStarted: true, composing: true },
  ]) {
    // A command may inspect composition flags, but must not dispatch while the
    // OS input method owns the text—even before it has inserted its first text.
    const view = { state, ...phase, dispatch() { assert.fail('Composition must not be changed by a snippet.'); } } as unknown as EditorView;
    assert.equal(snippetCompletionSource(new CompletionContext(state, state.doc.length, false, view)), null);
    assert.equal(expandSnippet(view), false);
    assert.equal(dismissSnippets(view), false);
    if (typeof completion.apply === 'function') completion.apply(view, completion, 0, state.doc.length);
  }
});

test('link placeholders support forward and reverse navigation before the final caret', () => {
  let state = stateAt('Read /link¦');
  const editor = { get state() { return state; }, dispatch(transaction: Transaction) { state = transaction.state; } };
  const definition = snippetCatalog.find(item => item.trigger === '/link')!;
  snippet(definition.template)(editor, null, 5, state.doc.length);
  assert.match(state.doc.toString(), /^Read \[.+\]\(.+\)$/);
  const first = state.sliceDoc(state.selection.main.from, state.selection.main.to);
  assert.ok(first.length > 0, 'The link label starts selected.');
  assert.equal(nextSnippetField(editor), true);
  const second = state.sliceDoc(state.selection.main.from, state.selection.main.to);
  assert.ok(second.length > 0, 'The destination is the next editable field.');
  assert.notEqual(second, first);
  assert.equal(prevSnippetField(editor), true);
  assert.equal(state.sliceDoc(state.selection.main.from, state.selection.main.to), first);
  assert.equal(nextSnippetField(editor), true);
  assert.equal(nextSnippetField(editor), true);
  assert.equal(state.selection.main.empty, true);
  assert.equal(state.selection.main.head, state.doc.length);
  assert.equal(nextSnippetField(editor), false, 'Tab is free after the final caret.');
});

test('multiline snippets retain indentation and serialize with a Windows note’s line endings', () => {
  let state = stateAt('# Windows\r\n\r\n  /code¦');
  const editor = { get state() { return state; }, dispatch(transaction: Transaction) { state = transaction.state; } };
  const definition = snippetCatalog.find(item => item.trigger === '/code')!;
  const context = findSnippetContext(state)!;
  snippet(definition.template)(editor, null, context.from, context.to);
  const saved = state.doc.sliceString(0, state.doc.length, '\r\n');
  assert.match(saved, /^# Windows\r\n\r\n  ```[^\r\n]*\r\n  [^\r\n]*\r\n  ```/);
  assert.equal(saved.replace(/\r\n/g, '').includes('\n'), false);
});
