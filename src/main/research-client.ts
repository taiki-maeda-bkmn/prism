import { marked, type Tokens } from 'marked';
import { baseArxivId, normalizeArxivId } from '../shared/arxiv';
import type { ResearchCatalog, ResearchIdentity, ResearchPaper, ResearchReview } from '../shared/research';

export const RESEARCH_SITE_URL = 'https://beautysamurai.github.io/public-page/';
export const MAX_RESEARCH_JSON_BYTES = 12 * 1024 * 1024;
export const MAX_RESEARCH_PDF_BYTES = 100 * 1024 * 1024;
const cacheAge = 5 * 60 * 1000;
const maximumEditions = 3000;
const maximumEditionPapers = 200;
const maximumPapers = 20000;
const maximumReviewText = 500000;
const arxivHosts = new Set(['arxiv.org', 'www.arxiv.org', 'export.arxiv.org']);
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown, limit: number): string => typeof value === 'string'
  ? value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, '').trim().slice(0, limit) : '';
const singleLine = (value: unknown, limit: number): string => text(value, limit).replace(/\s+/g, ' ');

function date(value: unknown): string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return '';
  const parsed = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value ? value : '';
}

function editionId(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,139}$/.test(value)) throw new Error('Invalid research edition.');
  return value;
}

export function researchIdentity(value: unknown): ResearchIdentity {
  if (!object(value)) throw new Error('Choose a valid research paper.');
  const arxivId = normalizeArxivId(value.arxivId);
  if (!arxivId) throw new Error('Invalid arXiv identifier.');
  return { editionId: editionId(value.editionId), arxivId };
}

export function researchReviewURL(id: string): string {
  return `${RESEARCH_SITE_URL}?edition=${encodeURIComponent(editionId(id))}`;
}

function normalizePaper(raw: unknown, edition: { editionId: string; date: string; kind: string }): ResearchPaper | null {
  if (!object(raw)) return null;
  const arxivId = normalizeArxivId(raw.arxivId);
  const title = singleLine(raw.title, 500);
  if (!arxivId || !title) return null;
  const scale = raw.schedulerRatingScale;
  const rating = raw.schedulerRating;
  const rated = typeof scale === 'number' && Number.isFinite(scale) && scale > 0
    && typeof rating === 'number' && Number.isFinite(rating) && rating >= 0 && rating <= scale;
  return {
    ...edition, arxivId, baseId: baseArxivId(arxivId)!, title,
    authors: Array.isArray(raw.authors) ? raw.authors.slice(0, 200).map(value => singleLine(value, 200)).filter(Boolean) : [],
    topics: Array.isArray(raw.topics) ? [...new Set(raw.topics.slice(0, 30).map(value => singleLine(value, 100)).filter(Boolean))] : [],
    rating: rated ? rating : null, ratingScale: rated ? scale : null, score: rated ? rating / scale * 10 : null,
    rank: typeof raw.schedulerRank === 'number' && Number.isSafeInteger(raw.schedulerRank) && raw.schedulerRank > 0 && raw.schedulerRank <= maximumEditionPapers ? raw.schedulerRank : null,
    summary: text(raw.schedulerSummary, 100000),
  };
}

export function normalizeResearchCatalogue(value: unknown): ResearchCatalog {
  if (!object(value) || value.schemaVersion !== 1 || !Array.isArray(value.editions)
    || value.editions.length > maximumEditions) throw new Error('Unsupported research catalogue format.');
  const papers: ResearchPaper[] = [];
  const identities = new Set<string>();
  for (const raw of value.editions) {
    if (!object(raw)) throw new Error('Unsupported research catalogue edition.');
    const id = editionId(raw.editionId);
    const editionDate = date(raw.date);
    const kind = singleLine(raw.kind, 30);
    if (!editionDate || !['daily', 'weekly', 'monthly'].includes(kind) || !Array.isArray(raw.papers)
      || raw.papers.length > maximumEditionPapers) throw new Error('Unsupported research catalogue edition.');
    for (const candidate of raw.papers) {
      const paper = normalizePaper(candidate, { editionId: id, date: editionDate, kind });
      if (!paper) continue;
      const key = `${id}:${paper.arxivId}`;
      if (identities.has(key)) throw new Error('The research catalogue contains an ambiguous paper entry.');
      identities.add(key);
      papers.push(paper);
      if (papers.length > maximumPapers) throw new Error('The research catalogue contains too many papers.');
    }
  }
  papers.sort((a, b) => b.date.localeCompare(a.date) || b.editionId.localeCompare(a.editionId) || a.arxivId.localeCompare(b.arxivId));
  return { papers, sourceUrl: RESEARCH_SITE_URL };
}

interface Edition { id: string; papers: ResearchPaper[]; source: string; kind: string }

function normalizeEdition(value: unknown, expectedId: string): Edition {
  if (!object(value) || value.schemaVersion !== 2 || value.editionId !== expectedId || !Array.isArray(value.papers)
    || value.papers.length > maximumEditionPapers || !date(value.editionDate)
    || !['daily', 'weekly', 'monthly'].includes(String(value.editionKind))) throw new Error('Unsupported research review format.');
  if (value.sourceText !== undefined && (typeof value.sourceText !== 'string' || value.sourceText.length > maximumReviewText)) {
    throw new Error('The published review is too large or has an unsupported format.');
  }
  const kind = value.editionKind as string;
  const papers = value.papers.map(raw => normalizePaper(raw, { editionId: expectedId, date: value.editionDate as string, kind }));
  if (papers.some(paper => !paper)) throw new Error('The published review contains an invalid paper.');
  const valid = papers as ResearchPaper[];
  if (new Set(valid.map(paper => paper.arxivId)).size !== valid.length) throw new Error('The published review contains an ambiguous paper entry.');
  return { id: expectedId, papers: valid, kind, source: text(value.sourceText, maximumReviewText).replace(/\r\n?/g, '\n') };
}

function publishedReview(edition: Edition, paper: ResearchPaper): Pick<ResearchReview, 'reviewText' | 'reviewScope'> {
  if (!edition.source) return { reviewText: paper.summary, reviewScope: 'summary' };
  const entire = { reviewText: edition.source, reviewScope: 'edition' as const };
  if (edition.kind !== 'daily') return entire;
  const tokens = marked.lexer(edition.source);
  // Only top-level headings define sections. Quoted/list/code examples cannot
  // be mistaken for another paper, and source offsets must be lossless.
  if (tokens.map(token => token.raw).join('') !== edition.source) return entire;
  let offset = 0;
  const headings: { token: Tokens.Heading; start: number; end: number; rank: number | null }[] = [];
  for (const token of tokens) {
    const start = offset;
    offset += token.raw.length;
    if (token.type === 'heading') {
      const rank = /^(\d{1,4})[.)]\s/.exec(token.text);
      headings.push({ token: token as Tokens.Heading, start, end: offset, rank: rank ? Number(rank[1]) : null });
    }
  }
  const numbered = headings.filter(heading => heading.rank !== null);
  const ranks = edition.papers.map(item => item.rank);
  if (numbered.length !== edition.papers.length || new Set(ranks).size !== ranks.length
    || new Set(numbered.map(heading => heading.rank)).size !== ranks.length
    || ranks.some(rank => rank === null || rank > ranks.length || !numbered.some(heading => heading.rank === rank))) return entire;
  const normalizeTitle = (title: string) => title.replace(/[*_`]/g, '').replace(/\s+/g, ' ').trim().toLowerCase();
  // Agreement between the archive's rank and heading title prevents a valid
  // but reordered/mismatched archive from attributing another paper's review.
  if (numbered.some(heading => normalizeTitle(heading.token.text.replace(/^\d+[.)]\s+/, ''))
    !== normalizeTitle(edition.papers.find(item => item.rank === heading.rank)!.title))) return entire;
  const section = numbered.find(heading => heading.rank === paper.rank)!;
  const next = headings.find(heading => heading.start > section.start && heading.token.depth <= section.token.depth);
  const reviewText = edition.source.slice(section.end, next?.start).trim();
  return reviewText ? { reviewText, reviewScope: 'paper' } : entire;
}

interface ResearchClientOptions {
  fetchImpl?: typeof fetch;
  now?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
  jsonByteLimit?: number;
  pdfByteLimit?: number;
  jsonTimeoutMs?: number;
  pdfTimeoutMs?: number;
}

/** Fixed-origin, bounded networking owned by the desktop process. */
export class ResearchClient {
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly sleep: (milliseconds: number) => Promise<void>;
  private readonly jsonByteLimit: number;
  private readonly pdfByteLimit: number;
  private readonly jsonTimeout: number;
  private readonly pdfTimeout: number;
  private catalog: { time: number; value: ResearchCatalog } | undefined;
  private catalogPending: Promise<ResearchCatalog> | undefined;
  private readonly editions = new Map<string, { time: number; value: Edition }>();
  private readonly editionPending = new Map<string, Promise<Edition>>();
  private readonly downloads = new Map<string, Promise<Uint8Array>>();
  private generation = 0;
  private downloadQueue: Promise<unknown> = Promise.resolve();
  private lastDownloadStart = -Infinity;

  constructor(options: ResearchClientOptions = {}) {
    this.fetchImpl = options.fetchImpl ?? ((input, init) => globalThis.fetch(input, init));
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? (milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)));
    const bound = (value: number | undefined, limit: number) => value !== undefined && Number.isSafeInteger(value) && value > 0 ? Math.min(value, limit) : limit;
    this.jsonByteLimit = bound(options.jsonByteLimit, MAX_RESEARCH_JSON_BYTES);
    this.pdfByteLimit = bound(options.pdfByteLimit, MAX_RESEARCH_PDF_BYTES);
    this.jsonTimeout = bound(options.jsonTimeoutMs, 20000);
    this.pdfTimeout = bound(options.pdfTimeoutMs, 120000);
  }

  private async bytes(response: Response, limit: number, name: string): Promise<Uint8Array> {
    if (Number(response.headers.get('content-length')) > limit) {
      await response.body?.cancel().catch(() => undefined);
      throw new Error(`${name} is too large.`);
    }
    if (!response.body) throw new Error(`${name} is empty.`);
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > limit) throw new Error(`${name} is too large.`);
        chunks.push(value);
      }
      const bytes = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
      return bytes;
    } catch (error) {
      await reader.cancel().catch(() => undefined);
      throw error;
    } finally { reader.releaseLock(); }
  }

  private async json(relative: string): Promise<unknown> {
    const response = await this.fetchImpl(new URL(relative, RESEARCH_SITE_URL).href, {
      signal: AbortSignal.timeout(this.jsonTimeout), redirect: 'error',
      headers: { Accept: 'application/json', 'User-Agent': 'Prism/0.1 (local research reader)' },
    });
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new Error(`Rates & Execution returned HTTP ${response.status}.`);
    }
    const bytes = await this.bytes(response, this.jsonByteLimit, 'The research response');
    try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
    catch { throw new Error('Rates & Execution returned invalid JSON.'); }
  }

  async catalogue(refresh = false): Promise<ResearchCatalog> {
    if (typeof refresh !== 'boolean') throw new Error('Invalid research refresh request.');
    if (this.catalogPending) return structuredClone(await this.catalogPending);
    if (!refresh && this.catalog && this.now() - this.catalog.time < cacheAge) return structuredClone(this.catalog.value);
    if (refresh) { this.generation++; this.editions.clear(); this.editionPending.clear(); }
    const pending = this.json('data/papers.json').then(value => {
      const catalog = normalizeResearchCatalogue(value);
      this.catalog = { time: this.now(), value: catalog };
      return catalog;
    });
    this.catalogPending = pending;
    try { return structuredClone(await pending); }
    finally { if (this.catalogPending === pending) this.catalogPending = undefined; }
  }

  async review(value: unknown): Promise<ResearchReview> {
    const identity = researchIdentity(value);
    const cached = this.editions.get(identity.editionId);
    let edition: Edition;
    if (cached && this.now() - cached.time < cacheAge) edition = cached.value;
    else {
      let pending = this.editionPending.get(identity.editionId);
      if (!pending) {
        const generation = this.generation;
        pending = this.json(`data/archive/${identity.editionId}.json`).then(raw => {
          const result = normalizeEdition(raw, identity.editionId);
          if (generation === this.generation) {
            if (this.editions.size >= 50) this.editions.delete(this.editions.keys().next().value!);
            this.editions.set(identity.editionId, { time: this.now(), value: result });
          }
          return result;
        });
        this.editionPending.set(identity.editionId, pending);
      }
      try { edition = await pending; }
      finally { if (this.editionPending.get(identity.editionId) === pending) this.editionPending.delete(identity.editionId); }
    }
    const paper = edition.papers.find(item => item.arxivId === identity.arxivId);
    if (!paper) throw new Error('This paper is not present in the selected review edition.');
    return structuredClone({ ...paper, ...publishedReview(edition, paper), sourceUrl: researchReviewURL(identity.editionId) });
  }

  async downloadPDF(value: string): Promise<Uint8Array> {
    const id = normalizeArxivId(value);
    if (!id) throw new Error('Invalid arXiv identifier.');
    const existing = this.downloads.get(id);
    if (existing) return existing;
    const result = this.downloadQueue.then(async () => {
      const delay = 3000 - (this.now() - this.lastDownloadStart);
      if (delay > 0) await this.sleep(delay);
      this.lastDownloadStart = this.now();
      const signal = AbortSignal.timeout(this.pdfTimeout);
      let url = new URL(`https://arxiv.org/pdf/${id.split('/').map(encodeURIComponent).join('/')}`);
      for (let redirects = 0; ; redirects++) {
        const response = await this.fetchImpl(url.href, {
          signal, redirect: 'manual', headers: { Accept: 'application/pdf', 'User-Agent': 'Prism/0.1 (local research reader)' },
        });
        if ([301, 302, 303, 307, 308].includes(response.status)) {
          await response.body?.cancel().catch(() => undefined);
          const location = response.headers.get('location');
          if (!location || redirects >= 3) throw new Error('arXiv returned too many or invalid PDF redirects.');
          const next = new URL(location, url);
          const match = /^\/pdf\/(.+?)(?:\.pdf)?$/.exec(next.pathname);
          const nextId = match ? normalizeArxivId(match[1]) : null;
          if (next.protocol !== 'https:' || !arxivHosts.has(next.hostname) || next.port || next.username || next.password
            || next.search || next.hash || !nextId || baseArxivId(nextId) !== baseArxivId(id)
            || (/v[0-9]+$/.test(id) && nextId !== id)) throw new Error('arXiv redirected this PDF to an unsupported destination.');
          url = next;
          continue;
        }
        if (response.status !== 200) {
          await response.body?.cancel().catch(() => undefined);
          throw new Error(`arXiv returned HTTP ${response.status}.`);
        }
        const bytes = await this.bytes(response, this.pdfByteLimit, 'The PDF');
        if (!/^%PDF-[0-9]\.[0-9]/.test(new TextDecoder('ascii').decode(bytes.subarray(0, 8)))) throw new Error('arXiv did not return a PDF document.');
        return bytes;
      }
    });
    this.downloadQueue = result.catch(() => undefined);
    this.downloads.set(id, result);
    try { return await result; }
    finally { if (this.downloads.get(id) === result) this.downloads.delete(id); }
  }
}
