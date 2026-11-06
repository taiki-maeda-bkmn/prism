import { LibraryStore, type ArxivImportMetadata, type DownloadedPDFImport, type LibraryWriteIO } from './library';
import { LibraryLock } from './library-lock';

interface OpenLibrary { store: LibraryStore; lock: LibraryLock }

/** Shared lifecycle for both desktop entry points; the underlying store stays private. */
export class PDFLibraryService {
  private opening: Promise<OpenLibrary> | undefined;
  private readonly pending = new Set<Promise<unknown>>();
  private closing: Promise<void> | undefined;

  constructor(private readonly directory: string, private readonly writeIO: Partial<LibraryWriteIO> = {}) {}

  private getLibrary(): Promise<OpenLibrary> {
    if (!this.opening) {
      this.opening = (async () => {
        const lock = await LibraryLock.acquire(this.directory);
        try {
          const store = await LibraryStore.open(lock.root, this.writeIO, () => lock.assertOwned());
          return { store, lock };
        } catch (error) {
          lock.release();
          throw error;
        }
      })().catch(error => {
        this.opening = undefined;
        throw error;
      });
    }
    return this.opening;
  }

  private run<T>(operation: (store: LibraryStore) => Promise<T>): Promise<T> {
    if (this.closing) return Promise.reject(new Error('The PDF library is closing. Reopen the app before continuing.'));
    const result = this.getLibrary().then(({ store }) => operation(store));
    this.pending.add(result);
    const finished = () => { this.pending.delete(result); };
    void result.then(finished, finished);
    return result;
  }

  load() { return this.run(store => store.load()); }
  createFolder(name: unknown) { return this.run(store => store.createFolder(name)); }
  renameFolder(id: unknown, name: unknown) { return this.run(store => store.renameFolder(id, name)); }
  removeFolder(id: unknown) { return this.run(store => store.removeFolder(id)); }
  import(paths: readonly string[], folderId?: unknown) { return this.run(store => store.import(paths, folderId)); }
  importDownloaded(input: DownloadedPDFImport) { return this.run(store => store.importDownloaded(input)); }
  importArxiv(input: ArxivImportMetadata, download: () => Promise<Uint8Array>) {
    return this.run(store => store.importArxiv(input, download));
  }
  read(id: unknown) { return this.run(store => store.read(id)); }
  update(id: unknown, patch: unknown) { return this.run(store => store.update(id, patch)); }
  remove(id: unknown) { return this.run(store => store.remove(id)); }
  withDocumentPath(id: unknown, action: (filename: string) => Promise<void> | void): Promise<void> {
    return this.run(store => store.withDocumentPath(id, action));
  }

  close(): Promise<void> {
    if (!this.closing) {
      this.closing = (async () => {
        // Calls admitted before close retain ownership until their filesystem and
        // shell operations settle. New calls are refused, including during open.
        await Promise.allSettled([...this.pending]);
        const opened = await this.opening?.catch(() => undefined);
        opened?.lock.release();
      })();
    }
    return this.closing;
  }
}
