import { useEffect, useRef, useState } from 'react';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import { emptyPDFSearchResult, normalizeSearchQuery, searchPDFDocument, type PDFSearchResult } from './pdfTextSearch';

interface SearchSession {
  pdf: PDFDocumentProxy | null;
  query: string;
  result: PDFSearchResult;
  complete: boolean;
  initialSelectionMade: boolean;
}

/** Extraction is demand-driven and stops when this reader is hidden or closed. */
export function usePDFTextSearch(pdf: PDFDocumentProxy | null, visible: boolean) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [result, setResult] = useState<PDFSearchResult>(() => emptyPDFSearchResult());
  const [selection, setSelection] = useState({ index: -1, request: 0 });
  const sequence = useRef(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const session = useRef<SearchSession | undefined>(undefined);

  useEffect(() => {
    let active = true;
    const controller = new AbortController();
    const cleanup = () => { active = false; clearTimeout(timer); controller.abort(); };
    let timer: ReturnType<typeof setTimeout> | undefined;
    let normalized: string;
    try { normalized = normalizeSearchQuery(query); }
    catch (cause) {
      session.current = undefined;
      setResult(emptyPDFSearchResult(pdf?.numPages ?? 0));
      setSelection({ index: -1, request: ++sequence.current });
      setBusy(false);
      setError(cause instanceof Error ? cause.message : 'PDF text search failed.');
      return cleanup;
    }
    if (session.current?.pdf !== pdf || session.current.query !== normalized) {
      const fresh = emptyPDFSearchResult(pdf?.numPages ?? 0);
      session.current = { pdf, query: normalized, result: fresh, complete: false, initialSelectionMade: false };
      setResult(fresh);
      setSelection({ index: -1, request: ++sequence.current });
      setError('');
    }
    const current = session.current;
    if (!pdf || !visible || !open || !normalized || current.complete) {
      setBusy(false);
      return cleanup;
    }
    setBusy(true);
    setError('');
    const publish = (next: PDFSearchResult, complete = false) => {
      if (!active || controller.signal.aborted || session.current !== current) return;
      // A resumed scan starts at page one. Keep the previous snapshot until
      // it catches up, so the selected later match never disappears mid-scan.
      if (!complete && next.scannedPages < current.result.scannedPages) return;
      const previousResult = current.result;
      current.result = next;
      current.complete = complete;
      const selectFirst = next.matches.length > 0 && !current.initialSelectionMade;
      if (selectFirst) current.initialSelectionMade = true;
      setResult(next);
      setSelection(previous => {
        const selected = previousResult.matches[previous.index];
        if (selected) {
          const index = next.matches.findIndex(value => value.pageNumber === selected.pageNumber
            && value.match.from === selected.match.from && value.match.to === selected.match.to);
          // A recovered earlier page may change the index, but it must not
          // issue a navigation request for the same selected occurrence.
          return index === previous.index ? previous : { ...previous, index };
        }
        return previous.index < 0 && selectFirst
          ? { index: 0, request: ++sequence.current } : previous;
      });
    };
    timer = setTimeout(() => {
      void searchPDFDocument(pdf, query, { signal: controller.signal, onProgress: publish })
        .then(next => publish(next, true))
        .catch(cause => {
          if (active && !controller.signal.aborted) setError(cause instanceof Error ? cause.message : 'PDF text search failed.');
        })
        .finally(() => { if (active) setBusy(false); });
    }, 250);
    return cleanup;
  }, [pdf, query, open, visible]);

  const move = (direction: number) => {
    if (!result.matches.length) return;
    setSelection(previous => ({
      index: previous.index < 0 ? direction < 0 ? result.matches.length - 1 : 0
        : (previous.index + direction + result.matches.length) % result.matches.length,
      request: ++sequence.current,
    }));
  };
  return { open, setOpen, query, setQuery, result, busy, error, selection, move };
}
