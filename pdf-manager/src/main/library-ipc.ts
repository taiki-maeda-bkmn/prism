import { clipboard, dialog, ipcMain, shell } from 'electron';
import type { BrowserWindow, IpcMainInvokeEvent } from 'electron';
import type { ImportResult, LibrarySnapshot, PDFDocument } from '../shared/types';
import type { PDFURLImportManager } from './pdf-url-import';
import { validateImportPaths } from './file-imports';
import { validateExternalURL } from '../../../src/main/security';

/** Storage operations only; application and window lifecycle belong to the host. */
export interface PDFLibraryOperations {
  load(): Promise<LibrarySnapshot>;
  import(paths: readonly string[], folderId?: unknown): Promise<ImportResult>;
  createFolder(name: unknown): Promise<LibrarySnapshot>;
  renameFolder(id: unknown, name: unknown): Promise<LibrarySnapshot>;
  removeFolder(id: unknown): Promise<LibrarySnapshot>;
  read(id: unknown): Promise<Uint8Array>;
  update(id: unknown, patch: unknown): Promise<PDFDocument>;
  withDocumentPath(id: unknown, action: (filename: string) => Promise<void> | void): Promise<void>;
  remove(id: unknown): Promise<LibrarySnapshot>;
}

interface PDFLibraryIPCOptions {
  service: PDFLibraryOperations;
  urlImports: PDFURLImportManager;
  validateSender(event: IpcMainInvokeEvent): void;
  getWindow(): BrowserWindow | null;
}

/** Register once per application; the standalone and integrated shells share this boundary. */
export function registerPDFLibraryIPC({ service, urlImports, validateSender, getWindow }: PDFLibraryIPCOptions): void {
  let importing = false;

  ipcMain.handle('prism-pdf:external', async (event, url: unknown) => {
    validateSender(event);
    await shell.openExternal(validateExternalURL(url));
  });
  ipcMain.handle('prism-pdf:copy-text', (event, text: unknown) => {
    validateSender(event);
    if (typeof text !== 'string' || text.length > 2_000_000) throw new Error('Select a smaller amount of PDF text to copy.');
    return clipboard.writeText(text);
  });

  ipcMain.handle('prism-pdf:url-start', (event, url: unknown) => {
    validateSender(event);
    return urlImports.start(url);
  });
  ipcMain.handle('prism-pdf:url-status', event => {
    validateSender(event);
    return urlImports.get();
  });
  ipcMain.handle('prism-pdf:url-cancel', async (event, id: unknown) => {
    validateSender(event);
    const result = urlImports.cancel(id);
    // A cancellation response means another import can start immediately.
    if (result.phase === 'cancelled') await urlImports.cancelActive();
    return result;
  });

  ipcMain.handle('prism-pdf:load', async event => {
    validateSender(event);
    return service.load();
  });
  ipcMain.handle('prism-pdf:folder-create', (event, name: unknown) => {
    validateSender(event);
    return service.createFolder(name);
  });
  ipcMain.handle('prism-pdf:folder-rename', (event, id: unknown, name: unknown) => {
    validateSender(event);
    return service.renameFolder(id, name);
  });
  ipcMain.handle('prism-pdf:folder-remove', (event, id: unknown) => {
    validateSender(event);
    return service.removeFolder(id);
  });
  ipcMain.handle('prism-pdf:import', async (event, folderId: unknown) => {
    validateSender(event);
    if (importing) throw new Error('Finish the current import before starting another.');
    importing = true;
    try {
      // Report a locked or damaged library before asking the user to select files.
      await service.load();
      validateSender(event);
      const window = getWindow();
      if (!window || window.isDestroyed()) throw new Error('The Prism PDF window is unavailable.');
      const result = await dialog.showOpenDialog(window, {
        title: 'Add PDFs to your library', buttonLabel: 'Import PDFs',
        properties: ['openFile', 'multiSelections'], filters: [{ name: 'PDF documents', extensions: ['pdf'] }],
      });
      return await service.import(result.canceled ? [] : result.filePaths, folderId);
    } finally { importing = false; }
  });
  ipcMain.handle('prism-pdf:import-dropped', async (event, paths: unknown, folderId: unknown) => {
    validateSender(event);
    if (importing) throw new Error('Finish the current import before starting another.');
    validateImportPaths(paths);
    importing = true;
    try { return await service.import(paths, folderId); }
    finally { importing = false; }
  });
  ipcMain.handle('prism-pdf:read', async (event, id: unknown) => {
    validateSender(event);
    return service.read(id);
  });
  ipcMain.handle('prism-pdf:update', async (event, id: unknown, patch: unknown) => {
    validateSender(event);
    return service.update(id, patch);
  });
  ipcMain.handle('prism-pdf:open', async (event, id: unknown) => {
    validateSender(event);
    await service.withDocumentPath(id, async filename => {
      const error = await shell.openPath(filename);
      if (error) throw new Error('The PDF could not be opened: ' + error);
    });
  });
  ipcMain.handle('prism-pdf:reveal', async (event, id: unknown) => {
    validateSender(event);
    await service.withDocumentPath(id, filename => shell.showItemInFolder(filename));
  });
  ipcMain.handle('prism-pdf:remove', async (event, id: unknown) => {
    validateSender(event);
    return service.remove(id);
  });
}
