import assert from 'node:assert/strict';
import test from 'node:test';
import { baseArxivId, normalizeArxivId } from '../src/shared/arxiv';
import { normalizeResearchCatalogue, ResearchClient, RESEARCH_SITE_URL } from '../src/main/research-client';

const firstId = '2610.11691v1';
const secondId = '2609.12345';
const editionId = '2026-10-09-daily-01';
const paper = (id = firstId, title = 'First paper', rank = 1) => ({
  arxivId: id, title, authors: ['研究者', 'A. Author'], topics: ['Market microstructure'],
  schedulerRating: 4, schedulerRatingScale: 5, schedulerRank: rank, schedulerSummary: 'Published summary.',
  pdfUrl: 'http://127.0.0.1/private', absUrl: 'file:///private',
});
const catalogue = () => ({ schemaVersion: 1, editions: [{ editionId, date: '2026-10-09', kind: 'daily', papers: [paper()] }] });
const archive = () => ({
  schemaVersion: 2, editionId, editionDate: '2026-10-09', editionKind: 'daily',
  papers: [paper(), paper(secondId, 'Second paper', 2)],
  sourceText: '# Published edition\n\n## 1. First paper\n\n日本語のレビュー $x^2$.\n\n```md\n## 3. Example heading\n```\n\n## 2. Second paper\n\nSecond review.\n',
});
const json = (value: unknown) => new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } });
const pdf = () => new Response('%PDF-1.7\nfixture\n', { headers: { 'Content-Type': 'application/pdf' } });
const fetcher = (fn: (url: string, init: RequestInit | undefined) => Response | Promise<Response>): typeof fetch =>
  (async (input, init) => fn(String(input), init)) as typeof fetch;
const fakeClock = () => {
  let current = 10000;
  const sleeps: number[] = [];
  return { now: () => current, sleep: async (duration: number) => { sleeps.push(duration); current += duration; }, sleeps,
    advance: (duration: number) => { current += duration; } };
};

test('arXiv identities are bounded canonical bare identifiers, with version-independent duplicate keys', () => {
  assert.equal(normalizeArxivId(' 2610.11691V2 '), '2610.11691v2');
  assert.equal(normalizeArxivId('HEP-TH/9901001v1'), 'hep-th/9901001v1');
  assert.equal(baseArxivId('hep-th/9901001v12'), 'hep-th/9901001');
  assert.equal(baseArxivId(firstId), '2610.11691');
  for (const invalid of ['https://arxiv.org/abs/2610.11691', 'arxiv:2610.11691', '../2610.11691', '2613.11691',
    '2600.12345', 'hep-th/9913001', '2610.11691v0', '2610.11691v01', '2610.11691v9999999', '2610.11691?x=1',
    '2610.11691.pdf', '2610.11691\nOTHER', 'a/'.repeat(60), null, {}]) assert.equal(normalizeArxivId(invalid), null);
});

test('catalogue normalizes metadata and scales without trusting published URLs or treating missing scores as zero', () => {
  const value = catalogue();
  value.editions[0].papers.push({ ...paper(secondId, 'Other paper'), schedulerRating: null as unknown as number });
  const result = normalizeResearchCatalogue(value);
  assert.equal(result.sourceUrl, RESEARCH_SITE_URL);
  const first = result.papers.find(item => item.arxivId === firstId)!;
  assert.equal(first.rating, 4); assert.equal(first.ratingScale, 5); assert.equal(first.score, 8);
  assert.equal(first.baseId, '2610.11691');
  assert.deepEqual(first.authors, ['研究者', 'A. Author']);
  assert.equal(result.papers.find(item => item.arxivId === secondId)!.score, null);
  assert.equal('pdfUrl' in first, false); assert.equal('absUrl' in first, false);
  const withoutRatings = catalogue();
  withoutRatings.editions[0].papers[0].schedulerRating = '4' as unknown as number;
  assert.equal(normalizeResearchCatalogue(withoutRatings).papers[0].score, null);
});

test('catalogue rejects unsupported shape, invalid editions, overflow and ambiguous entries', () => {
  const malformed: unknown[] = [null, { schemaVersion: 2, editions: [] }, { schemaVersion: 1, editions: Array(3001).fill({}) }];
  for (const change of [{ editionId: '../private' }, { date: '2026-02-31' }, { kind: 'other' }, { papers: Array(201).fill(paper()) }, { papers: [paper(), paper()] }]) {
    malformed.push({ schemaVersion: 1, editions: [{ ...catalogue().editions[0], ...change }] });
  }
  for (const value of malformed) assert.throws(() => normalizeResearchCatalogue(value));
  const badPaper = catalogue();
  badPaper.editions[0].papers[0].arxivId = '../../private';
  assert.equal(normalizeResearchCatalogue(badPaper).papers.length, 0);
});

test('catalogue coalesces in-flight requests, caches defensively, refreshes and retries after failure', async () => {
  let release!: () => void;
  const wait = new Promise<void>(resolve => { release = resolve; });
  const clock = fakeClock();
  let calls = 0;
  const client = new ResearchClient({ ...clock, fetchImpl: fetcher(async (url, init) => {
    calls++;
    assert.equal(url, `${RESEARCH_SITE_URL}data/papers.json`);
    assert.equal(init?.redirect, 'error'); assert.ok(init?.signal);
    await wait;
    return json(catalogue());
  }) });
  const first = client.catalogue(); const second = client.catalogue();
  release();
  const [a, b] = await Promise.all([first, second]);
  assert.equal(calls, 1);
  a.papers[0].title = 'Mutated'; a.papers[0].topics.push('Mutated');
  assert.equal(b.papers[0].title, 'First paper');
  assert.deepEqual((await client.catalogue()).papers[0].topics, ['Market microstructure']);
  await client.catalogue(true); assert.equal(calls, 2);
  clock.advance(300001); await client.catalogue(); assert.equal(calls, 3);
  await assert.rejects(client.catalogue('yes' as unknown as boolean), /refresh/);
  let fail = true;
  const retry = new ResearchClient({ fetchImpl: fetcher(() => fail ? new Response('Unavailable', { status: 503 }) : json(catalogue())) });
  await assert.rejects(retry.catalogue(), /HTTP 503/);
  fail = false;
  assert.equal((await retry.catalogue()).papers.length, 1);
});

test('JSON reads enforce byte caps both with headers and streamed bodies and reject invalid JSON/UTF-8', async () => {
  for (const response of [
    () => new Response('small', { headers: { 'Content-Length': '101' } }),
    () => new Response('x'.repeat(101)),
  ]) {
    const client = new ResearchClient({ jsonByteLimit: 100, fetchImpl: fetcher(response) });
    await assert.rejects(client.catalogue(), /too large/);
  }
  for (const body of ['{broken', new Uint8Array([0xff, 0xfe])]) {
    const client = new ResearchClient({ fetchImpl: fetcher(() => new Response(body)) });
    await assert.rejects(client.catalogue(), /invalid JSON/);
  }
});

test('daily review extraction uses matching top-level ranks/titles and preserves Markdown and math', async () => {
  let calls = 0;
  const client = new ResearchClient({ fetchImpl: fetcher(url => {
    calls++; assert.equal(url, `${RESEARCH_SITE_URL}data/archive/${editionId}.json`); return json(archive());
  }) });
  const [first, second] = await Promise.all([
    client.review({ editionId, arxivId: firstId }), client.review({ editionId, arxivId: secondId }),
  ]);
  assert.equal(calls, 1);
  assert.equal(first.reviewScope, 'paper');
  assert.equal(first.reviewText, '日本語のレビュー $x^2$.\n\n```md\n## 3. Example heading\n```');
  assert.equal(second.reviewText, 'Second review.');
  assert.equal(first.sourceUrl, `${RESEARCH_SITE_URL}?edition=${editionId}`);
  first.authors.length = 0;
  assert.equal((await client.review({ editionId, arxivId: firstId })).authors.length, 2);
});

test('ambiguous daily sections and weekly editions retain the full edition; absent text uses the summary', async () => {
  for (const mutate of [
    (value: ReturnType<typeof archive>) => { value.papers[1].schedulerRank = 1; },
    (value: ReturnType<typeof archive>) => { value.sourceText = value.sourceText.replace('## 2. Second paper', '## 1. Second paper'); },
    (value: ReturnType<typeof archive>) => { value.sourceText = value.sourceText.replace('## 1. First paper', '## 1. Unrelated title'); },
    (value: ReturnType<typeof archive>) => { value.editionKind = 'weekly'; },
  ]) {
    const value = archive(); mutate(value);
    const client = new ResearchClient({ fetchImpl: fetcher(() => json(value)) });
    const result = await client.review({ editionId, arxivId: firstId });
    assert.equal(result.reviewScope, 'edition'); assert.equal(result.reviewText, value.sourceText.trim());
  }
  const value = archive(); value.sourceText = '';
  const client = new ResearchClient({ fetchImpl: fetcher(() => json(value)) });
  const result = await client.review({ editionId, arxivId: firstId });
  assert.equal(result.reviewScope, 'summary'); assert.equal(result.reviewText, 'Published summary.');
});

test('review validates request identity, archive identity and exact paper version without arbitrary URL fetches', async () => {
  let calls = 0;
  const client = new ResearchClient({ fetchImpl: fetcher(() => { calls++; return json(archive()); }) });
  for (const value of [null, { editionId: '../other', arxivId: firstId }, { editionId, arxivId: 'https://arxiv.org/pdf/2610.11691' }]) {
    await assert.rejects(client.review(value));
  }
  assert.equal(calls, 0);
  await assert.rejects(client.review({ editionId, arxivId: '2610.11691v2' }), /not present/);
  for (const mutate of [
    (value: ReturnType<typeof archive>) => { value.editionId = 'other'; },
    (value: ReturnType<typeof archive>) => { value.sourceText = 'x'.repeat(500001); },
    (value: ReturnType<typeof archive>) => { value.papers.push(paper()); },
  ]) {
    const value = archive(); mutate(value);
    await assert.rejects(new ResearchClient({ fetchImpl: fetcher(() => json(value)) }).review({ editionId, arxivId: firstId }));
  }
});

test('catalogue refresh invalidates edition cache and an older review completion cannot repopulate it', async () => {
  let resolveOld!: (value: Response) => void;
  let editions = 0;
  const old = new Promise<Response>(resolve => { resolveOld = resolve; });
  const client = new ResearchClient({ fetchImpl: fetcher(url => {
    if (url.endsWith('papers.json')) return json(catalogue());
    editions++;
    if (editions === 1) return old;
    const value = archive(); value.sourceText = ''; value.papers[0].schedulerSummary = 'New';
    return json(value);
  }) });
  const first = client.review({ editionId, arxivId: firstId });
  await client.catalogue(true);
  assert.equal((await client.review({ editionId, arxivId: firstId })).reviewText, 'New');
  resolveOld(json(archive())); await first;
  assert.equal((await client.review({ editionId, arxivId: firstId })).reviewText, 'New');
  assert.equal(editions, 2);
});

test('PDF downloads derive trusted URLs, coalesce duplicate work, and serialize requests three seconds apart', async () => {
  const clock = fakeClock(); const starts: number[] = []; const urls: string[] = [];
  const client = new ResearchClient({ ...clock, fetchImpl: fetcher((url, init) => {
    starts.push(clock.now()); urls.push(url);
    assert.equal(init?.redirect, 'manual'); assert.ok(init?.signal);
    return pdf();
  }) });
  await Promise.all([client.downloadPDF(firstId), client.downloadPDF(firstId), client.downloadPDF('hep-th/9901001v1')]);
  assert.deepEqual(urls, [`https://arxiv.org/pdf/${firstId}`, 'https://arxiv.org/pdf/hep-th/9901001v1']);
  assert.deepEqual(starts, [10000, 13000]); assert.deepEqual(clock.sleeps, [3000]);
  await assert.rejects(client.downloadPDF('https://example.com/file.pdf'), /identifier/);
  assert.equal(urls.length, 2);
});

test('PDF redirects accept only HTTPS official hosts and the same requested paper/version', async () => {
  for (const destination of ['http://arxiv.org/pdf/' + firstId, 'https://evil.example/pdf/' + firstId,
    'https://arxiv.org.evil.example/pdf/' + firstId, 'https://user@arxiv.org/pdf/' + firstId,
    'https://arxiv.org:8443/pdf/' + firstId, 'https://arxiv.org/pdf/' + secondId,
    'https://arxiv.org/pdf/2610.11691v2', 'https://arxiv.org/help', 'https://arxiv.org/pdf/' + firstId + '?secret=1']) {
    let requests = 0;
    const client = new ResearchClient({ fetchImpl: fetcher(() => { requests++; return new Response(null, { status: 302, headers: { Location: destination } }); }) });
    await assert.rejects(client.downloadPDF(firstId), /unsupported destination/);
    assert.equal(requests, 1);
  }
  let requests = 0;
  const client = new ResearchClient({ fetchImpl: fetcher(() => ++requests === 1
    ? new Response(null, { status: 302, headers: { Location: `https://export.arxiv.org/pdf/${firstId}.pdf` } }) : pdf()) });
  assert.match(new TextDecoder().decode(await client.downloadPDF(firstId)), /^%PDF/);
  assert.equal(requests, 2);
  const looping = new ResearchClient({ fetchImpl: fetcher(() => new Response(null, { status: 302, headers: { Location: `/pdf/${firstId}` } })) });
  await assert.rejects(looping.downloadPDF(firstId), /too many/);
});

test('PDF failures leave the queue retryable and enforce headers, streamed size and PDF signature', async () => {
  for (const response of [
    () => new Response('%PDF-1.7', { headers: { 'Content-Length': '101' } }),
    () => new Response('%PDF-1.7' + 'x'.repeat(100)),
    () => new Response('<html>Not a PDF</html>'),
    () => new Response('%PDF-1.7', { status: 206 }),
  ]) {
    const clock = fakeClock(); let fail = true;
    const client = new ResearchClient({ ...clock, pdfByteLimit: 100, fetchImpl: fetcher(() => fail ? response() : pdf()) });
    await assert.rejects(client.downloadPDF(firstId));
    fail = false;
    assert.match(new TextDecoder().decode(await client.downloadPDF(firstId)), /^%PDF/);
    assert.deepEqual(clock.sleeps, [3000]);
  }
});

test('network requests carry bounded abort signals', async () => {
  const signals: AbortSignal[] = [];
  const client = new ResearchClient({ jsonTimeoutMs: 10, pdfTimeoutMs: 10, fetchImpl: fetcher((_url, init) => {
    signals.push(init!.signal!);
    return new Promise<Response>((_resolve, reject) => init!.signal!.addEventListener('abort', () => reject(init!.signal!.reason), { once: true }));
  }) });
  // Keep an ordinary timer alive as AbortSignal.timeout itself is unreferenced.
  const keepAlive = setTimeout(() => undefined, 1000);
  try {
    await assert.rejects(client.catalogue(), { name: 'TimeoutError' });
    await assert.rejects(client.downloadPDF(firstId), { name: 'TimeoutError' });
    assert.equal(signals.length, 2); assert.ok(signals.every(signal => signal.aborted));
  } finally { clearTimeout(keepAlive); }
});
