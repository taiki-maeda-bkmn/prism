import { app, BrowserWindow, dialog, ipcMain, Menu, screen, session, shell } from 'electron';
import type { IpcMainEvent, IpcMainInvokeEvent } from 'electron';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { WindowState, Workspace } from '../shared/types';
import { ensureStarterNotebook, WorkspaceStore } from './workspace';
import { isRendererResource, validateExternalURL } from './security';
import { installWslgWindowRecovery } from './window-recovery';
import { PDFLibraryService } from '../../pdf-manager/src/main/library-service';
import { resolvePDFProfileDirectory } from '../../pdf-manager/src/main/library-location';
import { registerPDFLibraryIPC } from '../../pdf-manager/src/main/library-ipc';

app.setName('Prism');
if (!app.isPackaged && process.env.PRISM_USER_DATA) app.setPath('userData', path.resolve(process.env.PRISM_USER_DATA));

const rendererPath = path.join(__dirname, 'renderer', 'index.html');
const rendererURL = pathToFileURL(rendererPath).href;
let window: BrowserWindow | null = null;
let dirty = false;
let allowClose = false;
let pendingClose = false;
let closingIntent: 'close' | 'quit' = 'close';
let workspace: WorkspaceStore | undefined;
let operations: Promise<unknown> = Promise.resolve();
// Constructing the service does not open or lock the library. The first PDF
// request uses the existing PDF profile, independently of the Notes profile.
const pdfLibrary = new PDFLibraryService(path.join(resolvePDFProfileDirectory({
  appData: app.getPath('appData'), isPackaged: app.isPackaged, override: process.env.PRISM_PDF_USER_DATA,
}), 'library'));
let quitting = false;
let quitReady = false;

function serialize<T>(operation: () => Promise<T>): Promise<T> {
  const result = operations.then(operation);
  operations = result.catch(() => undefined);
  return result;
}

function validateSender(event: IpcMainEvent | IpcMainInvokeEvent): void {
  if (quitting) throw new Error('Prism is closing. Reopen it before continuing.');
  if (!window || window.isDestroyed() || event.sender !== window.webContents
    || event.senderFrame !== window.webContents.mainFrame || event.senderFrame.url !== rendererURL) {
    throw new Error('This request did not come from the Prism window.');
  }
}

async function persistFolder(directory: string): Promise<void> {
  const userData = app.getPath('userData');
  await fs.mkdir(userData, { recursive: true });
  const target = path.join(userData, 'notebook.json');
  const temporary = path.join(userData, 'notebook.json.tmp');
  try {
    await fs.writeFile(temporary, JSON.stringify({ path: directory }), { encoding: 'utf8', mode: 0o600, flush: true });
    await fs.rename(temporary, target);
  } finally { await fs.unlink(temporary).catch(() => undefined); }
}

async function initializeWorkspace(): Promise<Workspace> {
  const warnings: string[] = [];
  let selected: string | undefined = !app.isPackaged ? process.env.PRISM_WORKSPACE : undefined;
  if (!selected) {
    try {
      const settings: unknown = JSON.parse(await fs.readFile(path.join(app.getPath('userData'), 'notebook.json'), 'utf8'));
      if (settings && typeof settings === 'object' && 'path' in settings && typeof settings.path === 'string') selected = settings.path;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') warnings.push('The previous notebook setting could not be read. Your notebook files are untouched.');
    }
  }
  if (selected) {
    try {
      const candidate = await WorkspaceStore.open(selected);
      const loaded = await candidate.load();
      workspace = candidate;
      return { ...loaded, warnings: [...warnings, ...loaded.warnings] };
    } catch { warnings.push('The previous notebook is unavailable. Open its folder to reconnect; its files have not been changed.'); }
  }
  const starter = await ensureStarterNotebook(app.getPath('userData'));
  const candidate = await WorkspaceStore.open(starter);
  const loaded = await candidate.load();
  // Filesystems without symbolic links use the complete private notebook directly.
  // Remember it before exposing editable notes, so reopening cannot choose a new one.
  if (starter !== path.join(app.getPath('userData'), 'Prism notebook')) await persistFolder(candidate.root);
  workspace = candidate;
  return { ...loaded, warnings: [...warnings, ...loaded.warnings] };
}

async function getWorkspace(): Promise<WorkspaceStore> {
  if (!workspace) await initializeWorkspace();
  if (!workspace) throw new Error('The notebook could not be opened.');
  return workspace;
}

function requestClose(intent: 'close' | 'quit'): void {
  closingIntent = intent;
  pendingClose = true;
  window?.webContents.send('prism:close-requested');
}

function windowState(): WindowState {
  return { maximized: window?.isMaximized() ?? false };
}

async function restrictRendererResources(): Promise<void> {
  const rendererRoot = await fs.realpath(path.dirname(rendererPath));
  session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
    void isRendererResource(details.url, rendererRoot, details.resourceType).then((allowed) => callback({ cancel: !allowed }));
  });
}

function registerIPC(): void {
  registerPDFLibraryIPC({ service: pdfLibrary, validateSender, getWindow: () => window });
  ipcMain.handle('prism:load', (event) => {
    validateSender(event);
    return serialize(async () => {
      return workspace ? workspace.load() : initializeWorkspace();
    });
  });
  ipcMain.handle('prism:open', (event) => {
    validateSender(event);
    return serialize(async () => {
      if (dirty) throw new Error('Save or discard your changes before opening another notebook.');
      if (!window) return null;
      const result = await dialog.showOpenDialog(window, { title: 'Open a notebook', buttonLabel: 'Open notebook', properties: ['openDirectory', 'createDirectory'] });
      if (result.canceled || !result.filePaths[0]) return null;
      const candidate = await WorkspaceStore.open(result.filePaths[0]);
      const loaded = await candidate.load();
      await persistFolder(candidate.root);
      workspace = candidate;
      return loaded;
    });
  });
  ipcMain.handle('prism:refresh', (event) => {
    validateSender(event);
    return serialize(async () => {
      if (dirty) throw new Error('Save or discard your changes before refreshing the notebook.');
      return (await getWorkspace()).load();
    });
  });
  ipcMain.handle('prism:save', (event, notePath: unknown, content: unknown, modified: unknown) => {
    validateSender(event);
    return serialize(async () => (await getWorkspace()).save(notePath, content, modified));
  });
  ipcMain.handle('prism:create', (event, notePath: unknown) => {
    validateSender(event);
    return serialize(async () => (await getWorkspace()).create(notePath));
  });
  ipcMain.handle('prism:external', async (event, value: unknown) => {
    validateSender(event);
    await shell.openExternal(validateExternalURL(value));
  });
  ipcMain.on('prism:dirty', (event, value: unknown) => {
    try { validateSender(event); if (typeof value === 'boolean') dirty = value; } catch { /* Ignore untrusted fire-and-forget messages. */ }
  });
  ipcMain.handle('prism:window-state', (event) => {
    validateSender(event);
    return windowState();
  });
  ipcMain.on('prism:window', (event, action: unknown) => {
    try {
      validateSender(event);
      if (!window) return;
      if (action === 'minimize') window.minimize();
      else if (action === 'close') window.close();
      else if (action === 'maximize') {
        if (window.isMaximized()) window.unmaximize();
        else window.maximize();
      }
    } catch { /* Ignore invalid controls. */ }
  });
  ipcMain.on('prism:confirm-close', (event) => {
    try {
      validateSender(event);
      if (!pendingClose) return;
      allowClose = true;
      dirty = false;
      pendingClose = false;
      if (closingIntent === 'quit') app.quit(); else window?.close();
    } catch { /* Ignore untrusted close confirmations. */ }
  });
}

async function createWindow(): Promise<void> {
  dirty = false;
  allowClose = false;
  pendingClose = false;
  const workArea = screen.getPrimaryDisplay().workAreaSize;
  window = new BrowserWindow({
    title: 'Prism', width: Math.min(1320, workArea.width), height: Math.min(860, workArea.height),
    icon: path.join(__dirname, 'icon.png'),
    frame: false, transparent: true, backgroundColor: '#00000000',
    // Linux window managers and macOS need resizable windows for native zoom.
    // Windows supports transparent maximize through Electron's API while
    // keeping resize handles disabled to protect its transparent surface.
    resizable: process.platform !== 'win32', maximizable: true, fullscreenable: false, show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true,
      nodeIntegration: false, sandbox: true, webSecurity: true, webviewTag: false,
      spellcheck: false, navigateOnDragDrop: false,
    },
  });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event) => event.preventDefault());
  window.webContents.on('will-frame-navigate', (event) => event.preventDefault());
  window.webContents.on('will-attach-webview', (event) => event.preventDefault());
  const publishWindowState = () => window?.webContents.send('prism:window-state', windowState());
  window.on('maximize', publishWindowState);
  window.on('unmaximize', publishWindowState);
  window.on('restore', publishWindowState);
  if (process.platform === 'linux' && process.env.WSL_DISTRO_NAME
    && app.commandLine.getSwitchValue('ozone-platform') === 'wayland') {
    installWslgWindowRecovery(window);
  }
  window.on('close', (event) => {
    if (dirty && !allowClose) { event.preventDefault(); requestClose('close'); }
  });
  window.on('closed', () => { window = null; });
  await window.loadFile(rendererPath);
  // Wayland can defer the first paint of an unmapped transparent surface, so
  // waiting for ready-to-show can leave the application permanently hidden.
  window?.show();
}

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => { if (quitting) return; if (window?.isMinimized()) window.restore(); window?.focus(); });
  app.on('before-quit', (event) => {
    if (quitReady) return;
    event.preventDefault();
    if (quitting) return;
    // A cancelled draft prompt must leave the PDF session open and usable.
    if (dirty && !allowClose && window) { requestClose('quit'); return; }
    quitting = true;
    void Promise.all([operations, pdfLibrary.close()]).then(() => {
      quitReady = true;
      app.quit();
    }).catch((error: unknown) => {
      dialog.showErrorBox('Prism could not close', error instanceof Error ? error.message : 'An unexpected error occurred.');
      app.exit(1);
    });
  });
  app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
  app.whenReady().then(async () => {
    Menu.setApplicationMenu(null);
    session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
    session.defaultSession.setPermissionCheckHandler(() => false);
    session.defaultSession.on('will-download', event => event.preventDefault());
    await restrictRendererResources();
    registerIPC();
    await createWindow();
    app.on('activate', () => { if (!quitting && !window) void createWindow(); });
  }).catch((error: unknown) => {
    dialog.showErrorBox('Prism could not start', error instanceof Error ? error.message : 'An unexpected error occurred.');
    app.exit(1);
  });
}
