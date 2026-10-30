import type { ElectronApplication } from '@playwright/test';
import { fixturePdf } from './pdf';

/** Replace only the transport in Electron's main process; the real downloader,
 * IPC, job, library writer, and PDF renderer run unchanged. Never uses user data. */
export async function installURLFixture(application: ElectronApplication) {
  await application.evaluate((_electron, encoded) => {
    const dns = process.getBuiltinModule('dns') as typeof import('node:dns');
    const https = process.getBuiltinModule('https') as typeof import('node:https');
    const { EventEmitter } = process.getBuiltinModule('events') as typeof import('node:events');
    const { PassThrough } = process.getBuiltinModule('stream') as typeof import('node:stream');
    const bytes = Buffer.from(encoded, 'base64');
    const state = { requests: [] as string[], destroyed: [] as string[], release: () => {} };
    (globalThis as typeof globalThis & { pdfURLFixture: typeof state }).pdfURLFixture = state;
    dns.lookup = ((_host: string, _options: unknown, callback: (error: null, addresses: import('node:dns').LookupAddress[]) => void) => {
      queueMicrotask(() => callback(null, [{ address: _host === 'private.example.org' ? '127.0.0.1' : '93.184.216.34', family: 4 }]));
    }) as typeof dns.lookup;
    https.request = ((options: import('node:https').RequestOptions, callback: (response: import('node:http').IncomingMessage) => void) => {
      const route = String(options.path);
      const response = new PassThrough() as unknown as import('node:http').IncomingMessage;
      const request = new EventEmitter() as import('node:http').ClientRequest;
      request.destroy = () => {
        if (!request.destroyed) { request.destroyed = true; state.destroyed.push(route); response.destroy(); }
        return request;
      };
      request.end = (() => {
        state.requests.push(route);
        queueMicrotask(() => {
          if (request.destroyed) return;
          response.statusCode = route === '/redirect' ? 302 : route === '/login' ? 403 : 200;
          response.headers = route === '/redirect' ? { location: '/slow.pdf' }
            : route === '/html' ? { 'content-type': 'text/html' }
            : route === '/huge' ? { 'content-type': 'application/pdf', 'content-length': String(101 * 1024 * 1024) }
            : { 'content-type': 'application/pdf', 'content-disposition': "attachment; filename*=UTF-8''%E7%B4%84%E5%AE%9A%E8%B3%87%E6%96%99.pdf" };
          if (!route.includes('unknown') && !['/redirect', '/html', '/login', '/huge'].includes(route)) response.headers['content-length'] = String(bytes.length);
          callback(response);
          if (response.destroyed) return;
          const stream = response as unknown as import('node:stream').PassThrough;
          if (route.includes('slow') || route.includes('unknown')) {
            stream.write(bytes.subarray(0, 64));
            state.release = () => { if (!stream.destroyed) stream.end(bytes.subarray(64)); };
          } else stream.end(route === '/html' ? '<html>Sign in</html>' : bytes);
        });
        return request;
      }) as typeof request.end;
      return request;
    }) as typeof https.request;
  }, fixturePdf().toString('base64'));
}

export async function releaseURLFixture(application: ElectronApplication) {
  await application.evaluate(() => (globalThis as typeof globalThis & { pdfURLFixture: { release(): void } }).pdfURLFixture.release());
}
