import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import { history, undo } from '@codemirror/commands';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { Compartment, EditorSelection, EditorState } from '@codemirror/state';
import { type EditorView, type WidgetType } from '@codemirror/view';
import { buildLiveDecorations, findLiveHeading } from '../src/renderer/liveMarkdown';
import { getLiveMathRanges, liveMath, liveMathState } from '../src/renderer/liveMath';

function stateFor(doc: string, selection = EditorSelection.cursor(doc.length)) {
  return EditorState.create({
    doc, selection: EditorSelection.create([selection]),
    extensions: [markdown({ base: markdownLanguage }), liveMathState, EditorState.allowMultipleSelections.of(true)],
  });
}

function formulas(state: EditorState) {
  const found: Array<{ from: number; to: number; block: boolean; widget: WidgetType }> = [];
  state.field(liveMathState).decorations.between(0, state.doc.length, (from, to, value) => {
    found.push({ from, to, block: value.spec.block === true, widget: value.spec.widget });
  });
  return found;
}

test('Live math renders inline and multiline formulas through direct state decorations without changing source', () => {
  const doc = '\ufeffInline $x^2$ and \\(y_1\\).\n\n$$\n\\frac{1}{2}\n$$\n\n\\[a+b\\]\n\nCaret';
  const state = stateFor(doc);
  const result = formulas(state);
  assert.deepEqual(result.map(range => state.sliceDoc(range.from, range.to)), ['$x^2$', '\\(y_1\\)', '$$\n\\frac{1}{2}\n$$', '\\[a+b\\]']);
  assert.deepEqual(result.map(range => range.block), [false, false, true, true]);
  assert.equal(state.doc.toString(), doc);
  assert.equal(state.selection.main.head, doc.length);
});

test('caret, reversed selections, and multiple selections reveal exact TeX source for every touched line', () => {
  const doc = 'Inline $x^2$ and $y^3$.\n\n$$\na+b\nc+d\n$$\n\nAfter $z$.\n\nCaret';
  const state = stateFor(doc);
  assert.equal(formulas(state).length, 4);
  const inline = state.update({ selection: { anchor: doc.indexOf('Inline') } }).state;
  assert.equal(formulas(inline).length, 2, 'A caret anywhere on an inline formula line reveals that line.');
  const block = state.update({ selection: { anchor: doc.indexOf('c+d') + 1 } }).state;
  assert.deepEqual(formulas(block).map(range => range.block), [false, false, false]);
  const reverse = state.update({ selection: { anchor: doc.indexOf('After'), head: doc.indexOf('x^2') } }).state;
  assert.equal(formulas(reverse).length, 0);
  const multiple = state.update({ selection: EditorSelection.create([
    EditorSelection.cursor(doc.indexOf('x^2')), EditorSelection.cursor(doc.indexOf('z')),
  ]) }).state;
  assert.deepEqual(formulas(multiple).map(range => range.block), [true]);
  assert.equal(multiple.doc.toString(), doc);
});

test('cursor motion reuses parsed math ranges and edits invalidate their exact source positions', () => {
  const doc = 'Before $x$\n\n$$y$$\n\nCaret';
  const state = stateFor(doc);
  const ranges = getLiveMathRanges(state);
  const moved = state.update({ selection: { anchor: doc.indexOf('Before') } }).state;
  assert.equal(getLiveMathRanges(moved), ranges, 'No document rescan is needed for a cursor move.');
  const edited = moved.update({ changes: { from: 0, insert: 'New paragraph\n\n' } }).state;
  assert.notEqual(getLiveMathRanges(edited), ranges);
  assert.equal(getLiveMathRanges(edited)[0].from, ranges[0].from + 'New paragraph\n\n'.length);
  const first = getLiveMathRanges(edited)[0];
  const replaced = edited.update({ changes: { from: first.contentFrom, to: first.contentTo, insert: '\\alpha' } }).state;
  assert.equal(getLiveMathRanges(replaced)[0].tex, '\\alpha');
  assert.equal(getLiveMathRanges(state)[0].tex, 'x', 'Earlier states remain immutable.');
});

test('math examples inside code, links, HTML, and wiki links stay editable literal Markdown', () => {
  const doc = [
    '`$inline$`', '```tex\n$$fenced$$\n```', '    $indented$',
    '[$label$](https://example.com/$destination$)', '[[Note|$alias$]]',
    '<div>\n$$html$$\n</div>', '<span>$tagged$</span>',
    'Price \\$5 and $10 then $20.', '$real$', 'Caret',
  ].join('\n\n');
  const state = stateFor(doc);
  assert.deepEqual(getLiveMathRanges(state).map(range => range.raw), ['$real$']);
  assert.equal(state.doc.toString(), doc);
});

test('changing quote context refreshes math even when its raw delimiter range is unchanged', () => {
  const state = stateFor('> $$\n> x^2\n> $$\n\nCaret');
  const edited = state.update({ changes: { from: 0, to: 2 } }).state;
  assert.equal(getLiveMathRanges(state)[0].raw, getLiveMathRanges(edited)[0].raw);
  assert.notEqual(getLiveMathRanges(state)[0].tex, getLiveMathRanges(edited)[0].tex);
  assert.equal(formulas(state)[0].widget.eq(formulas(edited)[0].widget), false);
});

test('Markdown formatting and outline navigation ignore syntax contained inside math', () => {
  const doc = '# Actual heading\n\n$$\n# Not a heading\nx_a_b + **literal**\n$$\n\n## Later heading\n\nCaret';
  const state = stateFor(doc);
  assert.equal(getLiveMathRanges(state).length, 1);
  const math = getLiveMathRanges(state)[0];
  const decorations: Array<{ from: number; to: number; className: string }> = [];
  buildLiveDecorations(state, [{ from: 0, to: doc.length }]).between(0, doc.length, (from, to, value) => {
    decorations.push({ from, to, className: value.spec.class ?? value.spec.attributes?.class ?? '' });
  });
  assert.equal(decorations.filter(range => range.from >= math.from && range.to <= math.to).length, 0);
  assert.equal(findLiveHeading(state, 0), 0);
  assert.equal(findLiveHeading(state, 1), doc.indexOf('## Later'));
  assert.equal(findLiveHeading(state, 2), null);
});

test('composition maps existing decorations and defers math parsing until composition ends', () => {
  let composing = false;
  const view = { get compositionStarted() { return composing; }, get composing() { return composing; } } as EditorView;
  let state = EditorState.create({
    doc: '$x$\n\nCaret', selection: { anchor: 10 },
    extensions: [markdown({ base: markdownLanguage }), liveMath(() => view)],
  });
  const original = formulas(state)[0].widget;
  composing = true;
  state = state.update({ changes: { from: state.doc.length, insert: '\n\n$y$' } }).state;
  assert.equal(state.field(liveMathState).pending, true);
  assert.equal(formulas(state).length, 1, 'New widgets cannot replace an active IME DOM.');
  assert.equal(formulas(state)[0].widget, original);
  composing = false;
  state = state.update({}).state;
  assert.equal(state.field(liveMathState).pending, false);
  assert.equal(getLiveMathRanges(state).length, 2);
  assert.equal(state.doc.toString(), '$x$\n\nCaret\n\n$y$');
});

test('switching Live presentation and revealing formulas does not add edits or lose undo', () => {
  const mode = new Compartment();
  let state = EditorState.create({
    doc: '$x$\n\nCaret', selection: { anchor: 1 },
    extensions: [history(), markdown({ base: markdownLanguage }), mode.of(liveMathState)],
  });
  state = state.update({ changes: { from: 1, to: 2, insert: 'y' }, selection: { anchor: 2 }, userEvent: 'input.type' }).state;
  state = state.update({ selection: { anchor: state.doc.length } }).state;
  assert.equal(formulas(state).length, 1);
  state = state.update({ effects: mode.reconfigure([]) }).state;
  assert.equal(state.field(liveMathState, false), undefined);
  state = state.update({ effects: mode.reconfigure(liveMathState) }).state;
  assert.equal(formulas(state).length, 1);
  assert.equal(state.doc.toString(), '$y$\n\nCaret');
  assert.equal(undo({ state, dispatch: transaction => { state = transaction.state; } }), true);
  assert.equal(state.doc.toString(), '$x$\n\nCaret');
  assert.equal(undo({ state, dispatch: transaction => { state = transaction.state; } }), false);
});

test('formula widgets provide accessible offline math and keep invalid TeX as literal text', () => {
  const dom = new JSDOM('<!DOCTYPE html><body></body>');
  const view = { dom: dom.window.document.body } as unknown as EditorView;
  const state = stateFor('$$\n\\frac{1}{2}\n$$\n\n$\\unknown{a<b}$\n\nCaret');
  const [valid, invalid] = formulas(state).map(range => range.widget.toDOM(view));
  assert.equal(valid.getAttribute('role'), 'button');
  assert.equal(valid.getAttribute('tabindex'), '0');
  assert.equal(valid.getAttribute('aria-label'), 'Edit formula: \\frac{1}{2}');
  assert.ok(valid.querySelector('.katex'));
  assert.ok(valid.querySelector('math'));
  assert.equal(invalid.classList.contains('cm-live-math-error'), true);
  assert.equal(invalid.textContent, '$\\unknown{a<b}$');
  assert.equal(invalid.querySelector('img'), null);
  assert.match(invalid.title, /Undefined control sequence/);
  dom.window.close();
});
