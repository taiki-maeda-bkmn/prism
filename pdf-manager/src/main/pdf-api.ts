import { ipcRenderer } from 'electron';
import type { PrismPdfAPI } from '../shared/types';

/** Keep the same narrow document bridge in both desktop hosts. */
export function createPDFAPI(windowChannel: 'prism:window' | 'prism-pdf:window'): PrismPdfAPI {
  return {
    loadLibrary: () => ipcRenderer.invoke('prism-pdf:load'),
    importDocuments: () => ipcRenderer.invoke('prism-pdf:import'),
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
    platform: process.platform,
  };
}
