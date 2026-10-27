import { useEffect, useRef, useState, type FormEvent } from 'react';
import { ArrowLeft, ChevronLeft, ChevronRight, FileText, Link2, LoaderCircle, LockKeyhole, RotateCw, X, ZoomIn, ZoomOut } from 'lucide-react';
import { getDocument, GlobalWorkerOptions, PasswordResponses, type PDFDocumentLoadingTask, type PDFDocumentProxy, type RenderTask } from 'pdfjs-dist';
import type { PDFDocument } from '../shared/types';
import type { PDFPageLinkRequest, PDFPageReference } from '../../../src/shared/pdfLinks';
import './reader.css';

GlobalWorkerOptions.workerSrc = new URL('./pdf.worker.mjs', import.meta.url).href;

function loadPdf(data: Uint8Array): PDFDocumentLoadingTask {
  return getDocument({
    data,
    cMapUrl: new URL('./cmaps/', import.meta.url).href,
    cMapPacked: true,
    standardFontDataUrl: new URL('./standard_fonts/', import.meta.url).href,
    wasmUrl: new URL('./wasm/', import.meta.url).href,
    // Let PDF.js downsample large scans. maxImageSize would silently omit them.
    canvasMaxAreaInBytes: 48_000_000,
    enableXfa: false,
  });
}

function describeError(error: unknown): string {
  if (error instanceof Error) {
    if (error.name === 'InvalidPDFException') return 'This file could not be read as a PDF. Try importing a new copy.';
    if (error.name === 'PasswordException') return 'Open this document to enter its password.';
    return error.message || 'The PDF could not be opened.';
  }
  return 'The PDF could not be opened.';
}

function cancelled(error: unknown): boolean {
  return error instanceof Error && (error.name === 'RenderingCancelledException' || error.name === 'AbortException');
}

interface PdfReaderProps {
  workspaceActive?: boolean;
  document: PDFDocument;
  onUpdate: (patch: { lastPage?: number; pageCount?: number }) => void;
  onClose: () => void;
  pageLinkRequest?: PDFPageLinkRequest | null;
  onInsertPageLink?: (reference: PDFPageReference) => void;
  canInsertPageLink?: boolean;
}

/** PDF files never become executable documents: only PDF.js canvas output is mounted. */
export function PdfReader({ document: entry, onUpdate, onClose, workspaceActive = true, pageLinkRequest, onInsertPageLink, canInsertPageLink = false }: PdfReaderProps) {
  const [pdf, setPdf] = useState<PDFDocumentProxy | null>(null);
  const [pageNumber, setPageNumber] = useState(Math.max(1, entry.lastPage || 1));
  const [pageInput, setPageInput] = useState(String(Math.max(1, entry.lastPage || 1)));
  const [loading, setLoading] = useState(true);
  const [rendering, setRendering] = useState(false);
  const [error, setError] = useState('');
  const [pageLinkError, setPageLinkError] = useState('');
  const [renderedPage, setRenderedPage] = useState<number | null>(null);
  const [completedLink, setCompletedLink] = useState<number | null>(null);
  const [zoom, setZoom] = useState<number | 'fit'>('fit');
  const [actualZoom, setActualZoom] = useState(1);
  const [rotation, setRotation] = useState(0);
  const [availableWidth, setAvailableWidth] = useState(800);
  const [passwordPrompt, setPasswordPrompt] = useState<'required' | 'incorrect' | null>(null);
  const [password, setPassword] = useState('');
  const [retry, setRetry] = useState(0);
  const viewportRef = useRef<HTMLDivElement>(null);
  const passwordRef = useRef<HTMLInputElement>(null);
  const paperRef = useRef<HTMLDivElement>(null);
  const passwordCallback = useRef<((value: string) => void) | null>(null);
  const updateRef = useRef(onUpdate);
  const startingPageRef = useRef(entry.lastPage || 1);
  const lastSavedPage = useRef<number | null>(null);
  const handledLink = useRef<number | null>(null);
  const latestLink = useRef(pageLinkRequest);
  const currentPage = useRef(pageNumber);
  updateRef.current = onUpdate;
  startingPageRef.current = entry.lastPage || 1;
  latestLink.current = pageLinkRequest;
  currentPage.current = pageNumber;

  function linkedPage(loaded: PDFDocumentProxy, fallback: number): number {
    const request = latestLink.current;
    if (!request || request.documentId !== entry.id || request.request === handledLink.current) return fallback;
    handledLink.current = request.request;
    setCompletedLink(request.request);
    if (!Number.isSafeInteger(request.page) || request.page < 1 || request.page > loaded.numPages) {
      setPageLinkError(`Page ${request.page} is not available in this PDF (${loaded.numPages} pages). Choose a valid page and insert a replacement link.`);
      return fallback;
    }
    setPageLinkError('');
    return request.page;
  }

  useEffect(() => {
    const container = viewportRef.current;
    if (!container) return;
    const observer = new ResizeObserver(([size]) => {
      // Hiding the workspace must not replace the retained page with a tiny render.
      if (size.contentRect.width > 0) setAvailableWidth(Math.max(160, size.contentRect.width - 64));
    });
    observer.observe(container);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!workspaceActive || !passwordPrompt || window.document.querySelector('dialog[open]')) return;
    const focused = window.document.activeElement;
    // A visible reader can become active while the user clicks library search
    // or another control. A pending password must not steal that input focus.
    if (focused && focused !== window.document.body && focused !== viewportRef.current
      && !(focused instanceof HTMLElement && focused.matches('.pdf-panel, .pdf-workspace'))) return;
    passwordRef.current?.focus();
  }, [workspaceActive, passwordPrompt]);

  useEffect(() => {
    let active = true;
    let task: PDFDocumentLoadingTask | undefined;
    setPdf(null);
    setLoading(true);
    setError('');
    setRenderedPage(null);
    setPassword('');
    setPasswordPrompt(null);
    setRotation(0);
    setZoom('fit');
    lastSavedPage.current = null;
    paperRef.current?.replaceChildren();
    void (async () => {
      try {
        const bytes = await window.prismPdf.readDocument(entry.id);
        if (!active) return;
        task = loadPdf(bytes);
        task.onPassword = (providePassword: (password: string) => void, reason: number) => {
          if (!active) return;
          passwordCallback.current = providePassword;
          setPassword('');
          setPasswordPrompt(reason === PasswordResponses.INCORRECT_PASSWORD ? 'incorrect' : 'required');
        };
        const loaded = await task.promise;
        if (!active) return;
        // Read the latest request after loading/unlocking, never the request
        // captured when the asynchronous document load began.
        const fallback = Math.max(1, Math.min(loaded.numPages, retry ? currentPage.current : startingPageRef.current));
        const start = linkedPage(loaded, fallback);
        setPageNumber(start);
        setPageInput(String(start));
        setPdf(loaded);
        setPasswordPrompt(null);
        updateRef.current({ pageCount: loaded.numPages });
      } catch (failure) {
        if (active && !cancelled(failure)) setError(describeError(failure));
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => {
      active = false;
      passwordCallback.current = null;
      // destroy also stops the worker and any still-pending password request.
      void task?.destroy().catch(() => {});
    };
  }, [entry.id, retry]);

  useEffect(() => {
    if (!pageLinkRequest) { setPageLinkError(''); return; }
    if (!pdf || pageLinkRequest.documentId !== entry.id || handledLink.current === pageLinkRequest.request) return;
    const next = linkedPage(pdf, pageNumber);
    setPageNumber(next);
    setPageInput(String(next));
    // A link to the page already on screen still takes the reader to its top.
    if (next === pageLinkRequest.page) viewportRef.current?.scrollTo({ top: 0, left: 0 });
  }, [pageLinkRequest, pdf, entry.id]);

  useEffect(() => {
    if (!pdf) return;
    let active = true;
    let renderTask: RenderTask | undefined;
    let canvas: HTMLCanvasElement | undefined;
    setRendering(true);
    setError('');
    // Retain the previous surface while resizing renders its replacement.
    // Emptying the paper here collapses scroll height and loses reader scroll.
    void (async () => {
      try {
        const page = await pdf.getPage(pageNumber);
        if (!active) return;
        const combinedRotation = (page.rotate + rotation) % 360;
        const natural = page.getViewport({ scale: 1, rotation: combinedRotation });
        if (!Number.isFinite(natural.width) || !Number.isFinite(natural.height) || natural.width <= 0 || natural.height <= 0) {
          throw new Error('This page has invalid dimensions.');
        }
        const requestedScale = zoom === 'fit' ? Math.min(2, availableWidth / natural.width) : zoom;
        // Bound both the displayed surface and backing pixels for unusually large pages.
        const scale = Math.min(requestedScale, 8192 / Math.max(natural.width, natural.height), Math.sqrt(20_000_000 / (natural.width * natural.height)));
        const viewport = page.getViewport({ scale, rotation: combinedRotation });
        const outputScale = Math.min(window.devicePixelRatio || 1, 2, 4096 / Math.max(viewport.width, viewport.height), Math.sqrt(12_000_000 / (viewport.width * viewport.height)));
        canvas = window.document.createElement('canvas');
        canvas.width = Math.max(1, Math.floor(viewport.width * outputScale));
        canvas.height = Math.max(1, Math.floor(viewport.height * outputScale));
        canvas.style.width = `${viewport.width}px`;
        canvas.style.height = `${viewport.height}px`;
        canvas.setAttribute('role', 'img');
        canvas.setAttribute('aria-label', `Page ${pageNumber} of ${pdf.numPages}`);
        canvas.dataset.pageNumber = String(pageNumber);
        const context = canvas.getContext('2d', { alpha: false });
        if (!context) throw new Error('Your device could not create a PDF canvas.');
        renderTask = page.render({
          canvas,
          canvasContext: context,
          viewport,
          transform: outputScale === 1 ? undefined : [outputScale, 0, 0, outputScale, 0, 0],
          background: '#ffffff',
        });
        await renderTask.promise;
        if (!active) return;
        paperRef.current?.replaceChildren(canvas);
        setRenderedPage(pageNumber);
        setActualZoom(scale);
        if (lastSavedPage.current !== pageNumber) {
          lastSavedPage.current = pageNumber;
          updateRef.current({ lastPage: pageNumber });
          viewportRef.current?.scrollTo({ top: 0, left: 0 });
        }
      } catch (failure) {
        if (active && !cancelled(failure)) {
          paperRef.current?.replaceChildren();
          setRenderedPage(null);
          setError(describeError(failure));
        }
      } finally {
        if (active) setRendering(false);
      }
    })();
    return () => {
      active = false;
      renderTask?.cancel();
      // Each render owns its canvas; a new render never competes for this surface.
      if (canvas && !canvas.isConnected) {
        void renderTask?.promise.catch(() => {}).finally(() => { if (canvas) canvas.width = canvas.height = 0; });
      }
    };
  }, [pdf, pageNumber, zoom, rotation, availableWidth]);

  function goToPage(next: number) {
    const valid = Math.max(1, Math.min(pdf?.numPages || 1, Math.trunc(next) || 1));
    setPageNumber(valid);
    setPageInput(String(valid));
  }

  const linkPending = !!pageLinkRequest && pageLinkRequest.request !== completedLink;
  const canLinkCurrentPage = canInsertPageLink && !!pdf && !loading && !rendering && !error
    && renderedPage === pageNumber && !linkPending;

  function submitPassword(event: FormEvent) {
    event.preventDefault();
    if (!password || !passwordCallback.current) return;
    const provide = passwordCallback.current;
    passwordCallback.current = null;
    setPasswordPrompt(null);
    setPassword('');
    provide(password);
  }

  return <section className="pdf-reader" aria-label={`Reading ${entry.title}`}>
    <div className="pdf-reader-heading">
      <button className="pdf-back-button" onClick={onClose}><ArrowLeft size={17} /> Back to library</button>
      <div className="pdf-reader-document"><FileText size={18} /><h1 title={entry.title}>{entry.title}</h1><span>PDF</span></div>
    </div>
    <div className="pdf-reader-toolbar" aria-label="PDF reader controls">
      <div className="pdf-toolbar-group">
        <button aria-label="Previous page" title="Previous page" disabled={!pdf || pageNumber <= 1} onClick={() => goToPage(pageNumber - 1)}><ChevronLeft size={18} /></button>
        <form className="pdf-page-form" onSubmit={event => { event.preventDefault(); goToPage(Number(pageInput)); }}>
          <label htmlFor="pdf-page-number">Page</label>
          <input id="pdf-page-number" aria-label="Page number" inputMode="numeric" type="number" min={1} max={pdf?.numPages || 1} value={pageInput} disabled={!pdf} onChange={event => setPageInput(event.target.value)} onBlur={() => goToPage(Number(pageInput))} />
          <span className="pdf-page-total">of {pdf?.numPages ?? '—'}</span>
        </form>
        <button aria-label="Next page" title="Next page" disabled={!pdf || pageNumber >= pdf.numPages} onClick={() => goToPage(pageNumber + 1)}><ChevronRight size={18} /></button>
      </div>
      <div className="pdf-toolbar-group pdf-zoom-controls">
        <button aria-label="Zoom out" title="Zoom out" disabled={!pdf || actualZoom <= 0.25} onClick={() => setZoom(Math.max(0.25, Math.round((actualZoom - 0.25) * 100) / 100))}><ZoomOut size={18} /></button>
        <select aria-label="Page zoom" disabled={!pdf} value={zoom} onChange={event => setZoom(event.target.value === 'fit' ? 'fit' : Number(event.target.value))}>
          <option value="fit">Fit width</option>
          {[0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 3].map(value => <option key={value} value={value}>{value * 100}%</option>)}
          {typeof zoom === 'number' && ![0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 3].includes(zoom) && <option value={zoom}>{Math.round(zoom * 100)}%</option>}
        </select>
        <button aria-label="Zoom in" title="Zoom in" disabled={!pdf || actualZoom >= 3} onClick={() => setZoom(Math.min(3, Math.round((actualZoom + 0.25) * 100) / 100))}><ZoomIn size={18} /></button>
        <span className="pdf-toolbar-divider" />
        <button aria-label="Rotate page clockwise" title="Rotate page clockwise" disabled={!pdf} onClick={() => setRotation(value => (value + 90) % 360)}><RotateCw size={18} /></button>
      </div>
      <span className="pdf-reader-progress" aria-live="polite">{pdf ? `${Math.round(pageNumber / pdf.numPages * 100)}% through` : 'Opening document'}</span>
      {onInsertPageLink && <button className="pdf-insert-page-link" disabled={!canLinkCurrentPage}
        title={!canInsertPageLink ? 'Open a note to insert this page link.' : 'Insert this PDF page at the note’s cursor.'}
        onClick={() => { if (canLinkCurrentPage) onInsertPageLink({ documentId: entry.id, page: pageNumber, title: entry.title }); }}><Link2 size={16} />Insert page link</button>}
    </div>
    {pageLinkError && <div className="notice notice-error pdf-page-link-error" role="alert" aria-label="PDF page link error"><span>{pageLinkError}</span><button aria-label="Dismiss page link error" onClick={() => setPageLinkError('')}><X size={16} /></button></div>}
    <div className="pdf-reader-viewport" ref={viewportRef} tabIndex={0} aria-label="PDF page viewport" onKeyDown={event => {
      if (event.target !== event.currentTarget || !pdf) return;
      if (event.key === 'ArrowRight' || event.key === 'PageDown') { event.preventDefault(); goToPage(pageNumber + 1); }
      if (event.key === 'ArrowLeft' || event.key === 'PageUp') { event.preventDefault(); goToPage(pageNumber - 1); }
      if (event.key === 'Home') { event.preventDefault(); goToPage(1); }
      if (event.key === 'End') { event.preventDefault(); goToPage(pdf.numPages); }
    }}>
      <div className="pdf-paper" ref={paperRef} aria-busy={loading || rendering} />
      {passwordPrompt && <form className="pdf-reader-state pdf-password-form" onSubmit={submitPassword}>
        <LockKeyhole size={30} /><h2>Password required</h2>
        <p>{passwordPrompt === 'incorrect' ? 'That password did not work. Please try again.' : 'Enter this PDF’s password to read it. Passwords are never saved.'}</p>
        <label htmlFor="pdf-password">Document password</label>
        <input ref={passwordRef} id="pdf-password" type="password" value={password} onChange={event => setPassword(event.target.value)} autoComplete="off" />
        <button type="submit" disabled={!password}>Unlock PDF</button>
      </form>}
      {!passwordPrompt && error && <div className="pdf-reader-state" role="alert">
        <FileText size={32} /><h2>Unable to display this PDF</h2><p>{error}</p>
        <button onClick={() => setRetry(value => value + 1)}>Try again</button>
      </div>}
      {!passwordPrompt && !error && (loading || rendering) && <div className="pdf-reader-loading" role="status"><LoaderCircle className="pdf-spinner" size={23} /><span>{loading ? 'Opening your PDF…' : `Rendering page ${pageNumber}…`}</span></div>}
    </div>
    <div className="pdf-reader-footer"><span>Saved to your local library</span><span>{pdf ? `Page ${pageNumber} of ${pdf.numPages}` : 'PDF reader'}{pdf ? ` · ${Math.round(actualZoom * 100)}% zoom` : ''}</span></div>
  </section>;
}

// A small shared queue prevents a large library from starting a worker for every card.
type ThumbnailJob = { start: () => Promise<void>; cancelled: boolean };
const thumbnailQueue: ThumbnailJob[] = [];
let runningThumbnails = 0;
const thumbnailCache = new Map<string, HTMLCanvasElement>();
let cachedPixels = 0;

function pumpThumbnails() {
  while (runningThumbnails < 2 && thumbnailQueue.length) {
    const job = thumbnailQueue.shift()!;
    if (job.cancelled) continue;
    runningThumbnails++;
    void job.start().finally(() => { runningThumbnails--; pumpThumbnails(); });
  }
}

function rememberThumbnail(key: string, canvas: HTMLCanvasElement) {
  const existing = thumbnailCache.get(key);
  if (existing) cachedPixels -= existing.width * existing.height;
  thumbnailCache.delete(key);
  thumbnailCache.set(key, canvas);
  cachedPixels += canvas.width * canvas.height;
  while (cachedPixels > 8_000_000 || thumbnailCache.size > 48) {
    const oldest = thumbnailCache.keys().next().value;
    if (oldest === undefined) break;
    const removed = thumbnailCache.get(oldest)!;
    cachedPixels -= removed.width * removed.height;
    thumbnailCache.delete(oldest);
    removed.width = removed.height = 0;
  }
}

export function PdfThumbnail({ document: entry }: { document: PDFDocument }) {
  const holderRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [visible, setVisible] = useState(false);
  const [state, setState] = useState<'loading' | 'ready' | 'unavailable'>('loading');
  const [message, setMessage] = useState('PDF preview');

  useEffect(() => {
    const holder = holderRef.current;
    if (!holder) return;
    const observer = new IntersectionObserver(entries => {
      if (entries.some(item => item.isIntersecting)) { setVisible(true); observer.disconnect(); }
    }, { rootMargin: '160px' });
    observer.observe(holder);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!visible) return;
    let active = true;
    let task: PDFDocumentLoadingTask | undefined;
    let rendering: RenderTask | undefined;
    setState('loading');
    function display(source: HTMLCanvasElement) {
      const target = canvasRef.current;
      if (!active || !target) return;
      target.width = source.width;
      target.height = source.height;
      target.getContext('2d')?.drawImage(source, 0, 0);
      setState('ready');
    }
    const cached = thumbnailCache.get(entry.id);
    if (cached) {
      thumbnailCache.delete(entry.id);
      thumbnailCache.set(entry.id, cached);
      display(cached);
      return () => { active = false; };
    }
    const job: ThumbnailJob = { cancelled: false, start: async () => {
      try {
        if (!active) return;
        const bytes = await window.prismPdf.readDocument(entry.id);
        if (!active) return;
        task = loadPdf(bytes);
        // Thumbnails never ask for or retain document passwords.
        const pdf = await task.promise;
        if (!active) return;
        const page = await pdf.getPage(1);
        if (!active) return;
        const natural = page.getViewport({ scale: 1 });
        if (!Number.isFinite(natural.width) || !Number.isFinite(natural.height) || natural.width <= 0 || natural.height <= 0) throw new Error('Invalid page dimensions');
        const viewport = page.getViewport({ scale: Math.min(320 / natural.width, 440 / natural.height) });
        const canvas = window.document.createElement('canvas');
        canvas.width = Math.max(1, Math.ceil(viewport.width));
        canvas.height = Math.max(1, Math.ceil(viewport.height));
        const context = canvas.getContext('2d', { alpha: false });
        if (!context) throw new Error('Preview unavailable');
        rendering = page.render({ canvas, canvasContext: context, viewport, background: '#ffffff' });
        await rendering.promise;
        if (!active) return;
        rememberThumbnail(entry.id, canvas);
        display(canvas);
      } catch (failure) {
        if (active && !cancelled(failure)) {
          setState('unavailable');
          setMessage(failure instanceof Error && failure.name === 'PasswordException' ? 'Password protected' : 'Preview unavailable');
        }
      } finally {
        await task?.destroy().catch(() => {});
      }
    } };
    thumbnailQueue.push(job);
    pumpThumbnails();
    return () => {
      active = false;
      job.cancelled = true;
      rendering?.cancel();
      void task?.destroy().catch(() => {});
    };
  }, [entry.id, visible]);

  return <div className={`pdf-thumbnail pdf-thumbnail-${state}`} ref={holderRef}>
    <canvas ref={canvasRef} aria-label={`First page of ${entry.title}`} role="img" />
    {state !== 'ready' && <div className="pdf-thumbnail-fallback"><FileText size={32} strokeWidth={1.3} /><span>{state === 'loading' ? 'PDF' : message}</span></div>}
  </div>;
}
