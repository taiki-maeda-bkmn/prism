import { DOMParser, onWarningStopParsing, type Element, type Node } from '@xmldom/xmldom';
import { baseArxivId, normalizeArxivId } from '../shared/arxiv';
import { ARXIV_CATEGORIES, ARXIV_MAX_START, ARXIV_PAGE_SIZE, type ArxivPaper, type ArxivSearchRequest, type ArxivSearchResult } from '../shared/arxivSearch';

export const ARXIV_API_URL = 'https://export.arxiv.org/api/query';
export const MAX_ARXIV_FEED_BYTES = 5 * 1024 * 1024;
const atom = 'http://www.w3.org/2005/Atom';
const metadata = 'http://arxiv.org/schemas/atom';
const openSearch = 'http://a9.com/-/spec/opensearch/1.1/';
const cacheAge = 15 * 60 * 1000;
const interval = 3000;
const categories = new Set<string>(ARXIV_CATEGORIES.map(category => category.id));
const hosts = new Set(['arxiv.org', 'www.arxiv.org', 'export.arxiv.org']);
const categoryPattern = /^[a-z][a-z-]{0,29}(?:\.[A-Za-z][A-Za-z.-]{0,19})?$/;
const invalidFeed = () => new Error('arXiv returned an invalid search feed. Try searching again.');
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);

function idFromURL(value: string, allowPDF = false): string | null {
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || !hosts.has(url.hostname) || url.port || url.username || url.password || url.search || url.hash) return null;
    const match = (allowPDF ? /^\/(?:abs|pdf)\/(.+)$/ : /^\/abs\/(.+)$/).exec(url.pathname);
    if (!match) return null;
    const id = decodeURIComponent(match[1]);
    return normalizeArxivId(allowPDF ? id.replace(/\.pdf$/i, '') : id);
  } catch { return null; }
}

/** Convenience forms are accepted only in the search box, never as import URLs. */
function searchId(value: string): string | null {
  const candidate = value.trim().replace(/^arxiv\s*:\s*/i, '');
  return normalizeArxivId(candidate) || idFromURL(candidate, true);
}

export function normalizeArxivSearch(value: unknown): ArxivSearchRequest {
  if (!object(value) || Object.keys(value).some(key => !['query', 'field', 'category', 'sort', 'start'].includes(key))
    || typeof value.query !== 'string' || value.query.length > 1024
    || typeof value.field !== 'string' || !['all', 'title', 'author', 'id'].includes(value.field)
    || typeof value.category !== 'string' || value.category.length > 50
    || typeof value.sort !== 'string' || !['relevance', 'newest', 'updated'].includes(value.sort)
    || typeof value.start !== 'number' || !Number.isSafeInteger(value.start)
    || value.start < 0 || value.start > ARXIV_MAX_START || value.start % ARXIV_PAGE_SIZE !== 0) throw new Error('Choose valid arXiv search options.');
  const request = value as unknown as ArxivSearchRequest;
  if (request.field === 'id') {
    const query = searchId(request.query);
    if (!query || request.start !== 0) throw new Error('Enter one valid arXiv ID, such as 2610.01234v1.');
    return { query, field: 'id', category: '', sort: 'relevance', start: 0 };
  }
  if (request.category && !categories.has(request.category)) throw new Error('Choose a supported arXiv category.');
  // Each search is a literal phrase. Quotes and escapes cannot add API clauses.
  const query = request.query.replace(/["\\]/g, ' ').replace(/\s+/g, ' ').trim();
  if (query.length > 240 || /[\u0000-\u001f\u007f-\u009f]/.test(query)) throw new Error('Use up to 240 characters for the search phrase.');
  if (!query && !request.category) throw new Error('Enter a search phrase or choose a category.');
  return { ...request, query };
}

export function arxivSearchURL(value: unknown): string {
  const request = normalizeArxivSearch(value);
  const url = new URL(ARXIV_API_URL);
  if (request.field === 'id') {
    url.searchParams.set('id_list', request.query);
    url.searchParams.set('start', '0');
    url.searchParams.set('max_results', '1');
  } else {
    const field = { all: 'all', title: 'ti', author: 'au' }[request.field];
    const terms = [request.category ? `cat:${request.category}` : '', request.query ? `${field}:"${request.query}"` : ''].filter(Boolean);
    url.searchParams.set('search_query', terms.join(' AND '));
    url.searchParams.set('start', String(request.start));
    url.searchParams.set('max_results', String(ARXIV_PAGE_SIZE));
    url.searchParams.set('sortBy', { relevance: 'relevance', newest: 'submittedDate', updated: 'lastUpdatedDate' }[request.sort]);
    url.searchParams.set('sortOrder', 'descending');
  }
  return url.href;
}

function elements(parent: Node, namespace: string, name: string): Element[] {
  const found: Element[] = [];
  for (let child = parent.firstChild; child; child = child.nextSibling) {
    if (child.nodeType === 1) {
      const element = child as Element;
      if (element.namespaceURI === namespace && element.localName === name) found.push(element);
    }
  }
  return found;
}

function one(parent: Node, namespace: string, name: string, required = true): Element | null {
  const matches = elements(parent, namespace, name);
  if (matches.length > 1 || (required && matches.length !== 1)) throw invalidFeed();
  return matches[0] || null;
}

function content(element: Element | null, limit: number, required = true): string {
  if (!element) { if (required) throw invalidFeed(); return ''; }
  // arXiv metadata is text, not Atom XHTML content or nested foreign markup.
  for (let child = element.firstChild; child; child = child.nextSibling) if (![3, 4, 8].includes(child.nodeType)) throw invalidFeed();
  const value = (element.textContent || '').replace(/\s+/g, ' ').trim();
  if (value.length > limit || /[\u0000-\u001f\u007f-\u009f]/.test(value) || (required && !value)) throw invalidFeed();
  return value;
}

function integer(element: Element | null): number {
  const value = content(element, 12);
  if (!/^(?:0|[1-9]\d*)$/.test(value) || Number(value) > 100_000_000) throw invalidFeed();
  return Number(value);
}

function timestamp(element: Element | null): string {
  const value = content(element, 40);
  const date = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (!date || !Number.isFinite(Date.parse(value)) || +date[2] > 23 || +date[3] > 59 || +date[4] > 59
    || new Date(`${date[1]}T00:00:00Z`).toISOString().slice(0, 10) !== date[1]) throw invalidFeed();
  return value;
}

interface ParsedFeed { papers: ArxivPaper[]; totalResults: number; start: number; itemsPerPage: number }

/** Parse only direct, correctly namespaced Atom metadata; links are never trusted. */
export function parseArxivFeed(xml: string): ParsedFeed {
  if (!xml.trim() || Buffer.byteLength(xml, 'utf8') > MAX_ARXIV_FEED_BYTES
    || /<!\s*(?:DOCTYPE|ENTITY)\b/i.test(xml) || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]/.test(xml)) throw invalidFeed();
  let document;
  try { document = new DOMParser({ onError: onWarningStopParsing, locator: false }).parseFromString(xml, 'application/xml'); }
  catch { throw invalidFeed(); }
  const root = document.documentElement;
  if (!root || root.localName !== 'feed' || root.namespaceURI !== atom || document.doctype) throw invalidFeed();
  // Bound traversal before using recursive DOM textContent accessors.
  const pending: { node: Node; depth: number }[] = [{ node: document, depth: 0 }];
  let count = 0;
  while (pending.length) {
    const { node, depth } = pending.pop()!;
    if (++count > 30_000 || depth > 12) throw invalidFeed();
    if (node.nodeType === 1 && (node as Element).attributes.length > 30) throw invalidFeed();
    for (let child = node.firstChild; child; child = child.nextSibling) pending.push({ node: child, depth: depth + 1 });
  }
  const entries = elements(root, atom, 'entry');
  if (entries.length > ARXIV_PAGE_SIZE) throw invalidFeed();
  const papers = entries.map(entry => {
    const id = content(one(entry, atom, 'id'), 300);
    if (/^https?:\/\/(?:export\.)?arxiv\.org\/api\/errors#/.test(id)) {
      const detail = content(one(entry, atom, 'summary', false), 1000, false).slice(0, 300);
      throw new Error(detail ? `arXiv could not complete this search: ${detail}` : 'arXiv could not complete this search.');
    }
    const arxivId = idFromURL(id);
    if (!arxivId) throw invalidFeed();
    const authorElements = elements(entry, atom, 'author');
    const categoryElements = elements(entry, atom, 'category');
    if (!authorElements.length || authorElements.length > 2000 || !categoryElements.length || categoryElements.length > 100) throw invalidFeed();
    const authors = authorElements.map(author => content(one(author, atom, 'name'), 200));
    // Some old entries include ACM/MSC classifications in category. Retain only
    // category-shaped arXiv tags; the primary category has its own namespace.
    const paperCategories = [...new Set(categoryElements.map(category => category.getAttribute('term') || '').filter(category => categoryPattern.test(category)))];
    const primary = one(entry, metadata, 'primary_category', false)?.getAttribute('term') || paperCategories[0];
    if (!paperCategories.length || paperCategories.length > 30 || !primary || !categoryPattern.test(primary) || !paperCategories.includes(primary)) throw invalidFeed();
    return {
      arxivId, baseId: baseArxivId(arxivId)!, title: content(one(entry, atom, 'title'), 500),
      authors, summary: content(one(entry, atom, 'summary'), 30_000), primaryCategory: primary, categories: paperCategories,
      published: timestamp(one(entry, atom, 'published')), updated: timestamp(one(entry, atom, 'updated')),
    };
  });
  if (new Set(papers.map(paper => paper.baseId)).size !== papers.length) throw invalidFeed();
  const totalResults = integer(one(root, openSearch, 'totalResults'));
  const start = integer(one(root, openSearch, 'startIndex'));
  const itemsPerPage = integer(one(root, openSearch, 'itemsPerPage'));
  if (itemsPerPage > ARXIV_PAGE_SIZE || papers.length > itemsPerPage || papers.length > Math.max(0, totalResults - start)) throw invalidFeed();
  return { papers, totalResults, start, itemsPerPage };
}

interface ArxivClientOptions {
  fetchImpl?: typeof fetch;
  now?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
  feedByteLimit?: number;
  timeoutMs?: number;
}

/** A single metadata connection with bounded caches and no arbitrary feed URLs. */
export class ArxivClient {
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly sleep: (milliseconds: number) => Promise<void>;
  private readonly byteLimit: number;
  private readonly timeout: number;
  private queue: Promise<unknown> = Promise.resolve();
  private lastRequest = -Infinity;
  private readonly pending = new Map<string, Promise<ArxivSearchResult>>();
  private readonly cache = new Map<string, { time: number; value: ArxivSearchResult }>();
  private readonly papers = new Map<string, { time: number; value: ArxivPaper }>();

  constructor(options: ArxivClientOptions = {}) {
    this.fetchImpl = options.fetchImpl ?? ((...args) => globalThis.fetch(...args));
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? (milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)));
    this.byteLimit = Math.max(1, Math.min(MAX_ARXIV_FEED_BYTES, options.feedByteLimit ?? MAX_ARXIV_FEED_BYTES));
    this.timeout = Math.max(1, Math.min(25_000, options.timeoutMs ?? 25_000));
  }

  private async read(response: Response): Promise<string> {
    const length = response.headers.get('content-length');
    if (length && (!/^\d+$/.test(length) || Number(length) > this.byteLimit)) {
      await response.body?.cancel().catch(() => undefined);
      throw new Error('The arXiv search feed is too large.');
    }
    if (!response.body) throw invalidFeed();
    const reader = response.body.getReader();
    const decoder = new TextDecoder('utf-8', { fatal: true });
    const parts: string[] = [];
    let size = 0;
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > this.byteLimit) throw new Error('The arXiv search feed is too large.');
        parts.push(decoder.decode(value, { stream: true }));
      }
      parts.push(decoder.decode());
      return parts.join('');
    } catch (error) {
      await reader.cancel().catch(() => undefined);
      if (error instanceof TypeError) throw invalidFeed();
      throw error;
    } finally { reader.releaseLock(); }
  }

  async search(value: unknown): Promise<ArxivSearchResult> {
    const request = normalizeArxivSearch(value);
    const url = arxivSearchURL(request);
    const cached = this.cache.get(url);
    if (cached && this.now() - cached.time < cacheAge) return structuredClone(cached.value);
    let result = this.pending.get(url);
    if (!result) {
      if (this.pending.size >= 20) throw new Error('Too many arXiv searches are waiting. Wait for the current search to finish.');
      result = this.queue.then(async () => {
        const wait = interval - (this.now() - this.lastRequest);
        if (wait > 0) await this.sleep(wait);
        this.lastRequest = this.now();
        const signal = AbortSignal.timeout(this.timeout);
        try {
          const response = await this.fetchImpl(url, {
            signal, redirect: 'error', headers: { Accept: 'application/atom+xml, application/xml;q=0.9', 'User-Agent': 'Prism/0.1 (local research reader)' },
          });
          if (response.status !== 200) {
            await response.body?.cancel().catch(() => undefined);
            throw new Error(`arXiv search returned HTTP ${response.status}. Try again later.`);
          }
          const feed = parseArxivFeed(await this.read(response));
          if (feed.start !== request.start) throw invalidFeed();
          if (request.field === 'id' && (feed.papers.length > 1 || feed.papers.some(paper => paper.baseId !== baseArxivId(request.query)
            || (/v\d+$/.test(request.query) && paper.arxivId !== request.query)))) throw invalidFeed();
          const nextStart = request.start + ARXIV_PAGE_SIZE;
          const value: ArxivSearchResult = { papers: feed.papers, totalResults: feed.totalResults, start: feed.start,
            nextStart: request.field !== 'id' && feed.papers.length === ARXIV_PAGE_SIZE && nextStart < feed.totalResults && nextStart <= ARXIV_MAX_START ? nextStart : null };
          const time = this.now();
          this.cache.delete(url);
          if (this.cache.size >= 40) this.cache.delete(this.cache.keys().next().value!);
          this.cache.set(url, { time, value });
          for (const paper of value.papers) {
            this.papers.delete(paper.arxivId);
            if (this.papers.size >= 200) this.papers.delete(this.papers.keys().next().value!);
            this.papers.set(paper.arxivId, { time, value: paper });
          }
          return value;
        } catch (error) {
          if (signal.aborted) throw new Error('arXiv search timed out. Try again.');
          throw error;
        }
      });
      this.queue = result.catch(() => undefined);
      this.pending.set(url, result);
    }
    try { return structuredClone(await result); }
    finally { if (this.pending.get(url) === result) this.pending.delete(url); }
  }

  async resolve(value: unknown): Promise<ArxivPaper> {
    const id = normalizeArxivId(value);
    if (!id || value !== id) throw new Error('Choose a valid arXiv paper from the search results.');
    const cached = this.papers.get(id);
    if (cached && this.now() - cached.time < cacheAge) return structuredClone(cached.value);
    const result = await this.search({ query: id, field: 'id', category: '', sort: 'relevance', start: 0 });
    if (result.papers.length !== 1) throw new Error('This paper could not be found on arXiv. Search again before importing.');
    return result.papers[0];
  }
}
