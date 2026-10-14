import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { JSDOM } from 'jsdom';
import { extractLinks, getBacklinks, getTitle, renderMarkdown, resolveLink } from '../src/renderer/markdown';
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
  assert.deepEqual(extractLinks(content), ['Garden', 'Ideas/Slow mornings', 'Ideas/Research%20notes.md#reading', './Reading.md', 'Inside a list', 'In a table']);
});

test('code, images, embeds and external URLs do not create graph links', () => {
  const content = '\\[[Escaped]] `[[Inline code]]`\n\n```md\n[[Fenced code]]\n[fenced](Fenced.md)\n```\n\n    [[Indented code]]\n\n![image](Photo.md) ![[Embedded.md]] ![Image with [[caption]]](photo.png)\n[external](https://example.com/a.md) [[https://example.com/a.md]] [mail](mailto:a@example.com) [web](//example.com/a.md) [section](#heading)\n[[Real]]';
  assert.deepEqual(extractLinks(content), ['Real']);
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
