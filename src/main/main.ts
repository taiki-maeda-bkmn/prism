import { app, BrowserWindow, dialog, ipcMain, Menu, nativeTheme, screen, session, shell } from 'electron';
import type { IpcMainEvent, IpcMainInvokeEvent } from 'electron';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { WindowState, Workspace } from '../shared/types';
import type { VSCodeAppearanceResponse } from '../shared/vscodeAppearance';
import { ensureStarterNotebook, WorkspaceStore } from './workspace';
import { isRendererResource, validateExternalURL } from './security';
import { installWslgWindowRecovery } from './window-recovery';
import { loadWindowPlacement, trackWindowPlacement } from './window-placement';
import { installWindowTranslucency, translucentOpacity } from './window-translucency';
import { PDFLibraryService } from '../../pdf-manager/src/main/library-service';
import { resolvePDFProfileDirectory } from '../../pdf-manager/src/main/library-location';
import { registerPDFLibraryIPC } from '../../pdf-manager/src/main/library-ipc';
import { PDFURLImportManager } from '../../pdf-manager/src/main/pdf-url-import';
import { ResearchClient } from './research-client';
import { ResearchImporter } from './research-import';
import { ArxivClient } from './arxiv-client';
import { ArxivImporter } from './arxiv-import';
import { loadVSCodeAppearance } from './vscode-discovery';
import { mapVSCodeColors, readVSCodeTheme } from './vscode-theme';

app.setName('Prism');
if (!app.isPackaged && process.env.PRISM_USER_DATA) app.setPath('userData', path.resolve(process.env.PRISM_USER_DATA));

const rendererPath = path.join(__dirname, 'renderer', 'index.html');
const rendererURL = pathToFileURL(rendererPath).href;
let window: BrowserWindow | null = null;
let windowTranslucency: ReturnType<typeof installWindowTranslucency> | undefined;
let dirty = false;
let allowClose = false;
let pendingClose = false;
let closingIntent: 'close' | 'quit' = 'close';
let rendererUnavailable = false;
let nativeClosePrompt = false;
let openingWindow: Promise<void> | undefined;
let workspace: WorkspaceStore | undefined;
let operations: Promise<unknown> = Promise.resolve();
// Constructing the service does not open or lock the library. The first PDF
// request uses the existing PDF profile, independently of the Notes profile.
const pdfLibrary = new PDFLibraryService(path.join(resolvePDFProfileDirectory({
  appData: app.getPath('appData'), isPackaged: app.isPackaged, override: process.env.PRISM_PDF_USER_DATA,
}), 'library'));
const pdfURLImports = new PDFURLImportManager(pdfLibrary);
const researchClient = new ResearchClient();
const researchImporter = new ResearchImporter(researchClient, pdfLibrary, getWorkspace);
const arxivClient = new ArxivClient();
const arxivImporter = new ArxivImporter(arxivClient, researchClient, pdfLibrary);
let quitting = false;
let quitReady = false;
let appearanceImportPending = false;

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
  if (rendererUnavailable) { showUnavailableClosePrompt(); return; }
  window?.webContents.send('prism:close-requested');
}

function showUnavailableClosePrompt(): void {
  const target = window;
  if (!target || target.isDestroyed() || nativeClosePrompt || quitting) return;
  nativeClosePrompt = true;
  void dialog.showMessageBox(target, {
    type: 'warning', buttons: ['Keep open', 'Close Prism'], defaultId: 0, cancelId: 0, noLink: true,
    message: 'The editor is not responding.',
    detail: 'Unsaved changes cannot be saved right now. Keep Prism open to wait, or close it and discard those changes. Saved files will be kept.',
  }).then(({ response }) => {
    if (window !== target || target.isDestroyed() || quitting) return;
    pendingClose = false;
    if (response === 1) { allowClose = true; dirty = false; app.quit(); }
  }).catch(error => { console.error('Prism close confirmation failed:', error); })
    .finally(() => { nativeClosePrompt = false; });
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
  registerPDFLibraryIPC({ service: pdfLibrary, urlImports: pdfURLImports, validateSender, getWindow: () => window });
  ipcMain.handle('prism-arxiv:search', (event, request: unknown) => {
    validateSender(event);
    return arxivClient.search(request);
  });
  ipcMain.handle('prism-arxiv:import', (event, id: unknown) => {
    validateSender(event);
    return serialize(() => arxivImporter.import(id));
  });
  ipcMain.handle('prism-research:catalogue', (event, refresh: unknown) => {
    validateSender(event);
    if (refresh !== undefined && typeof refresh !== 'boolean') throw new Error('Invalid catalogue refresh request.');
    return researchClient.catalogue(refresh === true);
  });
  ipcMain.handle('prism-research:review', (event, identity: unknown) => {
    validateSender(event);
    return researchClient.review(identity);
  });
  ipcMain.handle('prism-research:import', (event, request: unknown) => {
    validateSender(event);
    return serialize(() => researchImporter.import(request));
  });
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
  ipcMain.handle('prism:create-folder', (event, folderPath: unknown) => {
    validateSender(event);
    return serialize(async () => (await getWorkspace()).createFolder(folderPath));
  });
  ipcMain.handle('prism:import-vscode-appearance', async (event, source: unknown): Promise<VSCodeAppearanceResponse> => {
    validateSender(event);
    if (source !== 'installed' && source !== 'file') throw new Error('Choose VS Code or a theme file.');
    if (appearanceImportPending) throw new Error('A theme import is already open.');
    appearanceImportPending = true;
    try {
      // Join the shutdown drain so a normal quit also removes any private
      // cache snapshot before the process exits.
      if (source === 'installed') return { ok: true, value: await serialize(() => loadVSCodeAppearance({
        home: app.getPath('home'), appData: app.getPath('appData'), platform: process.platform, env: process.env,
        dark: nativeTheme.shouldUseDarkColors, highContrast: nativeTheme.shouldUseHighContrastColors,
      })) };
      const picked = await dialog.showOpenDialog(window!, {
        title: 'Import a VS Code color theme', buttonLabel: 'Preview colors',
        properties: ['openFile'], filters: [{ name: 'VS Code color theme', extensions: ['json', 'jsonc'] }],
      });
      if (picked.canceled || !picked.filePaths[0]) return { ok: true, value: null };
      validateSender(event);
      const file = picked.filePaths[0];
      const theme = await readVSCodeTheme(file);
      const mapped = mapVSCodeColors(theme.colors);
      if (!Object.keys(mapped.colors).length) throw new Error('This file has no supported page, text, or accent colors. In VS Code, run “Developer: Generate Color Theme From Current Settings”, save it as JSON, and choose that file.');
      return { ok: true, value: { name: theme.name, source: `Theme file: ${path.basename(file)}`, ...mapped } };
    } catch (error) {
      // Expected import failures are user-facing results. Returning their text
      // avoids Electron adding its internal IPC/channel prefix to the dialog.
      return { ok: false, error: error instanceof Error ? error.message : 'The VS Code theme could not be read. Try choosing a theme JSON file.' };
    } finally { appearanceImportPending = false; }
  });
  ipcMain.handle('prism:external', async (event, value: unknown) => {
    validateSender(event);
    await shell.openExternal(validateExternalURL(value));
  });
  ipcMain.on('prism:dirty', (event, value: unknown) => {
    try { validateSender(event); if (typeof value === 'boolean') dirty = value; } catch { /* Ignore untrusted fire-and-forget messages. */ }
  });
  ipcMain.on('prism:window-translucency', (event, value: unknown) => {
    try { validateSender(event); windowTranslucency?.setTranslucent(value); }
    catch { /* Ignore invalid appearance messages. */ }
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
  ipcMain.on('prism:cancel-close', event => {
    try { validateSender(event); pendingClose = false; }
    catch { /* Ignore untrusted close cancellations. */ }
  });
}

async function createWindow(): Promise<void> {
  dirty = false;
  allowClose = false;
  pendingClose = false;
  rendererUnavailable = false;
  const workArea = screen.getPrimaryDisplay().workArea;
  const width = Math.min(1320, workArea.width);
  const height = Math.min(860, workArea.height);
  const placementFile = path.join(app.getPath('userData'), 'window-placement.json');
  const placement = loadWindowPlacement(placementFile, screen.getAllDisplays(), {
    x: workArea.x + Math.round((workArea.width - width) / 2),
    y: workArea.y + Math.round((workArea.height - height) / 2), width, height,
  });
  window = new BrowserWindow({
    title: 'Prism', ...placement.bounds,
    icon: path.join(__dirname, 'icon.png'),
    frame: false, transparent: true, backgroundColor: '#00000000',
    // Do not briefly hide background video before saved appearance arrives.
    // The renderer restores native opacity 1 when its background is opaque.
    ...(process.platform === 'win32' ? { opacity: translucentOpacity } : {}),
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
  const nativeWindow = window;
  windowTranslucency = installWindowTranslucency(nativeWindow);
  // Initial mapping must not replace a saved maximized state. Track after the
  // initial show/restore, respecting window controls used during startup.
  let placementTracker: ReturnType<typeof trackWindowPlacement> | undefined;
  let startupStateChanged = false;
  let startupMaximized = placement.maximized;
  const maximizedDuringStartup = () => { startupStateChanged = true; startupMaximized = true; };
  const restoredDuringStartup = () => { startupStateChanged = true; startupMaximized = false; };
  nativeWindow.on('maximize', maximizedDuringStartup);
  nativeWindow.on('unmaximize', restoredDuringStartup);
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event) => event.preventDefault());
  window.webContents.on('will-frame-navigate', (event) => event.preventDefault());
  window.webContents.on('will-attach-webview', (event) => event.preventDefault());
  const unavailable = () => {
    rendererUnavailable = true;
    if (pendingClose) showUnavailableClosePrompt();
  };
  window.webContents.on('render-process-gone', () => { unavailable(); void pdfURLImports.cancelActive(); });
  window.on('unresponsive', unavailable);
  window.on('responsive', () => { rendererUnavailable = false; });
  window.webContents.on('did-finish-load', () => { rendererUnavailable = false; });
  const publishWindowState = () => window?.webContents.send('prism:window-state', windowState());
  window.on('maximize', publishWindowState);
  window.on('unmaximize', publishWindowState);
  window.on('restore', publishWindowState);
  const wslgWayland = process.platform === 'linux' && process.env.WSL_DISTRO_NAME
    && app.commandLine.getSwitchValue('ozone-platform') === 'wayland';
  // Leave native Wayland placement to its compositor. Moving only WSLg's
  // Windows HWND desynchronizes its visible surface from pointer routing.
  // Preserve normal size/maximized state through Electron's own window API.
  if (wslgWayland) {
    installWslgWindowRecovery(window);
  }
  let windowClosing = false;
  window.on('close', (event) => {
    if (dirty && !allowClose) { event.preventDefault(); requestClose('close'); return; }
    windowClosing = true;
    placementTracker?.flush();
  });
  window.on('closed', () => {
    // A cancelled dirty-note prompt never reaches this point. Accepted closes
    // stop downloads, while an already-started atomic save is allowed to finish.
    void pdfURLImports.cancelActive();
    placementTracker?.dispose();
    if (window === nativeWindow) { window = null; windowTranslucency = undefined; }
  });
  try { await nativeWindow.loadFile(rendererPath); }
  catch (error) { if (quitting || nativeWindow.isDestroyed()) return; throw error; }
  if (quitting || nativeWindow.isDestroyed()) return;
  // Wayland can defer the first paint of an unmapped transparent surface, so
  // waiting for ready-to-show can leave the application permanently hidden.
  if (!nativeWindow.isDestroyed()) nativeWindow.show();
  if (!nativeWindow.isDestroyed() && /^[a-f0-9]{32,64}$/.test(process.env.PRISM_STARTUP_TOKEN ?? '')) {
    console.log(`\nPRISM_READY:${process.env.PRISM_STARTUP_TOKEN}`);
  }
  if (!nativeWindow.isDestroyed()) {
    nativeWindow.setTitle('Prism');
    nativeWindow.removeListener('maximize', maximizedDuringStartup);
    nativeWindow.removeListener('unmaximize', restoredDuringStartup);
    if (!windowClosing) {
      if (placement.maximized && !startupStateChanged && !nativeWindow.isMinimized()) nativeWindow.maximize();
      placementTracker = trackWindowPlacement(nativeWindow, placementFile, () => screen.getAllDisplays(), {
        bounds: placement.bounds, maximized: startupMaximized,
      });
    }
  }
}

async function showOrCreateWindow(): Promise<void> {
  if (quitting) return;
  if (!window || window.isDestroyed()) {
    openingWindow ??= createWindow().finally(() => { openingWindow = undefined; });
  }
  await openingWindow;
  if (quitting || !window || window.isDestroyed()) return;
  if (window.isMinimized()) window.restore();
  window.show();
  window.focus();
}

function startupFailed(error: unknown): void {
  if (quitting) return;
  dialog.showErrorBox('Prism could not start', error instanceof Error ? error.message : 'An unexpected error occurred.');
  app.exit(1);
}

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('before-quit', (event) => {
    if (quitReady) return;
    event.preventDefault();
    if (quitting) return;
    // A cancelled draft prompt must leave the PDF session open and usable.
    if (dirty && !allowClose && window) { requestClose('quit'); return; }
    window?.setEnabled(false);
    quitting = true;
    // Stop read-only network work immediately; accepted note/PDF publications
    // still drain before ownership is released and Electron exits.
    researchClient.close();
    arxivClient.close();
    void Promise.allSettled([operations, pdfURLImports.close()]).then(() => pdfLibrary.close()).then(() => {
      quitReady = true;
      session.defaultSession.flushStorageData();
      // File writes and library ownership have settled. Give Electron a normal
      // window/storage shutdown, with a fallback for an unresponsive renderer.
      setTimeout(() => app.exit(0), 2000).unref();
      app.quit();
    }).catch((error: unknown) => {
      console.error('Prism could not close:', error);
      app.exit(1);
    });
  });
  app.on('window-all-closed', () => app.quit());
  const startup = app.whenReady().then(async () => {
    Menu.setApplicationMenu(null);
    session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
    session.defaultSession.setPermissionCheckHandler(() => false);
    session.defaultSession.on('will-download', event => event.preventDefault());
    await restrictRendererResources();
    registerIPC();
    await showOrCreateWindow();
  });
  const showWindow = () => { void startup.then(showOrCreateWindow).catch(startupFailed); };
  app.on('second-instance', showWindow);
  app.on('activate', showWindow);
  void startup.catch(startupFailed);
}
