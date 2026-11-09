import { contextBridge, ipcRenderer } from 'electron';
import type { PrismAPI, WindowState } from '../shared/types';
import type { VSCodeAppearanceResponse } from '../shared/vscodeAppearance';
import { createPDFAPI } from '../../pdf-manager/src/main/pdf-api';
import type { PrismResearchAPI } from '../shared/research';
import type { PrismArxivAPI } from '../shared/arxivSearch';

const api: PrismAPI = {
  loadWorkspace: () => ipcRenderer.invoke('prism:load'),
  openWorkspace: () => ipcRenderer.invoke('prism:open'),
  refreshWorkspace: () => ipcRenderer.invoke('prism:refresh'),
  saveNote: (path, content, expectedModified) => ipcRenderer.invoke('prism:save', path, content, expectedModified),
  createNote: (path) => ipcRenderer.invoke('prism:create', path),
  createFolder: (path) => ipcRenderer.invoke('prism:create-folder', path),
  importVSCodeAppearance: async (source) => {
    const response: VSCodeAppearanceResponse = await ipcRenderer.invoke('prism:import-vscode-appearance', source);
    if (!response.ok) throw new Error(response.error);
    return response.value;
  },
  setDirty: (dirty) => ipcRenderer.send('prism:dirty', dirty),
  openExternal: (url) => ipcRenderer.invoke('prism:external', url),
  windowControl: (action) => ipcRenderer.send('prism:window', action),
  setWindowTranslucency: (translucent) => ipcRenderer.send('prism:window-translucency', translucent),
  getWindowState: () => ipcRenderer.invoke('prism:window-state'),
  onWindowStateChanged: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, state: WindowState) => callback(state);
    ipcRenderer.on('prism:window-state', listener);
    return () => { ipcRenderer.removeListener('prism:window-state', listener); };
  },
  onCloseRequested: (callback) => {
    const listener = () => callback();
    ipcRenderer.on('prism:close-requested', listener);
    return () => { ipcRenderer.removeListener('prism:close-requested', listener); };
  },
  confirmClose: () => ipcRenderer.send('prism:confirm-close'),
  cancelClose: () => ipcRenderer.send('prism:cancel-close'),
  platform: process.platform,
};

contextBridge.exposeInMainWorld('prism', Object.freeze(api));
contextBridge.exposeInMainWorld('prismPdf', Object.freeze(createPDFAPI('prism:window')));
const research: PrismResearchAPI = {
  catalogue: refresh => ipcRenderer.invoke('prism-research:catalogue', refresh),
  review: identity => ipcRenderer.invoke('prism-research:review', identity),
  importPaper: request => ipcRenderer.invoke('prism-research:import', request),
};
contextBridge.exposeInMainWorld('prismResearch', Object.freeze(research));
const arxiv: PrismArxivAPI = {
  search: request => ipcRenderer.invoke('prism-arxiv:search', request),
  importPaper: id => ipcRenderer.invoke('prism-arxiv:import', id),
};
contextBridge.exposeInMainWorld('prismArxiv', Object.freeze(arxiv));
