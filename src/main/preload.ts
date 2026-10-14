import { contextBridge, ipcRenderer } from 'electron';
import type { PrismAPI } from '../shared/types';

const api: PrismAPI = {
  loadWorkspace: () => ipcRenderer.invoke('prism:load'),
  openWorkspace: () => ipcRenderer.invoke('prism:open'),
  refreshWorkspace: () => ipcRenderer.invoke('prism:refresh'),
  saveNote: (path, content, expectedModified) => ipcRenderer.invoke('prism:save', path, content, expectedModified),
  createNote: (path) => ipcRenderer.invoke('prism:create', path),
  setDirty: (dirty) => ipcRenderer.send('prism:dirty', dirty),
  openExternal: (url) => ipcRenderer.invoke('prism:external', url),
  windowControl: (action) => ipcRenderer.send('prism:window', action),
  onCloseRequested: (callback) => {
    const listener = () => callback();
    ipcRenderer.on('prism:close-requested', listener);
    return () => { ipcRenderer.removeListener('prism:close-requested', listener); };
  },
  confirmClose: () => ipcRenderer.send('prism:confirm-close'),
  platform: process.platform,
};

contextBridge.exposeInMainWorld('prism', Object.freeze(api));
