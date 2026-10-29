import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { JSDOM } from 'jsdom';
import type { Note } from '../src/shared/types';
import { extractLinks, extractPDFPageLinks, getBacklinks, renderMarkdown, resolveNoteLink } from '../src/renderer/markdown';
import { parsePDFPageLink } from '../src/shared/pdfLinks';
import { getPDFBacklinks } from '../src/renderer/pdfBacklinks';

const firstId = '12345678-9abc-4234-8234-123456789abc';
const secondId = 'abcdef12-3456-4789-8123-abcdef123456';
const href = (page: number, id = firstId) => `prism-pdf://v1/documents/${id}?page=${page}`;
const link = (page: number, id = firstId, label = 'Reference') => `[${label}](${href(page, id)})`;
const note = (path: string, content: string): Note => ({ path, content, modified: 1 });
const dom = new JSDOM('<!doctype html><html><body></body></html>');
Object.defineProperty(globalThis, 'window', { value: dom.window, configurable: true });
after(() => dom.window.close());

test('extracts real inline, reference and autolinks using normalized document identity', () => {
  const source = [
    link(2), `[Renamed title](${href(2).toUpperCase()})`,
    `[Reference][pdf]`, `<${href(3)}>`, link(1, secondId),
    `[pdf]: ${href(10)}`, `[unused]: ${href(99)}`,
  ].join('\n\n');
  assert.deepEqual(extractPDFPageLinks(source), [
    { documentId: firstId, page: 2 }, { documentId: firstId, page: 10 },
    { documentId: firstId, page: 3 }, { documentId: secondId, page: 1 },
  ]);
});

test('finds citations in nested quotes, lists, formatting and table cells with global definitions', () => {
  const source = [
    `> - **${link(1)}**`,
    '>',
    '>   | Citation |',
    '>   | --- |',
    '>   | [Table][table] |',
    '',
    `1. First`,
    `   - ${link(3)}`,
    '',
    `| ${link(4)} |`,
    '| --- |',
    '| [Nested][quote] |',
    '',
    `[table]: ${href(2)}`,
    `> [quote]: ${href(5)}`,
  ].join('\n');
  assert.deepEqual(extractPDFPageLinks(source), [1, 2, 3, 4, 5].map(page => ({ documentId: firstId, page })));
});

test('destination character references match Read anchors exactly once, including autolink escaping', () => {
  const prefix = href(2).slice(0, -1);
  const sources = [
    `[Numeric](${prefix}&#50;)`, `[Hex](${prefix}&#x32;)`,
    `[Reference][encoded]\n\n[encoded]: ${prefix}&#50;`,
    `[Named](prism-pdf&colon;&sol;&sol;v1&sol;documents&sol;${firstId}&quest;page&equals;2)`,
    `[Double numeric](${prefix}&#38;#50;)`, `[Double named](${prefix}&amp;#50;)`,
    `[Escaped percent](${prefix}%32)`, `[Incomplete](${prefix}&#50)`,
    `[Too many digits](${prefix}&#00000050;)`, `<${prefix}&#50;>`,
    `[Markup](prism-pdf://v1/documents/${firstId}?page=2&quoT;&gt;&lt;img&sol;src=x&gt;)`,
  ];
  for (const source of sources) {
    const rendered = JSDOM.fragment(renderMarkdown(source));
    const expected = [...rendered.querySelectorAll('a[href]')]
      .map(anchor => parsePDFPageLink(anchor.getAttribute('href')!)).filter(target => target !== null);
    assert.deepEqual(extractPDFPageLinks(source), expected, source);
  }
  for (const source of sources.slice(0, 4)) {
    assert.deepEqual(extractPDFPageLinks(source), [{ documentId: firstId, page: 2 }], source);
  }
  for (const source of sources.slice(4)) assert.deepEqual(extractPDFPageLinks(source), [], source);
});

test('does not index code, math, images, wiki text, escaped syntax or raw HTML examples', () => {
  const citation = link(2);
  const examples = [
    `\`${citation}\``, `\`\`\`markdown\n${citation}\n\`\`\``, `    ${citation}`,
    `![Image](${href(2)})`, `![Image ${citation}](image.png)`,
    `[[${href(2)}]]`, `![[${href(2)}]]`, `\\${citation}`,
    `<a href="${href(2)}">Raw link</a>`,
    `<div>\n${citation}\n</div>`, `<pre>${citation}</pre>`,
    `<!-- ${citation} -->`, `<script>${citation}</script>`,
    `$\\text{${citation}}$`, `$$\n\\text{${citation}}\n$$`,
    `\\(\\text{${citation}}\\)`, `\\[\n\\text{${citation}}\n\\]`,
    `[unused]: ${href(2)}`,
  ];
  for (const example of examples) assert.deepEqual(extractPDFPageLinks(example), [], example);
  assert.deepEqual(extractPDFPageLinks(`${examples.join('\n\n')}\n\n${link(1)}`), [{ documentId: firstId, page: 1 }]);
});

test('ignores malformed and unsupported destinations rather than inferring titles or filenames', () => {
  const invalid = [
    href(0), href(-1), href(1.5), href(Number.MAX_SAFE_INTEGER + 1),
    href(2).replace('/v1/', '/v2/'), `${href(2)}&extra=1`, `${href(2)}#page=1`,
    href(2).replace(firstId, 'Reference'), href(2).replace(firstId, `${firstId}.pdf`),
    href(2).replace('page=2', 'page=%32'), 'file:///documents/Reference.pdf#page=2',
    'Reference.pdf#page=2', 'https://example.com/Reference.pdf#page=2',
  ];
  const source = invalid.map(target => `[Reference](${target})`).join('\n\n');
  assert.deepEqual(extractPDFPageLinks(source), []);
  assert.equal(getPDFBacklinks([note('Reference.md', `# Reference\n\n${source}`)]).size, 0);
});

test('groups unique pages per note and PDF, preserving duplicate titles and deterministic path order', () => {
  const source = [
    note('研究/考察.md', `# 同じ題名\n\n${link(10)} ${link(2)} ${link(2)} ${link(1)} ${link(4, secondId, 'Same PDF title')}`),
    note('Other.md', `# 同じ題名\n\n${link(3, firstId, 'Same PDF title')} ${link(1, secondId)}`),
    note('Unlinked.md', '# Reference'),
  ];
  const result = getPDFBacklinks(source);
  assert.deepEqual(result.get(firstId), [
    { path: 'Other.md', title: '同じ題名', pages: [3] },
    { path: '研究/考察.md', title: '同じ題名', pages: [1, 2, 10] },
  ]);
  assert.deepEqual(result.get(secondId), [
    { path: 'Other.md', title: '同じ題名', pages: [1] },
    { path: '研究/考察.md', title: '同じ題名', pages: [4] },
  ]);
  assert.deepEqual([...getPDFBacklinks([...source].reverse()).get(firstId)!], result.get(firstId));
});

test('draft additions, title edits, undo and removals update the current snapshot without altering notes', () => {
  const saved = note('Reading.md', `# Original\n\n${link(1)}`);
  const other = note('Other.md', `# Other\n\n${link(2)}`);
  const original = saved.content;
  assert.deepEqual(getPDFBacklinks([saved, other]).get(firstId)?.find(value => value.path === saved.path)?.pages, [1]);
  const draft = { ...saved, content: `# 新しい題名\n\n${link(10)} ${link(2)}` };
  assert.deepEqual(getPDFBacklinks([draft, other]).get(firstId), [
    { path: 'Other.md', title: 'Other', pages: [2] },
    { path: 'Reading.md', title: '新しい題名', pages: [2, 10] },
  ]);
  assert.deepEqual(getPDFBacklinks([saved, other]).get(firstId)?.find(value => value.path === saved.path)?.pages, [1]);
  assert.deepEqual(getPDFBacklinks([{ ...draft, content: '# No citation' }, other]).get(firstId), [
    { path: 'Other.md', title: 'Other', pages: [2] },
  ]);
  assert.equal(saved.content, original);
});

test('content-guarded cache and notebook replacement cannot expose stale paths or citations', () => {
  const mutable = note('Reading.md', link(1));
  assert.equal(getPDFBacklinks([mutable]).has(firstId), true);
  mutable.content = link(2, secondId);
  const changed = getPDFBacklinks([mutable]);
  assert.equal(changed.has(firstId), false);
  assert.deepEqual(changed.get(secondId), [{ path: 'Reading.md', title: 'Reading', pages: [2] }]);

  const replacement = [note('Reading.md', '# Another notebook'), note('別名.md', link(4))];
  assert.deepEqual(getPDFBacklinks(replacement).get(firstId), [{ path: '別名.md', title: '別名', pages: [4] }]);
  assert.equal(getPDFBacklinks(replacement).has(secondId), false);
  assert.equal(getPDFBacklinks([]).size, 0);
  const renamed = { ...replacement[1], path: '新しい名前.md' };
  assert.deepEqual(getPDFBacklinks([renamed]).get(firstId), [{ path: renamed.path, title: '新しい名前', pages: [4] }]);
});

test('PDF indexing keeps ordinary note graph and backlink identities unchanged', () => {
  const reading = note('Reading.md', '# Reference');
  const source = note('Source.md', `${link(2, firstId, 'Reading')} [Note](Reading.md) [[Reading]]`);
  const notes = [source, reading];
  assert.deepEqual(extractLinks(source.content), ['Reading.md', 'prism-note:Reading']);
  assert.deepEqual(getBacklinks(reading.path, notes), [source]);
  assert.equal(resolveNoteLink(href(2), source.path, notes), undefined);
  assert.deepEqual(getPDFBacklinks(notes).get(firstId), [{ path: source.path, title: 'Source', pages: [2] }]);
});
