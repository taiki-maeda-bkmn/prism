import { app, BrowserWindow, dialog, ipcMain, Menu, screen, session, shell } from 'electron';
import type { IpcMainEvent, IpcMainInvokeEvent, Rectangle } from 'electron';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { LibraryStore } from './library';

app.setName('Prism PDF');
app.setPath('userData', !app.isPackaged && process.env.PRISM_PDF_USER_DATA
  ? path.resolve(process.env.PRISM_PDF_USER_DATA)
  : path.join(app.getPath('appData'), 'prism-pdf'));

const rendererPath = path.join(__dirname, 'renderer', 'index.html');
const rendererURL = pathToFileURL(rendererPath).href;
let window: BrowserWindow | null = null;
let restoreBounds: Rectangle | null = null;
let library: Promise<LibraryStore> | undefined;
let importing = false;

function getLibrary(): Promise<LibraryStore> {
  if (!library) {
    library = LibraryStore.open(path.join(app.getPath('userData'), 'library')).catch(error => {
      library = undefined;
      throw error;
    });
  }
  return library;
}

function validateSender(event: IpcMainEvent | IpcMainInvokeEvent): void {
  if (!window || window.isDestroyed() || event.sender !== window.webContents
    || event.senderFrame !== window.webContents.mainFrame || event.senderFrame.url !== rendererURL) {
    throw new Error('This request did not come from the Prism PDF window.');
  }
}

async function allowedResource(value: string, root: string, resourceType: string): Promise<boolean> {
  try {
    const url = new URL(value);
    // PDF.js wraps its bundled worker in a blob module on the opaque file origin.
    // Decoded document fonts and images stay in memory; neither needs network access.
    if (url.protocol === 'blob:') return resourceType === 'script' || resourceType === 'other';
    if (url.protocol === 'data:') return resourceType === 'font' || resourceType === 'image';
    if (url.protocol !== 'file:' || (url.hostname && url.hostname !== 'localhost')) return false;
    const filename = await fs.realpath(fileURLToPath(url));
    const relative = path.relative(root, filename);
    return !!relative && relative !== '..' && !relative.startsWith('..' + path.sep)
      && !path.isAbsolute(relative) && (await fs.stat(filename)).isFile();
  } catch { return false; }
}

function registerIPC(): void {
  ipcMain.handle('prism-pdf:load', async event => {
    validateSender(event);
    return (await getLibrary()).load();
  });
  ipcMain.handle('prism-pdf:import', async event => {
    validateSender(event);
    if (importing) throw new Error('Finish the current import before starting another.');
    importing = true;
    try {
      const store = await getLibrary();
      if (!window) throw new Error('The Prism PDF window is unavailable.');
      const result = await dialog.showOpenDialog(window, {
        title: 'Add PDFs to your library', buttonLabel: 'Import PDFs',
        properties: ['openFile', 'multiSelections'], filters: [{ name: 'PDF documents', extensions: ['pdf'] }],
      });
      return await store.import(result.canceled ? [] : result.filePaths);
    } finally { importing = false; }
  });
  ipcMain.handle('prism-pdf:read', async (event, id: unknown) => {
    validateSender(event);
    return (await getLibrary()).read(id);
  });
  ipcMain.handle('prism-pdf:update', async (event, id: unknown, patch: unknown) => {
    validateSender(event);
    return (await getLibrary()).update(id, patch);
  });
  ipcMain.handle('prism-pdf:open', async (event, id: unknown) => {
    validateSender(event);
    await (await getLibrary()).withDocumentPath(id, async filename => {
      const error = await shell.openPath(filename);
      if (error) throw new Error('The PDF could not be opened: ' + error);
    });
  });
  ipcMain.handle('prism-pdf:reveal', async (event, id: unknown) => {
    validateSender(event);
    await (await getLibrary()).withDocumentPath(id, filename => shell.showItemInFolder(filename));
  });
  ipcMain.handle('prism-pdf:remove', async (event, id: unknown) => {
    validateSender(event);
    return (await getLibrary()).remove(id);
  });
  ipcMain.on('prism-pdf:window', (event, action: unknown) => {
    try {
      validateSender(event);
      if (!window) return;
      if (action === 'minimize') window.minimize();
      else if (action === 'maximize') {
        if (restoreBounds) { window.setBounds(restoreBounds); restoreBounds = null; }
        else { restoreBounds = window.getBounds(); window.setBounds(screen.getDisplayMatching(restoreBounds).workArea); }
      }
      else if (action === 'close') window.close();
    } catch { /* Ignore untrusted controls. */ }
  });
}

async function createWindow(): Promise<void> {
  restoreBounds = null;
  const workArea = screen.getPrimaryDisplay().workAreaSize;
  window = new BrowserWindow({
    title: 'Prism PDF', width: Math.min(1380, workArea.width), height: Math.min(900, workArea.height),
    transparent: true, backgroundColor: '#00000000', frame: false, show: false,
    // Native resizing/maximizing is unreliable for Electron's transparent windows.
    resizable: false, maximizable: false, fullscreenable: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true,
      nodeIntegration: false, sandbox: true, webSecurity: true, webviewTag: false,
      spellcheck: false, navigateOnDragDrop: false,
    },
  });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', event => event.preventDefault());
  window.webContents.on('will-frame-navigate', event => event.preventDefault());
  window.webContents.on('will-attach-webview', event => event.preventDefault());
  window.on('closed', () => { window = null; });
  window.once('ready-to-show', () => window?.show());
  await window.loadFile(rendererPath);
}

async function showOrCreateWindow(): Promise<void> {
  if (!window) { await createWindow(); return; }
  if (window.isMinimized()) window.restore();
  window.show();
  window.focus();
}

function handleStartupError(error: unknown): void {
  dialog.showErrorBox('Prism PDF could not start', error instanceof Error ? error.message : 'An unexpected error occurred.');
  app.exit(1);
}

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
  app.whenReady().then(async () => {
    Menu.setApplicationMenu(process.platform === 'darwin'
      ? Menu.buildFromTemplate([{ role: 'appMenu' }, { role: 'fileMenu' }, { role: 'editMenu' }])
      : null);
    session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    session.defaultSession.setPermissionCheckHandler(() => false);
    session.defaultSession.on('will-download', event => event.preventDefault());
    const rendererRoot = await fs.realpath(path.dirname(rendererPath));
    session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
      void allowedResource(details.url, rendererRoot, details.resourceType).then(allowed => callback({ cancel: !allowed }));
    });
    registerIPC();
    await createWindow();
    const showWindow = () => { void showOrCreateWindow().catch(handleStartupError); };
    app.on('second-instance', showWindow);
    app.on('activate', showWindow);
  }).catch(handleStartupError);
}
