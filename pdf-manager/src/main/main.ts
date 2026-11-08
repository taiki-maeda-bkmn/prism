import { app, BrowserWindow, dialog, ipcMain, Menu, screen, session } from 'electron';
import type { IpcMainEvent, IpcMainInvokeEvent, Rectangle } from 'electron';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { PDFLibraryService } from './library-service';
import { registerPDFLibraryIPC } from './library-ipc';
import { PDFURLImportManager } from './pdf-url-import';
import { resolvePDFProfileDirectory } from './library-location';
import { installWindowTranslucency, translucentOpacity } from '../../../src/main/window-translucency';

app.setName('Prism PDF');
app.setPath('userData', resolvePDFProfileDirectory({
  appData: app.getPath('appData'), isPackaged: app.isPackaged, override: process.env.PRISM_PDF_USER_DATA,
}));

const rendererPath = path.join(__dirname, 'renderer', 'index.html');
const rendererURL = pathToFileURL(rendererPath).href;
let window: BrowserWindow | null = null;
let windowTranslucency: ReturnType<typeof installWindowTranslucency> | undefined;
let restoreBounds: Rectangle | null = null;
const library = new PDFLibraryService(path.join(app.getPath('userData'), 'library'));
const pdfURLImports = new PDFURLImportManager(library);
let quitting = false;
let quitReady = false;
let openingWindow: Promise<void> | undefined;

function validateSender(event: IpcMainEvent | IpcMainInvokeEvent): void {
  if (quitting) throw new Error('Prism PDF is closing. Reopen it before continuing.');
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
  registerPDFLibraryIPC({ service: library, urlImports: pdfURLImports, validateSender, getWindow: () => window });
  ipcMain.on('prism-pdf:window-translucency', (event, value: unknown) => {
    try { validateSender(event); windowTranslucency?.setTranslucent(value); }
    catch { /* Ignore invalid appearance messages. */ }
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
    icon: path.join(__dirname, 'icon.png'),
    transparent: true, backgroundColor: '#00000000', frame: false, show: false,
    // Preserve background playback until the renderer supplies its appearance.
    ...(process.platform === 'win32' ? { opacity: translucentOpacity } : {}),
    // Native resizing/maximizing is unreliable for Electron's transparent windows.
    resizable: false, maximizable: false, fullscreenable: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true,
      nodeIntegration: false, sandbox: true, webSecurity: true, webviewTag: false,
      spellcheck: false, navigateOnDragDrop: false,
    },
  });
  const nativeWindow = window;
  windowTranslucency = installWindowTranslucency(nativeWindow);
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', event => event.preventDefault());
  window.webContents.on('will-frame-navigate', event => event.preventDefault());
  window.webContents.on('will-attach-webview', event => event.preventDefault());
  window.webContents.on('render-process-gone', () => { void pdfURLImports.cancelActive(); });
  window.on('closed', () => {
    void pdfURLImports.cancelActive();
    if (window === nativeWindow) { window = null; windowTranslucency = undefined; }
  });
  try { await nativeWindow.loadFile(rendererPath); }
  catch (error) { if (quitting || nativeWindow.isDestroyed()) return; throw error; }
  // Unmapped transparent Wayland windows may never emit ready-to-show.
  if (!quitting && !nativeWindow.isDestroyed()) {
    nativeWindow.show();
    if (/^[a-f0-9]{32,64}$/.test(process.env.PRISM_STARTUP_TOKEN ?? '')) console.log(`\nPRISM_READY:${process.env.PRISM_STARTUP_TOKEN}`);
  }
}

async function showOrCreateWindow(): Promise<void> {
  if (quitting) return;
  if (!window || window.isDestroyed()) openingWindow ??= createWindow().finally(() => { openingWindow = undefined; });
  await openingWindow;
  if (quitting || !window || window.isDestroyed()) return;
  if (window.isMinimized()) window.restore();
  window.show();
  window.focus();
}

function handleStartupError(error: unknown): void {
  if (quitting) return;
  dialog.showErrorBox('Prism PDF could not start', error instanceof Error ? error.message : 'An unexpected error occurred.');
  app.exit(1);
}

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('before-quit', event => {
    if (quitReady) return;
    event.preventDefault();
    if (quitting) return;
    quitting = true;
    window?.setEnabled(false);
    void pdfURLImports.close().then(() => library.close()).then(() => {
      quitReady = true;
      session.defaultSession.flushStorageData();
      setTimeout(() => app.exit(0), 2000).unref();
      app.quit();
    }).catch(error => { console.error('Prism PDF could not close:', error); app.exit(1); });
  });
  app.on('window-all-closed', () => app.quit());
  const startup = app.whenReady().then(async () => {
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
    await showOrCreateWindow();
  });
  const showWindow = () => { void startup.then(showOrCreateWindow).catch(handleStartupError); };
  app.on('second-instance', showWindow);
  app.on('activate', showWindow);
  void startup.catch(handleStartupError);
}
