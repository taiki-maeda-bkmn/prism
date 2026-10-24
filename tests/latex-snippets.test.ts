import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CompletionContext, nextSnippetField } from '@codemirror/autocomplete';
import { history, undo } from '@codemirror/commands';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { EditorState, type Transaction } from '@codemirror/state';
import type { EditorView } from '@codemirror/view';
import { customSnippetConfiguration, findSnippetContext, markdownSnippets, snippetCompletionSource, type MarkdownSnippet } from '../src/renderer/snippets';

const widehat: MarkdownSnippet = { trigger: '/widehat', title: 'Wide hat', description: '', template: '\\widehat{${1:x}}${0}', block: false };
const screenshot = '$$\n\\begin{aligned}\n\\mathbb{E}[(/widehat¦)]';
const ending = '\n\\end{aligned}\n$$';

function stateAt(marked: string, block = false) {
  const anchor = marked.indexOf('¦');
  assert.notEqual(anchor, -1);
  return EditorState.create({
    doc: marked.replace('¦', ''), selection: { anchor },
    extensions: [markdown({ base: markdownLanguage }), markdownSnippets, history(), customSnippetConfiguration.of([{ ...widehat, block }])],
  });
}
const completions = (state: EditorState) => snippetCompletionSource(new CompletionContext(state, state.selection.main.head, false));

test('offers the screenshot shortcut inside LaTeX brackets before and after completing the equation', () => {
  for (const doc of [screenshot, screenshot + ending, screenshot.replace('\\mathbb', '    \\mathbb') + ending]) {
    const state = stateAt(doc);
    assert.equal(findSnippetContext(state)?.inMath, true, doc);
    assert.deepEqual(completions(state)?.options.map(option => option.label), ['/widehat']);
  }
});

test('recognizes custom shortcuts in complete and unfinished dollar and backslash equations', () => {
  for (const [open, close] of [['$', '$'], ['$$', '$$'], ['\\(', '\\)'], ['\\[', '\\]']]) {
    for (const suffix of ['', close]) {
      for (const tex of ['\\mathbb{E}[(/widehat¦)]', '\\frac{/widehat¦}{2}', 'x+/widehat¦y']) {
        const state = stateAt(`${open}${tex}${suffix}`);
        assert.equal(findSnippetContext(state)?.inMath, true, `${open}${tex}${suffix}`);
        assert.equal(completions(state)?.options[0].label, '/widehat');
      }
    }
  }
});

test('inserts saved custom block templates into math without adding Markdown block separators', () => {
  for (const block of [false, true]) {
    let state = stateAt(screenshot + ending, block);
    const original = state.doc.toString();
    const context = findSnippetContext(state)!;
    const completion = completions(state)!.options[0];
    const editor = { get state() { return state; }, dispatch(transaction: Transaction) { state = transaction.state; } } as unknown as EditorView;
    assert.equal(typeof completion.apply, 'function');
    if (typeof completion.apply === 'function') completion.apply(editor, completion, context.from, context.to);
    assert.equal(state.doc.toString(), original.replace('/widehat', '\\widehat{x}'));
    assert.equal(state.doc.lines, 5);
    assert.equal(state.sliceDoc(state.selection.main.from, state.selection.main.to), 'x');
    assert.equal(nextSnippetField(editor), true);
    assert.equal(state.sliceDoc(state.selection.main.head, state.selection.main.head + 2), ')]');
    assert.equal(undo(editor), true);
    assert.equal(state.doc.toString(), original);
  }
});

test('prefix suggestions and builtin block restrictions use the same math context', () => {
  const partial = stateAt(screenshot.replace('/widehat', '/wid'));
  assert.deepEqual(completions(partial)?.options.map(option => option.label), ['/widehat']);
  for (const trigger of ['/h1', '/task', '/code', '/table']) {
    assert.equal(completions(stateAt(screenshot.replace('/widehat', trigger))), null, trigger);
  }
});

test('math expansion preserves literal escaped shortcuts and incomplete trigger suffixes', () => {
  assert.equal(completions(stateAt('$x+/wid¦ehat$')), null);
  assert.equal(completions(stateAt('$\\/widehat¦$')), null);
  assert.equal(completions(stateAt('$x+/widehat¦y$'))?.options[0].label, '/widehat');
});

test('math-like text in real code, HTML, or Markdown links does not enable snippets', () => {
  for (const doc of [
    '`$\\mathbb{E}[(/widehat¦)]$`',
    '```tex\n' + screenshot + ending + '\n```',
    '    $x+/widehat¦$',
    '<div>\n' + screenshot + ending + '\n</div>',
    'Some <span title="$x+/widehat¦$">text</span>',
    '[label $x+/widehat¦$](target.md)',
    '[unfinished $x+/widehat¦$',
    '[label](https://example.org/$x+/widehat¦$)',
    '[[note $x+/widehat¦$]]',
    '$$\n```tex\n/widehat¦\n```',
    'https://example.org/$x/widehat¦$',
    '\\$\\mathbb{E}[(/widehat¦)]',
  ]) assert.equal(completions(stateAt(doc)), null, doc);
});

test('closing equations and ordinary currency do not leave math context enabled', () => {
  for (const doc of ['$a$ 日本語 /widehat¦', '$a$日本語/widehat¦続き$b$', '$5 and $10 /widehat¦', '$x\nText /widehat¦']) {
    assert.equal(findSnippetContext(stateAt(doc))?.inMath, false, doc);
  }
  assert.equal(findSnippetContext(stateAt('$5+/widehat¦$'))?.inMath, true);
});

test('math context stays responsive in large notes and ignores distant or oversized openers', () => {
  for (const doc of [
    'Ordinary prose.\n\n'.repeat(100_000) + screenshot + ending,
    '\\(a '.repeat(4_900) + ' /widehat¦',
  ]) {
    const state = stateAt(doc);
    const start = performance.now();
    // The editor parser may need additional work on first access to a large note.
    // A second lookup must still avoid quadratic delimiter/path searches.
    findSnippetContext(state);
    findSnippetContext(state);
    assert.ok(performance.now() - start < 1_500, 'Snippet detection must remain responsive.');
  }
  const large = stateAt('$$\n' + 'a'.repeat(20_010) + ' /widehat¦');
  assert.equal(findSnippetContext(large)?.inMath, false);
});
