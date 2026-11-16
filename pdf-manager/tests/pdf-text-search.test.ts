import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildSearchPage, emptyPDFSearchResult, findPageMatches, normalizeSearchQuery, PDF_SEARCH_LIMITS, searchPDFDocument,
  type PDFSearchDocument, type PDFSearchResult, type PDFSearchTextItem,
} from '../src/renderer/pdfTextSearch';

const text = (str: string, hasEOL = false): PDFSearchTextItem => ({ str, hasEOL });

function document(pages: (readonly PDFSearchTextItem[] | Error)[], requests: number[] = []): PDFSearchDocument {
  return {
    numPages: pages.length,
    async getPage(number) {
      requests.push(number);
      const page = pages[number - 1];
      if (page instanceof Error) throw page;
      return { async getTextContent() { return { items: page }; } };
    },
  };
}

test('literal search spans PDF text chunks and line breaks with exact text-layer indices', () => {
  const page = buildSearchPage([
    { type: 'beginMarkedContent' }, text('A'), text(''), text('bc', true),
    { type: 'endMarkedContent' }, text('Def'),
  ]);
  assert.equal(page.text, 'abc def');
  assert.deepEqual(findPageMatches(page, 'BC\nD'), [{
    from: 1, to: 5, ranges: [{ itemIndex: 2, from: 0, to: 2 }, { itemIndex: 3, from: 0, to: 1 }],
  }]);
  assert.deepEqual(findPageMatches(page, 'abcdef'), []);
});

test('whitespace normalization matches copied phrases without inventing text ranges for EOL', () => {
  const page = buildSearchPage([text('hello\t  '), text('world', true), text('next\u00a0line')]);
  assert.equal(page.text, 'hello world next line');
  assert.deepEqual(findPageMatches(page, 'HELLO world NEXT')[0].ranges, [
    { itemIndex: 0, from: 0, to: 8 }, { itemIndex: 1, from: 0, to: 5 }, { itemIndex: 2, from: 0, to: 4 },
  ]);
  assert.deepEqual(findPageMatches(page, '   \t\n'), []);
});

test('Japanese, surrogate pairs, ligatures and width variants map to the unchanged source', () => {
  const page = buildSearchPage([text('😀日本'), text('語 ＰＤＦ oﬃce')]);
  assert.deepEqual(findPageMatches(page, '日本語')[0].ranges, [
    { itemIndex: 0, from: 2, to: 4 }, { itemIndex: 1, from: 0, to: 1 },
  ]);
  assert.deepEqual(findPageMatches(page, 'pdf')[0].ranges, [{ itemIndex: 1, from: 2, to: 5 }]);
  assert.deepEqual(findPageMatches(page, 'ffi')[0].ranges, [{ itemIndex: 1, from: 7, to: 8 }]);
  assert.deepEqual(findPageMatches(page, '😀')[0].ranges, [{ itemIndex: 0, from: 0, to: 2 }]);
});

test('canonical combining marks normalize across item boundaries and keep both source portions', () => {
  const page = buildSearchPage([text('Cafe'), text('\u0301, か'), text('\u3099く')]);
  assert.deepEqual(findPageMatches(page, 'CAFÉ')[0].ranges, [
    { itemIndex: 0, from: 0, to: 4 }, { itemIndex: 1, from: 0, to: 1 },
  ]);
  assert.deepEqual(findPageMatches(page, 'がく')[0].ranges, [
    { itemIndex: 1, from: 3, to: 4 }, { itemIndex: 2, from: 0, to: 2 },
  ]);
});

test('case folding expansions and sigma variants retain accurate source offsets', () => {
  const page = buildSearchPage([text('Straße ßß İ ΟΣ ος')]);
  assert.deepEqual(findPageMatches(page, 'STRASSE')[0].ranges, [{ itemIndex: 0, from: 0, to: 6 }]);
  assert.deepEqual(findPageMatches(page, 'ss').map(match => match.ranges), [
    [{ itemIndex: 0, from: 4, to: 5 }], [{ itemIndex: 0, from: 7, to: 8 }], [{ itemIndex: 0, from: 8, to: 9 }],
  ]);
  assert.deepEqual(findPageMatches(page, 'i')[0].ranges, [{ itemIndex: 0, from: 10, to: 11 }]);
  assert.equal(findPageMatches(page, 'ΟΣ').length, 2);
});

test('literal punctuation is not a regular expression and matches do not overlap', () => {
  const page = buildSearchPage([text('a.b a+b [test] aaa')]);
  assert.equal(findPageMatches(page, 'a.b').length, 1);
  assert.equal(findPageMatches(page, '[test]').length, 1);
  assert.equal(findPageMatches(page, 'aa').length, 1);
});

test('normalization expansions count an original glyph only once for the same highlighted range', () => {
  const page = buildSearchPage([text('ﬀ f ﬃ')]);
  const matches = findPageMatches(page, 'f');
  assert.deepEqual(matches.map(match => match.ranges), [
    [{ itemIndex: 0, from: 0, to: 1 }],
    [{ itemIndex: 0, from: 2, to: 3 }],
    [{ itemIndex: 0, from: 4, to: 5 }],
  ]);
  assert.deepEqual(findPageMatches(buildSearchPage([text('ßß')]), 's').map(match => match.ranges[0]), [
    { itemIndex: 0, from: 0, to: 1 }, { itemIndex: 0, from: 1, to: 2 },
  ]);
});

test('common text and repeated Unicode expansions use compressed offset runs', () => {
  const page = buildSearchPage([text('Plain text with spaces. '.repeat(1_000))]);
  assert.equal(page.offsets.length, 1);
  const expanded = buildSearchPage([text('ß'.repeat(1_000))]);
  assert.equal(expanded.offsets.length, 1);
  assert.equal(expanded.text.length, 2_000);
  assert.deepEqual(findPageMatches(expanded, 'ss', 2).map(match => match.ranges[0]), [
    { itemIndex: 0, from: 0, to: 1 }, { itemIndex: 0, from: 1, to: 2 },
  ]);
});

test('query, page and result limits are explicit and cannot be raised by callers', () => {
  assert.throws(() => normalizeSearchQuery('a'.repeat(PDF_SEARCH_LIMITS.queryLength + 1)), /limited to 512/);
  assert.equal(normalizeSearchQuery('  ＰＤＦ\n日本語  '), 'pdf 日本語');
  const page = buildSearchPage([text('abcdefghijkl')], 6);
  assert.equal(page.text, 'abcdef');
  assert.equal(page.truncated, true);
  assert.equal(findPageMatches(buildSearchPage([text('x '.repeat(1_100))]), 'x', 5_000).length, PDF_SEARCH_LIMITS.matches);
});

test('document search is sequential, returns later-page matches and reports stable snapshots', async () => {
  const requests: number[] = [], progress: PDFSearchResult[] = [];
  const result = await searchPDFDocument(document([[text('one')], [text('needle')], [text('NEEDLE again')]], requests), 'needle', {
    onProgress: snapshot => progress.push(snapshot),
  });
  assert.deepEqual(requests, [1, 2, 3]);
  assert.deepEqual(result.matches.map(match => match.pageNumber), [2, 3]);
  assert.equal(result.scannedPages, 3);
  assert.equal(result.hasText, true);
  assert.equal(result.truncated, false);
  assert.equal(progress[0].matches.length, 0);
  assert.equal(progress.find(snapshot => snapshot.scannedPages === 2)?.matches.length, 1);
});

test('one damaged page does not hide later matches and image-only pages are distinguishable', async () => {
  const result = await searchPDFDocument(document([[], new Error('Damaged stream'), [text('needle')]]), 'needle');
  assert.deepEqual(result.failedPages, [2]);
  assert.deepEqual(result.matches.map(match => match.pageNumber), [3]);
  const scanned = await searchPDFDocument(document([[], [text(' \t', true)]]), 'needle');
  assert.equal(scanned.hasText, false);
  assert.deepEqual(scanned.failedPages, []);
  assert.equal(scanned.scannedPages, 2);
});

test('document search stops at result, page and character limits and marks partial results', async () => {
  const requests: number[] = [];
  const matches = await searchPDFDocument(document([[text('x x x x')], [text('x')]], requests), 'x', { maxMatches: 2 });
  assert.deepEqual(requests, [1]);
  assert.equal(matches.matches.length, 2);
  assert.equal(matches.truncated, true);
  const pages = await searchPDFDocument(document([[text('x')], [text('x')], [text('x')]]), 'x', { maxPages: 1 });
  assert.equal(pages.scannedPages, 1);
  assert.equal(pages.truncated, true);
  const characters = await searchPDFDocument(document([[text('abcde')], [text('abcde')], [text('abcde')]]), 'a', { maxCharacters: 7 });
  assert.equal(characters.scannedPages, 2);
  assert.equal(characters.matches.length, 2);
  assert.equal(characters.truncated, true);
});

test('empty queries do no extraction, while invalid queries and page counts fail clearly', async () => {
  const requests: number[] = [];
  assert.deepEqual(await searchPDFDocument(document([[text('x')]], requests), '  '), emptyPDFSearchResult(1));
  assert.deepEqual(requests, []);
  await assert.rejects(searchPDFDocument(document([[text('x')]], requests), 'a'.repeat(513)), /limited/);
  await assert.rejects(searchPDFDocument({ numPages: Infinity, getPage: async () => { throw new Error('unreachable'); } }, 'x'), /invalid page count/);
});

test('cancellation after a progress result prevents further page reads and callbacks', async () => {
  const controller = new AbortController(), requests: number[] = [], progress: number[] = [];
  await assert.rejects(searchPDFDocument(document([[text('x')], [text('x')]], requests), 'x', {
    signal: controller.signal,
    onProgress: value => { progress.push(value.scannedPages); controller.abort(); },
  }), { name: 'AbortError' });
  assert.deepEqual(requests, [1]);
  assert.deepEqual(progress, [1]);
});

test('cancellation during a pending page fetch prevents text extraction and publication', async () => {
  const controller = new AbortController();
  let resolve!: (page: { getTextContent(): Promise<{ items: PDFSearchTextItem[] }> }) => void;
  let extracted = false, published = false;
  const pending = searchPDFDocument({ numPages: 1, getPage: () => new Promise(done => { resolve = done; }) }, 'x', {
    signal: controller.signal, onProgress: () => { published = true; },
  });
  controller.abort();
  resolve({ getTextContent: async () => { extracted = true; return { items: [text('x')] }; } });
  await assert.rejects(pending, { name: 'AbortError' });
  assert.equal(extracted, false);
  assert.equal(published, false);
});
