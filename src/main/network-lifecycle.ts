/** Permanently cancel read-only network work without interrupting file publication. */
export class NetworkLifecycle {
  private readonly controller = new AbortController();
  readonly signal = this.controller.signal;

  close(): void {
    this.controller.abort(new Error('Prism is closing. Reopen the app before continuing.'));
  }

  assertOpen(): void { this.signal.throwIfAborted(); }

  requestSignal(timeout: number): AbortSignal {
    this.assertOpen();
    return AbortSignal.any([this.signal, AbortSignal.timeout(timeout)]);
  }

  /** Also settles injected transports/sleeps which do not implement abort themselves. */
  wait<T>(pending: Promise<T>, signal = this.signal): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const cleanup = () => signal.removeEventListener('abort', abort);
      const abort = () => { cleanup(); reject(signal.reason); };
      signal.addEventListener('abort', abort, { once: true });
      pending.then(value => {
        cleanup();
        if (signal.aborted) reject(signal.reason); else resolve(value);
      }, error => { cleanup(); reject(signal.aborted ? signal.reason : error); });
      if (signal.aborted) abort();
    });
  }

  async delay(milliseconds: number, sleep?: (milliseconds: number) => Promise<void>): Promise<void> {
    this.assertOpen();
    if (sleep) {
      await this.wait(Promise.resolve().then(() => { this.assertOpen(); return sleep(milliseconds); }));
    } else {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try { await this.wait(new Promise<void>(resolve => { timer = setTimeout(resolve, milliseconds); })); }
      finally { clearTimeout(timer); }
    }
    this.assertOpen();
  }

  async fetch(fetchImpl: typeof fetch, url: string, init: RequestInit & { signal: AbortSignal }): Promise<Response> {
    this.assertOpen();
    init.signal.throwIfAborted();
    const pending = fetchImpl(url, init).then(response => {
      // An injected/late transport may return after cancellation. It must not
      // publish a result or leave its response stream open.
      if (init.signal.aborted) {
        void response.body?.cancel().catch(() => undefined);
        throw init.signal.reason;
      }
      return response;
    });
    return this.wait(pending, init.signal);
  }
}
