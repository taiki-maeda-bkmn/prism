import { contextBridge, ipcRenderer } from 'electron';
import type { PrismPdfAPI } from '../shared/types';

const api: PrismPdfAPI = {
  loadLibrary: () => ipcRenderer.invoke('prism-pdf:load'),
  importDocuments: () => ipcRenderer.invoke('prism-pdf:import'),
  readDocument: (id) => ipcRenderer.invoke('prism-pdf:read', id),
  updateDocument: (id, patch) => ipcRenderer.invoke('prism-pdf:update', id, patch),
  openDocument: (id) => ipcRenderer.invoke('prism-pdf:open', id),
  revealDocument: (id) => ipcRenderer.invoke('prism-pdf:reveal', id),
  removeDocument: (id) => ipcRenderer.invoke('prism-pdf:remove', id),
  windowControl: (action) => ipcRenderer.send('prism-pdf:window', action),
  platform: process.platform,
};

contextBridge.exposeInMainWorld('prismPdf', Object.freeze(api));
