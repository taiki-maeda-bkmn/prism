import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { JSDOM } from 'jsdom';
import { extractLinks, getBacklinks, getNoteLinks, getTitle, renderMarkdown, renderMarkdownDocument, resolveLink, resolveNoteLink } from '../src/renderer/markdown';
import type { Note } from '../src/shared/types';

const dom = new JSDOM('<!doctype html><html><body></body></html>');
Object.defineProperty(globalThis, 'window', { value: dom.window, configurable: true });
after(() => dom.window.close());

const note = (path: string, content = ''): Note => ({ path, content, modified: 1 });

test('extracts wiki links, aliases, Markdown references, lists and tables', () => {
  const content = `# Connections
[[Garden]] and [[Ideas/Slow mornings|A different title]].
[Research](Ideas/Research%20notes.md#reading) and [reference][ref].
- [[Inside a list]]

| Thought |
| --- |
| [[In a table]] |

[ref]: ./Reading.md
`;
  assert.deepEqual(extractLinks(content), ['prism-note:Garden', 'prism-note:Ideas%2FSlow%20mornings', 'Ideas/Research%20notes.md#reading', './Reading.md', 'prism-note:Inside%20a%20list', 'prism-note:In%20a%20table']);
});

test('code, images, embeds and external URLs do not create graph links', () => {
  const content = '\\[[Escaped]] `[[Inline code]]`\n\n```md\n[[Fenced code]]\n[fenced](Fenced.md)\n```\n\n    [[Indented code]]\n\n![image](Photo.md) ![[Embedded.md]] ![Image with [[caption]]](photo.png)\n[external](https://example.com/a.md) [[https://example.com/a.md]] [mail](mailto:a@example.com) [web](//example.com/a.md) [section](#heading)\n[[Real]]';
  assert.deepEqual(extractLinks(content), ['prism-note:Real']);
});

test('wiki preview, graph links and backlinks preserve literal percent escapes and Unicode filenames', () => {
  const targets = ['Percent%', 'Percent%25', 'Space%20name', 'Space name', 'Literal%2Fslash', 'Literal/slash', '資料/進捗%25'];
  for (const target of targets) {
    const source = note('Source.md', `[[${target}|Readable label]]`);
    const notes = [source, ...targets.map(path => note(`${path}.md`))];
    const href = JSDOM.fragment(renderMarkdown(source.content)).querySelector('a')?.getAttribute('href');
    assert.ok(href);
    assert.equal(resolveLink(href, source.path, notes)?.path, `${target}.md`, `preview: ${target}`);
    assert.deepEqual(extractLinks(source.content), [href]);
    assert.deepEqual(getNoteLinks(source).map(link => resolveLink(link, source.path, notes)?.path), [`${target}.md`], `graph: ${target}`);
    for (const candidate of targets) {
      assert.deepEqual(getBacklinks(`${candidate}.md`, notes).map(item => item.path), candidate === target ? ['Source.md'] : [], `backlinks: ${target} → ${candidate}`);
    }
  }
});

test('Markdown URI paths decode once while encoded separators remain filename characters', () => {
  const cases = [
    ['Percent%25.md', 'Percent%.md'],
    ['Percent%2525.md', 'Percent%25.md'],
    ['Space%20name.md', 'Space name.md'],
    ['Space%2520name.md', 'Space%20name.md'],
    ['Literal%252Fslash.md', 'Literal%2Fslash.md'],
    ['Literal/slash.md', 'Literal/slash.md'],
    ['Topic%23part.md#section', 'Topic#part.md'],
    ['Topic.md?mode=read#section', 'Topic.md'],
    ['%E8%B3%87%E6%96%99/%E9%80%B2%E6%8D%97%2525.md', '資料/進捗%25.md'],
  ];
  for (const [href, expected] of cases) {
    const source = note('Source.md', `[Link](${href})`);
    const notes = [source, ...cases.map(([, path]) => note(path))];
    const previewHref = JSDOM.fragment(renderMarkdown(source.content)).querySelector('a')?.getAttribute('href');
    assert.ok(previewHref);
    assert.equal(resolveLink(previewHref, source.path, notes)?.path, expected, `preview: ${href}`);
    assert.deepEqual(getNoteLinks(source).map(link => resolveLink(link, source.path, notes)?.path), [expected], `graph: ${href}`);
    assert.deepEqual(getBacklinks(expected, notes).map(item => item.path), ['Source.md']);
  }
});

test('wiki links prefer literal hash filenames and retain heading fallback without treating question marks as queries', () => {
  const notes = [note('Source.md'), note('Topic.md'), note('Topic#part.md')];
  const resolveWiki = (target: string) => resolveLink(extractLinks(`[[${target}]]`)[0], 'Source.md', notes)?.path;
  assert.equal(resolveWiki('Topic#part'), 'Topic#part.md');
  assert.equal(resolveWiki('Topic#part#heading'), 'Topic#part.md');
  assert.equal(resolveWiki('Topic#other-heading'), 'Topic.md');
  assert.equal(resolveWiki('#heading'), 'Source.md');
  assert.equal(resolveWiki('Topic?query'), undefined);
  const href = JSDOM.fragment(renderMarkdown('[[Topic#part]]')).querySelector('a')?.getAttribute('href');
  assert.ok(href);
  assert.equal(resolveLink(href, 'Source.md', notes)?.path, 'Topic#part.md');
  const ambiguous = [note('Source.md'), note('Topic.md'), note('One/Topic#part.md'), note('Two/Topic#part.md')];
  assert.equal(resolveLink(href, 'Source.md', ambiguous), undefined);
});

test('note destinations retain URI fragments, decoding the path and fragment exactly once', () => {
  const source = note('Source.md');
  const other = note('Other.md');
  const escaped = note('Percent%25.md');
  const hash = note('Other#part.md');
  const notes = [source, other, escaped, hash];
  assert.deepEqual(resolveNoteLink('Other.md#setup', source.path, notes), { note: other, fragment: 'setup' });
  assert.deepEqual(resolveNoteLink('Other.md?read=true#setup', source.path, notes), { note: other, fragment: 'setup' });
  assert.deepEqual(resolveNoteLink('Other.md#setup?detail', source.path, notes), { note: other, fragment: 'setup?detail' });
  assert.deepEqual(resolveNoteLink('Percent%2525.md#part%2525', source.path, notes), { note: escaped, fragment: 'part%25' });
  assert.deepEqual(resolveNoteLink('Other%23part.md#%E6%97%A5%E6%9C%AC%E8%AA%9E', source.path, notes), { note: hash, fragment: '日本語' });
  assert.deepEqual(resolveNoteLink('Other%23part.md', source.path, notes), { note: hash });
  assert.deepEqual(resolveNoteLink('#setup', source.path, notes), { note: source, fragment: 'setup' });
  assert.deepEqual(resolveNoteLink('Other.md#', source.path, notes), { note: other, fragment: '' });
  assert.deepEqual(resolveNoteLink('Other.md#bad%escape', source.path, notes), { note: other, fragment: 'bad%escape' });
});

test('wiki heading destinations preserve literal hash filenames and all remaining fragment text', () => {
  const source = note('Source.md');
  const other = note('Other.md');
  const hash = note('Other#part.md');
  const escaped = note('Percent%25.md');
  const notes = [source, other, hash, escaped];
  const resolveWiki = (target: string) => {
    const href = JSDOM.fragment(renderMarkdown(`[[${target}|Heading link]]`)).querySelector('a')?.getAttribute('href');
    assert.ok(href);
    return resolveNoteLink(href, source.path, notes);
  };
  assert.deepEqual(resolveWiki('Other#setup'), { note: other, fragment: 'setup' });
  assert.deepEqual(resolveWiki('#setup'), { note: source, fragment: 'setup' });
  assert.deepEqual(resolveWiki('Other#part'), { note: hash });
  assert.deepEqual(resolveWiki('Other#part#setup'), { note: hash, fragment: 'setup' });
  assert.deepEqual(resolveWiki('Other#setup#detail'), { note: other, fragment: 'setup#detail' });
  assert.deepEqual(resolveWiki('Other#日本語'), { note: other, fragment: '日本語' });
  assert.deepEqual(resolveWiki('Percent%25#part%25'), { note: escaped, fragment: 'part%25' });
  assert.deepEqual(resolveWiki('Other#'), { note: other, fragment: '' });
  const content = '[[Other#setup]] [Other section](Other.md#second) [[#setup]]';
  const linkedSource = { ...source, content };
  const linkedNotes = [linkedSource, other, hash, escaped];
  assert.deepEqual(getNoteLinks(linkedSource).map(href => resolveLink(href, source.path, linkedNotes)?.path), ['Other.md', 'Other.md', 'Source.md']);
  assert.deepEqual(getBacklinks(other.path, linkedNotes).map(item => item.path), ['Source.md']);
  assert.deepEqual(getBacklinks(source.path, linkedNotes), []);
});

test('resolves relative, root, percent-encoded and extensionless note links', () => {
  const notes = [note('Home.md'), note('Ideas/Research notes.md'), note('Ideas/Seed.md'), note('Topics/Seed.md'), note('Topics/Solo.md')];
  assert.equal(resolveLink('./Research%20notes.md#Reading', 'Ideas/Seed.md', notes)?.path, 'Ideas/Research notes.md');
  assert.equal(resolveLink('../Home.md', 'Ideas/Seed.md', notes)?.path, 'Home.md');
  assert.equal(resolveLink('/Home', 'Ideas/Seed.md', notes)?.path, 'Home.md');
  assert.equal(resolveLink('Seed', 'Ideas/Research notes.md', notes)?.path, 'Ideas/Seed.md');
  assert.equal(resolveLink('Solo', 'Home.md', notes)?.path, 'Topics/Solo.md');
  assert.equal(resolveLink('prism-note:Ideas%2FResearch%20notes', 'Home.md', notes)?.path, 'Ideas/Research notes.md');
});

test('extensionless Markdown destinations agree across preview, graph links and backlinks', () => {
  const cases = [
    ['Solo', 'Solo.md'],
    ['./Neighbor#details', 'Projects/Neighbor.md'],
    ['../Topics/Thought#setup', 'Topics/Thought.md'],
    ['/Topics/Thought', 'Topics/Thought.md'],
    ['Topics/Thought?read=true#setup', 'Topics/Thought.md'],
    ['Space%20name#heading', 'Space name.md'],
    ['Percent%2525', 'Percent%25.md'],
    ['prism-note:Solo', 'Solo.md'],
  ];
  for (const [target, expected] of cases) {
    const source = note('Projects/Source.md', `[Linked note](${target})`);
    const notes = [source, ...[...new Set(cases.map(([, path]) => path))].map(path => note(path))];
    const previewHref = JSDOM.fragment(renderMarkdown(source.content)).querySelector('a')?.getAttribute('href');
    assert.ok(previewHref);
    assert.equal(resolveNoteLink(previewHref, source.path, notes)?.note.path, expected, `preview: ${target}`);
    assert.deepEqual(getNoteLinks(source), [target]);
    assert.deepEqual(getNoteLinks(source).map(link => resolveLink(link, source.path, notes)?.path), [expected], `graph: ${target}`);
    assert.deepEqual(getBacklinks(expected, notes).map(item => item.path), [source.path], `backlinks: ${target}`);
  }
});

test('local candidate extraction creates no edges for missing targets, assets, external URLs or same-note fragments', () => {
  const source = note('Projects/Source.md', '[missing](Missing) [asset](image.png) [neighbor](./Neighbor) [self](Source#heading) [section](#heading) [query](?read=true#heading) [empty]()\n\n![image](Other) `[code](Other)` [external](https://example.com/Other) [file](file:///Other)');
  const neighbor = note('Projects/Neighbor.md');
  const other = note('Projects/Other.md');
  const notes = [source, neighbor, other];
  assert.deepEqual(extractLinks(source.content), ['Missing', 'image.png', './Neighbor', 'Source#heading']);
  const connections = getNoteLinks(source).map(link => resolveLink(link, source.path, notes)).filter(target => target && target.path !== source.path);
  assert.deepEqual(connections, [neighbor]);
  assert.deepEqual(getBacklinks(neighbor.path, notes), [source]);
  assert.deepEqual(getBacklinks(source.path, notes), []);
  assert.deepEqual(getBacklinks(other.path, notes), []);
});

test('ambiguous basenames and invalid paths never jump to another file', () => {
  const notes = [note('One/Note.md'), note('Two/Note.md'), note('Home.md')];
  assert.equal(resolveLink('Note', 'Home.md', notes), undefined);
  assert.equal(resolveLink('Missing/Note', 'Home.md', notes), undefined);
  assert.equal(resolveLink('../../One/Note', 'Home.md', notes), undefined);
  assert.equal(resolveLink('https://example.com/One/Note.md', 'Home.md', notes), undefined);
  assert.equal(resolveLink('javascript:alert(1)', 'Home.md', notes), undefined);
  assert.equal(resolveLink('%E0%A4%A.md', 'Home.md', notes), undefined);
});

test('backlinks include resolved references and exclude self-links and code examples', () => {
  const notes = [note('Garden.md', '[[Garden]]'), note('Ideas/Seeds.md', '[[Garden]] [[Garden]]'), note('Overview.md', '[Garden](Garden.md)'), note('Examples.md', '`[[Garden]]`')];
  assert.deepEqual(getBacklinks('Garden.md', notes).map(item => item.path), ['Ideas/Seeds.md', 'Overview.md']);
});

test('editing links, adding notes and changing titles updates cached note metadata', () => {
  const source = note('Source.md', '# First title\n\n[[Garden]] [[New note]]');
  const notes = [source, note('Garden.md'), note('Orchard.md')];
  assert.equal(getTitle(source), 'First title');
  assert.equal(getBacklinks('Garden.md', notes).length, 1);
  assert.equal(resolveLink('New note', source.path, notes), undefined);
  const edited = { ...source, content: '# Second title\n\n[[Orchard]] [[New note]]' };
  const updated = [edited, ...notes.slice(1), note('New note.md')];
  assert.equal(getTitle(edited), 'Second title');
  assert.equal(getBacklinks('Garden.md', updated).length, 0);
  assert.equal(getBacklinks('Orchard.md', updated)[0], edited);
  assert.equal(getBacklinks('New note.md', updated)[0], edited);
});

test('titles use the first real H1 and fall back to the filename', () => {
  assert.equal(getTitle(note('fallback.md', '```md\n# Not a title\n```\n# A **quiet** place\n')), 'A quiet place');
  assert.equal(getTitle(note('Ideas/Small things.md', '## A smaller heading')), 'Small things');
  assert.equal(getTitle(note('fallback.md', '# [[Somewhere|Some place]]')), 'Some place');
});

test('renders formatted Markdown and safe wiki aliases without transforming code', () => {
  const html = renderMarkdown('# My garden\n\n[[Ideas/A & B|A < B]] and `[[Example]]`\n\n- **Grow** something');
  const fragment = JSDOM.fragment(html);
  assert.equal(fragment.querySelector('h1')?.textContent, 'My garden');
  assert.equal(fragment.querySelector('a')?.getAttribute('href'), 'prism-note:Ideas%2FA%20%26%20B');
  assert.equal(fragment.querySelector('a')?.textContent, 'A < B');
  assert.equal(fragment.querySelector('code')?.textContent, '[[Example]]');
  assert.equal(fragment.querySelectorAll('a').length, 1);
  assert.equal(fragment.querySelector('strong')?.textContent, 'Grow');
});

test('rendering strips script execution, event handlers, style injection and dangerous URLs', () => {
  const html = renderMarkdown('<script>alert(1)</script>\n\n<img src="x" onerror="alert(1)"><a href="javascript:alert(1)" onclick="alert(1)" style="position:fixed">bad</a><iframe src="https://example.com"></iframe><style>body{display:none}</style>\n\n[safe](https://example.com) [local](Ideas/Seed.md)');
  const fragment = JSDOM.fragment(html);
  assert.equal(fragment.querySelector('script, iframe, style, [onerror], [onclick], [style]'), null);
  assert.equal(fragment.querySelector('a')?.hasAttribute('href'), false);
  assert.ok(fragment.querySelector('a[href="https://example.com"]'));
  assert.ok(fragment.querySelector('a[href="Ideas/Seed.md"]'));
});

test('headings receive stable unique IDs for in-note links, including Unicode headings', () => {
  const fragment = JSDOM.fragment(renderMarkdown('# A quiet place\n\n## A quiet place\n\n## A quiet place-1\n\n## 日本語\n\n[Go](#a-quiet-place)'));
  assert.deepEqual([...fragment.querySelectorAll('h1,h2')].map(heading => heading.id), ['a-quiet-place', 'a-quiet-place-1', 'a-quiet-place-1-1', '日本語']);
  assert.equal(JSDOM.fragment(renderMarkdown('# A quiet place')).querySelector('h1')?.id, 'a-quiet-place');
});

test('editable heading indices follow Markdown H1–H3 while raw HTML and smaller headings stay outside the mapping', () => {
  const content = '# First\n\n<h1 data-prism-heading="0">Raw HTML heading</h1>\n\n#### Small heading\n\n> ## Quoted heading\n\nSetext heading\n--------------\n\n```md\n## Not a heading\n```\n\n### Last';
  const rendered = renderMarkdownDocument(content);
  assert.deepEqual(rendered.headings, [
    { title: 'First', level: 1, index: 0 },
    { title: 'Quoted heading', level: 2, index: 1 },
    { title: 'Setext heading', level: 2, index: 2 },
    { title: 'Last', level: 3, index: 3 },
  ]);
  assert.equal(rendered.html, renderMarkdown(content));
});

test('GFM task lists preserve checked state as disabled checkboxes', () => {
  const fragment = JSDOM.fragment(renderMarkdown('- [x] Finished\n- [ ] Still to do'));
  const inputs = [...fragment.querySelectorAll('input')];
  assert.equal(inputs.length, 2);
  assert.deepEqual(inputs.map(input => input.type), ['checkbox', 'checkbox']);
  assert.deepEqual(inputs.map(input => input.checked), [true, false]);
  assert.ok(inputs.every(input => input.disabled));
});

test('raw HTML cannot create interactive forms or non-checkbox inputs', () => {
  const fragment = JSDOM.fragment(renderMarkdown('<form action="https://example.com"><input type="password" autofocus value="secret"><input type="file"><input type="submit"><input type="checkbox" name="send" value="data" oninput="alert(1)" checked><button>Send</button></form>'));
  assert.equal(fragment.querySelector('form, button, input:not([type="checkbox"]), [autofocus], [oninput], [name], [value]'), null);
  const checkbox = fragment.querySelector('input');
  assert.ok(checkbox);
  assert.equal(checkbox.disabled, true);
  assert.equal(checkbox.checked, true);
});

test('Markdown renders inline and display math without changing ordinary Markdown', () => {
  const content = '# Energy $E=mc^2$\n\nInline $\\frac{a}{b}$ and **bold**.\n\n$$\n\\begin{aligned}x&=y+1\\\\z&=2\n\\end{aligned}\n$$\n\n- [x] A task';
  const rendered = renderMarkdownDocument(content);
  const fragment = JSDOM.fragment(rendered.html);
  assert.equal(fragment.querySelectorAll('.katex').length, 3);
  assert.equal(fragment.querySelectorAll('.prism-math-display').length, 1);
  assert.equal(fragment.querySelector('strong')?.textContent, 'bold');
  assert.ok(fragment.querySelector('input[type="checkbox"][checked][disabled]'));
  assert.deepEqual(rendered.headings, [{ title: 'Energy E=mc^2', level: 1, index: 0 }]);
  assert.equal(getTitle(note('Energy.md', content)), 'Energy E=mc^2');
  assert.equal(fragment.querySelector('h1')?.id, 'energy-emc2');
  assert.equal(rendered.html, renderMarkdown(content), 'fresh tokens do not leak into rendered HTML');
});

test('TeX wiki links and Markdown-looking contents create no graph connections', () => {
  const content = String.raw`$\text{[[Not a note]]} + x_1$ and [[Actual note]]

$$\text{[Not a link](Fake.md)}$$

[Actual link](Real.md)`;
  assert.deepEqual(extractLinks(content), ['prism-note:Actual%20note', 'Real.md']);
  const fragment = JSDOM.fragment(renderMarkdown(content));
  assert.equal(fragment.querySelectorAll('a').length, 2);
  assert.equal(fragment.querySelectorAll('.katex').length, 2);
});

test('math keeps raw HTML sanitization strict while preserving only generated KaTeX geometry', () => {
  const content = '<span class="katex" data-prism-math="forged" style="position:fixed" onclick="alert(1)">forged</span>\n\n$\\frac{1}{2}$\n\n<img src="x" onerror="alert(1)"><style>body{display:none}</style>';
  const fragment = JSDOM.fragment(renderMarkdown(content));
  assert.equal(fragment.querySelector('[data-prism-math="forged"]')?.hasAttribute('style'), false);
  assert.equal(fragment.querySelector('script, style, [onclick], [onerror]'), null);
  assert.ok(fragment.querySelector('.prism-math-inline .katex [style]'));
  assert.equal(fragment.querySelectorAll('.prism-math-inline').length, 1);
});

test('invalid math diagnostics and source are escaped without replacing later valid formulas', () => {
  const content = '$\\frac{<img src=x onerror=alert(1)>}{ $\n\n$\\unknownPrism{<script>alert(1)</script>}$\n\nValid $x^2$';
  const fragment = JSDOM.fragment(renderMarkdown(content));
  assert.equal(fragment.querySelector('script, [onerror]'), null);
  assert.equal(fragment.querySelectorAll('.katex').length, 1);
  const malformed = JSDOM.fragment(renderMarkdown('$\\frac{1}{$ and $x^2$'));
  assert.equal(malformed.querySelectorAll('.prism-math-error').length, 1);
  assert.equal(malformed.querySelector('.prism-math-error')?.textContent, '$\\frac{1}{$');
  assert.equal(malformed.querySelectorAll('.katex').length, 1);
});

test('math parsing preserves code examples, raw HTML, link destinations and prices', () => {
  const content = '`$code$`\n\n```tex\n$$fenced$$\n```\n\n<span>$html$</span>\n\n[price](Cost$5$.md)\n\nCost $5 and $10; formula $x^2$.';
  const fragment = JSDOM.fragment(renderMarkdown(content));
  assert.equal(fragment.querySelectorAll('.katex').length, 1);
  assert.equal(fragment.querySelector('a')?.getAttribute('href'), 'Cost$5$.md');
  assert.ok(fragment.textContent?.includes('Cost $5 and $10; formula'));
  assert.deepEqual([...fragment.querySelectorAll('code')].map(node => node.textContent), ['$code$', '$$fenced$$\n']);
});


test('note titles preserve TeX subscripts while stripping surrounding Markdown formatting', () => {
  const source = '# **Series** $x_1 + x_2$';
  assert.equal(getTitle(note('Series.md', source)), 'Series x_1 + x_2');
  assert.equal(renderMarkdownDocument(source).headings[0].title, 'Series x_1 + x_2');
});


test('quoted display formulas render without Markdown container markers', () => {
  const source = '> $$\n> \\frac{x^2}{2}\n> $$\n\n- > $$\n  > y^2\n  > $$';
  const fragment = JSDOM.fragment(renderMarkdown(source));
  assert.equal(fragment.querySelectorAll('blockquote .katex').length, 2);
  assert.deepEqual([...fragment.querySelectorAll('.katex annotation')].map(node => node.textContent?.trim()), ['\\frac{x^2}{2}', 'y^2']);
  assert.equal(fragment.querySelector('.prism-math-error'), null);
});
