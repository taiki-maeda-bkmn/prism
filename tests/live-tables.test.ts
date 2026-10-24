import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { JSDOM } from 'jsdom';
import { history, undo } from '@codemirror/commands';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { Compartment, EditorSelection, EditorState, type Extension } from '@codemirror/state';
import { type EditorView, type WidgetType } from '@codemirror/view';
import { liveMathState } from '../src/renderer/liveMath';
import { liveLinkNavigation } from '../src/renderer/liveLinks';
import { buildLiveDecorations } from '../src/renderer/liveMarkdown';
import { getLiveTableRanges, liveTables, liveTableState } from '../src/renderer/liveTables';
import { renderMarkdown } from '../src/renderer/markdown';
import { scanMarkdownTables, tableCellPosition } from '../src/renderer/tables';

const dom = new JSDOM('<!doctype html><html><body></body></html>');
Object.defineProperty(globalThis, 'window', { value: dom.window, configurable: true });
after(() => dom.window.close());

const simpleTable = '| Name | Value |\n| --- | --- |\n| 日本語 | one |';

function stateFor(doc: string, selection = EditorSelection.cursor(doc.length), extensions: Extension = []) {
  return EditorState.create({
    doc, selection: EditorSelection.create([selection]),
    extensions: [
      markdown({ base: markdownLanguage }), liveMathState, liveTableState,
      EditorState.allowMultipleSelections.of(true), extensions,
    ],
  });
}

function tables(state: EditorState) {
  const found: Array<{ from: number; to: number; block: boolean; widget: WidgetType }> = [];
  state.field(liveTableState).decorations.between(0, state.doc.length, (from, to, value) => {
    found.push({ from, to, block: value.spec.block === true, widget: value.spec.widget });
  });
  return found;
}

function widgetDOM(state: EditorState, index = 0): HTMLElement {
  return tables(state)[index].widget.toDOM({ dom: dom.window.document.body } as unknown as EditorView);
}

test('Live tables render aligned cells, inline Markdown, and Japanese without rewriting source', () => {
  const table = '| **名前** | `Code` | Result |\n| :--- | :---: | ---: |\n| *日本語* | `x\\|y` | ~~old~~ |';
  const source = `${table}\n\nCaret`;
  const state = stateFor(source);
  assert.deepEqual(tables(state).map(({ from, to, block }) => ({ from, to, block })), [
    { from: 0, to: table.length, block: true },
  ]);
  const element = widgetDOM(state);
  assert.equal(element.querySelector('button')?.textContent, 'Edit table');
  assert.equal(element.querySelector('table')?.rows.length, 2);
  assert.equal(element.querySelector('th strong')?.textContent, '名前');
  assert.equal(element.querySelector('td em')?.textContent, '日本語');
  assert.equal(element.querySelector('td code')?.textContent, 'x|y');
  assert.equal(element.querySelector('td del')?.textContent, 'old');
  assert.deepEqual([...element.querySelectorAll('th')].map(cell => cell.getAttribute('align')), ['left', 'center', 'right']);
  assert.equal(state.doc.toString(), source);
  assert.equal(state.selection.main.head, source.length);
});

test('cell source mapping retains empty slots, escaped pipes, Unicode, and BOM offsets', () => {
  // EditorState normalizes CRLF before scanning; serialization is covered below.
  const source = '\ufeff| | 名前 | Code |\n| --- | --- | --- |\n| first | | x\\|y |\n| short |\n\nAfter';
  const [table] = scanMarkdownTables(source);
  assert.ok(table);
  assert.equal(table.from, 1);
  assert.equal(table.raw, source.slice(1, source.indexOf('\n\n')));
  assert.deepEqual(table.rows.map(row => row.cells.map(cell => source.slice(cell.from, cell.to))), [
    ['', '名前', 'Code'], ['first', '', 'x\\|y'], ['short'],
  ]);
  assert.equal(tableCellPosition(table, 0, 1), source.indexOf('名前'));
  assert.equal(tableCellPosition(table, 1, 2), source.indexOf('x\\|y'));
  assert.equal(tableCellPosition(table, 1, 1), source.indexOf('| | x') + 2, 'An empty slot remains an editable position.');
  assert.equal(tableCellPosition(table, 2, 1), table.rows[2].to, 'A GFM-padded cell maps to its row end.');
});

test('tables without outer pipes and GFM short or extra rows follow reading rendering', () => {
  const source = 'A | B\n--- | ---\nleft | right\nshort\none | two | extra\n\nCaret';
  const state = stateFor(source);
  const rows = [...widgetDOM(state).querySelectorAll('tr')];
  assert.deepEqual(rows.map(row => [...row.children].map(cell => cell.textContent)), [
    ['A', 'B'], ['left', 'right'], ['short', ''], ['one', 'two'],
  ]);
  assert.equal(state.doc.toString(), source, 'Extra source cells are retained even though GFM does not display them.');
});

test('malformed tables, HTML, and code examples remain source', () => {
  const fallback = [
    '| A | B |\n| not a delimiter | --- |\n| one | two |',
    '| A | B |\n| --- |\n| one | two |',
    `\`\`\`md\n${simpleTable}\n\`\`\``,
    simpleTable.split('\n').map(line => `    ${line}`).join('\n'),
    `<div>\n${simpleTable}\n</div>`,
  ];
  for (const source of fallback) {
    const state = stateFor(`${source}\n\nCaret`);
    assert.equal(tables(state).length, 0, source);
    assert.equal(state.doc.toString(), `${source}\n\nCaret`);
  }
});

test('carets and selections reveal the whole touched table including delimiter and empty lines', () => {
  const source = `${simpleTable}\n\n${simpleTable.replace('日本語', 'Second')}\n\nCaret`;
  const state = stateFor(source);
  assert.equal(tables(state).length, 2);
  for (const anchor of [0, source.indexOf('---'), source.indexOf('日本語'), simpleTable.length]) {
    const revealed = state.update({ selection: { anchor } }).state;
    assert.equal(tables(revealed).length, 1);
    assert.equal(tables(revealed)[0].from, simpleTable.length + 2);
    assert.equal(revealed.doc.toString(), source);
  }
  const reversed = state.update({ selection: { anchor: source.indexOf('Second') + 3, head: 0 } }).state;
  assert.equal(tables(reversed).length, 0);
  const multiple = state.update({ selection: EditorSelection.create([
    EditorSelection.cursor(source.indexOf('日本語')), EditorSelection.cursor(source.indexOf('Second')),
  ]) }).state;
  assert.equal(tables(multiple).length, 0);
  const all = state.update({ selection: { anchor: 0, head: source.length } }).state;
  assert.equal(all.sliceDoc(all.selection.main.from, all.selection.main.to), source, 'Copy uses literal Markdown.');
});

test('moving a caret reuses table parsing while reference-definition edits invalidate rendering', () => {
  const source = '| Reference |\n| --- |\n| [guide] |\n\n[guide]: https://example.com/first\n\nCaret';
  const state = stateFor(source);
  const ranges = getLiveTableRanges(state);
  const moved = state.update({ selection: { anchor: source.indexOf('Caret') } }).state;
  assert.equal(getLiveTableRanges(moved), ranges);
  assert.equal(widgetDOM(state).querySelector('.cm-live-table-link')?.textContent, 'guide');
  const edited = moved.update({ changes: { from: source.indexOf('/first'), to: source.indexOf('/first') + 6, insert: '/second' } }).state;
  assert.equal(getLiveTableRanges(edited)[0].raw, ranges[0].raw);
  assert.notEqual(getLiveTableRanges(edited)[0].referenceKey, ranges[0].referenceKey);
  assert.equal(tables(state)[0].widget.eq(tables(edited)[0].widget), false);
  assert.equal(ranges[0].references.guide.href, 'https://example.com/first', 'Older states remain unchanged.');
  const fakeReference = '| Reference |\n| --- |\n| [fake] |\n\n```md\n[fake]: https://example.com\n```\n\nCaret';
  assert.equal(widgetDOM(stateFor(fakeReference)).querySelector('.cm-live-table-link'), null, 'Code examples are not reference definitions.');
});

test('quoted and listed reference definitions keep table labels and destinations consistent with reading', () => {
  const examples = [
    { label: 'guide', definition: '> [guide]: https://example.com/quote "Quoted title"' },
    { label: 'guide', definition: '- [guide]: https://example.com/list\n    "List title"' },
    { label: 'guide', definition: '> - [guide]:\n>     https://example.com/nested\n>     "Nested title"' },
    { label: 'long guide', definition: '> [long\n> guide]: https://example.com/multiline "A title\n> across lines"' },
    { label: 'long guide', definition: '> - [long\n>   guide]: https://example.com/nested-multiline\n>   "A title\n>   across lines"' },
    { label: 'a\\]b', definition: '- [a\\]b]: https://example.com/escaped "Escaped label"' },
    { label: 'guide', definition: '> [guide]: </a\\>b> "Escaped destination"' },
  ];
  for (const { label, definition } of examples) {
    const source = `| Reference |\n| --- |\n| [**Guide**][${label}] |\n\n${definition}\n\nCaret`;
    const state = stateFor(source);
    const rendered = dom.window.document.createElement('div');
    rendered.innerHTML = renderMarkdown(source);
    const readingLink = rendered.querySelector<HTMLAnchorElement>('table a');
    assert.ok(readingLink, definition);
    assert.equal(readingLink.textContent, 'Guide');
    const tableContext = dom.window.document.createElement('div');
    const table = getLiveTableRanges(state)[0];
    tableContext.innerHTML = renderMarkdown(table.raw, table.references);
    const contextLink = tableContext.querySelector<HTMLAnchorElement>('table a');
    assert.ok(contextLink, definition);
    assert.deepEqual(
      [contextLink.textContent, contextLink.getAttribute('href'), contextLink.getAttribute('title')],
      [readingLink.textContent, readingLink.getAttribute('href'), readingLink.getAttribute('title')],
      definition,
    );
    const widget = widgetDOM(state);
    assert.equal(widget.querySelector('.cm-live-table-link strong')?.textContent, 'Guide', definition);
    assert.equal(widget.querySelector('a.cm-live-link')?.getAttribute('href'), readingLink.getAttribute('href'));
    assert.match(widget.querySelector('a.cm-live-link')?.getAttribute('title') ?? '', /Ctrl\+click to open/);
    assert.equal(state.doc.toString(), source);
  }
});

test('reference definitions preserve first-definition precedence across container boundaries', () => {
  for (const definitions of [
    '> [guide]: https://example.com/first\n\n[guide]: https://example.com/second',
    '- [guide]: https://example.com/first\n\n> [guide]: https://example.com/second',
    '[guide]: https://example.com/first\n\n> - [guide]: https://example.com/second',
  ]) {
    const source = `| Reference |\n| --- |\n| [Guide][guide] |\n\n${definitions}\n\nCaret`;
    const state = stateFor(source);
    const table = getLiveTableRanges(state)[0];
    for (const html of [renderMarkdown(source), renderMarkdown(table.raw, table.references)]) {
      const rendered = dom.window.document.createElement('div');
      rendered.innerHTML = html;
      assert.equal(rendered.querySelector('table a')?.getAttribute('href'), 'https://example.com/first', definitions);
    }
    assert.equal(widgetDOM(state).querySelector('.cm-live-table-link')?.textContent, 'Guide');
  }
});

test('reference examples in quoted and listed code remain literal', () => {
  for (const definition of [
    '> ```md\n> [fake]: https://example.com/code\n> ```',
    '- Example\n\n      [fake]: https://example.com/code',
  ]) {
    const source = `| Reference |\n| --- |\n| [Code][fake] |\n\n${definition}\n\nCaret`;
    const state = stateFor(source);
    assert.equal(widgetDOM(state).querySelector('.cm-live-table-link'), null, definition);
    assert.equal(widgetDOM(state).querySelector('td')?.textContent, '[Code][fake]');
    assert.equal(getLiveTableRanges(state)[0].references.fake, undefined);
  }
});

test('table widgets sanitize note HTML and preserve only supported link targets', () => {
  const source = '| Content |\n| --- |\n| [link](https://example.com) ![alt text](https://example.com/image.png) <span tabindex="0" contenteditable="true" onclick="alert(1)">safe</span> <img src="x" onerror="alert(1)"> <select><option>Choice</option></select> <textarea>Draft</textarea> <details><summary>Open</summary>Hidden</details> <audio controls src="sound.mp3"></audio> <video controls src="movie.mp4"></video> |\n\nCaret';
  const element = widgetDOM(stateFor(source));
  assert.equal(element.querySelector('img, script, select, textarea, details, summary, audio, video, [onclick], [onerror], [tabindex], [contenteditable]'), null);
  assert.equal(element.querySelector('.cm-live-table-link')?.textContent, 'link');
  assert.equal(element.querySelector('a.cm-live-link')?.getAttribute('href'), 'https://example.com');
  assert.match(element.textContent || '', /alt text/);
  assert.equal(element.querySelectorAll('button').length, 1, 'Only Prism’s edit control is a button.');
  const blocked = widgetDOM(stateFor('| Links |\n| --- |\n| [script](javascript:alert) [file](file:///tmp/note.md) [ftp](ftp://example.com) |\n\nCaret'));
  assert.equal(blocked.querySelector('a'), null, 'Unsupported destinations never become actionable links.');
  assert.equal(blocked.querySelectorAll('.cm-live-table-link').length, 3);
});

test('table links open only with Ctrl or Command plus left-click and retain source editing', () => {
  const source = 'Before\n\n| Links |\n| --- |\n| [**Open**][target] |\n\n[target]: Next.md#section\n\nCaret';
  const opened: string[] = [];
  let state = stateFor(source, EditorSelection.cursor(source.length), liveLinkNavigation.of(href => opened.push(href)));
  const original = tables(state)[0].widget;
  let focused = false;
  const view = {
    dom: dom.window.document.body,
    get state() { return state; },
    compositionStarted: false, composing: false,
    posAtDOM: () => getLiveTableRanges(state)[0].from,
    dispatch: (spec: Parameters<EditorState['update']>[0]) => { state = state.update(spec).state; },
    focus: () => { focused = true; },
  } as unknown as EditorView;
  const element = original.toDOM(view);
  dom.window.document.body.append(element);
  try {
    // DOM can be reused after preceding text changes. Navigation resolves it
    // against current ranges instead of the original widget's absolute offset.
    state = state.update({ changes: { from: 0, insert: 'Added\n\n' } }).state;
    assert.equal(original.eq(tables(state)[0].widget), true);
    const selected = state.selection.main.head;
    const label = element.querySelector('a strong')!;
    for (const modifier of [{ ctrlKey: true }, { metaKey: true }]) {
      for (const type of ['mousedown', 'click']) {
        const event = new dom.window.MouseEvent(type, { bubbles: true, cancelable: true, button: 0, ...modifier });
        label.dispatchEvent(event);
        assert.equal(event.defaultPrevented, true);
      }
      assert.equal(state.selection.main.head, selected, 'Opening a link must not reveal its table source.');
      assert.equal(focused, false);
    }
    assert.deepEqual(opened, ['Next.md#section', 'Next.md#section']);
    const middle = new dom.window.MouseEvent('auxclick', { bubbles: true, cancelable: true, button: 1, ctrlKey: true });
    label.dispatchEvent(middle);
    assert.equal(middle.defaultPrevented, true, 'Middle-click cannot navigate the renderer.');
    assert.equal(opened.length, 2);
    label.dispatchEvent(new dom.window.MouseEvent('mousedown', { bubbles: true, button: 0 }));
    assert.equal(state.selection.main.head, state.doc.toString().indexOf('[**Open**]'));
    assert.equal(focused, true);
    assert.equal(opened.length, 2);
    assert.equal(state.doc.toString(), 'Added\n\n' + source);
  } finally {
    element.remove();
  }
});

test('table links ignore composition, detached DOM, and stale reference destinations', () => {
  const source = '| Link |\n| --- |\n| [Open][target] |\n\n[target]: First.md\n\nCaret';
  const opened: string[] = [];
  let state = stateFor(source, EditorSelection.cursor(source.length), liveLinkNavigation.of(href => opened.push(href)));
  let composing = false;
  const view = {
    dom: dom.window.document.body,
    get state() { return state; },
    get compositionStarted() { return composing; },
    get composing() { return composing; },
    posAtDOM: () => getLiveTableRanges(state)[0].from,
    dispatch: (spec: Parameters<EditorState['update']>[0]) => { state = state.update(spec).state; },
    focus() {},
  } as unknown as EditorView;
  const element = tables(state)[0].widget.toDOM(view);
  dom.window.document.body.append(element);
  const click = (root: HTMLElement) => root.querySelector('a')!.dispatchEvent(new dom.window.MouseEvent('click', {
    bubbles: true, cancelable: true, button: 0, ctrlKey: true,
  }));
  try {
    composing = true;
    click(element);
    assert.deepEqual(opened, []);
    composing = false;
    state = state.update({ changes: { from: source.indexOf('First.md'), to: source.indexOf('First.md') + 8, insert: 'Second.md' } }).state;
    click(element);
    assert.deepEqual(opened, [], 'A stale widget cannot open the old reference destination.');
    element.remove();
    const refreshed = tables(state)[0].widget.toDOM(view);
    dom.window.document.body.append(refreshed);
    click(refreshed);
    assert.deepEqual(opened, ['Second.md']);
    refreshed.remove();
    click(refreshed);
    assert.deepEqual(opened, ['Second.md']);
  } finally {
    element.remove();
  }
});

test('math in table cells renders once and multiline equations retain ownership of table-looking text', () => {
  const source = '| Inline | Display |\n| --- | --- |\n| $x^2$ | $$y_1$$ |\n\nOutside $z$.\n\nCaret';
  const state = stateFor(source);
  assert.equal(widgetDOM(state).querySelectorAll('.katex').length, 2);
  const mathSource: string[] = [];
  state.field(liveMathState).decorations.between(0, source.length, (from, to) => { mathSource.push(state.sliceDoc(from, to)); });
  assert.deepEqual(mathSource, ['$z$']);
  const active = state.update({ selection: { anchor: source.indexOf('Inline') } }).state;
  assert.equal(tables(active).length, 0);
  const activeMath: string[] = [];
  active.field(liveMathState).decorations.between(0, source.length, (from, to) => { activeMath.push(active.sliceDoc(from, to)); });
  assert.deepEqual(activeMath, ['$z$'], 'Editing a table reveals all of its exact cell syntax.');
  const equation = `$$\n${simpleTable}\n$$\n\nCaret`;
  const equationState = stateFor(equation);
  assert.equal(tables(equationState).length, 0);
  assert.equal(equationState.field(liveMathState).ranges.length, 1);
});

test('formula-owned pipes preserve following cell positions and ambiguous header shapes remain source', () => {
  const source = '| Formula | Result |\n| --- | --- |\n| $|x|$ | target |\n\nCaret';
  const state = stateFor(source);
  const [table] = getLiveTableRanges(state);
  assert.equal(table.rows[1].cells.length, 2);
  assert.equal(tableCellPosition(table, 1, 1), source.indexOf('target'));
  const rendered = widgetDOM(state);
  assert.equal(rendered.querySelectorAll('tbody td').length, 2);
  assert.equal(rendered.querySelectorAll('tbody td')[1].textContent, 'target');
  assert.equal(rendered.querySelectorAll('.katex').length, 1);
  for (const formula of ['$|x|$', '$|\\text{𠮷}|$']) {
    const headerSource = `\ufeff# 日本語𠮷\n\n| ${formula} | Value𠮷 |\n| --- | --- |\n| 一 | 二 |\n\nCaret`;
    let headerState = stateFor(headerSource);
    const [headerTable] = getLiveTableRanges(headerState);
    assert.ok(headerTable, formula);
    assert.equal(headerTable.rows[0].cells.length, 2);
    assert.equal(tableCellPosition(headerTable, 0, 1), headerSource.indexOf('Value𠮷'));
    assert.equal(headerSource.slice(headerTable.rows[0].cells[0].from, headerTable.rows[0].cells[0].to), formula);
    const view = {
      dom: dom.window.document.body,
      get state() { return headerState; },
      compositionStarted: false, composing: false,
      posAtDOM: () => headerTable.from,
      dispatch: (spec: Parameters<EditorState['update']>[0]) => { headerState = headerState.update(spec).state; },
      focus() {},
    } as unknown as EditorView;
    const widget = tables(headerState)[0].widget.toDOM(view);
    dom.window.document.body.append(widget);
    try {
      const reading = dom.window.document.createElement('div');
      reading.innerHTML = renderMarkdown(headerSource);
      assert.deepEqual([...widget.querySelectorAll('th')].map(cell => cell.textContent), [...reading.querySelectorAll('th')].map(cell => cell.textContent));
      assert.equal(widget.querySelectorAll('th .katex').length, 1);
      assert.equal(widget.querySelector('th .katex-mathml annotation')?.textContent, formula.slice(1, -1));
      widget.querySelectorAll('th')[1].dispatchEvent(new dom.window.MouseEvent('mousedown', { bubbles: true, button: 0 }));
      assert.equal(headerState.selection.main.head, headerSource.indexOf('Value𠮷'), 'Header clicks retain UTF-16 source positions after math and Japanese text.');
      assert.equal(headerState.doc.toString(), headerSource);
    } finally {
      widget.remove();
    }
  }
  // Math masking leaves only two header columns, so a four-column delimiter
  // does not describe a table in either Live or reading mode.
  const ambiguous = '| $|x|$ | B |\n| --- | --- | --- | --- |\n| 1 | 2 | 3 | 4 |\n\nCaret';
  assert.equal(tables(stateFor(ambiguous)).length, 0);
});

test('a reused widget resolves cell clicks against current source offsets after earlier edits', () => {
  let state = stateFor(`Before\n\n${simpleTable}\n\nCaret`);
  const original = tables(state)[0].widget;
  let focused = false;
  const view = {
    dom: dom.window.document.body,
    get state() { return state; },
    compositionStarted: false, composing: false,
    posAtDOM: () => getLiveTableRanges(state)[0].from,
    dispatch: (spec: Parameters<EditorState['update']>[0]) => { state = state.update(spec).state; },
    focus: () => { focused = true; },
  } as unknown as EditorView;
  const element = original.toDOM(view);
  dom.window.document.body.append(element);
  try {
    state = state.update({ changes: { from: 0, insert: 'New paragraph\n\n' } }).state;
    assert.equal(original.eq(tables(state)[0].widget), true, 'Equivalent content may reuse the old DOM.');
    const target = element.querySelectorAll('tbody td')[1];
    target.dispatchEvent(new dom.window.MouseEvent('mousedown', { bubbles: true, button: 0 }));
    assert.equal(state.selection.main.head, state.doc.toString().indexOf('one'));
    assert.equal(tables(state).length, 0);
    assert.equal(focused, true);
    assert.equal(state.doc.toString(), `New paragraph\n\nBefore\n\n${simpleTable}\n\nCaret`);
  } finally {
    element.remove();
  }
});

test('the Edit table control reveals the first cell without adding an edit', () => {
  let state = stateFor(`${simpleTable}\n\nCaret`);
  const before = state.doc.toString();
  const view = {
    dom: dom.window.document.body,
    get state() { return state; },
    compositionStarted: false, composing: false,
    posAtDOM: () => 0,
    dispatch: (spec: Parameters<EditorState['update']>[0]) => { state = state.update(spec).state; },
    focus() {},
  } as unknown as EditorView;
  const element = tables(state)[0].widget.toDOM(view);
  dom.window.document.body.append(element);
  try {
    element.querySelector('button')!.click();
    assert.equal(state.selection.main.head, before.indexOf('Name'));
    assert.equal(state.doc.toString(), before);
    assert.equal(tables(state).length, 0);
  } finally {
    element.remove();
  }
});

test('math-header tables own all formatting while rendered and while their source is revealed', () => {
  const source = '| $|x|$ | **B** |\n| --- | --- |\n| *A* | target |\n\nCaret';
  let state = stateFor(source);
  for (const anchor of [source.length, source.indexOf('target')]) {
    state = state.update({ selection: { anchor } }).state;
    const table = getLiveTableRanges(state)[0];
    const decorations: unknown[] = [];
    buildLiveDecorations(state, [{ from: 0, to: source.length }]).between(table.from, table.to,
      (from, to, decoration) => { decorations.push({ from, to, decoration }); });
    assert.deepEqual(decorations, [], 'Table source must not have independently hidden Markdown markers.');
    assert.equal(state.doc.toString(), source);
  }
});

test('composition maps existing widgets and defers new table presentation until completion', () => {
  let composing = false;
  const view = { get compositionStarted() { return composing; }, get composing() { return composing; } } as EditorView;
  let state = EditorState.create({
    doc: `${simpleTable}\n\nCaret`, selection: { anchor: simpleTable.length + 7 },
    extensions: [markdown({ base: markdownLanguage }), liveTables(() => view)],
  });
  const original = tables(state)[0].widget;
  composing = true;
  state = state.update({ changes: { from: 0, insert: '日本語\n\n' } }).state;
  assert.equal(state.field(liveTableState).pending, true);
  assert.equal(tables(state)[0].widget, original);
  assert.equal(tables(state)[0].from, '日本語\n\n'.length);
  state = state.update({ changes: { from: state.doc.length, insert: `\n\n${simpleTable}\n\nEnd` } }).state;
  assert.equal(tables(state).length, 1, 'Composition cannot create a new replacement over the IME-owned DOM.');
  composing = false;
  state = state.update({}).state;
  assert.equal(state.field(liveTableState).pending, false);
  assert.equal(getLiveTableRanges(state).length, 2);
  assert.equal(getLiveTableRanges(state)[0].from, '日本語\n\n'.length);
});

test('presentation toggles, cell editing, and undo preserve exact Markdown and line-ending serialization', () => {
  const mode = new Compartment();
  const source = `\ufeff${simpleTable}\n\nCaret`;
  let state = EditorState.create({
    doc: source, selection: { anchor: source.indexOf('one') },
    extensions: [history(), markdown({ base: markdownLanguage }), mode.of(liveTableState)],
  });
  const from = source.indexOf('one');
  state = state.update({ changes: { from, to: from + 3, insert: '二' }, userEvent: 'input.type' }).state;
  state = state.update({ selection: { anchor: state.doc.length } }).state;
  assert.equal(tables(state).length, 1);
  state = state.update({ effects: mode.reconfigure([]) }).state;
  assert.equal(state.field(liveTableState, false), undefined);
  state = state.update({ effects: mode.reconfigure(liveTableState) }).state;
  assert.equal(tables(state).length, 1);
  assert.equal(state.doc.sliceString(0, state.doc.length, '\r\n'), source.replace('one', '二').replaceAll('\n', '\r\n'));
  assert.equal(undo({ state, dispatch: transaction => { state = transaction.state; } }), true);
  assert.equal(state.doc.toString(), source);
  assert.equal(undo({ state, dispatch: transaction => { state = transaction.state; } }), false);
});
