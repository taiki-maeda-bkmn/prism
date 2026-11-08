export interface PDFLayout {
  sidebar: boolean;
  sidebarWidth: number;
  search: boolean;
  heading: boolean;
  toolbar: boolean;
  backlinks: boolean;
  footer: boolean;
  compact: boolean;
}

export const librarySidebarSize = Object.freeze({ min: 180, default: 228, max: 420 });
export const pdfLayoutStorageKey = 'prism-pdf-layout';
export const defaultPDFLayout: Readonly<PDFLayout> = Object.freeze({
  sidebar: true,
  sidebarWidth: librarySidebarSize.default,
  search: true,
  heading: true,
  toolbar: true,
  backlinks: true,
  footer: true,
  compact: false,
});

const booleanSettings = ['sidebar', 'search', 'heading', 'toolbar', 'backlinks', 'footer', 'compact'] as const;

function normalizePDFLayout(value: Record<string, unknown>): PDFLayout {
  const layout = { ...defaultPDFLayout };
  for (const key of booleanSettings) {
    if (typeof value[key] === 'boolean') layout[key] = value[key];
  }
  if (typeof value.sidebarWidth === 'number' && Number.isFinite(value.sidebarWidth)) {
    layout.sidebarWidth = Math.max(librarySidebarSize.min, Math.min(librarySidebarSize.max, Math.round(value.sidebarWidth)));
  }
  return layout;
}

/** Invalid or future settings must leave a usable, fully visible workspace. */
export function parsePDFLayout(raw: string | null): PDFLayout {
  try {
    const value: unknown = raw === null ? null : JSON.parse(raw);
    if (value && typeof value === 'object' && !Array.isArray(value) && 'version' in value && value.version === 1) {
      return normalizePDFLayout(value as Record<string, unknown>);
    }
  } catch { /* A damaged preference must not prevent the library from opening. */ }
  return { ...defaultPDFLayout };
}

export function serializePDFLayout(layout: PDFLayout): string {
  return JSON.stringify({ version: 1, ...normalizePDFLayout({ ...layout }) });
}

export function moreReadingSpace(current: PDFLayout): PDFLayout {
  return {
    ...current,
    sidebar: false,
    search: false,
    heading: false,
    toolbar: true,
    backlinks: false,
    footer: false,
    compact: true,
  };
}
