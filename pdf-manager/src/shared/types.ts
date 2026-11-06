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
  /** Library folder identity; absent means Unfiled. Managed file paths stay stable. */
  folderId?: string;
}

export interface PDFFolder { id: string; name: string; }

export interface LibrarySnapshot {
  documents: PDFDocument[];
  folders: PDFFolder[];
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

export type DocumentPatch = Partial<Pick<PDFDocument, 'title' | 'tags' | 'favorite' | 'lastPage' | 'pageCount'>>
  & { folderId?: string | null };

export interface PrismPdfAPI {
  loadLibrary(): Promise<LibrarySnapshot>;
  importDocuments(folderId?: string | null): Promise<ImportResult>;
  importDroppedDocuments(files: File[], folderId?: string | null): Promise<ImportResult>;
  createFolder(name: string): Promise<LibrarySnapshot>;
  renameFolder(id: string, name: string): Promise<LibrarySnapshot>;
  removeFolder(id: string): Promise<LibrarySnapshot>;
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
