import type { PDFDocumentSearchMatch } from './pdfTextSearch';

/** Only text nodes and local marks are inserted; PDF content is never HTML. */
export function highlightPDFMatches(textDivs: readonly HTMLElement[], strings: readonly string[], matches: readonly PDFDocumentSearchMatch[], page: number, activeIndex: number): HTMLElement | null {
  const byItem = new Map<number, { from: number; to: number; active: boolean }[]>();
  matches.forEach((item, index) => {
    if (item.pageNumber !== page) return;
    for (const range of item.match.ranges) {
      const ranges = byItem.get(range.itemIndex) ?? [];
      ranges.push({ from: range.from, to: range.to, active: index === activeIndex });
      byItem.set(range.itemIndex, ranges);
    }
  });
  let selected: HTMLElement | null = null;
  textDivs.forEach((div, index) => {
    const value = strings[index] ?? '';
    const ranges = byItem.get(index);
    if (!ranges?.length) {
      // Preserve selection when a query has never touched this item.
      if (div.querySelector('.pdf-search-highlight')) div.textContent = value;
      return;
    }
    const fragment = document.createDocumentFragment();
    let offset = 0;
    for (const range of ranges.sort((a, b) => a.from - b.from)) {
      const from = Math.max(offset, Math.min(value.length, range.from));
      const to = Math.max(from, Math.min(value.length, range.to));
      if (to === from) continue;
      fragment.append(document.createTextNode(value.slice(offset, from)));
      const mark = document.createElement('mark');
      mark.className = 'pdf-search-highlight';
      mark.dataset.current = String(range.active);
      mark.textContent = value.slice(from, to);
      fragment.append(mark);
      if (range.active && !selected) selected = mark;
      offset = to;
    }
    fragment.append(document.createTextNode(value.slice(offset)));
    div.replaceChildren(fragment);
  });
  return selected;
}
