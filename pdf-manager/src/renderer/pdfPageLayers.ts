import type { PDFDocumentProxy, PDFPageProxy, PageViewport } from 'pdfjs-dist';
import type { TextContent } from 'pdfjs-dist/types/src/display/api';
import './pdf-page-layers.css';

type DestinationMode = 'XYZ' | 'Fit' | 'FitB' | 'FitH' | 'FitBH' | 'FitV' | 'FitBV' | 'FitR';
type PageReference = number | { num: number; gen: number };
export type PDFExplicitDestination = [PageReference, { name: DestinationMode }, ...(number | null)[]];
export type PDFDestination = string | PDFExplicitDestination;
export type PDFPageAction = 'NextPage' | 'PrevPage' | 'FirstPage' | 'LastPage';
export type PDFLinkTarget =
  | { kind: 'external'; url: string }
  | { kind: 'destination'; destination: PDFDestination }
  | { kind: 'action'; action: PDFPageAction };

const controlCharacters = /[\u0000-\u001f\u007f-\u009f]/;
const pageActions = new Set<PDFPageAction>(['NextPage', 'PrevPage', 'FirstPage', 'LastPage']);
const maxLinkRegions = 5_000;

/** Renderer-side filtering only; the main process must validate URLs again. */
export function safePDFExternalURL(value: unknown): string | null {
  if (typeof value !== 'string' || !value || value.length > 4096 || value.trim() !== value || controlCharacters.test(value)) return null;
  try {
    const url = new URL(value);
    if (url.username || url.password) return null;
    if (url.protocol === 'http:' || url.protocol === 'https:') return url.href;
    if (url.protocol === 'mailto:' && !url.host && !url.hash && url.pathname) return url.href;
  } catch { /* An unsupported link must not become a clickable region. */ }
  return null;
}

/** Copy the small, supported destination shape rather than keeping PDF objects. */
export function parsePDFDestination(value: unknown): PDFDestination | null {
  if (typeof value === 'string') return value.length > 0 && value.length <= 4096 && !controlCharacters.test(value) ? value : null;
  if (!Array.isArray(value) || value.length < 2 || value.length > 6) return null;
  const [reference, mode, ...parameters] = value;
  let page: PageReference;
  if (Number.isSafeInteger(reference) && reference >= 0) page = reference;
  else if (reference && typeof reference === 'object'
    && Number.isSafeInteger(reference.num) && reference.num > 0
    && Number.isSafeInteger(reference.gen) && reference.gen >= 0) page = { num: reference.num, gen: reference.gen };
  else return null;
  if (!mode || typeof mode !== 'object' || typeof mode.name !== 'string') return null;
  const name = mode.name as DestinationMode;
  const length = parameters.length;
  if (name === 'XYZ' ? length < 2 || length > 3
    : name === 'Fit' || name === 'FitB' ? length !== 0
    : name === 'FitH' || name === 'FitBH' || name === 'FitV' || name === 'FitBV' ? length > 1
    : name === 'FitR' ? length !== 4 : true) return null;
  if (parameters.some(parameter => !(typeof parameter === 'number' && Number.isFinite(parameter)) && !(parameter === null && name !== 'FitR'))) return null;
  return [page, { name }, ...parameters];
}

/** Only ordinary link annotations get interactive DOM; PDF actions stay inert. */
export function annotationLinkTarget(value: unknown): PDFLinkTarget | null {
  if (!value || typeof value !== 'object') return null;
  const annotation = value as Record<string, unknown>;
  // AnnotationType.LINK is 2. Keeping this helper independent of PDF.js runtime
  // allows untrusted annotation data to be tested without a DOM or a worker.
  if (annotation.annotationType !== 2 && annotation.subtype !== 'Link') return null;
  if (annotation.url !== undefined && annotation.url !== null && annotation.url !== '') {
    const url = safePDFExternalURL(annotation.url);
    return url ? { kind: 'external', url } : null;
  }
  if (typeof annotation.action === 'string' && annotation.action) {
    return pageActions.has(annotation.action as PDFPageAction) ? { kind: 'action', action: annotation.action as PDFPageAction } : null;
  }
  const destination = parsePDFDestination(annotation.dest);
  return destination ? { kind: 'destination', destination } : null;
}

function abortError(): DOMException { return new DOMException('PDF page layers were cancelled.', 'AbortError'); }
function checkAbort(signal?: AbortSignal) { if (signal?.aborted) throw abortError(); }

/** Resolve both named destinations and explicit page references to a 1-based page. */
export async function resolvePDFDestinationPage(
  pdf: Pick<PDFDocumentProxy, 'numPages' | 'getDestination' | 'getPageIndex'>,
  destination: PDFDestination,
  signal?: AbortSignal,
): Promise<number | null> {
  checkAbort(signal);
  try {
    const parsed = parsePDFDestination(destination);
    const resolved = typeof parsed === 'string' ? parsePDFDestination(await pdf.getDestination(parsed)) : parsed;
    checkAbort(signal);
    if (!resolved || typeof resolved === 'string') return null;
    const reference = resolved[0];
    const index = typeof reference === 'number' ? reference : await pdf.getPageIndex(reference);
    checkAbort(signal);
    return Number.isSafeInteger(index) && index >= 0 && index < pdf.numPages ? index + 1 : null;
  } catch {
    checkAbort(signal);
    return null;
  }
}

type LinkRectangle = { left: number; top: number; width: number; height: number };

function linkRectangles(annotation: Record<string, unknown>, viewport: PageViewport): LinkRectangle[] {
  const rectangles: number[][] = [];
  const quadPoints = annotation.quadPoints;
  if ((Array.isArray(quadPoints) || quadPoints instanceof Float32Array || quadPoints instanceof Float64Array)
    && quadPoints.length >= 8 && quadPoints.length % 8 === 0) {
    for (let offset = 0; offset < Math.min(quadPoints.length, maxLinkRegions * 8); offset += 8) {
      const points = Array.from(quadPoints.slice(offset, offset + 8)) as number[];
      if (!points.every(value => typeof value === 'number' && Number.isFinite(value))) continue;
      rectangles.push([Math.min(points[0], points[2], points[4], points[6]), Math.min(points[1], points[3], points[5], points[7]),
        Math.max(points[0], points[2], points[4], points[6]), Math.max(points[1], points[3], points[5], points[7])]);
    }
  } else if (Array.isArray(annotation.rect) && annotation.rect.length === 4
    && annotation.rect.every(value => typeof value === 'number' && Number.isFinite(value))) rectangles.push(annotation.rect);
  return rectangles.flatMap(rectangle => {
    // PDF.js 6 exposes point conversion only. PageViewport rotations are in
    // 90-degree steps, so transformed opposite corners bound the whole rect.
    const [x1, y1] = viewport.convertToViewportPoint(rectangle[0], rectangle[1]);
    const [x2, y2] = viewport.convertToViewportPoint(rectangle[2], rectangle[3]);
    const left = Math.max(0, Math.min(x1, x2)), top = Math.max(0, Math.min(y1, y2));
    const right = Math.min(viewport.width, Math.max(x1, x2)), bottom = Math.min(viewport.height, Math.max(y1, y2));
    return right > left && bottom > top ? [{ left, top, width: right - left, height: bottom - top }] : [];
  });
}

export interface PDFPageLayers {
  element: HTMLDivElement;
  text: TextContent;
  /** Matches TextContent's string items, including empty strings. */
  textDivs: HTMLElement[];
  warnings: string[];
  dispose: () => void;
}

/** Build a selectable text layer and allowlisted links for one painted page. */
export async function createPageLayers(
  page: PDFPageProxy,
  viewport: PageViewport,
  callbacks: { onLink: (target: PDFLinkTarget) => void },
  signal: AbortSignal,
): Promise<PDFPageLayers> {
  checkAbort(signal);
  const element = document.createElement('div');
  element.className = 'pdf-page-layers';
  element.style.width = `${viewport.width}px`;
  element.style.height = `${viewport.height}px`;
  element.style.setProperty('--total-scale-factor', String(viewport.scale * viewport.userUnit));
  const textContainer = document.createElement('div');
  textContainer.className = 'pdf-text-layer';
  const links = document.createElement('div');
  links.className = 'pdf-link-layer';
  element.append(textContainer, links);
  let layer: InstanceType<typeof import('pdfjs-dist').TextLayer> | undefined;
  let disposed = false;
  let rejectAbort: ((error: DOMException) => void) | undefined;
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    signal.removeEventListener('abort', onAbort);
    layer?.cancel();
    element.remove();
  };
  const onAbort = () => { dispose(); rejectAbort?.(abortError()); };
  const aborted = new Promise<never>((_, reject) => { rejectAbort = reject; });
  // The race below always observes this rejection, even if a later render is
  // abandoned after the completed overlay has been returned to its owner.
  signal.addEventListener('abort', onAbort, { once: true });
  try {
    const warnings: string[] = [];
    const [textResult, annotationsResult] = await Promise.race([
      Promise.allSettled([page.getTextContent(), page.getAnnotations({ intent: 'display' })]), aborted,
    ]);
    checkAbort(signal);
    const text: TextContent = textResult.status === 'fulfilled' ? textResult.value : { items: [], styles: {}, lang: null };
    if (textResult.status === 'rejected') warnings.push('Text could not be extracted from this page.');
    if (annotationsResult.status === 'rejected') warnings.push('Links could not be read from this page.');
    if (textResult.status === 'fulfilled') {
      try {
        const { TextLayer } = await import('pdfjs-dist');
        checkAbort(signal);
        layer = new TextLayer({ textContentSource: text, container: textContainer, viewport });
        await Promise.race([layer.render(), aborted]);
        checkAbort(signal);
        if (layer.textDivs.length < text.items.filter(item => 'str' in item).length) warnings.push('Some text on this unusually complex page could not be made selectable.');
      } catch (failure) {
        checkAbort(signal);
        layer?.cancel();
        layer = undefined;
        textContainer.replaceChildren();
        warnings.push('Text selection could not be prepared for this page.');
      }
    }
    if (annotationsResult.status === 'fulfilled') {
      let count = 0;
      for (const raw of annotationsResult.value) {
        const target = annotationLinkTarget(raw);
        if (!target) continue;
        for (const rectangle of linkRectangles(raw, viewport)) {
          if (count++ >= maxLinkRegions) break;
          const link = document.createElement('a');
          link.className = 'pdf-page-link';
          link.draggable = false;
          link.href = target.kind === 'external' ? target.url : '#pdf-destination';
          const title = target.kind === 'external' ? target.url : target.kind === 'action'
            ? ({ NextPage: 'Next page', PrevPage: 'Previous page', FirstPage: 'First page', LastPage: 'Last page' })[target.action]
            : typeof target.destination === 'string' ? `Go to ${target.destination}` : 'Go to linked page';
          link.title = title;
          link.setAttribute('aria-label', title);
          link.style.left = `${rectangle.left}px`;
          link.style.top = `${rectangle.top}px`;
          link.style.width = `${rectangle.width}px`;
          link.style.height = `${rectangle.height}px`;
          // Never let PDF URLs navigate the application renderer, including
          // modifier/middle clicks. All activation goes through the host.
          link.onclick = event => {
            event.preventDefault();
            event.stopPropagation();
            if (!disposed && !signal.aborted) callbacks.onLink(target);
          };
          link.onauxclick = event => { event.preventDefault(); event.stopPropagation(); };
          links.append(link);
        }
        if (count >= maxLinkRegions) { warnings.push('Some links on this unusually complex page were omitted.'); break; }
      }
    }
    checkAbort(signal);
    return { element, text, textDivs: layer?.textDivs ?? [], warnings, dispose };
  } catch (failure) {
    dispose();
    throw failure;
  }
}
