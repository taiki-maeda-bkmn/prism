export interface PDFDocument {
  id: string;
  title: string;
  filename: string;
  size: number;
  sha256: string;
  importedAt: string;
  updatedAt: string;
  tags: string[];
  favorite: boolean;
  lastOpenedAt: string | null;
  lastPage: number;
  pageCount: number | null;
  /** Canonical arXiv ID of the saved copy, including its version when known. */
  arxivId?: string;
}

export interface LibrarySnapshot {
  documents: PDFDocument[];
  warnings: string[];
}

export interface ImportResult {
  library: LibrarySnapshot;
  importedIds: string[];
  duplicateCount: number;
  errors: string[];
}

/** One main-process download; PDF bytes never cross the import IPC boundary. */
export interface PDFURLImportState {
  id: string;
  phase: 'downloading' | 'saving' | 'complete' | 'cancelled' | 'error';
  receivedBytes: number;
  totalBytes: number | null;
  document: PDFDocument | null;
  duplicate: boolean;
  error: string | null;
}

export type DocumentPatch = Partial<Pick<PDFDocument, 'title' | 'tags' | 'favorite' | 'lastPage' | 'pageCount'>>;

export interface PrismPdfAPI {
  loadLibrary(): Promise<LibrarySnapshot>;
  importDocuments(): Promise<ImportResult>;
  startURLImport(url: string): Promise<PDFURLImportState>;
  getURLImport(): Promise<PDFURLImportState | null>;
  cancelURLImport(id: string): Promise<PDFURLImportState>;
  readDocument(id: string): Promise<Uint8Array>;
  updateDocument(id: string, patch: DocumentPatch): Promise<PDFDocument>;
  openDocument(id: string): Promise<void>;
  revealDocument(id: string): Promise<void>;
  removeDocument(id: string): Promise<LibrarySnapshot>;
  windowControl(action: 'minimize' | 'maximize' | 'close'): void;
  platform: string;
}

declare global {
  interface Window { prismPdf: PrismPdfAPI; }
}
