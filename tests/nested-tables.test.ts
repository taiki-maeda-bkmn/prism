import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { JSDOM } from 'jsdom';
import { history, undo } from '@codemirror/commands';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { Compartment, EditorSelection, EditorState } from '@codemirror/state';
import { type EditorView, type WidgetType } from '@codemirror/view';
import { buildLiveDecorations } from '../src/renderer/liveMarkdown';
import { liveMathState } from '../src/renderer/liveMath';
import { getLiveTableRanges, liveTableState } from '../src/renderer/liveTables';
import { renderMarkdown } from '../src/renderer/markdown';
import { scanMarkdownTables, tableCellPosition } from '../src/renderer/tables';

const dom = new JSDOM('<!doctype html><html><body></body></html>');
Object.defineProperty(globalThis, 'window', { value: dom.window, configurable: true });
after(() => dom.window.close());

const bare = '| **名前** | Value |\n| :--- | ---: |\n| 日本語 | one |';
const prefixed = (prefix: string) => bare.split('\n').map(line => prefix + line).join('\n');

function stateFor(doc: string, anchor = doc.replace(/\r\n?/g, '\n').length) {
  return EditorState.create({
    doc, selection: { anchor }, extensions: [
      markdown({ base: markdownLanguage }), liveMathState, liveTableState,
      EditorState.allowMultipleSelections.of(true),
    ],
  });
}

function tables(state: EditorState) {
  const result: Array<{ from: number; to: number; widget: WidgetType }> = [];
  state.field(liveTableState).decorations.between(0, state.doc.length, (from, to, decoration) => {
    result.push({ from, to, widget: decoration.spec.widget });
  });
  return result;
}

function widgetDOM(state: EditorState, index = 0): HTMLElement {
  return tables(state)[index].widget.toDOM({ dom: dom.window.document.body } as unknown as EditorView);
}

test('quoted, listed, and mixed nested tables render without leaking their container prefixes into cells', () => {
  const examples = [
    prefixed('> '), prefixed('> > '),
    '- ' + bare.replaceAll('\n', '\n  '),
    '7. ' + bare.replaceAll('\n', '\n   '),
    '- - ' + bare.replaceAll('\n', '\n    '),
    '> - ' + bare.replaceAll('\n', '\n>   '),
    '- Intro\n\n' + prefixed('  > '),
    '> - Intro\n>\n' + prefixed('>   '),
    '- Intro\n\n' + prefixed('\t'),
  ];
  for (const source of examples) {
    const state = stateFor(source + '\n\nCaret');
    assert.equal(tables(state).length, 1, source);
    const widget = widgetDOM(state);
    assert.deepEqual([...widget.querySelectorAll('th')].map(cell => cell.textContent), ['名前', 'Value'], source);
    assert.deepEqual([...widget.querySelectorAll('td')].map(cell => cell.textContent), ['日本語', 'one'], source);
    assert.deepEqual([...widget.querySelectorAll('th')].map(cell => cell.getAttribute('align')), ['left', 'right'], source);
    assert.equal(widget.querySelectorAll('table').length, 1);
    assert.equal(widget.querySelectorAll('button').length, 1);
    assert.equal(state.doc.toString(), source + '\n\nCaret');
  }
});

test('nested replacement boundaries include every first-line prefix and preserve adjacent container prose', () => {
  const nested = prefixed('>   ');
  const source = '\ufeff> - Before\n>\n' + nested + '\n>\n>   After\n\nOutside';
  const [table] = scanMarkdownTables(source);
  assert.ok(table);
  assert.equal(table.from, source.indexOf('>   |'));
  assert.equal(table.to, source.indexOf('\n>\n>   After'));
  assert.equal(table.raw, nested);
  assert.equal(source.slice(table.from, table.to), table.raw);
  assert.deepEqual(table.rows.map(row => row.cells.map(cell => source.slice(cell.from, cell.to))), [
    ['**名前**', 'Value'], ['日本語', 'one'],
  ]);
  assert.equal(tableCellPosition(table, 0, 0), source.indexOf('**名前**'));
  assert.equal(tableCellPosition(table, 1, 1), source.indexOf('one'));
  assert.match(source.slice(0, table.from), /Before/);
  assert.match(source.slice(table.to), /After/);
  const atStart = scanMarkdownTables('\ufeff' + prefixed('> '))[0];
  assert.equal(atStart.from, 1, 'The BOM remains encoding metadata outside the replacement.');
  assert.equal(atStart.raw, prefixed('> '));
});

test('nested empty, short, escaped, and outer-pipe-free rows retain exact cell source targets', () => {
  const source = '> A | B | C\n> --- | --- | ---\n> one | | `x\\|y`\n> short\n\nCaret';
  const state = stateFor(source);
  const table = getLiveTableRanges(state)[0];
  assert.ok(table);
  assert.deepEqual(table.rows.map(row => row.cells.map(cell => source.slice(cell.from, cell.to))), [
    ['A', 'B', 'C'], ['one', '', '`x\\|y`'], ['short'],
  ]);
  const widget = widgetDOM(state);
  assert.deepEqual([...widget.querySelectorAll('tbody tr')].map(row => [...row.children].map(cell => cell.textContent)), [
    ['one', '', 'x|y'], ['short', '', ''],
  ]);
  assert.equal(tableCellPosition(table, 1, 1), source.indexOf('| |') + 2);
  assert.equal(tableCellPosition(table, 2, 2), source.indexOf('short') + 'short'.length);
});

test('selecting any quote/list prefix or delimiter reveals the complete table and leaves its source literal', () => {
  const nested = '> - ' + bare.replaceAll('\n', '\n>   ');
  const source = '> Before\n>\n' + nested + '\n>\n> After\n\nCaret';
  let state = stateFor(source);
  assert.equal(tables(state).length, 1);
  const table = getLiveTableRanges(state)[0];
  const positions = [table.from, table.from + 2, source.indexOf('>   | :---'), source.indexOf('>   | 日本語'), table.to];
  for (const anchor of positions) {
    state = state.update({ selection: { anchor } }).state;
    assert.equal(tables(state).length, 0, `Prefix or delimiter position ${anchor}`);
    const independent: unknown[] = [];
    buildLiveDecorations(state, [{ from: 0, to: source.length }]).between(table.from, table.to, (from, to, decoration) => {
      independent.push({ from, to, decoration });
    });
    assert.deepEqual(independent, [], 'Container source belongs to the table even when its ancestor quote includes other paragraphs.');
    assert.equal(state.doc.toString(), source);
  }
  state = state.update({ selection: { anchor: source.length } }).state;
  assert.equal(tables(state).length, 1);
  const selected = state.update({ selection: { anchor: table.to, head: table.from } }).state;
  assert.equal(selected.sliceDoc(selected.selection.main.from, selected.selection.main.to), nested);
  assert.equal(tables(selected).length, 0);
});

test('nested table equations and document references render once with original UTF-16 source offsets', () => {
  const source = '\ufeff# 日本語𠮷\n\n> - | $|\\text{𠮷}|$ | Value𠮷 |\n>   | --- | --- |\n>   | $x^2$ | [**Guide**][target] |\n\n'
    + '- [target]: Destination%20note.md#heading\n\nOutside $z$.\n\nCaret';
  const state = stateFor(source);
  const table = getLiveTableRanges(state)[0];
  assert.ok(table);
  assert.equal(table.rows[0].cells.length, 2);
  assert.equal(source.slice(table.rows[0].cells[0].from, table.rows[0].cells[0].to), '$|\\text{𠮷}|$');
  assert.equal(tableCellPosition(table, 0, 1), source.indexOf('Value𠮷'));
  assert.equal(tableCellPosition(table, 1, 1), source.indexOf('[**Guide**]'));
  const widget = widgetDOM(state);
  assert.equal(widget.querySelectorAll('.katex').length, 2);
  assert.equal(widget.querySelector('a strong')?.textContent, 'Guide');
  assert.equal(widget.querySelector('a')?.getAttribute('href'), 'Destination%20note.md#heading');
  const reading = dom.window.document.createElement('div');
  reading.innerHTML = renderMarkdown(source);
  assert.deepEqual([...widget.querySelectorAll('th,td')].map(cell => cell.textContent), [...reading.querySelectorAll('th,td')].map(cell => cell.textContent));
  const outsideMath: string[] = [];
  state.field(liveMathState).decorations.between(0, source.length, (from, to) => { outsideMath.push(source.slice(from, to)); });
  assert.deepEqual(outsideMath, ['$z$']);
});

test('a reused nested widget resolves cell clicks after preceding edits and ignores composition or changed prefixes', () => {
  const source = 'Before\n\n' + prefixed('> ') + '\n\nCaret';
  let state = stateFor(source);
  const original = tables(state)[0].widget;
  let composing = false;
  let focused = false;
  const view = {
    dom: dom.window.document.body,
    get state() { return state; },
    get composing() { return composing; },
    get compositionStarted() { return composing; },
    posAtDOM: () => getLiveTableRanges(state)[0].from,
    dispatch: (spec: Parameters<EditorState['update']>[0]) => { state = state.update(spec).state; },
    focus() { focused = true; },
  } as unknown as EditorView;
  const element = original.toDOM(view);
  dom.window.document.body.append(element);
  const clickCell = () => element.querySelectorAll('tbody td')[1].dispatchEvent(new dom.window.MouseEvent('mousedown', { bubbles: true, button: 0 }));
  try {
    state = state.update({ changes: { from: 0, insert: '日本語\n\n' } }).state;
    assert.equal(original.eq(tables(state)[0].widget), true);
    const selected = state.selection.main.head;
    composing = true;
    clickCell();
    assert.equal(state.selection.main.head, selected);
    assert.equal(focused, false);
    composing = false;
    clickCell();
    assert.equal(state.selection.main.head, state.doc.toString().indexOf('one'));
    assert.equal(focused, true);
    assert.equal(tables(state).length, 0);
    assert.equal(state.doc.toString(), '日本語\n\n' + source);
    state = state.update({ selection: { anchor: state.doc.length } }).state;
    const from = getLiveTableRanges(state)[0].from;
    state = state.update({ changes: { from, insert: ' ' } }).state;
    const unchanged = state.selection.main.head;
    clickCell();
    assert.equal(state.selection.main.head, unchanged, 'A stale container prefix cannot reveal a guessed source position.');
  } finally {
    element.remove();
  }
});

test('ordered container changes invalidate a table widget even when its table source is unchanged', () => {
  const source = '3. Before\n1. ' + bare.replaceAll('\n', '\n   ') + '\n\nCaret';
  const state = stateFor(source);
  const before = getLiveTableRanges(state)[0];
  assert.ok(before);
  const changed = state.update({ changes: { from: 0, to: 1, insert: '7' } }).state;
  const after = getLiveTableRanges(changed)[0];
  assert.equal(before.raw, after.raw);
  assert.equal(widgetDOM(state).querySelector('.cm-live-table-list-marker')?.textContent, '4.');
  assert.equal(widgetDOM(changed).querySelector('.cm-live-table-list-marker')?.textContent, '8.');
  assert.equal(tables(state)[0].widget.eq(tables(changed)[0].widget), false, 'The visible enclosing number changes from 4 to 8.');
  const wide = stateFor('999. Before\n1. ' + bare.replaceAll('\n', '\n   ') + '\n\nCaret');
  const marker = widgetDOM(wide).querySelector<HTMLElement>('.cm-live-table-list-marker')!;
  assert.equal(marker.textContent, '1000.');
  assert.equal(marker.style.width, '6ch', 'Computed numbering needs enough room before the table border.');
});

test('container list markers reveal their current source by mouse or keyboard without edits and reject stale or composing interactions', () => {
  const source = 'Before\n\n> 3. Intro\n> 1. ' + bare.replaceAll('\n', '\n>    ') + '\n\nCaret';
  let state = EditorState.create({
    doc: source, selection: { anchor: source.length },
    extensions: [history(), markdown({ base: markdownLanguage }), liveMathState, liveTableState],
  });
  const original = tables(state)[0].widget;
  let composing = false;
  let focusCount = 0;
  const view = {
    dom: dom.window.document.body,
    get state() { return state; },
    get composing() { return composing; },
    get compositionStarted() { return composing; },
    posAtDOM: () => getLiveTableRanges(state)[0].from,
    dispatch: (spec: Parameters<EditorState['update']>[0]) => { state = state.update(spec).state; },
    focus() { focusCount++; },
  } as unknown as EditorView;
  const element = original.toDOM(view);
  dom.window.document.body.append(element);
  const marker = element.querySelector<HTMLElement>('.cm-live-table-list-marker')!;
  assert.equal(marker.textContent, '4.');
  assert.equal(marker.getAttribute('role'), 'button');
  const gestures = [
    () => marker.dispatchEvent(new dom.window.MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0 })),
    () => marker.dispatchEvent(new dom.window.KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: 'Enter' })),
    () => marker.dispatchEvent(new dom.window.KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: ' ' })),
  ];
  const moveOutside = () => { state = state.update({ selection: { anchor: state.doc.length } }).state; };
  try {
    const added = '日本語\n\n';
    state = state.update({ changes: { from: 0, insert: added }, userEvent: 'input.type' }).state;
    assert.equal(original.eq(tables(state)[0].widget), true, 'The same marker DOM may survive a preceding edit.');
    for (const gesture of gestures) {
      moveOutside();
      const current = getLiveTableRanges(state)[0];
      const container = current.containers.find(item => item.kind === 'list');
      assert.ok(container?.kind === 'list');
      assert.equal(container.markerOffset, 2, 'The original quote prefix precedes the list marker.');
      assert.equal(gesture(), false, 'Handled marker gestures suppress their browser defaults.');
      assert.equal(state.selection.main.head, current.from + container.markerOffset!);
      assert.equal(state.sliceDoc(state.selection.main.head, state.selection.main.head + 2), '1.');
      assert.equal(tables(state).length, 0);
      assert.equal(state.doc.toString(), added + source);
    }
    assert.equal(focusCount, 3);

    moveOutside();
    composing = true;
    for (const gesture of gestures) gesture();
    assert.equal(state.selection.main.head, state.doc.length);
    assert.equal(focusCount, 3);
    composing = false;
    element.remove();
    for (const gesture of gestures) gesture();
    assert.equal(state.selection.main.head, state.doc.length);
    assert.equal(focusCount, 3);
    dom.window.document.body.append(element);

    assert.equal(undo({ state, dispatch: transaction => { state = transaction.state; } }), true);
    assert.equal(state.doc.toString(), source, 'The only undo step is the preceding text insertion.');
    assert.equal(undo({ state, dispatch: transaction => { state = transaction.state; } }), false, 'Source reveal adds no history entries.');

    const firstNumber = state.doc.toString().indexOf('3. Intro');
    state = state.update({ changes: { from: firstNumber, to: firstNumber + 1, insert: '7' } }).state;
    moveOutside();
    for (const gesture of gestures) gesture();
    assert.equal(state.selection.main.head, state.doc.length, 'An old 4. marker cannot reveal a table whose visible number is now 8.');
    assert.equal(focusCount, 3);
    const earlierItem = '> 7. Intro\n';
    const firstLine = state.doc.toString().indexOf(earlierItem);
    state = state.update({ changes: { from: firstLine, to: firstLine + earlierItem.length } }).state;
    moveOutside();
    const afterRemoval = state.doc.toString();
    for (const gesture of gestures) gesture();
    assert.equal(state.selection.main.head, state.doc.length, 'Removing the earlier sibling also invalidates the reused marker context.');
    assert.equal(focusCount, 3);
    assert.equal(state.doc.toString(), afterRemoval);
  } finally {
    element.remove();
  }
});

test('nested code, HTML, multiline equations, and malformed tables remain protected source', () => {
  for (const source of [
    '> ```md\n' + prefixed('> ') + '\n> ```',
    '- Example\n\n' + prefixed('      '),
    '> <div>\n' + prefixed('> ') + '\n> </div>',
    '> $$\n' + prefixed('> ') + '\n> $$',
    '- $$\n' + prefixed('  ') + '\n  $$',
    '> | A | B |\n> | --- |\n> | one | two |',
    // Lezer accepts these lazy quote rows, but the reading parser does not
    // recognize the same table. Keep all source available instead of guessing.
    '> | A | B |\n| --- | --- |\n| x | y |',
    '> | A | B |\n> | --- | --- |\n| x | y |',
    '- > | A | B |\n  | --- | --- |\n  | x | y |',
  ]) assert.equal(tables(stateFor(source + '\n\nCaret')).length, 0, source);
});

test('two tables in one container keep disjoint replacements and independent source reveal', () => {
  const first = prefixed('> ');
  const second = prefixed('> ').replace('one', 'two');
  const source = first + '\n>\n' + second + '\n\nCaret';
  const state = stateFor(source);
  const ranges = getLiveTableRanges(state);
  assert.equal(ranges.length, 2);
  assert.ok(ranges[0].to < ranges[1].from);
  assert.equal(tables(state).length, 2);
  const selected = state.update({ selection: { anchor: ranges[1].from } }).state;
  assert.equal(tables(selected).length, 1);
  assert.equal(tables(selected)[0].from, ranges[0].from);
  assert.equal(selected.doc.toString(), source);
});

test('nested table editing, presentation changes, and undo preserve prefixes and exact BOM/CRLF serialization', () => {
  const presentation = new Compartment();
  const original = '\ufeff> - Before\r\n>\r\n' + prefixed('>   ').replaceAll('\n', '\r\n') + '\r\n\r\nCaret';
  const normalized = original.replaceAll('\r\n', '\n');
  let state = EditorState.create({
    doc: original, selection: { anchor: normalized.length },
    extensions: [history(), markdown({ base: markdownLanguage }), presentation.of([liveMathState, liveTableState])],
  });
  const table = getLiveTableRanges(state)[0];
  assert.ok(table);
  const position = tableCellPosition(table, 1, 1);
  state = state.update({ changes: { from: position, to: position + 3, insert: '二' }, userEvent: 'input.type' }).state;
  state = state.update({ effects: presentation.reconfigure([]) }).state;
  state = state.update({ effects: presentation.reconfigure([liveMathState, liveTableState]) }).state;
  assert.equal(tables(state).length, 1);
  assert.equal(state.doc.sliceString(0, state.doc.length, '\r\n'), original.replace('one', '二'));
  assert.equal(undo({ state, dispatch: transaction => { state = transaction.state; } }), true);
  assert.equal(state.doc.sliceString(0, state.doc.length, '\r\n'), original);
  assert.equal(undo({ state, dispatch: transaction => { state = transaction.state; } }), false);
});
