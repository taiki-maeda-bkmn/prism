import assert from 'node:assert/strict';
import dns from 'node:dns';
import https from 'node:https';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ClientRequest, IncomingMessage, IncomingHttpHeaders } from 'node:http';
import test from 'node:test';
import { PDFURLDownloader, validatePublicPDFURL, type PDFURLDownloadProgress } from '../src/main/pdf-url-download';

const pdf = Buffer.from('%PDF-1.7\n1 0 obj\n<< /Type /Catalog >>\nendobj\n%%EOF\n');
const publicIPv4 = { address: '93.184.215.14', family: 4 };
type ConstructorOptions = NonNullable<ConstructorParameters<typeof PDFURLDownloader>[0]>;
type Route = {
  status?: number;
  headers?: IncomingHttpHeaders;
  chunks?: Buffer[];
  hold?: boolean;
  error?: Error;
};
class FakeRequest extends EventEmitter {
  destroyed = false;
  response?: PassThrough;
  constructor(private readonly start: () => void) { super(); }
  end() { queueMicrotask(this.start); return this; }
  destroy() { this.destroyed = true; this.response?.destroy(); return this; }
}
interface Attempt { options: https.RequestOptions; request: FakeRequest; response?: PassThrough; address?: string | dns.LookupAddress[]; family?: number }

function fixture(routes: Route[] = [{}], overrides: ConstructorOptions = {}) {
  const attempts: Attempt[] = [];
  const lookups: string[] = [];
  const progress: PDFURLDownloadProgress[] = [];
  const controller = new AbortController();
  const lookup: NonNullable<ConstructorOptions['lookup']> = (host, callback) => {
    lookups.push(host); queueMicrotask(() => callback(null, [{ ...publicIPv4 }]));
  };
  const request: NonNullable<ConstructorOptions['request']> = (options, callback) => {
    const index = attempts.length;
    const attempt: Attempt = { options, request: undefined! };
    const req = new FakeRequest(() => {
      if (req.destroyed) return;
      options.lookup!(String(options.hostname), { family: options.family }, (error, address, family) => {
        if (error) { req.emit('error', error); return; }
        attempt.address = address; attempt.family = family;
        const route = routes[index];
        assert.ok(route, 'Unexpected additional HTTP request');
        if (route.error) { req.emit('error', route.error); return; }
        const response = new PassThrough();
        Object.assign(response, { statusCode: route.status ?? 200, headers: route.headers ?? { 'content-type': 'application/pdf' } });
        attempt.response = response;
        req.response = response;
        callback(response as unknown as IncomingMessage);
        if (response.destroyed) return;
        for (const chunk of route.chunks ?? [pdf]) {
          if (response.destroyed) break;
          response.write(chunk);
        }
        if (!route.hold && !response.destroyed) response.end();
      });
    });
    attempt.request = req;
    attempts.push(attempt);
    return req as unknown as ClientRequest;
  };
  const client = new PDFURLDownloader({ lookup, request, ...overrides });
  const download = (...input: [] | [unknown]) => client.download(input.length ? input[0] : 'https://papers.example.org/paper.pdf', {
    signal: controller.signal, onProgress: value => { progress.push(value); },
  });
  return { client, download, controller, attempts, lookups, progress, lookup, request };
}

async function until(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 30 && !condition(); attempt++) await new Promise<void>(resolve => setImmediate(resolve));
  assert.ok(condition(), 'Expected the asynchronous stage to be reached');
}

test('URL validation accepts normalized public HTTPS and rejects credentials, local literals, and malformed links before DNS', async () => {
  assert.equal(validatePublicPDFURL('  https://Papers.Example.org:443/a.pdf?token=keep#page=2  '), 'https://papers.example.org/a.pdf?token=keep');
  assert.equal(validatePublicPDFURL('https://papers.example.org:8443/a.pdf'), 'https://papers.example.org:8443/a.pdf');
  for (const value of [undefined, 7, {}, '', 'pdf', 'http://example.org/a.pdf', 'file:///tmp/a.pdf',
    'https://user:secret@example.org/a.pdf', 'https://user@example.org/', 'https://example.org:0/',
    'https://localhost/', 'https://sub.localhost./', 'https://printer/', 'https://printer.local/', 'https://router.home.arpa/',
    'https://127.0.0.1/', 'https://127.1/', 'https://2130706433/', 'https://0x7f000001/', 'https://0177.0.0.1/',
    'https://[::1]/', 'https://[::ffff:127.0.0.1]/', 'https://[64:ff9b::7f00:1]/',
    'https://example.org/with space.pdf', 'https://example.org/\nfile.pdf', 'https://example.org\\other/file.pdf',
    'https://example.org/' + 'x'.repeat(8192)]) {
    const f = fixture();
    await assert.rejects(f.download(value), String(value));
    assert.equal(f.lookups.length, 0, String(value));
    assert.equal(f.attempts.length, 0, String(value));
  }
});

test('all resolved IPv4/IPv6 destinations must be public, including mixed DNS answers', async () => {
  for (const address of [
    '0.1.2.3', '10.0.0.1', '100.64.0.1', '100.127.255.255', '127.2.3.4', '169.254.169.254',
    '172.16.0.1', '172.31.255.255', '192.0.0.9', '192.0.2.1', '192.88.99.1', '192.168.1.1',
    '198.18.0.1', '198.19.255.255', '198.51.100.1', '203.0.113.1', '224.0.0.1', '240.0.0.1', '255.255.255.255',
    '::', '::1', '::ffff:8.8.8.8', '64:ff9b::808:808', '100::1', '2001::1', '2001:2::1', '2001:db8::1',
    '2002:7f00:1::', '2001:1000::1', '2003:8000::1', '2500::1', '2d00::1', '3000::1', '3ffe::1',
    '3fff::1', '5f00::1', 'fc00::1', 'fd12::1', 'fe80::1', 'ff02::1',
  ]) {
    const f = fixture([{}], { lookup: (_host, callback) => callback(null, [
      { ...publicIPv4 }, { address, family: address.includes(':') ? 6 : 4 },
    ]) });
    await assert.rejects(f.download(), /private|unsupported network/);
    assert.equal(f.attempts.length, 0, address);
  }
  for (const addresses of [[], Array.from({ length: 65 }, () => ({ ...publicIPv4 })), [{ address: 'wrong', family: 4 }], [{ address: publicIPv4.address, family: 6 }]]) {
    const f = fixture([{}], { lookup: (_host, callback) => callback(null, addresses) });
    await assert.rejects(f.download(), /private|unsupported network/);
    assert.equal(f.attempts.length, 0);
  }
});

test('pins the approved address while retaining TLS identity and bypassing ambient proxy/auth/session state', async () => {
  const f = fixture([{}], { lookup: (host, callback) => callback(null, [{ address: '2606:4700:4700::1111', family: 6 }, { ...publicIPv4 }]) });
  const result = await f.download('https://papers.example.org:8443/report.pdf?access=signed-secret');
  assert.deepEqual(result.bytes, pdf);
  const attempt = f.attempts[0];
  assert.equal(attempt.address, publicIPv4.address);
  assert.equal(attempt.family, 4);
  assert.equal(attempt.options.hostname, 'papers.example.org');
  assert.equal(attempt.options.servername, 'papers.example.org');
  assert.equal(attempt.options.path, '/report.pdf?access=signed-secret');
  assert.equal(attempt.options.port, 8443);
  assert.equal(attempt.options.rejectUnauthorized, true);
  assert.equal(attempt.options.auth, undefined);
  assert.equal(attempt.options.method, 'GET');
  assert.deepEqual(attempt.options.headers, {
    Accept: 'application/pdf, application/octet-stream;q=0.9', 'Accept-Encoding': 'identity', 'User-Agent': 'Prism/0.1 (PDF reader)',
  });
  const agent = attempt.options.agent as https.Agent;
  assert.notEqual(agent, https.globalAgent);
  assert.deepEqual(agent.options.proxyEnv, {});
  assert.equal(agent.options.keepAlive, false);
  assert.equal(agent.options.autoSelectFamily, false);
  await new Promise<void>((resolve, reject) => attempt.options.lookup!('papers.example.org', { all: true }, (error, addresses) => {
    if (error) reject(error); else { assert.deepEqual(addresses, [{ ...publicIPv4 }]); resolve(); }
  }));
});

test('supports public IPv6 and literal public IPs without weakening TLS verification', async () => {
  for (const address of ['2606:4700:4700::1111', '2001:4860:4860::8888', '2a00:1450:4001::200e', '2404:6800:4001::200e']) {
    const f = fixture([{}], { lookup: (_host, callback) => callback(null, [{ address, family: 6 }]) });
    await f.download();
    assert.equal(f.attempts[0].address, address);
    assert.equal(f.attempts[0].family, 6);
  }
  for (const url of ['https://8.8.8.8/paper.pdf', 'https://[2606:4700:4700::1111]/paper.pdf']) {
    const literal = fixture();
    await literal.download(url);
    assert.equal(literal.lookups.length, 0);
    assert.equal(literal.attempts[0].options.servername, '');
    assert.equal(literal.attempts[0].options.rejectUnauthorized, true);
  }
});

test('follows up to five HTTPS redirects, validates each DNS answer, and never forwards cookies', async () => {
  const f = fixture([
    { status: 302, headers: { location: '/step1', 'set-cookie': ['session=private'] } },
    { status: 303, headers: { location: 'https://cdn.example.org/step2' } },
    { status: 307, headers: { location: '/step3' } },
    { status: 308, headers: { location: '/step4' } },
    { status: 301, headers: { location: '/final.pdf?signature=kept' } },
    {},
  ]);
  const result = await f.download();
  assert.equal(result.filename, 'final.pdf');
  assert.equal(f.attempts.length, 6);
  assert.deepEqual(f.lookups, ['papers.example.org', 'papers.example.org', 'cdn.example.org', 'cdn.example.org', 'cdn.example.org', 'cdn.example.org']);
  assert.equal(f.attempts.at(-1)!.options.path, '/final.pdf?signature=kept');
  for (const attempt of f.attempts) {
    assert.equal((attempt.options.headers as Record<string, string>).Cookie, undefined);
    assert.equal(attempt.request.destroyed, true);
    assert.equal(attempt.response?.destroyed, true);
  }
});

test('rejects unsafe/invalid redirects, redirect loops, excess redirects, and redirect-time DNS rebinding', async () => {
  for (const location of ['http://example.org/file.pdf', 'https://127.0.0.1/a.pdf', 'https://[::ffff:127.0.0.1]/a.pdf',
    'https://person:password@example.org/a.pdf', 'file:///tmp/file.pdf', 'https://example.org/' + 'x'.repeat(8192), '']) {
    const f = fixture([{ status: 302, headers: { location } }]);
    await assert.rejects(f.download());
    assert.equal(f.attempts.length, 1);
    assert.equal(f.attempts[0].response?.destroyed, true);
  }
  const loop = fixture([{ status: 302, headers: { location: '/paper.pdf#again' } }]);
  await assert.rejects(loop.download(), /redirect loop/);
  assert.equal(loop.attempts.length, 1);
  const excess = fixture(Array.from({ length: 6 }, (_, index) => ({ status: 302, headers: { location: '/hop-' + index } })));
  await assert.rejects(excess.download(), /too many PDF redirects/);
  assert.equal(excess.attempts.length, 6);
  let resolutions = 0;
  const rebinding = fixture([{ status: 302, headers: { location: '/next.pdf' } }], {
    lookup: (_host, callback) => callback(null, [++resolutions === 1 ? { ...publicIPv4 } : { address: '127.0.0.1', family: 4 }]),
  });
  await assert.rejects(rebinding.download(), /private|unsupported/);
  assert.equal(rebinding.attempts.length, 1);
});

test('streams progress across split PDF magic and bounds memory even with many tiny chunks', async () => {
  const large = Buffer.concat([pdf, Buffer.alloc(140_000, 32)]);
  const chunks = [large.subarray(0, 2), large.subarray(2, 7), large.subarray(7, 65_537), large.subarray(65_537)];
  const f = fixture([{ headers: { 'content-type': 'application/octet-stream', 'content-length': String(large.length) }, chunks }]);
  assert.deepEqual((await f.download()).bytes, large);
  assert.deepEqual(f.progress.map(value => value.receivedBytes), [0, 2, 7, 65_537, large.length]);
  assert.ok(f.progress.every(value => value.totalBytes === large.length));
  const tiny = fixture([{ headers: {}, chunks: Array.from(pdf, byte => Buffer.from([byte])) }]);
  assert.deepEqual((await tiny.download()).bytes, pdf);
  assert.ok(tiny.progress.every(value => value.totalBytes === null));
});

test('rejects misleading content types, HTML, JSON, compressed bodies, HTTP errors and short files', async () => {
  for (const type of ['text/html', 'application/xhtml+xml', 'application/json', 'application/problem+json', 'text/plain', 'image/png']) {
    const f = fixture([{ headers: { 'content-type': type }, chunks: [pdf] }]);
    await assert.rejects(f.download(), /web page|another file/);
    assert.equal(f.progress.length, 0);
  }
  for (const body of [Buffer.from('<html>sign in here</html>'), Buffer.from('{"pdf":"not really"}'), Buffer.from('%PDF-xx!'), Buffer.from('%PDF-1')]) {
    const f = fixture([{ headers: { 'content-type': 'application/octet-stream' }, chunks: [body] }]);
    await assert.rejects(f.download(), /PDF/);
  }
  for (const encoding of ['gzip', 'br', 'deflate']) {
    const f = fixture([{ headers: { 'content-encoding': encoding }, chunks: [pdf] }]);
    await assert.rejects(f.download(), /compressed/);
  }
  for (const [status, message] of [[401, /sign-in/], [403, /sign-in/], [429, /too many requests/], [404, /HTTP 404/], [500, /HTTP 500/], [206, /HTTP 206/]] as const) {
    const f = fixture([{ status }]);
    await assert.rejects(f.download(), message);
    assert.equal(f.progress.length, 0);
  }
});

test('enforces declared/streaming size limits, valid length, and complete responses', async () => {
  for (const length of ['-1', '1.2', 'Infinity', '9007199254740992', '30, 30']) {
    await assert.rejects(fixture([{ headers: { 'content-length': length } }]).download(), /invalid PDF size/);
  }
  await assert.rejects(fixture([{ headers: { 'content-length': '104857601' } }]).download(), /100 MB/);
  await assert.rejects(fixture([{ headers: { 'content-length': '0' } }]).download(), /too short/);
  const streaming = fixture([{ chunks: [pdf, Buffer.alloc(4)] }], { maxBytes: pdf.length + 3 });
  await assert.rejects(streaming.download(), /100 MB/);
  assert.equal(streaming.attempts[0].response?.destroyed, true);
  const under = fixture([{ headers: { 'content-length': String(pdf.length + 1) } }]);
  await assert.rejects(under.download(), /before the complete/);
  const over = fixture([{ headers: { 'content-length': String(pdf.length - 1) } }]);
  await assert.rejects(over.download(), /does not match/);
  assert.deepEqual((await fixture([{ chunks: [pdf] }], { maxBytes: pdf.length }).download()).bytes, pdf);
});

test('prefers UTF-8 Content-Disposition and sanitizes names without exposing URL queries', async () => {
  const cases: Array<[IncomingHttpHeaders, string, string]> = [
    [{ 'content-disposition': "attachment; filename=backup.pdf; filename*=UTF-8''%E6%97%A5%E6%9C%AC%E8%AA%9E.pdf" }, 'https://example.org/x', '日本語.pdf'],
    [{ 'content-disposition': 'attachment; filename="../../report.pdf"' }, 'https://example.org/x', 'report.pdf'],
    [{ 'content-disposition': "attachment; filename*=UTF-8''%2Ftmp%2Freport%00.pdf" }, 'https://example.org/x', 'report.pdf'],
    [{ 'content-disposition': "attachment; filename*=UTF-8''%ZZ; filename=backup.pdf" }, 'https://example.org/x', 'backup.pdf'],
    [{ 'content-disposition': "attachment; filename*=iso-8859-1''caf%E9.pdf; filename=backup.pdf" }, 'https://example.org/x', 'backup.pdf'],
    [{ 'content-disposition': 'attachment; filename="CON.pdf"' }, 'https://example.org/x', '_CON.pdf'],
    [{ 'content-disposition': 'attachment; filename=" . "' }, 'https://example.org/path/report.pdf', 'report.pdf'],
    [{}, 'https://example.org/%E6%97%A5%E6%9C%AC%E8%AA%9E.pdf?token=private', '日本語.pdf'],
    [{}, 'https://example.org/get-document?name=secret.pdf', 'get-document.pdf'],
    [{}, 'https://example.org/', 'document.pdf'],
    [{}, 'https://example.org/%ZZ', 'document.pdf'],
  ];
  for (const [headers, url, expected] of cases) assert.equal((await fixture([{ headers }]).download(url)).filename, expected);
  const huge = '日'.repeat(300);
  const long = await fixture([{ headers: { 'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(huge)}.pdf` } }]).download();
  assert.ok(Buffer.byteLength(long.filename) <= 244);
  assert.ok(!long.filename.includes('\ufffd'));
});

test('abort before starting or while DNS is pending settles promptly and ignores late lookup answers', async () => {
  const before = fixture();
  before.controller.abort(new Error('secret external abort reason'));
  await assert.rejects(before.download(), { name: 'AbortError', message: 'PDF download canceled.' });
  assert.equal(before.lookups.length, 0);
  let answer: Parameters<NonNullable<ConstructorOptions['lookup']>>[1] | undefined;
  const dnsWait = fixture([{}], { lookup: (_host, callback) => { answer = callback; } });
  const pending = dnsWait.download();
  await until(() => !!answer);
  dnsWait.controller.abort();
  await assert.rejects(pending, { name: 'AbortError' });
  answer!(null, [{ ...publicIPv4 }]);
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(dnsWait.attempts.length, 0);
});

test('abort while waiting for headers or streaming destroys the request and clears partial progress state', async () => {
  let request: FakeRequest | undefined;
  const waiting = fixture([{}], { request: () => {
    request = new FakeRequest(() => undefined);
    return request as unknown as ClientRequest;
  } });
  const headersPending = waiting.download();
  await until(() => !!request);
  waiting.controller.abort();
  await assert.rejects(headersPending, { name: 'AbortError' });
  assert.equal(request!.destroyed, true);
  const streaming = fixture([{ chunks: [pdf], hold: true }]);
  const bodyPending = streaming.download();
  await until(() => streaming.progress.some(value => value.receivedBytes > 0));
  streaming.controller.abort();
  await assert.rejects(bodyPending, { name: 'AbortError' });
  assert.equal(streaming.attempts[0].response?.destroyed, true);
  assert.equal(streaming.attempts[0].request.destroyed, true);
  const count = streaming.progress.length;
  streaming.attempts[0].response?.emit('data', pdf);
  assert.equal(streaming.progress.length, count);
});

test('overall timeout covers DNS, HTTP headers, and streaming bodies', async () => {
  for (const overrides of [
    { lookup: () => undefined },
    { request: () => new FakeRequest(() => undefined) as unknown as ClientRequest },
    {},
  ] satisfies ConstructorOptions[]) {
    const f = fixture([{ chunks: [pdf], hold: true }], { ...overrides, timeoutMs: 10 });
    await assert.rejects(f.download(), { name: 'TimeoutError' });
    for (const attempt of f.attempts) assert.equal(attempt.request.destroyed, true);
  }
});

test('DNS/TLS/connection and truncated-stream failures never disclose a signed URL or underlying diagnostics', async () => {
  const secret = 'https://example.org/secret.pdf?token=do-not-display';
  const dnsFailure = fixture([{}], { lookup: (_host, callback) => callback(new Error(secret), []) });
  await assert.rejects(dnsFailure.download(secret), { message: 'The website address could not be resolved.' });
  const tls = fixture([{ error: Object.assign(new Error(secret), { code: 'ERR_TLS_CERT_ALTNAME_INVALID' }) }]);
  await assert.rejects(tls.download(secret), { message: 'The website’s HTTPS connection could not be verified.' });
  const network = fixture([{ error: Object.assign(new Error(secret), { code: 'ECONNRESET' }) }]);
  await assert.rejects(network.download(secret), error => error instanceof Error && !error.message.includes(secret) && /interrupted/.test(error.message));
  const broken = fixture([{ hold: true }]);
  const pending = broken.download();
  await until(() => !!broken.attempts[0]?.response);
  broken.attempts[0].response!.destroy();
  await assert.rejects(pending, /interrupted/);
});

test('default DNS and HTTPS methods are looked up lazily, even when replaced after construction', async t => {
  const f = fixture();
  const client = new PDFURLDownloader();
  const originalLookup = dns.lookup;
  const originalRequest = https.request;
  t.after(() => { dns.lookup = originalLookup; https.request = originalRequest; });
  dns.lookup = ((host: string, options: dns.LookupAllOptions, callback: Parameters<typeof f.lookup>[1]) => {
    assert.deepEqual(options, { all: true, order: 'verbatim' }); f.lookup(host, callback);
  }) as typeof dns.lookup;
  https.request = f.request as typeof https.request;
  const result = await client.download('https://papers.example.org/paper.pdf', { signal: new AbortController().signal, onProgress: () => undefined });
  assert.deepEqual(result.bytes, pdf);
  assert.equal(f.attempts.length, 1);
});
