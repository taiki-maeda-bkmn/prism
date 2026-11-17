/** Limits bound retained search metadata, even for unusually large PDF pages. */
export const PDF_SEARCH_LIMITS = Object.freeze({
  queryLength: 512,
  matches: 1_000,
  pageCharacters: 1_000_000,
  documentCharacters: 32_000_000,
  pages: 20_000,
  pageItems: 100_000,
  offsetRuns: 100_000,
});

export type PDFSearchTextItem = { str: string; hasEOL?: boolean } | { type: string };
export interface PDFSearchRange { itemIndex: number; from: number; to: number; }
export interface PDFSearchMatch { from: number; to: number; ranges: PDFSearchRange[]; }
export interface PDFDocumentSearchMatch { pageNumber: number; match: PDFSearchMatch; }
interface ItemSpan { itemIndex: number; from: number; to: number; }
interface OffsetRun {
  from: number; to: number; sourceFrom: number; sourceTo: number;
  unitLength: number; sourceUnitLength: number;
}
export interface PDFSearchPage {
  text: string;
  spans: readonly ItemSpan[];
  offsets: readonly OffsetRun[];
  sourceLength: number;
  truncated: boolean;
}
export interface PDFSearchResult {
  matches: PDFDocumentSearchMatch[];
  scannedPages: number;
  totalPages: number;
  failedPages: number[];
  truncated: boolean;
  hasText: boolean;
}
export interface PDFSearchDocument {
  numPages: number;
  getPage(pageNumber: number): Promise<{ getTextContent(): Promise<{ items: readonly PDFSearchTextItem[] }> }>;
}
export interface PDFSearchOptions {
  signal?: AbortSignal;
  onProgress?: (snapshot: PDFSearchResult) => void;
  maxMatches?: number;
  /** Optional lower limits are useful for low-memory clients and tests. */
  maxPages?: number;
  maxCharacters?: number;
  maxPageCharacters?: number;
}

const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
const whitespace = /^\s+$/u;
// NFKC covers PDF ligatures/full-width text; these folds also cover sharp-s and
// final sigma without depending on the user's UI language.
const fold = (value: string) => value.normalize('NFKC').toLowerCase().replace(/ß/gu, 'ss').replace(/ς/gu, 'σ');
const bounded = (value: number | undefined, ceiling: number) => value !== undefined && Number.isSafeInteger(value) && value > 0 ? Math.min(value, ceiling) : ceiling;

export function emptyPDFSearchResult(totalPages = 0): PDFSearchResult {
  return { matches: [], scannedPages: 0, totalPages, failedPages: [], truncated: false, hasText: false };
}

export function normalizeSearchQuery(query: string): string {
  if (query.length > PDF_SEARCH_LIMITS.queryLength) throw new Error(`Search text is limited to ${PDF_SEARCH_LIMITS.queryLength} characters.`);
  return Array.from(graphemes.segment(query), part => fold(part.segment)).join('').replace(/\s+/gu, ' ').trim();
}

/** Text item indices match TextLayer.textDivs, excluding marked-content items. */
export function buildSearchPage(items: readonly PDFSearchTextItem[], maxCharacters?: number): PDFSearchPage {
  const limit = bounded(maxCharacters, PDF_SEARCH_LIMITS.pageCharacters);
  const source: string[] = [], spans: ItemSpan[] = [], offsets: OffsetRun[] = [];
  let sourceLength = 0, itemIndex = 0, truncated = false;
  const count = Math.min(items.length, PDF_SEARCH_LIMITS.pageItems);
  for (let index = 0; index < count; index++) {
    const item = items[index];
    if (!('str' in item)) continue;
    const remaining = limit - sourceLength;
    const value = item.str.slice(0, remaining);
    if (value) {
      source.push(value);
      spans.push({ itemIndex, from: sourceLength, to: sourceLength + value.length });
      sourceLength += value.length;
    }
    itemIndex++;
    if (value.length < item.str.length) { truncated = true; break; }
    if (item.hasEOL && sourceLength < limit) { source.push('\n'); sourceLength++; }
    if (sourceLength >= limit && index + 1 < items.length) { truncated = true; break; }
  }
  if (items.length > count) truncated = true;
  const raw = source.join('');
  const parts: string[] = [];
  let buffer = '', length = 0;
  let pendingWhitespace: { from: number; to: number } | undefined;
  const append = (value: string, from: number, to: number): boolean => {
    if (length + value.length > limit) { truncated = true; return false; }
    const sameWidth = value.length === to - from;
    const unitLength = sameWidth ? 1 : value.length;
    const sourceUnitLength = sameWidth ? 1 : to - from;
    const previous = offsets[offsets.length - 1];
    if (previous && previous.to === length && previous.sourceTo === from && previous.unitLength === unitLength && previous.sourceUnitLength === sourceUnitLength) {
      previous.to += value.length; previous.sourceTo = to;
    } else {
      if (offsets.length >= PDF_SEARCH_LIMITS.offsetRuns) { truncated = true; return false; }
      offsets.push({ from: length, to: length + value.length, sourceFrom: from, sourceTo: to, unitLength, sourceUnitLength });
    }
    buffer += value; length += value.length;
    if (buffer.length >= 8_192) { parts.push(buffer); buffer = ''; }
    return true;
  };
  if (/^[\x00-\x7f]*$/u.test(raw)) {
    // Most extracted technical papers are predominantly ASCII. A whole-page
    // fast path avoids allocating a grapheme object for every character.
    for (const part of raw.matchAll(/\s+|\S+/gu)) {
      const value = whitespace.test(part[0]) ? ' ' : part[0].toLowerCase();
      if (!append(value, part.index, part.index + part[0].length)) break;
    }
  } else {
    for (const part of graphemes.segment(raw)) {
      const value = fold(part.segment), end = part.index + part.segment.length;
      if (whitespace.test(value)) {
        if (pendingWhitespace) pendingWhitespace.to = end;
        else pendingWhitespace = { from: part.index, to: end };
        continue;
      }
      if (pendingWhitespace) {
        if (!append(' ', pendingWhitespace.from, pendingWhitespace.to)) break;
        pendingWhitespace = undefined;
      }
      if (!append(value, part.index, end)) break;
    }
    if (pendingWhitespace) append(' ', pendingWhitespace.from, pendingWhitespace.to);
  }
  parts.push(buffer);
  return { text: parts.join(''), spans, offsets, sourceLength, truncated };
}

function firstEndingAfter<T extends { to: number }>(entries: readonly T[], position: number): number {
  let low = 0, high = entries.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (entries[middle].to <= position) low = middle + 1; else high = middle;
  }
  return low;
}

/** Returns non-overlapping literal matches, with original UTF-16 span offsets. */
export function findPageMatches(page: PDFSearchPage, query: string, maxMatches?: number): PDFSearchMatch[] {
  const needle = normalizeSearchQuery(query);
  if (!needle) return [];
  const matches: PDFSearchMatch[] = [], limit = bounded(maxMatches, PDF_SEARCH_LIMITS.matches);
  let position = 0;
  let previousSourceFrom = -1, previousSourceTo = -1;
  while (matches.length < limit) {
    const from = page.text.indexOf(needle, position);
    if (from < 0) break;
    const to = from + needle.length;
    const first = page.offsets[firstEndingAfter(page.offsets, from)];
    const last = page.offsets[firstEndingAfter(page.offsets, to - 1)];
    const sourceFrom = first.sourceFrom + Math.floor((from - first.from) / first.unitLength) * first.sourceUnitLength;
    const sourceTo = last.sourceFrom + Math.ceil((to - last.from) / last.unitLength) * last.sourceUnitLength;
    position = to;
    // One PDF glyph can normalize to several characters (for example ﬀ → ff).
    // Searching f must not offer two indistinguishable selections of that glyph.
    if (sourceFrom === previousSourceFrom && sourceTo === previousSourceTo) continue;
    previousSourceFrom = sourceFrom; previousSourceTo = sourceTo;
    const ranges: PDFSearchRange[] = [];
    for (let index = firstEndingAfter(page.spans, sourceFrom); index < page.spans.length && page.spans[index].from < sourceTo; index++) {
      const span = page.spans[index];
      ranges.push({ itemIndex: span.itemIndex, from: Math.max(sourceFrom, span.from) - span.from, to: Math.min(sourceTo, span.to) - span.from });
    }
    matches.push({ from, to, ranges });
  }
  return matches;
}

function checkAbort(signal?: AbortSignal) {
  if (signal?.aborted) {
    const error = new Error('PDF search was cancelled.'); error.name = 'AbortError'; throw error;
  }
}

/** Read one page at a time; retain only bounded matches, never a document index. */
export async function searchPDFDocument(pdf: PDFSearchDocument, query: string, options: PDFSearchOptions = {}): Promise<PDFSearchResult> {
  const needle = normalizeSearchQuery(query);
  const result = emptyPDFSearchResult(pdf.numPages);
  checkAbort(options.signal);
  if (!needle) return result;
  if (!Number.isSafeInteger(pdf.numPages) || pdf.numPages < 1) throw new Error('The PDF has an invalid page count.');
  const maxMatches = bounded(options.maxMatches, PDF_SEARCH_LIMITS.matches);
  const maxPages = bounded(options.maxPages, PDF_SEARCH_LIMITS.pages);
  const maxCharacters = bounded(options.maxCharacters, PDF_SEARCH_LIMITS.documentCharacters);
  let characters = 0, lastReportedAt = 0;
  const report = () => {
    checkAbort(options.signal);
    options.onProgress?.({ ...result, matches: result.matches.slice(), failedPages: result.failedPages.slice() });
    lastReportedAt = Date.now();
  };
  for (let pageNumber = 1; pageNumber <= Math.min(pdf.numPages, maxPages); pageNumber++) {
    checkAbort(options.signal);
    try {
      const page = await pdf.getPage(pageNumber);
      checkAbort(options.signal);
      const content = await page.getTextContent();
      checkAbort(options.signal);
      const indexed = buildSearchPage(content.items, Math.min(bounded(options.maxPageCharacters, PDF_SEARCH_LIMITS.pageCharacters), maxCharacters - characters));
      characters += indexed.sourceLength;
      result.hasText ||= !!indexed.text.trim();
      result.truncated ||= indexed.truncated;
      for (const match of findPageMatches(indexed, query, maxMatches - result.matches.length)) {
        result.matches.push({ pageNumber, match });
      }
    } catch (error) {
      checkAbort(options.signal);
      // A damaged text stream should not hide matches in the following pages.
      result.failedPages.push(pageNumber);
    }
    result.scannedPages = pageNumber;
    if (result.matches.length >= maxMatches || characters >= maxCharacters) {
      // At the match ceiling, there may also be unreported matches on this page.
      result.truncated ||= result.matches.length >= maxMatches || pageNumber < pdf.numPages;
      break;
    }
    if (pageNumber <= 3 || pageNumber % 16 === 0 || Date.now() - lastReportedAt >= 75) report();
    // Yield even when worker responses are already cached, keeping input usable.
    await new Promise<void>(resolve => setTimeout(resolve, 0));
  }
  result.truncated ||= result.scannedPages < pdf.numPages;
  report();
  return result;
}
