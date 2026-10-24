import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { JSDOM } from 'jsdom';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { ensureSyntaxTree } from '@codemirror/language';
import { EditorSelection, EditorState, type SelectionRange } from '@codemirror/state';
import { type EditorView, type WidgetType } from '@codemirror/view';
import { buildLiveDecorations } from '../src/renderer/liveMarkdown';
import { liveMathState } from '../src/renderer/liveMath';
import { liveTableState } from '../src/renderer/liveTables';

const dom = new JSDOM('<!doctype html><html><body></body></html>');
Object.defineProperty(globalThis, 'window', { value: dom.window, configurable: true });
after(() => dom.window.close());

function stateFor(doc: string, selection: SelectionRange = EditorSelection.cursor(doc.replace(/\r\n?/g, '\n').length)) {
  const state = EditorState.create({
    doc, selection: EditorSelection.create([selection]),
    extensions: [markdown({ base: markdownLanguage }), liveMathState, liveTableState, EditorState.allowMultipleSelections.of(true)],
  });
  ensureSyntaxTree(state, state.doc.length, 1_000);
  // Commit completed background parsing as the editor's parser plugin does.
  return state.update({}).state;
}

function lists(state: EditorState, ranges = [{ from: 0, to: state.doc.length }]) {
  const result: Array<{ from: number; to: number; raw: string; label: string; kind: string | undefined; element: HTMLElement }> = [];
  buildLiveDecorations(state, ranges).between(0, state.doc.length, (from, to, value) => {
    if (!value.spec.liveList) return;
    const element = (value.spec.widget as WidgetType).toDOM({ dom: dom.window.document.body } as unknown as EditorView);
    assert.ok(element.classList.contains('cm-live-list-marker'));
    result.push({ from, to, raw: state.sliceDoc(from, to), label: element.textContent?.trim() ?? '', kind: element.dataset.listKind, element });
  });
  return result;
}

test('Live lists render each bullet syntax without replacing indentation, contents, or line breaks', () => {
  const doc = '- First **item**\n- Second\n\n+ Plus\n\n* Star\n\nCaret';
  const state = stateFor(doc);
  const result = lists(state);
  assert.deepEqual(result.map(item => item.kind), ['bullet', 'bullet', 'bullet', 'bullet']);
  assert.deepEqual(result.map(item => item.label), ['•', '•', '•', '•']);
  assert.deepEqual(result.map(item => item.raw.trim()), ['-', '-', '+', '*']);
  for (const item of result) {
    assert.ok(item.to > item.from);
    assert.match(item.raw, /^[-+*][ \t]*$/);
    assert.equal(item.raw.includes('\n'), false);
  }
  assert.equal(state.doc.toString(), doc);
});

test('ordered lists use their first number and count items rather than copying repeated source numbers', () => {
  const doc = '0. Zero\n9. Second\n1. Third\n\nBreak\n\n3) Parenthesized\n1) Next\n\nCaret';
  const state = stateFor(doc);
  const result = lists(state);
  assert.deepEqual(result.map(item => item.kind), Array(5).fill('ordered'));
  assert.deepEqual(result.map(item => item.label), ['0.', '1.', '2.', '3.', '4.']);
  assert.deepEqual(result.map(item => item.raw.trim()), ['0.', '9.', '1.', '3)', '1)']);
  assert.deepEqual(lists(stateFor('1. First\n7) New list\n1) Another\n\nCaret')).map(item => item.label), ['1.', '7.', '8.']);
  assert.equal(state.doc.toString(), doc);
});

test('nested and quoted lists retain their prefixes and number each list independently', () => {
  const bullets = '- Parent\n  - Child\n    - Grandchild\n- Tail\n\nCaret';
  const bulletState = stateFor(bullets);
  const bulletMarkers = lists(bulletState);
  assert.equal(bulletMarkers.length, 4);
  assert.deepEqual(bulletMarkers.map(item => item.label), ['•', '◦', '▪', '•']);
  assert.equal(bullets.slice(bulletState.doc.lineAt(bulletMarkers[1].from).from, bulletMarkers[1].from), '  ');
  assert.equal(bullets.slice(bulletState.doc.lineAt(bulletMarkers[2].from).from, bulletMarkers[2].from), '    ');
  const doc = '4. Parent\n   1. Child\n   1. Next child\n1. Tail\n\n> 7. Quoted\n> 1. Another quoted\n\nCaret';
  const state = stateFor(doc);
  const result = lists(state);
  assert.deepEqual(result.map(item => item.label), ['4.', '1.', '2.', '5.', '7.', '8.']);
  for (const item of result) assert.match(item.raw, /^\d+[.)][ \t]*$/);
  assert.equal(result[4].from, doc.indexOf('7. Quoted'));
  assert.equal(result[5].from, doc.indexOf('1. Another quoted'));
  assert.equal(state.doc.toString(), doc);
});

test('empty markers stay editable and a parent list item retains its bullet above a nested task', () => {
  for (const raw of ['-', '+ ', '*\t', '1.', '3) ']) {
    assert.equal(lists(stateFor(raw + '\n\nCaret')).length, 0, raw);
  }
  const doc = '- Parent\n  - [ ] Nested task\n\n1. Ordered parent\n   - Child bullet\n\nCaret';
  const state = stateFor(doc);
  const result = lists(state);
  assert.deepEqual(result.map(item => item.label), ['•', '1.', '◦']);
  assert.equal(result[0].from, 0);
  assert.equal(state.doc.toString(), doc);
});

test('caret, reversed selections, and multiple cursors reveal every selected line without changing numbering elsewhere', () => {
  const doc = '5. First\n1. Second\n1. Third\n1. Fourth\n\nCaret';
  const state = stateFor(doc, EditorSelection.cursor(doc.indexOf('Second') + 2));
  assert.deepEqual(lists(state).map(item => item.label), ['5.', '7.', '8.']);
  const reversed = state.update({ selection: { anchor: doc.indexOf('Third') + 2, head: doc.indexOf('First') + 1 } }).state;
  assert.deepEqual(lists(reversed).map(item => item.label), ['8.']);
  const multiple = state.update({ selection: EditorSelection.create([
    EditorSelection.cursor(doc.indexOf('First')), EditorSelection.cursor(doc.indexOf('Third')),
  ]) }).state;
  assert.deepEqual(lists(multiple).map(item => item.label), ['6.', '8.']);
  const all = state.update({ selection: { anchor: 0, head: state.doc.length } }).state;
  assert.deepEqual(lists(all), []);
  assert.equal(all.doc.toString(), doc);
});

test('task markers own their bullet while still counting toward an enclosing ordered list', () => {
  const doc = '2. First\n1. [ ] Task\n1. Third\n\n- [x] Done\n  - Ordinary child\n\nCaret';
  const state = stateFor(doc);
  const result = lists(state);
  assert.deepEqual(result.filter(item => item.kind === 'ordered').map(item => item.label), ['2.', '4.']);
  assert.equal(result.filter(item => item.kind === 'bullet').length, 1);
  const taskRanges: Array<{ from: number; to: number }> = [];
  buildLiveDecorations(state, [{ from: 0, to: doc.length }]).between(0, doc.length, (from, to, value) => {
    if (value.spec.liveTask) taskRanges.push({ from, to });
  });
  assert.equal(taskRanges.length, 2);
  for (const task of taskRanges) assert.equal(result.some(item => item.from < task.to && item.to > task.from), false);
  assert.equal(state.doc.toString(), doc);
});

test('list-looking text in protected blocks, equations, and escaped syntax remains literal', () => {
  for (const raw of [
    '```md\n- Bullet\n1. Ordered\n```', '    - Indented code',
    '- ```md\n  code\n  ```', '- <span>HTML</span>',
    '<div>\n- HTML example\n1. Ordered example\n</div>',
    '$$\n- x\n1. y\n$$', '\\[\n- x\n1. y\n\\]',
    '| Heading |\n| --- |\n| - Cell |\n| 1. Cell |',
    '`- Inline code`', '\\- Escaped bullet', '1\\. Escaped number',
    '-not a list', '1.not a list', '- - -', '1234567890. Too many digits',
  ]) assert.equal(lists(stateFor(`${raw}\n\nCaret`)).length, 0, raw);
});

test('list markers coexist with Markdown and wiki links without consuming their source', () => {
  const doc = '- [[Note|Alias]]\n- [**Guide**](guide.md)\n- $x^2$\n\nCaret';
  const state = stateFor(doc);
  const result = lists(state);
  assert.equal(result.length, 3);
  assert.ok(result.every(item => /^-[ \t]*$/.test(item.raw)));
  assert.equal(state.doc.toString(), doc);
});

test('overlapping viewport ranges do not duplicate markers and edits refresh list numbers and offsets', () => {
  const doc = '8. First\n1. Second\n1. Third\n\nCaret';
  const state = stateFor(doc);
  const visible = [{ from: 0, to: doc.indexOf('Third') }, { from: doc.indexOf('1. Second'), to: doc.length }];
  const result = lists(state, visible);
  assert.deepEqual(result.map(item => item.label), ['8.', '9.', '10.']);
  assert.equal(new Set(result.map(item => item.from)).size, result.length);
  const edited = state.update({ changes: { from: 0, to: 1, insert: '12' } }).state;
  assert.deepEqual(lists(edited).map(item => item.label), ['12.', '13.', '14.']);
  assert.equal(lists(edited)[1].from, result[1].from + 1);
});

test('rendering preserves BOM, CRLF serialization, and ordered source values', () => {
  const source = '\ufeff# Notes\r\n\r\n7) 日本語\r\n1) Second\r\n  continued text\r\n\r\nCaret';
  const state = stateFor(source);
  assert.deepEqual(lists(state).map(item => item.label), ['7.', '8.']);
  assert.equal(state.doc.sliceString(0, state.doc.length, '\r\n'), source);
});

test('a distant viewport retains the full ordered-list count with bounded decoration work', () => {
  const count = 6_000;
  const doc = '7. First\n' + Array.from({ length: count - 1 }, (_, index) => `1. Item ${index + 2}\n`).join('') + '\nCaret';
  const state = stateFor(doc);
  const from = state.doc.line(count - 1).from;
  const to = state.doc.line(count).to;
  const started = performance.now();
  const result = lists(state, [{ from, to }]);
  assert.deepEqual(result.map(item => item.label), [`${count + 5}.`, `${count + 6}.`]);
  assert.ok(performance.now() - started < 2_000, 'Two visible markers should not require repeated whole-list rescans.');
  assert.equal(state.doc.toString(), doc);
});

test('clicking a marker resolves its current position and ignores IME, stale, or detached source', () => {
  let state = stateFor('3. First\n1. Second\n\nCaret');
  let position = 0;
  const view = {
    dom: dom.window.document.body,
    get state() { return state; },
    compositionStarted: false,
    composing: false,
    posAtDOM: () => position,
    dispatch: (transaction: Parameters<EditorState['update']>[0]) => { state = state.update(transaction).state; },
    focus: () => {},
  };
  let widget: WidgetType | undefined;
  buildLiveDecorations(state, [{ from: 0, to: state.doc.length }]).between(0, state.doc.length, (_from, _to, value) => {
    if (!widget && value.spec.liveList) widget = value.spec.widget;
  });
  assert.ok(widget);
  const marker = widget.toDOM(view as unknown as EditorView);
  dom.window.document.body.append(marker);
  const click = (button = 0) => marker.dispatchEvent(new dom.window.MouseEvent('mousedown', { bubbles: true, cancelable: true, button }));

  assert.equal(click(), false);
  assert.equal(state.selection.main.head, 0);
  assert.equal(lists(state).some(item => item.from === 0), false, 'Clicking exposes the full original marker.');

  state = state.update({ changes: { from: 0, insert: '日本語\n\n' } }).state;
  state = state.update({ selection: { anchor: state.doc.length } }).state;
  position = state.doc.toString().indexOf('3. First');
  click();
  assert.equal(state.selection.main.head, position, 'A reused widget follows its current DOM position after preceding edits.');

  state = state.update({ selection: { anchor: state.doc.length } }).state;
  const untouched = state.selection.main.head;
  view.composing = true;
  click();
  assert.equal(state.selection.main.head, untouched);
  view.composing = false;
  view.compositionStarted = true;
  click();
  assert.equal(state.selection.main.head, untouched);
  view.compositionStarted = false;
  click(2);
  assert.equal(state.selection.main.head, untouched);

  state = state.update({ changes: { from: position, to: position + 1, insert: '4' } }).state;
  click();
  assert.equal(state.selection.main.head, untouched, 'A stale marker cannot act after its source has changed.');
  state = state.update({ changes: { from: position, to: position + 1, insert: '3' } }).state;
  position = state.doc.toString().indexOf('Caret');
  click();
  assert.equal(state.selection.main.head, untouched, 'A non-list DOM position cannot reveal an unrelated line.');
  position = state.doc.toString().indexOf('3. First');
  marker.remove();
  click();
  assert.equal(state.selection.main.head, untouched);
});
