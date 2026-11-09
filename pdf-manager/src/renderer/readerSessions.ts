/** Only lightweight reading coordinates survive an inactive reader's eviction. */
export interface PDFReaderSession {
  page: number;
  zoom: number | 'fit';
  rotation: number;
  scrollTop: number;
  scrollLeft: number;
}

export const MAX_RETAINED_PDF_READERS = 3;

/** Oldest first; restored tabs stay unloaded until explicitly selected. */
export function retainedPDFReaders(current: readonly string[], openIds: readonly string[], activeId: string | null): readonly string[] {
  const open = new Set(openIds);
  const next = current.filter(id => open.has(id) && id !== activeId);
  if (activeId && open.has(activeId)) next.push(activeId);
  const bounded = next.slice(-MAX_RETAINED_PDF_READERS);
  return bounded.length === current.length && bounded.every((id, index) => id === current[index]) ? current : bounded;
}
