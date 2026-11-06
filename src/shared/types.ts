export interface Note {
  path: string;
  content: string;
  modified: number;
}

export interface Workspace {
  name: string;
  path: string;
  notes: Note[];
  warnings: string[];
}

export interface WindowState {
  maximized: boolean;
}

export interface PrismAPI {
  loadWorkspace(): Promise<Workspace>;
  openWorkspace(): Promise<Workspace | null>;
  refreshWorkspace(): Promise<Workspace>;
  saveNote(path: string, content: string, expectedModified: number): Promise<Note>;
  createNote(path: string): Promise<Note>;
  setDirty(dirty: boolean): void;
  openExternal(url: string): Promise<void>;
  windowControl(action: 'minimize' | 'maximize' | 'close'): void;
  setWindowTranslucency(translucent: boolean): void;
  getWindowState(): Promise<WindowState>;
  onWindowStateChanged(callback: (state: WindowState) => void): () => void;
  onCloseRequested(callback: () => void): () => void;
  confirmClose(): void;
  cancelClose(): void;
  platform: string;
}

declare global {
  interface Window {
    prism: PrismAPI;
  }
}
