import assert from 'node:assert/strict';
import test from 'node:test';
import { ArxivClient, ARXIV_API_URL, arxivSearchURL, normalizeArxivSearch, parseArxivFeed } from '../src/main/arxiv-client';
import type { ArxivSearchRequest } from '../src/shared/arxivSearch';

const request = (patch: Partial<ArxivSearchRequest> = {}): ArxivSearchRequest => ({ query: 'market impact', field: 'all', category: '', sort: 'relevance', start: 0, ...patch });
const atom = 'http://www.w3.org/2005/Atom';
const openSearch = 'http://a9.com/-/spec/opensearch/1.1/';
const metadata = 'http://arxiv.org/schemas/atom';
function entry(id = '2610.01234v2', extra = '', prefix = '') {
  const tag = (name: string, text: string) => `<${prefix}${name}>${text}</${prefix}${name}>`;
  return `<${prefix}entry>${tag('id', `http://arxiv.org/abs/${id}`)}${tag('title', 'Market impact &amp; execution')}
    ${tag('summary', 'An abstract with $x^2$ and &lt;img src="https://untrusted.invalid/image"&gt;.')}
    ${tag('published', '2026-10-20T10:10:10Z')}${tag('updated', '2026-10-28T10:10:10Z')}
    <${prefix}author>${tag('name', 'Alice &amp; Bob')}</${prefix}author>
    <${prefix}category term="q-fin.TR"/><${prefix}category term="math.PR"/>
    <arxiv:primary_category term="q-fin.TR"/>${extra}</${prefix}entry>`;
}
function feed(entries = entry(), { total = 1, start = 0, size = 20, prefix = '' } = {}) {
  return `<?xml version="1.0" encoding="UTF-8"?><${prefix}feed ${prefix ? `xmlns:${prefix.slice(0, -1)}` : 'xmlns'}="${atom}" xmlns:arxiv="${metadata}" xmlns:os="${openSearch}">
    <os:totalResults>${total}</os:totalResults><os:startIndex>${start}</os:startIndex><os:itemsPerPage>${size}</os:itemsPerPage>${entries}</${prefix}feed>`;
}
const response = (xml = feed()) => new Response(xml, { headers: { 'content-type': 'application/atom+xml' } });
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function clock() {
  let time = 0;
  const sleeps: number[] = [];
  return { now: () => time, advance: (milliseconds: number) => { time += milliseconds; }, sleeps,
    sleep: async (milliseconds: number) => { sleeps.push(milliseconds); time += milliseconds; } };
}

test('search URLs use bounded literal fields, category filters, sorting and paging on the fixed API', () => {
  const url = new URL(arxivSearchURL(request({ query: '  market "impact"\\ and execution ', field: 'title', category: 'q-fin.TR', sort: 'newest', start: 20 })));
  assert.equal(`${url.origin}${url.pathname}`, ARXIV_API_URL);
  assert.equal(url.searchParams.get('search_query'), 'cat:q-fin.TR AND ti:"market impact and execution"');
  assert.equal(url.searchParams.get('start'), '20');
  assert.equal(url.searchParams.get('max_results'), '20');
  assert.equal(url.searchParams.get('sortBy'), 'submittedDate');
  assert.equal(url.searchParams.get('sortOrder'), 'descending');
  assert.equal(new URL(arxivSearchURL(request({ field: 'author', sort: 'updated' }))).searchParams.get('sortBy'), 'lastUpdatedDate');
  assert.equal(new URL(arxivSearchURL(request({ query: '', category: 'math.PR' }))).searchParams.get('search_query'), 'cat:math.PR');
  assert.equal(new URL(arxivSearchURL(request({ query: 'x" OR cat:cs.AI' }))).searchParams.get('search_query'), 'all:"x OR cat:cs.AI"');
  for (const invalid of [null, [], {}, request({ query: '' }), request({ query: 'x'.repeat(241) }), request({ query: '\u0000bad' }),
    request({ category: 'q-fin.TR OR all:*' }), request({ category: 'unknown' }), request({ start: 1 }), request({ start: -20 }), request({ start: 2000 }),
    request({ start: NaN }), { ...request(), sort: 'size' }, { ...request(), field: 'other' }, { ...request(), url: 'https://untrusted.invalid' }]) {
    assert.throws(() => normalizeArxivSearch(invalid));
  }
});

test('ID searches accept pasted official links but cannot turn search or import into arbitrary requests', async () => {
  for (const query of ['2610.01234v2', ' arXiv:2610.01234V2 ', 'https://arxiv.org/abs/2610.01234v2', 'http://www.arxiv.org/pdf/2610.01234v2.pdf']) {
    const url = new URL(arxivSearchURL(request({ query, field: 'id', category: 'q-fin.TR', sort: 'newest' })));
    assert.equal(url.searchParams.get('id_list'), '2610.01234v2');
    assert.equal(url.searchParams.get('max_results'), '1');
    assert.equal(url.searchParams.has('search_query'), false);
    assert.equal(url.searchParams.has('sortBy'), false);
  }
  assert.equal(normalizeArxivSearch(request({ field: 'id', query: 'hep-th/9901001V3' })).query, 'hep-th/9901001v3');
  for (const query of ['', '2613.12345', '2610.01234,2610.01235', 'https://evil.invalid/abs/2610.01234', 'https://arxiv.org.evil.invalid/abs/2610.01234',
    'file:///abs/2610.01234', 'https://x@arxiv.org/abs/2610.01234', 'https://arxiv.org:8080/abs/2610.01234', 'https://arxiv.org/abs/2610.01234?x=1']) {
    assert.throws(() => normalizeArxivSearch(request({ query, field: 'id' })));
  }
  assert.throws(() => normalizeArxivSearch(request({ query: '2610.01234', field: 'id', start: 20 })));
  const client = new ArxivClient({ fetchImpl: async () => { throw new Error('No request expected'); } });
  for (const value of [' arxiv:2610.01234 ', 'https://arxiv.org/abs/2610.01234', '2610.01234V2', ' 2610.01234v2 ', null]) await assert.rejects(client.resolve(value), /valid arXiv paper/);
});

test('Atom parsing respects namespaces, returns text metadata and ignores supplied URLs', () => {
  const extra = '<link rel="alternate" href="https://evil.invalid/steal"/><link title="pdf" href="file:///private.pdf"/>'
    + '<x:author xmlns:x="urn:foreign"><x:name>Wrong author</x:name></x:author><category term="I.2.6"/>';
  const parsed = parseArxivFeed(feed(entry('2610.01234v2', extra)));
  assert.equal(parsed.papers[0].arxivId, '2610.01234v2');
  assert.equal(parsed.papers[0].baseId, '2610.01234');
  assert.equal(parsed.papers[0].title, 'Market impact & execution');
  assert.deepEqual(parsed.papers[0].authors, ['Alice & Bob']);
  assert.deepEqual(parsed.papers[0].categories, ['q-fin.TR', 'math.PR']);
  assert.equal(parsed.papers[0].primaryCategory, 'q-fin.TR');
  assert.match(parsed.papers[0].summary, /\$x\^2\$/);
  assert.match(parsed.papers[0].summary, /<img src=/);
  assert.equal(JSON.stringify(parsed.papers).includes('private.pdf'), false);
  assert.deepEqual(parseArxivFeed(feed(entry('2610.01234v2', '', 'a:'), { prefix: 'a:' })).papers, parsed.papers);
  assert.equal(parseArxivFeed(feed(entry('hep-th/9901001v3'))).papers[0].baseId, 'hep-th/9901001');
  const fallback = feed(entry().replace('<arxiv:primary_category term="q-fin.TR"/>', ''));
  assert.equal(parseArxivFeed(fallback).papers[0].primaryCategory, 'q-fin.TR');
});

test('malformed XML, DTDs, entity expansion, duplicate fields and namespace spoofing fail closed', () => {
  const original = feed();
  const cases = ['', '<html>not a feed</html>', original.replace('</entry>', '</entry\njunk>'), original.replace('</title>', '</summary>'),
    original.replace('Market impact &amp;', 'Market impact &unknown;'), original.replace('Market impact', '\u0000'),
    original.replace('?>', '?><!DOCTYPE feed SYSTEM "https://evil.invalid/xxe">'),
    original.replace('?>', '?><!DOCTYPE feed [<!ENTITY x "expanded">]>'),
    original.replace('<title>', '<title bad=unquoted>'), original.replace('<title>', '<title attr="one" attr="two">'),
    original.replace(atom, 'urn:wrong'), original.replace(openSearch, 'urn:wrong'),
    original.replace('</entry>', '<id>http://arxiv.org/abs/2610.01235v1</id></entry>'),
    original.replace('<title>Market impact &amp; execution</title>', '<foreign:title xmlns:foreign="urn:wrong">Wrong</foreign:title>'),
    original.replace('<author><name>', '<author><foreign:name xmlns:foreign="urn:wrong">').replace('</name>', '</foreign:name>'),
    original.replace('<title>Market impact &amp; execution</title>', '<title><b>Nested metadata</b></title>'),
    original.replace('http://arxiv.org/abs/2610.01234v2', 'https://evil.invalid/abs/2610.01234v2'),
    original.replace('http://arxiv.org/abs/2610.01234v2', 'http://arxiv.org/abs/2610.01234v2?download=1')];
  for (const xml of cases) assert.throws(() => parseArxivFeed(xml), /invalid search feed/, xml.slice(0, 100));
});

test('feed structure, duplicate identities, metadata size, dates and pagination counts are bounded', () => {
  const original = feed();
  for (const xml of [feed(entry() + entry(), { total: 2 }), feed(entry() + entry('2610.01234v3'), { total: 2 }),
    feed(Array.from({ length: 21 }, (_, index) => entry(`2610.${String(1234 + index).padStart(5, '0')}v1`)).join(''), { total: 21, size: 21 }),
    feed(entry(), { total: 0 }), feed(entry(), { size: 0 }), original.replace('<os:totalResults>1', '<os:totalResults>NaN'),
    original.replace('<os:totalResults>1', '<os:totalResults>100000001'), original.replace('<os:startIndex>0', '<os:startIndex>-1'),
    original.replace('Market impact &amp; execution', 'x'.repeat(501)), original.replace('An abstract with', 'x'.repeat(30_001)),
    original.replace('2026-10-20T10:10:10Z', '2026-02-30T10:10:10Z'), original.replace('2026-10-28T10:10:10Z', '2026-10-28T25:10:10Z'),
    original.replace('<author><name>Alice &amp; Bob</name></author>', ''), original.replace('term="q-fin.TR"/>', 'term="bad category"/>'),
    original.replace('</feed>', `${'<extra>'.repeat(15)}${'</extra>'.repeat(15)}</feed>`),
    original.replace('</feed>', `<extra ${Array.from({ length: 31 }, (_, index) => `a${index}="x"`).join(' ')}/></feed>`)]) assert.throws(() => parseArxivFeed(xml));
  assert.deepEqual(parseArxivFeed(feed('', { total: 0 })).papers, []);
  assert.equal(parseArxivFeed(original.replace('2026-10-20T10:10:10Z', '2026-10-20T10:10:10-04:00')).papers[0].published, '2026-10-20T10:10:10-04:00');
});

test('official error entries report bounded text without trusting error links', () => {
  const errorEntry = '<entry><id>http://arxiv.org/api/errors#bad_query</id><title>Error</title><summary>Search is unavailable.</summary></entry>';
  assert.throws(() => parseArxivFeed(feed(errorEntry)), /arXiv could not complete this search: Search is unavailable/);
  assert.throws(() => parseArxivFeed(feed(errorEntry.replace('http://arxiv.org', 'http://untrusted.invalid'))), /invalid search feed/);
});

test('metadata requests coalesce, clone outputs, cache and retry failed requests at the same rate', async () => {
  const timing = clock();
  const gate = deferred<Response>();
  const calls: { url: string; time: number; options: RequestInit | undefined }[] = [];
  let fail = false;
  const client = new ArxivClient({ ...timing, fetchImpl: async (url, options) => {
    calls.push({ url: String(url), time: timing.now(), options });
    if (calls.length === 1) return gate.promise;
    if (fail) throw new Error('Temporarily offline');
    return response();
  } });
  const one = client.search(request());
  const two = client.search(request());
  await Promise.resolve();
  assert.equal(calls.length, 1);
  gate.resolve(response());
  const [a, b] = await Promise.all([one, two]);
  a.papers[0].title = 'Mutated'; a.papers[0].categories.push('invalid');
  assert.equal(b.papers[0].title, 'Market impact & execution');
  assert.equal((await client.search(request())).papers[0].categories.length, 2);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].options?.redirect, 'error');
  assert.equal(new Headers(calls[0].options?.headers).get('accept'), 'application/atom+xml, application/xml;q=0.9');
  assert.ok(calls[0].options?.signal instanceof AbortSignal);
  fail = true;
  await assert.rejects(client.search(request({ query: 'second' })), /Temporarily offline/);
  fail = false;
  await client.search(request({ query: 'second' }));
  assert.deepEqual(calls.map(call => call.time), [0, 3000, 6000]);
  timing.advance(15 * 60 * 1000);
  await client.search(request());
  assert.equal(calls.length, 4);
});

test('requests use one connection and retain a bounded waiting queue', async () => {
  const timing = clock();
  const gate = deferred<Response>();
  let active = 0;
  let maximumActive = 0;
  let calls = 0;
  const client = new ArxivClient({ ...timing, fetchImpl: async () => {
    calls++; active++; maximumActive = Math.max(maximumActive, active);
    try { return calls === 1 ? await gate.promise : response(); }
    finally { active--; }
  } });
  const results = Array.from({ length: 20 }, (_, index) => client.search(request({ query: `query ${index}` })));
  await assert.rejects(client.search(request({ query: 'overflow' })), /Too many arXiv searches/);
  await Promise.resolve();
  assert.equal(calls, 1);
  gate.resolve(response());
  await Promise.all(results);
  assert.equal(calls, 20);
  assert.equal(maximumActive, 1);
  assert.deepEqual(timing.sleeps, Array.from({ length: 19 }, () => 3000));
});

test('streaming and declared length limits cancel oversized bodies and reject invalid UTF-8', async () => {
  let cancelled = 0;
  const tooLong = new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(65)); }, cancel() { cancelled++; } }));
  const client = new ArxivClient({ feedByteLimit: 64, fetchImpl: async () => tooLong });
  await assert.rejects(client.search(request()), /too large/);
  assert.equal(cancelled, 1);
  for (const length of ['65', '999999999999999999999', '-1', 'invalid']) {
    const body = new ReadableStream({ cancel() { cancelled++; } });
    await assert.rejects(new ArxivClient({ feedByteLimit: 64, fetchImpl: async () => new Response(body, { headers: { 'content-length': length } }) }).search(request()), /too large/);
  }
  assert.equal(cancelled, 5);
  await assert.rejects(new ArxivClient({ fetchImpl: async () => new Response(new Uint8Array([0xff, 0xfe])) }).search(request()), /invalid search feed/);
  const bytes = new TextEncoder().encode(feed(entry().replace('Alice', '日本')));
  const streamed = new Response(new ReadableStream({ start(controller) {
    for (let index = 0; index < bytes.length; index++) controller.enqueue(bytes.slice(index, index + 1));
    controller.close();
  } }));
  assert.match((await new ArxivClient({ fetchImpl: async () => streamed }).search(request())).papers[0].authors[0], /日本/);
});

test('HTTP, redirect and malformed feed failures do not poison a later search', async () => {
  const timing = clock();
  const responses = [new Response('Unavailable', { status: 503 }), new Response('', { status: 302, headers: { location: 'https://untrusted.invalid/feed' } }), response('<html>Oops</html>'), response()];
  const client = new ArxivClient({ ...timing, fetchImpl: async () => responses.shift()! });
  await assert.rejects(client.search(request()), /HTTP 503/);
  await assert.rejects(client.search(request()), /HTTP 302/);
  await assert.rejects(client.search(request()), /invalid search feed/);
  assert.equal((await client.search(request())).papers.length, 1);
});

test('paging is bounded by returned content and stops at the configured result ceiling', async () => {
  const timing = clock();
  const full = Array.from({ length: 20 }, (_, index) => entry(`2610.${String(1234 + index).padStart(5, '0')}v1`)).join('');
  const client = new ArxivClient({ ...timing, fetchImpl: async url => {
    const start = Number(new URL(String(url)).searchParams.get('start'));
    return response(feed(full, { total: 50_000, start }));
  } });
  assert.equal((await client.search(request())).nextStart, 20);
  assert.equal((await client.search(request({ start: 1980 }))).nextStart, null);
  assert.equal((await new ArxivClient({ fetchImpl: async () => response(feed(entry(), { total: 100 })) }).search(request())).nextStart, null);
  await assert.rejects(new ArxivClient({ fetchImpl: async () => response(feed(entry(), { total: 100, start: 20 })) }).search(request()), /invalid search feed/);
});

test('resolve uses authoritative cached metadata, preserves exact versions and validates lookup identity', async () => {
  const timing = clock();
  const calls: string[] = [];
  const client = new ArxivClient({ ...timing, fetchImpl: async url => {
    calls.push(String(url));
    const id = new URL(String(url)).searchParams.get('id_list');
    return response(feed(entry(id === '2610.01234v1' ? id : '2610.01234v2'), { size: id ? 1 : 20 }));
  } });
  await client.search(request());
  const paper = await client.resolve('2610.01234v2');
  paper.title = 'Injected';
  assert.equal((await client.resolve('2610.01234v2')).title, 'Market impact & execution');
  assert.equal(calls.length, 1);
  assert.equal((await client.resolve('2610.01234v1')).arxivId, '2610.01234v1');
  assert.equal(new URL(calls[1]).searchParams.get('id_list'), '2610.01234v1');
  assert.equal((await client.resolve('2610.01234')).arxivId, '2610.01234v2');
  assert.equal(new URL(calls[2]).searchParams.get('id_list'), '2610.01234');
  for (const id of ['2610.01235v1', '2610.01234v3']) {
    await assert.rejects(new ArxivClient({ fetchImpl: async () => response(feed(entry(), { size: 1 })) }).resolve(id), /invalid search feed/);
  }
  await assert.rejects(new ArxivClient({ fetchImpl: async () => response(feed('', { total: 0, size: 1 })) }).resolve('2610.01234'), /could not be found/);
});

test('bounded search and paper caches expire and evict old entries', async () => {
  const timing = clock();
  let calls = 0;
  const client = new ArxivClient({ ...timing, fetchImpl: async () => { calls++; return response(); } });
  for (let index = 0; index < 41; index++) await client.search(request({ query: `query ${index}` }));
  assert.equal(calls, 41);
  await client.search(request({ query: 'query 0' }));
  assert.equal(calls, 42);
  timing.advance(15 * 60 * 1000);
  await client.resolve('2610.01234v2');
  assert.equal(calls, 43);
});

test('request timeout aborts the metadata operation with a useful retry message', async () => {
  const keepAlive = setTimeout(() => undefined, 200);
  try {
    const client = new ArxivClient({ timeoutMs: 5, fetchImpl: async (_url, options) => new Promise((_resolve, reject) => {
      options!.signal!.addEventListener('abort', () => reject(options!.signal!.reason), { once: true });
    }) });
    await assert.rejects(client.search(request()), /arXiv search timed out/);
  } finally { clearTimeout(keepAlive); }
});
