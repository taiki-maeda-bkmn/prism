import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { JSDOM } from 'jsdom';
import { EditorState } from '@codemirror/state';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { ensureSyntaxTree } from '@codemirror/language';
import { formatPDFPageLink, isPDFPageLink, parsePDFPageLink } from '../src/shared/pdfLinks';
import { extractLinks, renderMarkdown, resolveNoteLink } from '../src/renderer/markdown';
import { getLiveLinks, isLiveLinkHref } from '../src/renderer/liveLinks';
import { liveMathState } from '../src/renderer/liveMath';
import { liveTableState } from '../src/renderer/liveTables';

const dom = new JSDOM('<!doctype html><html><body></body></html>');
Object.defineProperty(globalThis, 'window', { value: dom.window, configurable: true });
after(() => dom.window.close());

const id = '12345678-9abc-4234-8234-123456789abc';
const prefix = `prism-pdf://v1/documents/${id}`;
const uri = `${prefix}?page=2`;

test('PDF links identify a managed document and exact one-based page, independent of titles', () => {
  assert.deepEqual(parsePDFPageLink(uri), { documentId: id, page: 2 });
  assert.deepEqual(parsePDFPageLink(uri.toUpperCase()), { documentId: id, page: 2 });
  assert.deepEqual(parsePDFPageLink(`${prefix}?page=9007199254740991`), { documentId: id, page: Number.MAX_SAFE_INTEGER });
  const first = formatPDFPageLink({ documentId: id, page: 2, title: 'Before' });
  const renamed = formatPDFPageLink({ documentId: id, page: 2, title: '変更後' });
  for (const source of [first, renamed]) {
    const href = JSDOM.fragment(renderMarkdown(source)).querySelector('a')?.getAttribute('href');
    assert.equal(href, uri);
    assert.deepEqual(parsePDFPageLink(href!), { documentId: id, page: 2 });
  }
});

test('PDF destinations reject malformed, ambiguous, encoded, future, and unsafe addresses', () => {
  for (const href of [
    `${prefix}?page=0`, `${prefix}?page=-1`, `${prefix}?page=+2`, `${prefix}?page=02`,
    `${prefix}?page=1.5`, `${prefix}?page=1e2`, `${prefix}?page=Infinity`, `${prefix}?page=NaN`,
    `${prefix}?page=9007199254740992`, `${prefix}?page=${'1'.repeat(200)}`,
    `${uri}&page=3`, `${uri}&extra=yes`, `${uri}#page=3`, `${prefix}?page=%32`,
    `${prefix}?page= 2`, prefix, `${prefix}/?page=2`, `${prefix}?page=`,
    uri.replace('/v1/', '/v2/'), uri.replace('v1/', 'user@v1/'), uri.replace('v1/', 'v1:80/'),
    uri.replace('documents/', 'documents/../documents/'), uri.replace('documents/', 'documents%2f'),
    uri.replace(id, '../notes.md'), uri.replace(id, '研究'), uri.replace(id, `${id}.pdf`),
    uri.replace(id, id.replace('-', '%2d')), uri.replace('://', ':////'),
    `${uri}\n`, `${uri}\r`, `${uri}\r\n`, ` ${uri}`, `${uri} `, `\t${uri}`, `${uri}\0`,
    'file:///tmp/a.pdf#page=2', 'https://v1/documents/a?page=2', 'prism-note:a',
  ]) assert.equal(parsePDFPageLink(href), null, JSON.stringify(href));
  for (const href of ['prism-pdf:bad', 'PRISM-PDF://v2/unknown', ` ${uri}`]) assert.equal(isPDFPageLink(href), true);
  assert.equal(isPDFPageLink('https://example.com/prism-pdf:bad'), false);
  assert.throws(() => formatPDFPageLink({ documentId: '../secret', page: 1, title: 'Unsafe' }));
  assert.throws(() => formatPDFPageLink({ documentId: id, page: 0, title: 'Unsafe' }));
});

test('inserted labels retain Japanese and literal punctuation without creating markup or formulas', () => {
  for (const title of [
    '日本語の資料', '**bold** _italic_ ~strike~ `code`', 'A [title](javascript:alert(1))',
    '[[Note]] and ![image](file:///tmp/a)', '<img src=x onerror=alert(1)> &amp;',
    '$x^2$ \\(math\\) $$formula$$', 'A | B \\ [C]', '"quote" ! # % / + : = ? @ { }',
  ]) {
    const source = formatPDFPageLink({ documentId: id, page: 2, title });
    const prose = JSDOM.fragment(renderMarkdown(source));
    assert.equal(prose.querySelectorAll('a').length, 1, title);
    assert.equal(prose.querySelector('a')?.textContent, `${title} — p. 2`, title);
    assert.equal(prose.querySelector('a')?.getAttribute('href'), uri);
    assert.equal(prose.querySelector('a')?.children.length, 0, title);
    const table = JSDOM.fragment(renderMarkdown(`| Reference |\n| --- |\n| ${source} |`));
    assert.equal(table.querySelectorAll('tbody td').length, 1, title);
    assert.equal(table.querySelector('td a')?.textContent, `${title} — p. 2`, title);
    assert.equal(table.querySelector('td a')?.getAttribute('href'), uri);
  }
  const multiline = formatPDFPageLink({ documentId: id, page: 1, title: '日本語\r\n資料\t追記\0' });
  assert.equal(JSDOM.fragment(renderMarkdown(multiline)).querySelector('a')?.textContent, '日本語 資料 追記 — p. 1');
});

test('Read and Live keep internal page links, including references, and reject resource/script uses', () => {
  const doc = `[PDF](${uri})\n\n[Reference][ref]\n\n[Future](prism-pdf://v2/unsupported)\n\nCaret\n\n[ref]: ${uri}`;
  const fragment = JSDOM.fragment(renderMarkdown(doc));
  assert.deepEqual([...fragment.querySelectorAll('a')].map(anchor => anchor.getAttribute('href')), [uri, uri, 'prism-pdf://v2/unsupported']);
  const state = EditorState.create({ doc, selection: { anchor: doc.indexOf('Caret') }, extensions: [
    markdown({ base: markdownLanguage }), liveMathState, liveTableState,
  ] });
  ensureSyntaxTree(state, doc.length, 100);
  assert.deepEqual(getLiveLinks(state, [{ from: 0, to: doc.length }]).map(link => link.href), [uri, uri, 'prism-pdf://v2/unsupported']);
  assert.equal(isLiveLinkHref(uri), true);
  assert.equal(isLiveLinkHref('prism-pdf://v2/unsupported'), true);
  assert.equal(isLiveLinkHref(`${uri}\n`), false);
  const unsafe = JSDOM.fragment(renderMarkdown(`![PDF](${uri}) <a href="javascript:alert(1)">Script</a> <img src="${uri}">`));
  assert.equal(unsafe.querySelector('a')?.hasAttribute('href'), false);
  for (const image of unsafe.querySelectorAll('img')) assert.equal(image.hasAttribute('src'), false);
});

test('PDF links do not change note graph identity or resolve against a matching display title', () => {
  const content = `[PDF](${uri}) [Note](Reading.md) [Reference][pdf]\n\n[pdf]: ${uri}`;
  assert.deepEqual(extractLinks(content), ['Reading.md']);
  const notes = [{ path: 'Reading.md', content: '# PDF', modified: 1 }];
  assert.equal(resolveNoteLink(uri, 'Reading.md', notes), undefined);
});
