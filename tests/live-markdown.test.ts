import assert from 'node:assert/strict';
import test from 'node:test';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { EditorSelection, EditorState } from '@codemirror/state';
import { buildLiveDecorations, findLiveHeading } from '../src/renderer/liveMarkdown';

function stateFor(doc: string, selection = EditorSelection.cursor(doc.length)) {
  return EditorState.create({
    doc, selection: EditorSelection.create([selection]),
    extensions: [markdown({ base: markdownLanguage }), EditorState.allowMultipleSelections.of(true)],
  });
}

function decorations(state: EditorState, ranges = [{ from: 0, to: state.doc.length }]) {
  const result: { from: number; to: number; text: string; marker: boolean; className: string }[] = [];
  buildLiveDecorations(state, ranges).between(0, state.doc.length, (from, to, value) => {
    result.push({ from, to, text: state.sliceDoc(from, to), marker: value.spec.liveMarker === true, className: value.spec.class ?? value.spec.attributes?.class ?? '' });
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

test('keeps code, tables, HTML, links, images, wiki links, and escaped syntax editable as raw Markdown', () => {
  const fallback = [
    '```md\n# **Not a heading**\n```',
    '~~~md\n> *Not a quote*\n~~~',
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
