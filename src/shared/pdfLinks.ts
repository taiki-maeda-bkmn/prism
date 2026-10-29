/** A managed-library destination; labels never participate in resolution. */
export interface PDFPageTarget { documentId: string; page: number }
export interface PDFPageReference extends PDFPageTarget { title: string }
export interface PDFPageLinkRequest extends PDFPageTarget { request: number }
/** One current-notebook note that cites a managed PDF, grouped by page. */
export interface PDFNoteBacklink { path: string; title: string; pages: readonly number[] }

// Recognize the namespace independently of validity so malformed/future links
// can explain their failure inside Prism instead of reaching an external app.
export function isPDFPageLink(href: string): boolean {
  return /^prism-pdf:/i.test(href.trim());
}

/** Parse the serialized v1 format without URL normalization or path decoding. */
export function parsePDFPageLink(href: string): PDFPageTarget | null {
  if (href.length > 128) return null;
  const match = /^prism-pdf:\/\/v1\/documents\/([a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12})\?page=([1-9]\d*)$/i.exec(href);
  if (!match || match[0] !== href) return null;
  const page = Number(match[2]);
  if (!Number.isSafeInteger(page)) return null;
  return { documentId: match[1].toLowerCase(), page };
}

/** A plain-text label, safe in prose and table cells, with no title-based lookup. */
export function formatPDFPageLink(reference: PDFPageReference): string {
  const href = `prism-pdf://v1/documents/${reference.documentId}?page=${reference.page}`;
  const target = parsePDFPageLink(href);
  if (!target) throw new Error('The PDF page link has an invalid document or page.');
  const title = reference.title.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, ' ').replace(/\s+/g, ' ').trim() || 'PDF';
  // Keep punctuation literal, including table pipes and math delimiters.
  // Marked unescapes bracket escapes before lexing link labels; entities keep
  // a title containing [[...]] from being reinterpreted by the wiki extension.
  const label = title.replace(/[!-/:-@\[-`{-~]/g, character =>
    character === '[' ? '&#91;' : character === ']' ? '&#93;' : `\\${character}`);
  return `[${label} — p. ${target.page}](prism-pdf://v1/documents/${target.documentId}?page=${target.page})`;
}
