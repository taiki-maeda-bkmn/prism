import { ipcRenderer, webUtils } from 'electron';
import type { PrismPdfAPI } from '../shared/types';
import { droppedFilePaths } from '../shared/fileImports';

/** Keep the same narrow document bridge in both desktop hosts. */
export function createPDFAPI(windowChannel: 'prism:window' | 'prism-pdf:window'): PrismPdfAPI {
  return {
    loadLibrary: () => ipcRenderer.invoke('prism-pdf:load'),
    importDocuments: folderId => ipcRenderer.invoke('prism-pdf:import', folderId),
    importDroppedDocuments: async (files, folderId) => {
      // A renderer-supplied path property or text/URI payload is never used.
      const paths = droppedFilePaths(files, file => webUtils.getPathForFile(file));
      return ipcRenderer.invoke('prism-pdf:import-dropped', paths, folderId);
    },
    createFolder: name => ipcRenderer.invoke('prism-pdf:folder-create', name),
    renameFolder: (id, name) => ipcRenderer.invoke('prism-pdf:folder-rename', id, name),
    removeFolder: id => ipcRenderer.invoke('prism-pdf:folder-remove', id),
    startURLImport: url => ipcRenderer.invoke('prism-pdf:url-start', url),
    getURLImport: () => ipcRenderer.invoke('prism-pdf:url-status'),
    cancelURLImport: id => ipcRenderer.invoke('prism-pdf:url-cancel', id),
    readDocument: id => ipcRenderer.invoke('prism-pdf:read', id),
    updateDocument: (id, patch) => ipcRenderer.invoke('prism-pdf:update', id, patch),
    openDocument: id => ipcRenderer.invoke('prism-pdf:open', id),
    revealDocument: id => ipcRenderer.invoke('prism-pdf:reveal', id),
    removeDocument: id => ipcRenderer.invoke('prism-pdf:remove', id),
    windowControl: action => ipcRenderer.send(windowChannel, action),
    setWindowTranslucency: translucent => ipcRenderer.send(`${windowChannel}-translucency`, translucent),
    platform: process.platform,
  };
}
