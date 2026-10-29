/** Catalogue titles for graph labels; no reader resources or PDF bytes. */
export interface PDFGraphDocument { id: string; title: string }
export interface PDFGraphCatalog {
  status: 'idle' | 'loading' | 'ready' | 'error';
  documents: readonly PDFGraphDocument[];
  error?: string;
}
