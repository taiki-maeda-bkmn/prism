import { useEffect, useState, useSyncExternalStore } from 'react';
import type { PDFGraphCatalog, PDFGraphDocument } from '../shared/pdfGraph';

type LoadCatalog = () => Promise<{ documents: readonly PDFGraphDocument[] }>;

function graphDocuments(documents: readonly PDFGraphDocument[]): readonly PDFGraphDocument[] {
  return documents.map(({ id, title }) => ({ id, title }))
    .sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

function sameDocuments(a: readonly PDFGraphDocument[], b: readonly PDFGraphDocument[]): boolean {
  return a.length === b.length && a.every((document, index) => document.id === b[index].id && document.title === b[index].title);
}

/** The graph observes catalogue metadata without importing or mounting the reader. */
export class PDFGraphCatalogController {
  private snapshot: PDFGraphCatalog = { status: 'idle', documents: [] };
  private listeners = new Set<() => void>();
  private active = false;
  private revision = 0;
  private pending: number | null = null;

  constructor(private readonly load: LoadCatalog) {}

  getSnapshot = (): PDFGraphCatalog => this.snapshot;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  activate(): void { this.active = true; }

  deactivate(): void {
    this.active = false;
    this.revision++;
    this.pending = null;
    // A development effect remount can restart an interrupted load. Successful
    // snapshots survive ordinary graph visibility changes and effect remounts.
    if (this.snapshot.status === 'loading') this.snapshot = { status: 'idle', documents: this.snapshot.documents };
  }

  ensureLoaded = (): void => {
    if (this.snapshot.status === 'idle') this.refresh();
  };

  refresh = (): void => {
    if (!this.active || this.pending !== null) return;
    const request = ++this.revision;
    this.pending = request;
    this.publish({ status: 'loading', documents: this.snapshot.documents });
    void (async () => {
      try {
        const result = await this.load();
        if (!this.active || request !== this.revision) return;
        this.publish({ status: 'ready', documents: graphDocuments(result.documents) });
      } catch (failure) {
        if (!this.active || request !== this.revision) return;
        const error = failure instanceof Error
          ? failure.message.replace(/^Error invoking remote method '[^']+': Error: /, '')
          : 'The PDF library could not be opened. Please try again.';
        this.publish({ status: 'error', documents: this.snapshot.documents, error });
      } finally {
        if (this.pending === request) this.pending = null;
      }
    })();
  };

  updateDocuments = (documents: readonly PDFGraphDocument[]): void => {
    if (!this.active) return;
    // An in-app library publication is newer than any outstanding graph load,
    // including a publication with unchanged titles after a reading-position save.
    this.revision++;
    const projected = graphDocuments(documents);
    if (this.snapshot.status === 'ready' && sameDocuments(this.snapshot.documents, projected)) return;
    this.publish({ status: 'ready', documents: projected });
  };

  private publish(snapshot: PDFGraphCatalog): void {
    this.snapshot = snapshot;
    for (const listener of this.listeners) listener();
  }
}

export function usePDFGraphCatalog(enabled: boolean) {
  const [controller] = useState(() => new PDFGraphCatalogController(() => window.prismPdf.loadLibrary()));
  const catalog = useSyncExternalStore(controller.subscribe, controller.getSnapshot);

  useEffect(() => {
    controller.activate();
    return () => controller.deactivate();
  }, [controller]);
  useEffect(() => {
    if (enabled) controller.ensureLoaded();
  }, [controller, enabled, catalog.status]);

  return { catalog, refresh: controller.refresh, updateDocuments: controller.updateDocuments };
}
