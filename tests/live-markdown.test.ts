import assert from 'node:assert/strict';
import test from 'node:test';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { EditorSelection, EditorState } from '@codemirror/state';
import { buildLiveDecorations, findLiveHeading, liveTaskChange } from '../src/renderer/liveMarkdown';

function stateFor(doc: string, selection = EditorSelection.cursor(doc.length)) {
  return EditorState.create({
    doc, selection: EditorSelection.create([selection]),
    extensions: [markdown({ base: markdownLanguage }), EditorState.allowMultipleSelections.of(true)],
  });
}

function decorations(state: EditorState, ranges = [{ from: 0, to: state.doc.length }]) {
  const result: { from: number; to: number; text: string; marker: boolean; fence: boolean; task: boolean; className: string }[] = [];
  buildLiveDecorations(state, ranges).between(0, state.doc.length, (from, to, value) => {
    result.push({
      from, to, text: state.sliceDoc(from, to), marker: value.spec.liveMarker === true,
      fence: value.spec.liveFence === true, task: value.spec.liveTask === true,
      className: value.spec.class ?? value.spec.attributes?.class ?? '',
    });
  });
  return result;
}

test('renders all ATX heading levels while hiding only their Markdown markers', () => {
  const text = ['# One', '## Two ##', '### Three', '#### Four', '##### Five', '###### Six', '', 'Caret here'].join('\n');
  const state = stateFor(text);
  const result = decorations(state);
  for (let level = 1; level <= 6; level++) {
    assert.ok(result.some(item => item.className.split(' ').includes(`cm-live-heading-${level}`)), `Heading level ${level} is formatted.`);
  }
  const hidden = result.filter(item => item.marker);
  assert.ok(hidden.some(item => item.text.trim() === '#'));
  assert.ok(hidden.some(item => item.text.trim() === '######'));
  assert.ok(hidden.every(item => /^[ #]+$/.test(item.text)));
  assert.equal(state.doc.toString(), text, 'Rendering must not rewrite the Markdown document.');
});

test('formats inline Markdown and block quotes without hiding their contents', () => {
  const state = stateFor('**bold** and *emphasis* and ~~gone~~ and `code`\n\n> Quoted words\n\nCaret here');
  const result = decorations(state);
  for (const name of ['strong', 'emphasis', 'strike', 'code', 'quote']) {
    assert.ok(result.some(item => item.className.split(' ').includes(`cm-live-${name}`)), `${name} has its own style.`);
  }
  const hidden = result.filter(item => item.marker).map(item => item.text.trim());
  assert.deepEqual(hidden.sort(), ['**', '**', '*', '*', '~~', '~~', '`', '`', '>'].sort());
});

test('the caret reveals every marker on its line while preserving formatting', () => {
  const doc = '# A **bold** title\n\n*Another line*\n\nCaret here';
  const state = stateFor(doc, EditorSelection.cursor(doc.indexOf('bold') + 2));
  const result = decorations(state);
  assert.ok(result.some(item => item.className.includes('cm-live-heading-1')));
  assert.equal(result.filter(item => item.marker && item.from < doc.indexOf('\n')).length, 0);
  assert.deepEqual(result.filter(item => item.marker).map(item => item.text), ['*', '*']);
});

test('all lines touched by a selection reveal markers, including multiple cursors', () => {
  const doc = '**first**\n*second*\n~~third~~\n\nCaret here';
  const state = stateFor(doc, EditorSelection.range(2, doc.indexOf('second') + 3));
  assert.deepEqual(decorations(state).filter(item => item.marker).map(item => item.text), ['~~', '~~']);
  const multiple = state.update({ selection: EditorSelection.create([
    EditorSelection.cursor(2), EditorSelection.cursor(doc.indexOf('third') + 2),
  ]) }).state;
  assert.deepEqual(decorations(multiple).filter(item => item.marker).map(item => item.text), ['*', '*']);
});

test('keeps indented code, tables, HTML, links, images, wiki links, and escaped syntax editable as raw Markdown', () => {
  const fallback = [
    '    # **Indented code**',
    '| **Column** |\n| --- |\n| *Cell* |',
    '<div>\n# **Raw HTML**\n</div>',
    '[**link label**](https://example.com)',
    '![*image label*](image.png)',
    '[[A **wiki label**]]',
    '<https://example.com/path_with_underscores>',
    '\\# Plain heading and \\*literal stars\\*',
  ];
  for (const raw of fallback) {
    const state = stateFor(`${raw}\n\nCaret here`);
    assert.deepEqual(decorations(state).filter(item => item.marker), [], raw);
  }
  // Backticks inside a code span are literal content; only the outer pair hides.
  const code = stateFor('``**literal** and `backtick` ``\n\nCaret here');
  assert.deepEqual(decorations(code).filter(item => item.marker).map(item => item.text), ['``', '``']);
});

test('formats fenced code including blank lines without interpreting its literal Markdown body', () => {
  const text = '# Example\n\n```java\nclass Demo {\n\n  // **literal** - [ ] text\n}\n```\n\n~~~md\n# **Not a heading**\n> *Not a quote*\n- [x] Not a task\n~~~\n\nCaret here';
  const state = stateFor(text);
  const result = decorations(state);
  const codeLines = result.filter(item => item.className.split(' ').includes('cm-live-codeblock'));
  assert.equal(codeLines.length, 11, 'Both fences, every content line, and the blank code line are styled.');
  const blank = text.indexOf('\n\n  //') + 1;
  assert.ok(codeLines.some(item => item.from === blank), 'Empty code lines retain the block surface.');
  assert.deepEqual(result.filter(item => item.fence).map(item => item.text), ['```java', '```', '~~~md', '~~~']);
  assert.equal(result.filter(item => /cm-live-heading-/.test(item.className)).length, 1);
  assert.equal(result.filter(item => item.task || /cm-live-(?:strong|emphasis|quote)/.test(item.className)).length, 0);
  assert.equal(state.doc.toString(), text);
});

test('fence boundaries reveal source on selected lines without hiding a line break or code content', () => {
  const doc = '```java\nclass Demo {}\n```\n\nCaret here';
  const openingActive = stateFor(doc, EditorSelection.cursor(3));
  assert.deepEqual(decorations(openingActive).filter(item => item.fence).map(item => item.text), ['```']);
  const allSelected = stateFor(doc, EditorSelection.range(0, doc.length));
  assert.deepEqual(decorations(allSelected).filter(item => item.marker), []);
  for (const replacement of decorations(stateFor(doc)).filter(item => item.marker)) {
    assert.ok(replacement.to > replacement.from);
    assert.equal(replacement.text.includes('\n'), false);
    assert.equal(replacement.text.includes('class Demo'), false);
  }
});

test('an unfinished fence remains literal code and never invents a closing boundary', () => {
  const doc = 'Before\n\n```md\n# This is code\n- [ ] Also code\n';
  const result = decorations(stateFor(doc, EditorSelection.cursor(0)));
  assert.deepEqual(result.filter(item => item.fence).map(item => item.text), ['```md']);
  assert.equal(result.filter(item => item.task || /cm-live-heading-/.test(item.className)).length, 0);
});

test('only parsed task lists get checkboxes, including nested and uppercase completed tasks', () => {
  const doc = '- [ ] First **task**\n- [x] Finished\n  - [X] Nested\n\n> - [ ] Quoted\n\n[ ] Plain text\n- \\[ ] Escaped\n\n`- [ ] Inline code`\n\nCaret here';
  const result = decorations(stateFor(doc));
  const tasks = result.filter(item => item.task);
  assert.equal(tasks.length, 4);
  assert.ok(tasks.every(item => item.marker && /\[[ xX]\]/.test(item.text)));
  assert.ok(tasks.every(item => !item.text.includes('\n')));
  assert.ok(result.some(item => item.className.includes('cm-live-strong') && item.text.includes('task')));
  const active = decorations(stateFor(doc, EditorSelection.cursor(doc.indexOf('First'))));
  const activeTask = active.filter(item => item.task && item.from < doc.indexOf('\n'));
  assert.equal(activeTask.length, 1, 'The task remains clickable while editing its text.');
  assert.equal(activeTask[0].from, activeTask[0].to, 'An active line keeps the complete editable Markdown marker.');
  assert.equal(activeTask[0].marker, false);
});

test('toggling a task changes only its checkbox character and validates current Markdown context', () => {
  const doc = '- [ ] First task\n- [X] Finished\n\n```md\n- [ ] Code task\n```\n\n[ ] Plain text\n';
  const state = stateFor(doc);
  const first = doc.indexOf('[ ]');
  const change = liveTaskChange(state, first, true);
  assert.ok(change);
  const checked = state.update({ changes: change }).state;
  assert.equal(checked.doc.toString(), doc.replace('- [ ] First', '- [x] First'));
  assert.equal(liveTaskChange(checked, first, true), null, 'An already checked task does not create an edit.');
  const undone = liveTaskChange(checked, first, false);
  assert.ok(undone);
  assert.equal(checked.update({ changes: undone }).state.doc.toString(), doc);
  const upper = doc.indexOf('[X]');
  assert.equal(liveTaskChange(state, upper, true), null);
  const clearUpper = liveTaskChange(state, upper, false);
  assert.ok(clearUpper);
  assert.equal(state.update({ changes: clearUpper }).state.doc.toString(), doc.replace('[X]', '[ ]'));
  for (const position of [-1, 0.5, first + 1, doc.indexOf('[ ] Code'), doc.indexOf('[ ] Plain'), doc.length]) {
    assert.equal(liveTaskChange(state, position, true), null, `Position ${position} is not an editable task marker.`);
  }
  const readOnly = EditorState.create({ doc, extensions: [markdown({ base: markdownLanguage }), EditorState.readOnly.of(true)] });
  assert.equal(liveTaskChange(readOnly, first, true), null);
});

test('never replaces line breaks when formatting multiline emphasis or nested quotes', () => {
  const state = stateFor('**first line\nsecond line**\n\n> > Nested **quote**\n\nCaret here');
  const hidden = decorations(state).filter(item => item.marker);
  assert.ok(hidden.length > 0);
  for (const range of hidden) {
    assert.ok(range.to > range.from);
    assert.equal(range.text.includes('\n'), false);
  }
});

test('outline navigation follows heading order, including raw setext headings and duplicate titles', () => {
  const doc = '# Repeated\n\n```md\n## Fake\n```\n\n#### Not in outline\n\nSetext title\n------------\n\n### Repeated\n';
  const state = stateFor(doc);
  assert.equal(findLiveHeading(state, 0), 0);
  assert.equal(findLiveHeading(state, 1), doc.indexOf('Setext title'));
  assert.equal(findLiveHeading(state, 2), doc.indexOf('### Repeated'));
  for (const index of [-1, 3, 100]) assert.equal(findLiveHeading(state, index), null);
});

test('outline lookup can resume parsing a large note without changing the document or selection', async () => {
  const doc = '# Start\n\n' + 'A paragraph with **formatted words**.\n\n'.repeat(10_000) + '## Distant heading\n';
  const state = stateFor(doc, EditorSelection.cursor(0));
  const deadline = Date.now() + 5_000;
  let destination: number | null = null;
  do {
    destination = findLiveHeading(state, 1, 1);
    if (destination !== null) break;
    await new Promise<void>(resolve => setImmediate(resolve));
  } while (Date.now() < deadline);
  assert.equal(destination, doc.indexOf('## Distant heading'));
  assert.equal(state.doc.toString(), doc);
  assert.equal(state.selection.main.head, 0);
});
