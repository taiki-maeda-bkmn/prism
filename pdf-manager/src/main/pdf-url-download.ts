import dns from 'node:dns';
import https from 'node:https';
import { BlockList, isIP, type LookupFunction } from 'node:net';
import type { ClientRequest, IncomingMessage } from 'node:http';

const MAX_BYTES = 100 * 1024 * 1024;
const MAX_URL_LENGTH = 8192;
const TIMEOUT_MS = 120_000;
const MAX_REDIRECTS = 5;
const SLAB_BYTES = 64 * 1024;
const redirectStatuses = new Set([301, 302, 303, 307, 308]);
const pdfTypes = new Set(['application/pdf', 'application/x-pdf', 'application/octet-stream', 'binary/octet-stream']);

// Conservatively exclude IANA special-purpose ranges, including translation
// and transition mechanisms that could hide an IPv4 destination. IPv6 must be
// ordinary global unicast; these lists do not depend on a remote classification
// service or DNS answers received after the request has been authorized.
const excluded = new BlockList();
for (const [address, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
  ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24],
  ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
] as const) excluded.addSubnet(address, prefix, 'ipv4');
for (const [address, prefix] of [
  ['2001::', 23], ['2001:db8::', 32], ['2002::', 16], ['3fff::', 20],
] as const) excluded.addSubnet(address, prefix, 'ipv6');
const globalIPv6 = new BlockList();
// 2000::/3 also contains reserved future space. Use the allocated RIR prefixes
// from IANA's registry (checked 2026-10-30), not that broader enclosing range:
// https://www.iana.org/assignments/ipv6-unicast-address-assignments/
for (const [address, prefix] of [
  ['2001:200::', 23], ['2001:400::', 23], ['2001:600::', 23], ['2001:800::', 22],
  ['2001:c00::', 23], ['2001:e00::', 23], ['2001:1200::', 23], ['2001:1400::', 22],
  ['2001:1800::', 23], ['2001:1a00::', 23], ['2001:1c00::', 22], ['2001:2000::', 19],
  ['2001:4000::', 23], ['2001:4200::', 23], ['2001:4400::', 23], ['2001:4600::', 23],
  ['2001:4800::', 23], ['2001:4a00::', 23], ['2001:4c00::', 23], ['2001:5000::', 20],
  ['2001:8000::', 19], ['2001:a000::', 20], ['2001:b000::', 20], ['2003::', 18],
  ['2400::', 12], ['2410::', 12], ['2600::', 12], ['2610::', 23], ['2620::', 23],
  ['2630::', 12], ['2800::', 12], ['2a00::', 12], ['2a10::', 12], ['2c00::', 12],
] as const) globalIPv6.addSubnet(address, prefix, 'ipv6');

function publicAddress(address: string): boolean {
  const family = isIP(address);
  return family === 4 ? !excluded.check(address, 'ipv4')
    : family === 6 && !address.includes('%') && globalIPv6.check(address, 'ipv6') && !excluded.check(address, 'ipv6');
}

function hostname(url: URL): string { return url.hostname.replace(/^\[|\]$/g, ''); }

/** Synchronous input validation; every resolved destination is checked later. */
export function validatePublicPDFURL(value: unknown): string {
  if (typeof value !== 'string' || value.length > MAX_URL_LENGTH) throw new Error('Paste a public HTTPS PDF link.');
  const input = value.trim();
  if (!input || /[\u0000-\u0020\u007f\\]/.test(input)) throw new Error('Paste a valid HTTPS PDF link.');
  let url: URL;
  try { url = new URL(input); } catch { throw new Error('Paste a valid HTTPS PDF link.'); }
  if (url.protocol !== 'https:' || !url.hostname || url.username || url.password || url.port === '0') {
    throw new Error('Use a public HTTPS link without a username or password.');
  }
  const host = hostname(url);
  const name = host.toLowerCase().replace(/\.$/, '');
  if (isIP(host) ? !publicAddress(host)
    : !name.includes('.') || /(^|\.)(localhost|local|internal)$/.test(name) || name.endsWith('.home.arpa') || name === 'home.arpa') {
    throw new Error('Only public websites can be used for PDF imports.');
  }
  url.hash = '';
  if (url.href.length > MAX_URL_LENGTH) throw new Error('This PDF link is too long.');
  return url.href;
}

export interface PDFURLDownloadProgress { receivedBytes: number; totalBytes: number | null }
export interface PDFURLDownloadOptions {
  signal: AbortSignal;
  onProgress(progress: PDFURLDownloadProgress): void;
}
export interface PDFURLDownloadResult { bytes: Uint8Array; filename: string }

type Lookup = (hostname: string, callback: (error: NodeJS.ErrnoException | null, addresses: dns.LookupAddress[]) => void) => void;
type Request = (options: https.RequestOptions, callback: (response: IncomingMessage) => void) => ClientRequest;
interface DownloaderOptions {
  lookup?: Lookup;
  request?: Request;
  maxBytes?: number;
  timeoutMs?: number;
}
type HopResult = { redirect: string } | PDFURLDownloadResult;

function bounded(value: number | undefined, maximum: number): number {
  return Number.isSafeInteger(value) && value! > 0 ? Math.min(value!, maximum) : maximum;
}
function cancellation(): Error { return Object.assign(new Error('PDF download canceled.'), { name: 'AbortError' }); }
function connectionError(error: unknown): Error {
  const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
  return new Error(/CERT|TLS|SELF_SIGNED|UNABLE_TO_VERIFY|DEPTH_ZERO/.test(code)
    ? 'The website’s HTTPS connection could not be verified.'
    : 'The PDF download was interrupted. Check the link and your connection, then try again.');
}

function cleanFilename(value: string): string | null {
  // The header is metadata, never a filesystem path. Keep a final component,
  // strip platform-invalid/control characters, and always use a PDF extension.
  let name = value.replace(/\\/g, '/').split('/').pop()!.normalize('NFC')
    .replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069<>:"|?*]/g, '')
    .replace(/^[.\s]+|[.\s]+$/g, '');
  if (!name) return null;
  name = name.replace(/\.pdf$/i, '').replace(/[.\s]+$/g, '');
  if (!name) return null;
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)) name = '_' + name;
  // Bound Unicode bytes as well as JS length so the eventual filename works on
  // ordinary filesystems, including Japanese document names.
  name = Array.from(name).slice(0, 200).join('');
  while (Buffer.byteLength(name, 'utf8') > 240) name = Array.from(name).slice(0, -1).join('');
  return name ? name + '.pdf' : null;
}

function filename(headers: IncomingMessage['headers'], url: URL): string {
  const disposition = headers['content-disposition'];
  if (typeof disposition === 'string' && disposition.length <= 4096) {
    const extended = /(?:^|;)\s*filename\*\s*=\s*(?:"([^"\r\n]*)"|([^;\r\n]*))/i.exec(disposition);
    if (extended) {
      const encoded = (extended[1] ?? extended[2]).trim();
      const utf8 = /^utf-8'[^']*'(.*)$/i.exec(encoded);
      if (utf8) {
        try { const name = cleanFilename(decodeURIComponent(utf8[1])); if (name) return name; } catch { /* Fall back to filename/URL. */ }
      }
    }
    const regular = /(?:^|;)\s*filename\s*=\s*(?:"((?:[^"\\\r\n]|\\.)*)"|([^;\r\n]*))/i.exec(disposition);
    if (regular) {
      const name = cleanFilename(regular[1] === undefined ? regular[2].trim() : regular[1].replace(/\\(.)/g, '$1'));
      if (name) return name;
    }
  }
  try {
    const name = cleanFilename(decodeURIComponent(url.pathname.split('/').pop() ?? ''));
    if (name) return name;
  } catch { /* Invalid URL escaping does not become a local filename. */ }
  return 'document.pdf';
}

/** Main-process-only downloader for explicitly requested, public PDF links. */
export class PDFURLDownloader {
  private readonly lookup: Lookup;
  private readonly request: Request;
  private readonly maxBytes: number;
  private readonly timeoutMs: number;

  constructor(options: DownloaderOptions = {}) {
    // Resolve methods at call time so tests can replace the built-in transport;
    // no renderer fetch, browser session, cookies, or global proxy agent is used.
    this.lookup = options.lookup ?? ((host, callback) => dns.lookup(host, { all: true, order: 'verbatim' }, callback));
    this.request = options.request ?? ((requestOptions, callback) => https.request(requestOptions, callback));
    this.maxBytes = bounded(options.maxBytes, MAX_BYTES);
    this.timeoutMs = bounded(options.timeoutMs, TIMEOUT_MS);
  }

  private resolve(host: string, signal: AbortSignal): Promise<dns.LookupAddress> {
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (error: Error | null, addresses?: dns.LookupAddress[]) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener('abort', abort);
        if (error) { reject(error); return; }
        if (!Array.isArray(addresses) || !addresses.length || addresses.length > 64 || addresses.some(item =>
          !item || typeof item.address !== 'string' || isIP(item.address) !== item.family || !publicAddress(item.address))) {
          reject(new Error('This website resolves to a private or unsupported network address.')); return;
        }
        const chosen = addresses.find(item => item.family === 4) ?? addresses[0];
        resolve({ address: chosen.address, family: chosen.family });
      };
      const abort = () => finish(signal.reason as Error);
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) { abort(); return; }
      const family = isIP(host);
      if (family) { finish(null, [{ address: host, family }]); return; }
      try {
        this.lookup(host, (error, addresses) => finish(error ? new Error('The website address could not be resolved.') : null, addresses));
      } catch { finish(new Error('The website address could not be resolved.')); }
    });
  }

  private hop(url: URL, address: dns.LookupAddress, agent: https.Agent, options: PDFURLDownloadOptions): Promise<HopResult> {
    const { signal, onProgress } = options;
    return new Promise((resolve, reject) => {
      let request: ClientRequest | undefined;
      let response: IncomingMessage | undefined;
      let settled = false;
      const slabs: Buffer[] = [];
      let received = 0;
      let total: number | null = null;
      const finish = (error: Error | null, result?: HopResult) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener('abort', abort);
        slabs.length = 0;
        response?.destroy();
        request?.destroy();
        if (error) reject(error); else resolve(result!);
      };
      const abort = () => finish(signal.reason as Error);
      const failed = (error: unknown) => finish(signal.aborted ? signal.reason as Error : connectionError(error));
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) { abort(); return; }
      const pinnedLookup: LookupFunction = (_host, lookupOptions, callback) => {
        // No second DNS lookup is possible at connection time (rebinding).
        if (signal.aborted) { callback(signal.reason as Error, '', address.family); return; }
        if (lookupOptions.all) callback(null, [{ ...address }]);
        else callback(null, address.address, address.family);
      };
      try {
        request = this.request({
          protocol: 'https:', hostname: hostname(url), port: url.port ? Number(url.port) : 443,
          path: url.pathname + url.search, method: 'GET', agent, lookup: pinnedLookup,
          family: address.family,
          servername: isIP(hostname(url)) ? '' : hostname(url), rejectUnauthorized: true,
          maxHeaderSize: 16 * 1024,
          headers: { Accept: 'application/pdf, application/octet-stream;q=0.9', 'Accept-Encoding': 'identity', 'User-Agent': 'Prism/0.1 (PDF reader)' },
        }, incoming => {
          if (settled) { incoming.destroy(); return; }
          response = incoming;
          incoming.on('error', failed);
          incoming.on('aborted', () => failed(new Error('Response aborted.')));
          incoming.on('close', () => { if (!settled) failed(new Error('Response closed before completion.')); });
          try {
            const status = incoming.statusCode ?? 0;
            if (redirectStatuses.has(status)) {
              const location = incoming.headers.location;
              if (typeof location !== 'string' || !location || location.length > MAX_URL_LENGTH) throw new Error('The website returned an invalid PDF redirect.');
              finish(null, { redirect: location }); return;
            }
            if (status === 401 || status === 403) throw new Error('This PDF requires sign-in or the website does not allow direct downloading.');
            if (status === 429) throw new Error('This website is receiving too many requests. Try importing the PDF later.');
            if (status !== 200) throw new Error(`The website returned HTTP ${status}. Check that this is a direct PDF link.`);
            const encoding = incoming.headers['content-encoding'];
            if (encoding !== undefined && (typeof encoding !== 'string' || encoding.trim().toLowerCase() !== 'identity')) {
              throw new Error('The website returned an unsupported compressed download. Use another direct PDF link.');
            }
            const type = incoming.headers['content-type'];
            if (type !== undefined && (typeof type !== 'string' || !pdfTypes.has(type.split(';')[0].trim().toLowerCase()))) {
              throw new Error('The link returned a web page or another file instead of a PDF. Paste a direct PDF download link.');
            }
            const length = incoming.headers['content-length'];
            if (length !== undefined) {
              if (typeof length !== 'string' || !/^\d+$/.test(length) || !Number.isSafeInteger(Number(length))) throw new Error('The website returned an invalid PDF size.');
              total = Number(length);
              if (total > this.maxBytes) throw new Error('The PDF exceeds the 100 MB download limit.');
              if (total < 8) throw new Error('The download is too short to be a PDF.');
            }
            const name = filename(incoming.headers, url);
            onProgress({ receivedBytes: 0, totalBytes: total });
            if (signal.aborted || settled) return;
            incoming.on('data', (chunk: Buffer) => {
              if (settled) return;
              try {
                if (!Buffer.isBuffer(chunk)) throw new Error('The website returned an invalid PDF download.');
                if (chunk.length > this.maxBytes - received) throw new Error('The PDF exceeds the 100 MB download limit.');
                if (total !== null && chunk.length > total - received) throw new Error('The PDF download size does not match the website’s response.');
                let offset = 0;
                while (offset < chunk.length) {
                  const index = Math.floor(received / SLAB_BYTES);
                  const within = received % SLAB_BYTES;
                  if (!slabs[index]) slabs.push(Buffer.allocUnsafe(Math.min(SLAB_BYTES, this.maxBytes - received)));
                  const count = Math.min(chunk.length - offset, slabs[index].length - within);
                  chunk.copy(slabs[index], within, offset, offset + count);
                  received += count; offset += count;
                }
                if (received >= 8 && !/^%PDF-[0-9]\.[0-9]/.test(slabs[0].subarray(0, 8).toString('ascii'))) {
                  throw new Error('The download does not contain a PDF document. Use a direct PDF download link.');
                }
                onProgress({ receivedBytes: received, totalBytes: total });
              } catch (error) { finish(error instanceof Error ? error : new Error('The PDF could not be downloaded.')); }
            });
            incoming.on('end', () => {
              if (settled) return;
              if (received < 8) { finish(new Error('The download is too short to be a PDF.')); return; }
              if (total !== null && received !== total) { finish(new Error('The PDF download ended before the complete file arrived.')); return; }
              finish(null, { bytes: Buffer.concat(slabs, received), filename: name });
            });
          } catch (error) { finish(error instanceof Error ? error : new Error('The PDF could not be downloaded.')); }
        });
        request.on('error', failed);
        if (settled || signal.aborted) { request.destroy(); return; }
        request.end();
      } catch (error) { failed(error); }
    });
  }

  async download(value: unknown, options: PDFURLDownloadOptions): Promise<PDFURLDownloadResult> {
    let url = new URL(validatePublicPDFURL(value));
    const controller = new AbortController();
    const cancel = () => controller.abort(cancellation());
    options.signal.addEventListener('abort', cancel, { once: true });
    if (options.signal.aborted) cancel();
    const timeout = setTimeout(() => controller.abort(Object.assign(new Error('The PDF download timed out. Try again.'), { name: 'TimeoutError' })), this.timeoutMs);
    // A dedicated agent excludes browser credentials, environment proxies, and
    // previously pooled connections. TLS still validates the original hostname.
    const agent = new https.Agent({ keepAlive: false, maxSockets: 1, autoSelectFamily: false, proxyEnv: {} });
    const seen = new Set<string>();
    try {
      for (let redirects = 0; ; redirects++) {
        controller.signal.throwIfAborted();
        if (seen.has(url.href)) throw new Error('The website returned a PDF redirect loop.');
        seen.add(url.href);
        const address = await this.resolve(hostname(url), controller.signal);
        controller.signal.throwIfAborted();
        const result = await this.hop(url, address, agent, { signal: controller.signal, onProgress: options.onProgress });
        controller.signal.throwIfAborted();
        if (!('redirect' in result)) return result;
        if (redirects >= MAX_REDIRECTS) throw new Error('The website returned too many PDF redirects.');
        let next: URL;
        try { next = new URL(result.redirect, url); } catch { throw new Error('The website returned an invalid PDF redirect.'); }
        url = new URL(validatePublicPDFURL(next.href));
      }
    } finally {
      clearTimeout(timeout);
      options.signal.removeEventListener('abort', cancel);
      agent.destroy();
    }
  }
}
