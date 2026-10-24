import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { JSDOM } from 'jsdom';
import { EditorSelection, EditorState } from '@codemirror/state';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { ensureSyntaxTree } from '@codemirror/language';
import { type EditorView, type WidgetType } from '@codemirror/view';
import { buildLiveLinkDecorations, getLiveLinks, isLiveLinkHref, isLiveLinkOpenGesture, liveLinkNavigation } from '../src/renderer/liveLinks';
import { liveMathState } from '../src/renderer/liveMath';
import { liveTableState } from '../src/renderer/liveTables';
import { findLiveHeading } from '../src/renderer/liveMarkdown';
import { renderMarkdownDocument } from '../src/renderer/markdown';

const dom = new JSDOM('<!doctype html><body></body>');
Object.defineProperty(globalThis, 'window', { value: dom.window, configurable: true });
after(() => dom.window.close());

function stateFor(doc: string, position = doc.length, onOpen = (_href: string) => {}) {
  const state = EditorState.create({ doc, selection: { anchor: position }, extensions: [
    markdown({ base: markdownLanguage }), liveMathState, liveTableState,
    EditorState.allowMultipleSelections.of(true), liveLinkNavigation.of(onOpen),
  ] });
  ensureSyntaxTree(state, doc.length, 100);
  return state;
}
const links = (state: EditorState) => getLiveLinks(state, [{ from: 0, to: state.doc.length }]);
function decorations(state: EditorState) {
  const result: { from: number; to: number; widget?: WidgetType; tagName?: string }[] = [];
  buildLiveLinkDecorations(state, [{ from: 0, to: state.doc.length }]).between(0, state.doc.length, (from, to, value) => {
    result.push({ from, to, widget: value.spec.widget, tagName: value.spec.tagName });
  });
  return result;
}

test('Live renders Markdown, formatted labels, autolinks, and wiki aliases through the Read parser', () => {
  const doc = '[**日本語** &amp; `code`](Notes/a%2525.md#section "Title")\n\n'
    + '<https://example.com/a?x=1&y=2>\n\nhttps://example.com/b\n\n'
    + '[[Notes/100%25#part|Alias]]\n\nCaret';
  const state = stateFor(doc);
  assert.deepEqual(links(state).map(link => link.href), [
    'Notes/a%2525.md#section', 'https://example.com/a?x=1&y=2', 'https://example.com/b',
    'prism-note:Notes%2F100%2525%23part',
  ]);
  const first = links(state)[0];
  assert.match(first.html, /<strong>日本語<\/strong> &amp; <code>code<\/code>/);
  assert.equal(decorations(state).every(item => !!item.widget), true);
  assert.equal(state.doc.toString(), doc);
});

test('references use document-global definitions and update when destinations are edited', () => {
  const doc = '[Full][name] and [name][] and [name]\n\nCaret\n\n> [name]: <First%20note.md> "Title"';
  let state = stateFor(doc, doc.indexOf('Caret'));
  assert.deepEqual(links(state).map(link => link.href), Array(3).fill('First%20note.md'));
  const from = doc.indexOf('First%20note');
  state = state.update({ changes: { from, to: from + 'First%20note'.length, insert: 'Other' } }).state;
  assert.deepEqual(links(state).map(link => link.href), Array(3).fill('Other.md'));
  assert.equal(links(stateFor('[Unknown][missing]\n\nCaret')).length, 0);
});

test('code, images, math, definitions, and escaped examples never become live links', () => {
  for (const raw of [
    '`[x](note.md)`', '```md\n[x](note.md)\n[[note]]\n```', '    [x](note.md)',
    '![image](note.md)', '![[note]]', '\\[[note]]', '\\[label](note.md)',
    '<div>\n[x](note.md)\n</div>', '$[x](note.md)$', '$$\n[x](note.md)\n$$',
    '[id]: https://example.com',
  ]) assert.equal(links(stateFor(raw + '\n\nCaret')).length, 0, raw);
  const mixed = stateFor('$x$ and [real](note.md)\n\nCaret');
  assert.deepEqual(links(mixed).map(link => link.href), ['note.md']);
});

test('active selections expose complete source and multiline links keep line breaks', () => {
  const doc = '[first](one.md)\n\n[second](two.md)\n\n[multi\nline](three.md)\n\nCaret';
  const state = stateFor(doc);
  assert.equal(decorations(state).filter(item => !!item.widget).length, 2);
  const selected = state.update({ selection: EditorSelection.create([
    EditorSelection.cursor(2), EditorSelection.cursor(doc.indexOf('second') + 1),
  ]) }).state;
  assert.equal(decorations(selected).some(item => !!item.widget), false);
  assert.equal(decorations(selected).length, 3);
  assert.equal(selected.doc.toString(), doc);
  for (const item of decorations(state).filter(item => item.widget)) assert.equal(state.sliceDoc(item.from, item.to).includes('\n'), false);
});

test('only safe sanitized destinations and labels are actionable', () => {
  for (const href of ['javascript:alert(1)', 'data:text/html,hello', 'file:///etc/passwd', ' custom:thing', 'https://example.com\n']) {
    assert.equal(isLiveLinkHref(href), false, href);
  }
  for (const href of ['note.md', '#section', '//example.com', 'https://example.com', 'mailto:a@example.com', 'prism-note:note', '']) {
    assert.equal(isLiveLinkHref(href), true, href);
  }
  assert.equal(links(stateFor('[bad](javascript:alert%281%29)\n\nCaret')).length, 0);
  const safe = links(stateFor('[<img src="x" onerror="alert(1)" alt="label">](note.md)\n\nCaret'));
  assert.equal(safe.length, 1);
  assert.equal(safe[0].html, 'label');
});

test('Ctrl or Command left-click opens once, ordinary click reveals source, and stale widgets do not open', () => {
  const opened: string[] = [];
  let state = stateFor('[**label**](note.md)\n\nCaret', undefined, href => opened.push(href));
  const fakeView = {
    dom: dom.window.document.body, get state() { return state; },
    composing: false, compositionStarted: false, posAtDOM: () => 0,
    dispatch: (transaction: Parameters<EditorState['update']>[0]) => { state = state.update(transaction).state; },
    focus: () => {},
  };
  const widget = decorations(state)[0].widget!;
  const anchor = widget.toDOM(fakeView as unknown as EditorView);
  dom.window.document.body.append(anchor);
  const click = (options: MouseEventInit) => anchor.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true, ...options }));
  assert.equal(click({ ctrlKey: true }), false);
  assert.deepEqual(opened, ['note.md']);
  click({ button: 1, ctrlKey: true });
  fakeView.composing = true;
  click({ ctrlKey: true });
  assert.deepEqual(opened, ['note.md']);
  fakeView.composing = false;
  click({});
  assert.equal(state.selection.main.head, 1);
  assert.equal(decorations(state)[0].widget, undefined);
  const from = state.doc.toString().indexOf('note.md');
  state = state.update({ changes: { from, to: from + 7, insert: 'other.md' } }).state;
  click({ ctrlKey: true });
  assert.deepEqual(opened, ['note.md']);
  anchor.remove();
  for (const options of [{ button: 1, ctrlKey: true }, { button: 2, ctrlKey: true }, { ctrlKey: true, altKey: true }, {}]) {
    assert.equal(isLiveLinkOpenGesture(new dom.window.MouseEvent('click', options) as unknown as MouseEvent), false);
  }
});

test('visible link offsets follow preceding edits and table links are owned by their table widget', () => {
  const doc = 'Before\n\n[open](note.md)\n\n| Column |\n| --- |\n| [cell](table.md) |\n\nCaret';
  let state = stateFor(doc);
  assert.deepEqual(links(state).map(link => link.href), ['note.md']);
  state = state.update({ changes: { from: 0, insert: '日本語\n' } }).state;
  const position = state.doc.toString().indexOf('[open]');
  assert.equal(getLiveLinks(state, [{ from: position, to: position }])[0].from, position);
});

test('revealed table links stay clickable source on every row without replacing cell contents', () => {
  const doc = '| [Heading](header.md) | Other |\n| --- | --- |\n| [First](first.md) | [Second](second.md) |\n\nCaret';
  const rendered = stateFor(doc);
  assert.deepEqual(links(rendered), [], 'An inactive table owns its rendered links.');
  for (const position of [doc.indexOf('Heading'), doc.indexOf('---'), doc.indexOf('Second')]) {
    const state = rendered.update({ selection: { anchor: position } }).state;
    assert.deepEqual(links(state).map(link => link.href), ['header.md', 'first.md', 'second.md']);
    assert.equal(decorations(state).length, 3);
    assert.equal(decorations(state).some(decoration => !!decoration.widget), false, 'Even rows without the caret retain complete table source.');
    assert.equal(state.doc.toString(), doc);
  }
});

test('Live fragment heading metadata includes all six levels and excludes raw HTML headings', () => {
  const doc = '# Start\n\n<div><h2 id="fake">Fake</h2></div>\n\n#### Deep\n\n###### Deep\n\nCaret';
  const rendered = renderMarkdownDocument(doc);
  assert.deepEqual(rendered.allHeadings.map(heading => heading.id), ['start', 'deep', 'deep-1']);
  assert.equal(rendered.headings.length, 1);
  assert.equal(findLiveHeading(stateFor(doc), 2, 50, 6), doc.indexOf('###### Deep'));
});
