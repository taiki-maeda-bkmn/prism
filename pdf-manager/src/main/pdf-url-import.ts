import { randomUUID } from 'node:crypto';
import type { PDFURLImportState } from '../shared/types';
import { MAX_PDF_BYTES } from './library';
import type { PDFLibraryService } from './library-service';
import { PDFURLDownloader, validatePublicPDFURL } from './pdf-url-download';

interface ImportJob {
  state: PDFURLImportState;
  controller: AbortController;
  done: Promise<void>;
}

function safeFailure(error: unknown, stage: 'loading' | 'downloading' | 'saving'): string {
  const message = error instanceof Error ? error.message : '';
  // Never forward arbitrary transport/OS error text: it can contain a signed
  // URL or its query parameters. Every displayed message is generated here.
  if (error instanceof Error && error.name === 'TimeoutError') return 'The PDF download timed out. Try again.';
  if (/already open in another Prism/.test(message)) return 'This PDF library is already open in another Prism window. Close that app, then retry.';
  if (/catalog is damaged or unsupported/.test(message)) return 'The PDF library catalog is damaged or unsupported. Restore it from a backup before importing.';
  if (/catalog changed outside|library folder changed|library lock changed/.test(message)) return 'The PDF library changed outside this app. Reopen Prism before importing.';
  if (/library is closing|library is closed/.test(message)) return 'The PDF library is closing. Reopen Prism before importing.';
  if (/ENOSPC/.test(message)) return 'There is not enough disk space to save this PDF.';
  if (/EACCES|EPERM/.test(message)) return 'Prism could not write to the PDF library. Check its folder permissions and try again.';
  if (/retained for recovery/.test(message)) return 'The PDF could not be saved. A copy was retained for recovery in your library.';
  if (/managed PDF changed|existing library copy is missing or changed/.test(message)) return 'The existing library copy is missing or changed. Remove its entry and import the PDF again.';
  if (stage === 'loading') return 'The PDF library could not be opened. Check your library and try again.';
  if (stage === 'saving') return 'The PDF could not be saved. Check your library and try again.';
  if (/100 MB/.test(message)) return 'The PDF exceeds the 100 MB download limit.';
  if (/sign-in|does not allow direct downloading/.test(message)) return 'This PDF requires sign-in or the website does not allow direct downloading.';
  if (/private or unsupported network|Only public websites/.test(message)) return 'Only public websites can be used for PDF imports.';
  if (/too many requests/.test(message)) return 'This website is receiving too many requests. Try importing the PDF later.';
  const status = /^The website returned HTTP ([1-5][0-9]{2})\./.exec(message);
  if (status) return `The website returned HTTP ${status[1]}. Check that this is a direct PDF link.`;
  if (/instead of a PDF|does not contain a PDF|too short to be a PDF/.test(message)) return 'The link did not return a PDF document. Paste a direct PDF download link.';
  if (/redirect/.test(message)) return 'The website returned an invalid PDF redirect. Try another direct PDF link.';
  if (/ended before|size does not match/.test(message)) return 'The PDF download was incomplete. Try again.';
  return 'The PDF could not be downloaded. Check the link and your connection, then try again.';
}

/** One main-process download job; completed snapshots never retain source URLs. */
export class PDFURLImportManager {
  private latest: PDFURLImportState | null = null;
  private active: ImportJob | null = null;
  private draining: Promise<void> | undefined;
  private closing: Promise<void> | undefined;

  constructor(
    private readonly service: Pick<PDFLibraryService, 'load' | 'importDownloaded'>,
    private readonly downloader: Pick<PDFURLDownloader, 'download'> = new PDFURLDownloader(),
  ) {}

  start(value: unknown): PDFURLImportState {
    if (this.closing) throw new Error('PDF imports are closing. Reopen Prism before importing.');
    if (this.active || this.draining) throw new Error('Finish or cancel the current PDF import before starting another.');
    const url = validatePublicPDFURL(value);
    const state: PDFURLImportState = {
      id: randomUUID(), phase: 'downloading', receivedBytes: 0, totalBytes: null,
      document: null, duplicate: false, error: null,
    };
    const job: ImportJob = { state, controller: new AbortController(), done: Promise.resolve() };
    this.latest = state;
    this.active = job;
    // Defer even a synchronous setup failure so start always returns the initial
    // snapshot promptly. All asynchronous failures become observable job state.
    job.done = Promise.resolve().then(() => this.run(job, url)).then(() => {
      if (this.active === job) this.active = null;
    }, () => {
      state.phase = 'error';
      state.error = 'The PDF import could not finish. Try again.';
      if (this.active === job) this.active = null;
    });
    return structuredClone(state);
  }

  get(): PDFURLImportState | null { return this.latest ? structuredClone(this.latest) : null; }

  cancel(id: unknown): PDFURLImportState {
    if (typeof id !== 'string' || !this.latest || id !== this.latest.id) throw new Error('That PDF import is no longer active.');
    if (this.active?.state.id === id && this.active.state.phase === 'downloading') {
      this.active.state.phase = 'cancelled';
      this.active.controller.abort();
    }
    return structuredClone(this.latest);
  }

  cancelActive(): Promise<void> {
    if (this.draining) return this.draining;
    const job = this.active;
    if (!job) return Promise.resolve();
    this.cancel(job.state.id);
    this.draining = job.done.then(() => { this.draining = undefined; });
    return this.draining;
  }

  close(): Promise<void> {
    if (!this.closing) this.closing = this.cancelActive();
    return this.closing;
  }

  private async run(job: ImportJob, url: string): Promise<void> {
    let stage: 'loading' | 'downloading' | 'saving' = 'loading';
    try {
      if (job.controller.signal.aborted) return;
      await this.service.load();
      if (job.controller.signal.aborted) return;
      stage = 'downloading';
      const downloaded = await this.downloader.download(url, {
        signal: job.controller.signal,
        onProgress: progress => {
          if (this.active !== job || job.state.phase !== 'downloading' || job.controller.signal.aborted) return;
          if (!Number.isSafeInteger(progress.receivedBytes) || progress.receivedBytes < 0 || progress.receivedBytes > MAX_PDF_BYTES) return;
          job.state.receivedBytes = Math.max(job.state.receivedBytes, progress.receivedBytes);
          job.state.totalBytes = progress.totalBytes !== null && Number.isSafeInteger(progress.totalBytes)
            && progress.totalBytes >= job.state.receivedBytes && progress.totalBytes > 0 && progress.totalBytes <= MAX_PDF_BYTES
            ? progress.totalBytes : null;
        },
      });
      if (job.controller.signal.aborted) return;
      // Cancellation ends at this synchronous transition. Once publication is
      // admitted, shutdown waits for the library's atomic save or cleanup.
      stage = 'saving';
      job.state.phase = 'saving';
      job.state.receivedBytes = downloaded.bytes.byteLength;
      job.state.totalBytes = downloaded.bytes.byteLength;
      const saved = await this.service.importDownloaded(downloaded);
      job.state.document = structuredClone(saved.document);
      job.state.duplicate = saved.duplicate;
      job.state.phase = 'complete';
    } catch (error) {
      if (job.controller.signal.aborted && stage !== 'saving') {
        job.state.phase = 'cancelled';
      } else {
        job.state.phase = 'error';
        job.state.error = safeFailure(error, stage);
      }
    }
  }
}
