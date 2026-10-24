import { ipcRenderer } from 'electron';
import type { PrismPdfAPI } from '../shared/types';

/** Keep the same narrow document bridge in both desktop hosts. */
export function createPDFAPI(windowChannel: 'prism:window' | 'prism-pdf:window'): PrismPdfAPI {
  return {
    loadLibrary: () => ipcRenderer.invoke('prism-pdf:load'),
    importDocuments: () => ipcRenderer.invoke('prism-pdf:import'),
    readDocument: id => ipcRenderer.invoke('prism-pdf:read', id),
    updateDocument: (id, patch) => ipcRenderer.invoke('prism-pdf:update', id, patch),
    openDocument: id => ipcRenderer.invoke('prism-pdf:open', id),
    revealDocument: id => ipcRenderer.invoke('prism-pdf:reveal', id),
    removeDocument: id => ipcRenderer.invoke('prism-pdf:remove', id),
    windowControl: action => ipcRenderer.send(windowChannel, action),
    platform: process.platform,
  };
}
