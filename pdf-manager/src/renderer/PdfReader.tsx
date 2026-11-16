import { useEffect, useId, useLayoutEffect, useRef, useState, type FormEvent } from 'react';
import { ArrowLeft, Copy, Search, ChevronLeft, ChevronRight, FileText, Link2, LoaderCircle, LockKeyhole, RotateCw, X, ZoomIn, ZoomOut } from 'lucide-react';
import { getDocument, GlobalWorkerOptions, PasswordResponses, type PDFDocumentLoadingTask, type PDFDocumentProxy, type PDFPageProxy, type RenderTask } from 'pdfjs-dist';
import type { PDFDocument } from '../shared/types';
import type { PDFNoteBacklink, PDFPageLinkRequest, PDFPageReference } from '../../../src/shared/pdfLinks';
import { PdfBacklinks } from './PdfBacklinks';
import { defaultPDFLayout, type PDFLayout } from './pdfLayout';
import type { PDFReaderSession } from './readerSessions';
import './reader.css';
import { createPageLayers, resolvePDFDestinationPage, type PDFPageLayers, type PDFLinkTarget } from './pdfPageLayers';
import { usePDFTextSearch } from './usePDFTextSearch';
import { highlightPDFMatches } from './pdfSearchHighlights';
import { PDF_SEARCH_LIMITS, normalizeSearchQuery } from './pdfTextSearch';
import './pdfFind.css';

type PageSurface = { page: PDFPageProxy; viewport: ReturnType<PDFPageProxy['getViewport']>; canvas: HTMLCanvasElement; number: number };

GlobalWorkerOptions.workerSrc = new URL('./pdf.worker.mjs', import.meta.url).href;
const PAGE_SCROLL_EDGE_PX = 2;

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

function replacePageCanvas(paper: HTMLElement | null, canvas?: HTMLCanvasElement) {
  if (!paper) return;
  const previous = paper.firstElementChild;
  paper.replaceChildren(...(canvas ? [canvas] : []));
  // Completed surfaces can be large. Release their backing store as soon as
  // the replacement is visible, instead of waiting for garbage collection.
  if (previous instanceof HTMLCanvasElement && previous !== canvas) previous.width = previous.height = 0;
}

interface PdfReaderProps {
  layout?: PDFLayout;
  workspaceActive?: boolean;
  visible?: boolean;
  document: PDFDocument;
  onUpdate: (patch: { lastPage?: number; pageCount?: number }) => void;
  onClose: () => void;
  pageLinkRequest?: PDFPageLinkRequest | null;
  onInsertPageLink?: (reference: PDFPageReference) => void;
  canInsertPageLink?: boolean;
  backlinks?: readonly PDFNoteBacklink[];
  onOpenNote?: (path: string) => void;
  initialSession?: PDFReaderSession;
  onSessionChange?: (session: PDFReaderSession) => void;
}

/** PDF content stays passive: canvas, selectable text, and validated link targets. */
export function PdfReader({ document: entry, onUpdate, onClose, workspaceActive = true, visible = true, pageLinkRequest, onInsertPageLink, canInsertPageLink = false, backlinks = [], onOpenNote, layout = defaultPDFLayout, initialSession, onSessionChange }: PdfReaderProps) {
  const controlsId = useId();
  const restoredSession = useRef(initialSession);
  const initialPage = Math.max(1, restoredSession.current?.page ?? entry.lastPage ?? 1);
  const [pdf, setPdf] = useState<PDFDocumentProxy | null>(null);
  const [surface, setSurface] = useState<PageSurface | null>(null);
  const [layers, setLayers] = useState<PDFPageLayers | null>(null);
  const [layerLoading, setLayerLoading] = useState(false);
  const [layerError, setLayerError] = useState('');
  const [selectionText, setSelectionText] = useState('');
  const [copyStatus, setCopyStatus] = useState('');
  const [interactionError, setInteractionError] = useState('');
  const find = usePDFTextSearch(pdf, visible);
  const findInput = useRef<HTMLInputElement>(null);
  const openFindRef = useRef(() => {});
  const interactRef = useRef<(target: PDFLinkTarget) => void>(() => {});
  const interactionSequence = useRef(0);
  const lastFindRequest = useRef(0);
  const pendingFindScroll = useRef<number | null>(null);
  const highlighted = useRef<{ layers: PDFPageLayers; signature: string; mark: HTMLElement | null } | null>(null);
  const activeInteraction = useRef(false);
  const [pageNumber, setPageNumber] = useState(initialPage);
  const [pageInput, setPageInput] = useState(String(initialPage));
  const [loading, setLoading] = useState(true);
  const [rendering, setRendering] = useState(false);
  const [error, setError] = useState('');
  const [pageLinkError, setPageLinkError] = useState('');
  const [renderedPage, setRenderedPage] = useState<number | null>(null);
  const [completedLink, setCompletedLink] = useState<number | null>(null);
  const [zoom, setZoom] = useState<number | 'fit'>(restoredSession.current?.zoom ?? 'fit');
  const [actualZoom, setActualZoom] = useState(1);
  const [rotation, setRotation] = useState(restoredSession.current?.rotation ?? 0);
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
  // Numeric zoom is independent of the viewport. Resizing it needs no repaint.
  const fitWidth = zoom === 'fit' ? availableWidth : null;
  const pendingPageScroll = useRef<{ page: number; edge: 'top' | 'bottom' } | null>(null);
  const pendingSessionScroll = useRef(restoredSession.current);
  const sessionUpdateRef = useRef(onSessionChange);
  const session = useRef<PDFReaderSession>(restoredSession.current ?? { page: initialPage, zoom: 'fit', rotation: 0, scrollTop: 0, scrollLeft: 0 });
  session.current = { page: pageNumber, zoom, rotation, scrollTop: session.current.page === pageNumber ? session.current.scrollTop : 0, scrollLeft: session.current.page === pageNumber ? session.current.scrollLeft : 0 };
  sessionUpdateRef.current = onSessionChange;
  updateRef.current = onUpdate;
  startingPageRef.current = restoredSession.current?.page ?? entry.lastPage ?? 1;
  latestLink.current = pageLinkRequest;
  currentPage.current = pageNumber;

  useEffect(() => { sessionUpdateRef.current?.({ ...session.current }); }, [pageNumber, zoom, rotation]);

  useLayoutEffect(() => {
    // Chromium can reset a scroll container when an ancestor becomes hidden.
    // Keep its last visible coordinates for retained readers as well as evicted
    // ones; scroll events from hidden geometry must not overwrite this value.
    if (!visible) {
      pendingSessionScroll.current ??= { ...session.current };
      return;
    }
    const restored = pendingSessionScroll.current;
    const container = viewportRef.current;
    // A reader can finish loading after another tab was selected. Hidden
    // geometry cannot restore scrolling; keep the snapshot until it is shown.
    if (!container?.clientWidth || !restored || renderedPage !== restored.page) return;
    container.scrollTo({ top: restored.scrollTop, left: restored.scrollLeft });
    session.current = { ...session.current, scrollTop: container.scrollTop, scrollLeft: container.scrollLeft };
    sessionUpdateRef.current?.({ ...session.current });
    pendingSessionScroll.current = undefined;
  }, [visible, renderedPage]);

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
    pendingSessionScroll.current = undefined;
    return request.page;
  }

  useEffect(() => {
    const container = viewportRef.current;
    if (!container) return;
    let previousWidth: number | undefined;
    let pending: ReturnType<typeof setTimeout> | undefined;
    const observer = new ResizeObserver(([size]) => {
      // Hiding the workspace must not replace the retained page with a tiny render.
      if (size.contentRect.width <= 0) { clearTimeout(pending); previousWidth = undefined; return; }
      const next = Math.max(160, Math.round(size.contentRect.width - 64));
      if (next === previousWidth) return;
      const initial = previousWidth === undefined;
      previousWidth = next;
      clearTimeout(pending);
      // Show the initial page promptly, then keep its surface during a divider
      // or window drag and rasterize once the viewport has settled.
      if (initial) setAvailableWidth(next);
      else pending = setTimeout(() => setAvailableWidth(next), 120);
    });
    observer.observe(container);
    return () => { observer.disconnect(); clearTimeout(pending); };
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
    setSurface(null);
    interactionSequence.current++;
    setLoading(true);
    setError('');
    setRenderedPage(null);
    pendingPageScroll.current = null;
    setPassword('');
    setPasswordPrompt(null);
    setRotation(retry ? 0 : restoredSession.current?.rotation ?? 0);
    setZoom(retry ? 'fit' : restoredSession.current?.zoom ?? 'fit');
    lastSavedPage.current = null;
    replacePageCanvas(paperRef.current);
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
      interactionSequence.current++;
      passwordCallback.current = null;
      // destroy also stops the worker and any still-pending password request.
      void task?.destroy().catch(() => {});
    };
  }, [entry.id, retry]);

  useEffect(() => {
    pendingPageScroll.current = null;
    interactionSequence.current++;
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
        const requestedScale = zoom === 'fit' ? Math.min(2, fitWidth! / natural.width) : zoom;
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
        replacePageCanvas(paperRef.current, canvas);
        setSurface({ page, viewport, canvas, number: pageNumber });
        setRenderedPage(pageNumber);
        setActualZoom(scale);
        if (lastSavedPage.current !== pageNumber) {
          lastSavedPage.current = pageNumber;
          updateRef.current({ lastPage: pageNumber });
          const container = viewportRef.current;
          const bottom = pendingPageScroll.current?.page === pageNumber && pendingPageScroll.current.edge === 'bottom';
          const restored = pendingSessionScroll.current?.page === pageNumber ? pendingSessionScroll.current : undefined;
          if (!restored || container?.clientWidth) {
            container?.scrollTo({ top: restored?.scrollTop ?? (bottom ? container.scrollHeight : 0), left: restored?.scrollLeft ?? 0 });
            session.current = { ...session.current, page: pageNumber, scrollTop: container?.scrollTop ?? 0, scrollLeft: container?.scrollLeft ?? 0 };
            sessionUpdateRef.current?.({ ...session.current });
            pendingSessionScroll.current = undefined;
          }
          pendingPageScroll.current = null;
        }
      } catch (failure) {
        if (active && !cancelled(failure)) {
          replacePageCanvas(paperRef.current);
          setSurface(null);
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
  }, [pdf, pageNumber, zoom, rotation, fitWidth]);

  function goToPage(next: number, edge: 'top' | 'bottom' = 'top') {
    interactionSequence.current++;
    pendingFindScroll.current = null;
    pendingSessionScroll.current = undefined;
    const valid = Math.max(1, Math.min(pdf?.numPages || 1, Math.trunc(next) || 1));
    if (valid !== currentPage.current) pendingPageScroll.current = { page: valid, edge };
    currentPage.current = valid;
    setPageNumber(valid);
    setPageInput(String(valid));
  }

  const linkPending = !!pageLinkRequest && pageLinkRequest.request !== completedLink;
  const pageReady = !!pdf && !loading && !rendering && !error
    && renderedPage === pageNumber && !linkPending;
  const canLinkCurrentPage = canInsertPageLink && pageReady;

  activeInteraction.current = visible && pageReady;
  openFindRef.current = () => {
    find.setOpen(true);
    requestAnimationFrame(() => { findInput.current?.focus(); findInput.current?.select(); });
  };
  interactRef.current = target => {
    if (!pdf || !activeInteraction.current) return;
    const request = ++interactionSequence.current;
    setInteractionError('');
    void (async () => {
      try {
        if (target.kind === 'external') {
          await window.prismPdf.openExternal(target.url);
          return;
        }
        const next = target.kind === 'destination' ? await resolvePDFDestinationPage(pdf, target.destination)
          : ({ NextPage: currentPage.current + 1, PrevPage: currentPage.current - 1, FirstPage: 1, LastPage: pdf.numPages })[target.action];
        if (request !== interactionSequence.current || !activeInteraction.current) return;
        if (next === null) throw new Error('This link points to an unavailable PDF page.');
        goToPage(next);
        viewportRef.current?.scrollTo({ top: 0, left: 0 });
        viewportRef.current?.focus({ preventScroll: true });
      } catch (cause) {
        if (request === interactionSequence.current) setInteractionError(describeError(cause));
      }
    })();
  };

  useEffect(() => {
    const controller = new AbortController();
    let prepared: PDFPageLayers | undefined;
    setLayers(null);
    setLayerError('');
    setSelectionText('');
    setCopyStatus('');
    setLayerLoading(!!surface);
    if (surface) void createPageLayers(surface.page, surface.viewport, {
      onLink: target => { if (!controller.signal.aborted) interactRef.current(target); },
    }, controller.signal).then(next => {
      if (controller.signal.aborted || !surface.canvas.isConnected) { next.dispose(); return; }
      prepared = next;
      paperRef.current?.append(next.element);
      setLayers(next);
    }).catch(cause => {
      if (!controller.signal.aborted) setLayerError(describeError(cause));
    }).finally(() => { if (!controller.signal.aborted) setLayerLoading(false); });
    return () => { controller.abort(); prepared?.dispose(); };
  }, [surface]);

  function selectedPDFText(): string {
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed || !selection.anchorNode || !selection.focusNode
      || !layers?.element.contains(selection.anchorNode) || !layers.element.contains(selection.focusNode)) return '';
    return selection.toString();
  }
  async function copySelectedText() {
    const text = selectedPDFText();
    if (!text || !pageReady) return;
    try { await window.prismPdf.copyText(text); setCopyStatus('Copied'); }
    catch (cause) { setInteractionError(describeError(cause)); }
  }
  useEffect(() => {
    const changed = () => { setSelectionText(selectedPDFText()); setCopyStatus(''); };
    window.document.addEventListener('selectionchange', changed);
    return () => window.document.removeEventListener('selectionchange', changed);
  }, [layers]);

  useEffect(() => {
    if (!visible) interactionSequence.current++;
  }, [visible]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!workspaceActive || !visible || !pdf || event.defaultPrevented || event.isComposing
        || window.document.querySelector('dialog[open]')) return;
      if ((event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === 'f') {
        event.preventDefault(); openFindRef.current();
      } else if (event.key === 'F3' && find.open) {
        event.preventDefault(); find.move(event.shiftKey ? -1 : 1);
      } else if ((event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === 'c'
        && !(event.target instanceof Element && event.target.closest('input, textarea, [contenteditable="true"]')) && selectedPDFText()) {
        event.preventDefault(); void copySelectedText();
      } else if ((event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === 'a'
        && window.document.activeElement === viewportRef.current && pageReady) {
        const text = layers?.element.querySelector('.pdf-text-layer');
        if (text) {
          event.preventDefault();
          const range = window.document.createRange(); range.selectNodeContents(text);
          const selection = window.getSelection(); selection?.removeAllRanges(); selection?.addRange(range);
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [workspaceActive, visible, pdf, layers, pageReady, find.open, find.move]);

  useEffect(() => {
    const match = find.result.matches[find.selection.index];
    if (!match || !find.open || !visible || lastFindRequest.current === find.selection.request) return;
    lastFindRequest.current = find.selection.request;
    goToPage(match.pageNumber);
    pendingFindScroll.current = find.selection.request;
  }, [find.result, find.selection, find.open, visible]);

  useEffect(() => {
    if (!layers || !surface || !layers.element.isConnected || surface.canvas.nextElementSibling !== layers.element) return;
    const matches = find.open ? find.result.matches : [];
    const signature = JSON.stringify(matches.flatMap((item, index) => item.pageNumber === surface.number
      ? [{ match: item.match, active: index === find.selection.index }] : []));
    // Progress on later pages must not replace text nodes under a selection.
    if (highlighted.current?.layers !== layers || highlighted.current.signature !== signature) {
      const strings = layers.text.items.flatMap(item => 'str' in item ? [item.str] : []);
      highlighted.current = { layers, signature, mark: highlightPDFMatches(layers.textDivs, strings, matches, surface.number, find.selection.index) };
    }
    const mark = highlighted.current.mark;
    if (!mark || !visible || surface.number !== pageNumber || !pageReady
      || pendingFindScroll.current !== find.selection.request) return;
    const container = viewportRef.current;
    if (container) {
      const bounds = container.getBoundingClientRect(), target = mark.getBoundingClientRect();
      container.scrollTo({ top: container.scrollTop + target.top - bounds.top - container.clientHeight / 3,
        left: container.scrollLeft + target.left - bounds.left - container.clientWidth / 3 });
      pendingFindScroll.current = null;
    }
  }, [layers, surface, find.result, find.selection, find.open, visible, pageNumber, pageReady]);

  const hasPageText = !!layers?.text.items.some(item => 'str' in item && item.str.trim());
  const findCount = find.result.matches.length;
  const findStatus = !normalizeSearchQuery(find.query) ? 'Type to search this PDF.'
    : findCount ? `${find.selection.index + 1} of ${findCount}${find.result.truncated ? '+' : ''} matches`
      : find.busy ? 'Searching…' : !find.result.hasText && !find.result.failedPages.length
        ? 'No searchable text. Image-only scans need OCR.' : 'No matches';

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
    <div className="pdf-reader-heading" hidden={!layout.heading}>
      <button className="pdf-back-button" onClick={onClose}><ArrowLeft size={17} /> Back to library</button>
      <div className="pdf-reader-document"><FileText size={18} /><h1 title={entry.title}>{entry.title}</h1><span>PDF</span></div>
    </div>
    <div className="pdf-reader-toolbar" aria-label="PDF reader controls" hidden={!layout.toolbar}>
      <div className="pdf-toolbar-group">
        <button aria-label="Previous page" title="Previous page" disabled={!pdf || pageNumber <= 1} onClick={() => goToPage(pageNumber - 1)}><ChevronLeft size={18} /></button>
        <form className="pdf-page-form" onSubmit={event => { event.preventDefault(); goToPage(Number(pageInput)); }}>
          <label htmlFor={`${controlsId}-page-number`}>Page</label>
          <input id={`${controlsId}-page-number`} aria-label="Page number" inputMode="numeric" type="number" min={1} max={pdf?.numPages || 1} value={pageInput} disabled={!pdf} onChange={event => setPageInput(event.target.value)} onBlur={() => goToPage(Number(pageInput))} />
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
      <span className="pdf-reader-progress">{pdf ? `${Math.round(pageNumber / pdf.numPages * 100)}% through` : 'Opening document'}</span>
      {onInsertPageLink && <button className="pdf-insert-page-link" disabled={!canLinkCurrentPage}
        title={!canInsertPageLink ? 'Open a note to insert this page link.' : 'Insert this PDF page at the note’s cursor.'}
        onClick={() => { if (canLinkCurrentPage) onInsertPageLink({ documentId: entry.id, page: pageNumber, title: entry.title }); }}><Link2 size={16} />Insert page link</button>}
    </div>
    <div className="pdf-reader-tools" aria-label="PDF text tools">
      <button aria-label="Find in PDF" title="Find in PDF (Ctrl+F)" disabled={!pdf} onClick={() => openFindRef.current()}><Search size={16} /><span>Find</span></button>
      <button aria-label="Copy selected text" title="Copy selected text (Ctrl+C)" disabled={!selectionText || !pageReady}
        onPointerDown={event => event.preventDefault()} onClick={() => void copySelectedText()}><Copy size={16} /><span>Copy text</span></button>
      <span className="pdf-text-notice" role="status">{copyStatus || (layerLoading ? 'Preparing text…' : layerError || layers?.warnings.join(' ') || (layers && !hasPageText ? 'No selectable text on this page. Image-only scans need OCR.' : 'Select text to copy.'))}</span>
    </div>
    {find.open && <div className="pdf-find-bar" role="search" aria-label="Search PDF text">
      <input ref={findInput} type="search" aria-label="Find text in PDF" placeholder="Find in this PDF…" value={find.query} maxLength={PDF_SEARCH_LIMITS.queryLength}
        onChange={event => find.setQuery(event.target.value)} onKeyDown={event => {
          if (event.nativeEvent.isComposing) return;
          if (event.key === 'Enter') { event.preventDefault(); find.move(event.shiftKey ? -1 : 1); }
          if (event.key === 'Escape') { event.preventDefault(); find.setOpen(false); viewportRef.current?.focus({ preventScroll: true }); }
        }} />
      <button aria-label="Previous match" title="Previous match (Shift+Enter)" disabled={!findCount} onClick={() => find.move(-1)}><ChevronLeft size={17} /></button>
      <button aria-label="Next match" title="Next match (Enter)" disabled={!findCount} onClick={() => find.move(1)}><ChevronRight size={17} /></button>
      <span className="pdf-find-status" role="status">{findStatus}{find.busy && findCount ? ' · Searching…' : ''}</span>
      <button aria-label="Close PDF search" title="Close PDF search" onClick={() => { find.setOpen(false); viewportRef.current?.focus({ preventScroll: true }); }}><X size={17} /></button>
      {(find.error || find.result.failedPages.length > 0 || find.result.truncated) && <span className="pdf-find-warning" role="status">{find.error || [
        find.result.failedPages.length ? `${find.result.failedPages.length} page(s) could not be searched.` : '',
        find.result.truncated ? 'Showing limited results for this large document or query. Narrow your search.' : '',
      ].filter(Boolean).join(' ')}</span>}
    </div>}
    {interactionError && <div className="pdf-interaction-error" role="alert"><span>{interactionError}</span><button aria-label="Dismiss PDF interaction error" onClick={() => setInteractionError('')}><X size={16} /></button></div>}
    {onOpenNote && <div className="pdf-reader-backlinks" hidden={!layout.backlinks}><PdfBacklinks backlinks={backlinks} pageCount={pdf?.numPages ?? null} currentPage={pageNumber} onOpenNote={onOpenNote}
      onOpenPage={page => {
        if (!pdf || page < 1 || page > pdf.numPages) return;
        goToPage(page);
        viewportRef.current?.scrollTo({ top: 0, left: 0 });
        viewportRef.current?.focus({ preventScroll: true });
      }} /></div>}
    {pageLinkError && <div className="pdf-workspace-notices"><div className="notice notice-error pdf-page-link-error" role="alert" aria-label="PDF page link error"><span>{pageLinkError}</span><button aria-label="Dismiss page link error" onClick={() => setPageLinkError('')}><X size={16} /></button></div></div>}
    <div className="pdf-reader-viewport" ref={viewportRef} tabIndex={0} aria-label="PDF page viewport"
      onScroll={event => {
        const container = event.currentTarget;
        if (renderedPage !== pageNumber || !container.clientWidth || pendingSessionScroll.current) return;
        session.current = { ...session.current, scrollTop: container.scrollTop, scrollLeft: container.scrollLeft };
        sessionUpdateRef.current?.({ ...session.current });
      }}
      onPointerDown={event => {
        if (event.button === 0 && !event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey
          && event.target instanceof Node && paperRef.current?.contains(event.target)
          && !(event.target instanceof Element && event.target.closest('a, button'))) event.currentTarget.focus({ preventScroll: true });
      }}
      onKeyDown={event => {
        if (event.target !== event.currentTarget || !pdf || event.ctrlKey || event.metaKey || event.altKey
          || event.nativeEvent.isComposing || (event.shiftKey && event.key !== ' ')) return;
        if (!['ArrowRight', 'ArrowLeft', 'PageDown', 'PageUp', 'Home', 'End', ' '].includes(event.key)) return;
        event.preventDefault();
        if (!pageReady || event.repeat) return;
        if (event.key === 'ArrowRight' || event.key === 'PageDown') goToPage(currentPage.current + 1);
        if (event.key === 'ArrowLeft' || event.key === 'PageUp') goToPage(currentPage.current - 1);
        if (event.key === 'Home') goToPage(1);
        if (event.key === 'End') goToPage(pdf.numPages);
        if (event.key === ' ') {
          const container = event.currentTarget;
          const direction = event.shiftKey ? -1 : 1;
          const atEdge = direction < 0 ? container.scrollTop <= PAGE_SCROLL_EDGE_PX
            : container.scrollTop >= container.scrollHeight - container.clientHeight - PAGE_SCROLL_EDGE_PX;
          if (atEdge) goToPage(currentPage.current + direction, direction < 0 ? 'bottom' : 'top');
          else container.scrollBy({ top: direction * Math.max(1, container.clientHeight * 0.85) });
        }
      }}>
      <div className="pdf-paper" ref={paperRef} aria-busy={loading || rendering} inert={!pageReady} />
      {passwordPrompt && <form className="pdf-reader-state pdf-password-form" onSubmit={submitPassword}>
        <LockKeyhole size={30} /><h2>Password required</h2>
        <p>{passwordPrompt === 'incorrect' ? 'That password did not work. Please try again.' : 'Enter this PDF’s password to read it. Passwords are never saved.'}</p>
        <label htmlFor={`${controlsId}-password`}>Document password</label>
        <input ref={passwordRef} id={`${controlsId}-password`} type="password" value={password} onChange={event => setPassword(event.target.value)} autoComplete="off" />
        <button type="submit" disabled={!password}>Unlock PDF</button>
      </form>}
      {!passwordPrompt && error && <div className="pdf-reader-state" role="alert">
        <FileText size={32} /><h2>Unable to display this PDF</h2><p>{error}</p>
        <button onClick={() => setRetry(value => value + 1)}>Try again</button>
      </div>}
      {!passwordPrompt && !error && (loading || rendering) && <div className="pdf-reader-loading" role="status"><LoaderCircle className="pdf-spinner" size={23} /><span>{loading ? 'Opening your PDF…' : `Rendering page ${pageNumber}…`}</span></div>}
    </div>
    <footer className="pdf-reader-footer" hidden={!layout.footer}>
      <nav className="pdf-page-navigation" aria-label="Page navigation">
        <button aria-label="Previous PDF page" title="Previous page (← or Page Up)" disabled={!pdf || loading || pageNumber <= 1}
          onClick={() => { goToPage(currentPage.current - 1); viewportRef.current?.focus({ preventScroll: true }); }}><ChevronLeft size={20} /><span>Previous</span></button>
        <span className="pdf-page-position" role="status" aria-live="polite" aria-atomic="true">{pdf ? `Page ${pageNumber} of ${pdf.numPages}` : 'PDF reader'}</span>
        <button aria-label="Next PDF page" title="Next page (→ or Page Down)" disabled={!pdf || loading || pageNumber >= pdf.numPages}
          onClick={() => { goToPage(currentPage.current + 1); viewportRef.current?.focus({ preventScroll: true }); }}><span>Next</span><ChevronRight size={20} /></button>
        <span className="pdf-navigation-hint">← → to turn pages · Space to scroll{pdf ? ` · ${Math.round(actualZoom * 100)}% zoom` : ''}</span>
      </nav>
    </footer>
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
