import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { ArrowLeft, ArrowUpRight, BookOpen, Check, ChevronDown, ChevronRight, Code2, Columns2, Copy, FilePlus2, FileText, Folder, FolderOpen, GitFork, Layers3, Link2, LoaderCircle, Minus, PanelLeftClose, PanelLeftOpen, Plus, RefreshCw, Save, Search, Settings2, Sparkles, Square, X } from 'lucide-react';
import type { Note, Workspace } from '../shared/types';
import { Editor, type EditorHandle } from './Editor';
import { formatPDFPageLink, isPDFPageLink, parsePDFPageLink, type PDFPageLinkRequest, type PDFPageReference, type PDFPageTarget } from '../shared/pdfLinks';
import { Graph, type GraphPoint } from './Graph';
import { getBacklinks, getTitle, renderMarkdownDocument, resolveNoteLink } from './markdown';
import { mathTextContent } from './math';
import { appearanceStyle, parsePreferences, selectTheme, themes, textSize, type Mode, type Preferences } from './appearance';
import { ColorSettings } from './ColorSettings';
import { ThemeSettings } from './ThemeSettings';
import { ResizableInspector } from './ResizableInspector';
import { snippetCatalog, type MarkdownSnippet } from './snippetDefinitions';
import { readCustomSnippets, saveCustomSnippets } from './customSnippets';
import { SnippetSettings } from './SnippetSettings';
import { PDFWorkspaceLoader } from './PDFWorkspaceLoader';
import { getPDFBacklinks } from './pdfBacklinks';
import { usePDFGraphCatalog } from './usePDFGraphCatalog';
import { useWorkspaceSplit } from './useWorkspaceSplit';

type Intent = 'open' | 'refresh' | 'close';

function readPreferences(): Preferences {
  try { return parsePreferences(localStorage.getItem('prism.preferences')); }
  catch { return parsePreferences(null); }
}

function Modal({ title, children, onClose, className = '' }: { title: string; children: ReactNode; onClose: () => void; className?: string }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => { ref.current?.showModal(); }, []);
  return <dialog ref={ref} className={`modal ${className}`} aria-label={title} onCancel={event => { event.preventDefault(); onClose(); }}>
    <div className="modal-heading"><h2>{title}</h2><button className="icon-button" aria-label="Close dialog" onClick={onClose}><X size={18} /></button></div>
    {children}
  </dialog>;
}

function PrismMark({ small = false }: { small?: boolean }) {
  return <svg className={small ? 'prism-mark small' : 'prism-mark'} viewBox="0 0 32 36" fill="none" aria-hidden="true"><path d="M16 2 30 27 16 34 2 27Z" fill="currentColor" opacity=".12"/><path d="m16 2 14 25-14 7L2 27 16 2Z" stroke="currentColor" strokeWidth="1.4"/><path d="M16 2v32M2 27l14-7 14 7" stroke="currentColor" strokeWidth="1.4"/></svg>;
}

function NoteTree({ notes, activePath, drafts, query, onOpen }: { notes: Note[]; activePath: string; drafts: Record<string, string>; query: string; onOpen: (path: string) => void }) {
  const [closed, setClosed] = useState<Set<string>>(new Set());
  const render = (prefix: string, depth: number): ReactNode => {
    const children = new Map<string, Note | null>();
    for (const note of notes) {
      if (!note.path.startsWith(prefix)) continue;
      const rest = note.path.slice(prefix.length);
      const parts = rest.split('/');
      children.set(parts[0], parts.length > 1 ? null : note);
    }
    return [...children].sort(([a, av], [b, bv]) => Number(av !== null) - Number(bv !== null) || a.localeCompare(b)).map(([name, note]) => {
      const path = prefix + name;
      if (note) return <button key={path} className={`note-item ${activePath === path ? 'active' : ''}`} style={{ paddingLeft: 15 + depth * 14 }} onClick={() => onOpen(path)} title={path} aria-current={activePath === path ? 'page' : undefined}>
        <FileText size={15} /><span>{name.replace(/\.md$/i, '')}</span>{Object.hasOwn(drafts, path) && <span className="dirty-dot" aria-label="Unsaved changes" />}
      </button>;
      const expanded = !!query || !closed.has(path);
      return <div key={path}><button className="folder-item" style={{ paddingLeft: 13 + depth * 14 }} onClick={() => setClosed(previous => { const next = new Set(previous); next.has(path) ? next.delete(path) : next.add(path); return next; })} aria-expanded={expanded}>
        {expanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}<Folder size={14} /><span>{name}</span>
      </button>{expanded && render(path + '/', depth + 1)}</div>;
    });
  };
  return <nav className="note-tree" aria-label="Notes">{render('', 0)}</nav>;
}

export function App() {
  const [activeWorkspace, setActiveWorkspace] = useState<'notes' | 'pdfs'>('notes');
  const activeWorkspaceRef = useRef(activeWorkspace);
  activeWorkspaceRef.current = activeWorkspace;
  const [pdfVisited, setPdfVisited] = useState(false);
  const [pageLinkRequest, setPageLinkRequest] = useState<PDFPageLinkRequest | null>(null);
  const nextPageLinkRequest = useRef(0);
  const editor = useRef<EditorHandle>(null);
  const split = useWorkspaceSplit();
  const [notesNavigation, setNotesNavigation] = useState(false);
  const [focusRequest, setFocusRequest] = useState(0);
  const notesPanel = useRef<HTMLDivElement>(null);
  const pdfPanel = useRef<HTMLDivElement>(null);
  const notesNavigationButton = useRef<HTMLButtonElement>(null);
  const workspaceFocus = useRef<{ notes: HTMLElement | null; pdfs: HTMLElement | null }>({ notes: null, pdfs: null });
  const focusNoteContent = useRef(false);
  const switchWorkspace = (next: 'notes' | 'pdfs', noteContent = false) => {
    focusNoteContent.current = next === 'notes' && noteContent;
    if (next === 'pdfs') setPdfVisited(true);
    setActiveWorkspace(next);
    setFocusRequest(previous => previous + 1);
  };
  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const [workspaceRevision, setWorkspaceRevision] = useState(0);
  const [activePath, setActivePath] = useState('');
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [preferences, setPreferences] = useState(readPreferences);
  const [view, setView] = useState<'note' | 'graph'>('note');
  const [showGraphPDFs, setShowGraphPDFs] = useState(true);
  const [graphPositions, setGraphPositions] = useState<ReadonlyMap<string, GraphPoint>>(new Map());
  const moveGraphNode = useCallback((path: string, point: GraphPoint) => {
    setGraphPositions(previous => new Map(previous).set(path, point));
  }, []);
  const resetGraphLayout = useCallback(() => setGraphPositions(new Map()), []);
  const [query, setQuery] = useState('');
  const [focus, setFocus] = useState(false);
  const [maximized, setMaximized] = useState(false);
  const [settings, setSettings] = useState(false);
  const [snippetHelp, setSnippetHelp] = useState(false);
  const [customSnippets, setCustomSnippets] = useState(readCustomSnippets);
  const changeCustomSnippets = useCallback((snippets: MarkdownSnippet[]): string | null => {
    const failure = saveCustomSnippets(snippets);
    if (!failure) setCustomSnippets(snippets);
    return failure;
  }, []);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');
  const [pending, setPending] = useState<Intent | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [cursor, setCursor] = useState({ line: 1, column: 1 });
  const [previewNavigation, setPreviewNavigation] = useState<{ path: string; fragment?: string } | null>(null);
  const [headingTarget, setHeadingTarget] = useState<{ path: string; index: number; request: number; allLevels?: boolean; top?: boolean }>();
  const headingRequest = useRef(0);
  const preview = useRef<HTMLDivElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const latest = useRef({ workspace, drafts, activePath, busy });
  latest.current = { workspace, drafts, activePath, busy };
  const operation = useRef(false);
  const focusBeforeIO = useRef<HTMLElement | null>(null);
  const setWorking = useCallback((value: boolean) => {
    if (value) focusBeforeIO.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setBusy(value);
  }, []);
  useEffect(() => {
    if (busy) return;
    const frame = requestAnimationFrame(() => {
      const previous = focusBeforeIO.current;
      const focused = document.activeElement;
      // A completed picker/save may leave focus on the document body after its
      // pane was inert. Restore that focus, but never override a new user target.
      if (previous?.isConnected && !previous.closest('[hidden], [inert]')
        && (!focused || focused === document.body || focused === previous)
        && !document.querySelector('dialog[open]')) previous.focus({ preventScroll: true });
      focusBeforeIO.current = null;
    });
    return () => cancelAnimationFrame(frame);
  }, [busy]);

  const restoreWorkspaceFocus = useCallback((next: 'notes' | 'pdfs') => {
    const noteContent = next === 'notes' && focusNoteContent.current;
    focusNoteContent.current = false;
    if (document.querySelector('dialog[open]')) return;
    // Opening a backlink may replace the editor DOM. Resolve it after the note
    // mounts instead of restoring a stale editor or the old sidebar/search.
    const remembered = noteContent
      ? notesPanel.current?.querySelector<HTMLElement>('.source-pane:not([hidden]) .cm-content')
      : workspaceFocus.current[next];
    const panel = next === 'notes' ? notesPanel.current : pdfPanel.current;
    if (remembered?.isConnected && !remembered.closest('[hidden], [inert]') && remembered.getClientRects().length) remembered.focus({ preventScroll: true });
    else panel?.focus({ preventScroll: true });
  }, []);

  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      // A click in the other pane after the layout/navigation request is newer
      // than this scheduled restoration and must keep its focus ownership.
      if (activeWorkspaceRef.current === activeWorkspace) restoreWorkspaceFocus(activeWorkspace);
    });
    return () => cancelAnimationFrame(frame);
    // Ordinary focus/pointer changes update shortcut ownership only. Restoring
    // remembered focus here is reserved for explicit navigation and layouts.
  }, [focusRequest, split.visible, restoreWorkspaceFocus]);

  useEffect(() => {
    if (!split.visible || !notesNavigation) return;
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || document.querySelector('dialog[open]')
        || !(event.target instanceof Node) || !notesPanel.current?.contains(event.target)) return;
      event.preventDefault();
      setNotesNavigation(false);
      notesNavigationButton.current?.focus({ preventScroll: true });
    };
    window.addEventListener('keydown', escape);
    return () => window.removeEventListener('keydown', escape);
  }, [split.visible, notesNavigation]);

  const acceptWorkspace = useCallback((next: Workspace) => {
    const sameNotebook = latest.current.workspace?.path === next.path;
    setGraphPositions(previous => {
      if (!sameNotebook) return new Map();
      const identities = new Set(next.notes.map(note => `note:${note.path}`));
      if ([...previous.keys()].some(id => id.startsWith('pdf:'))) {
        for (const id of getPDFBacklinks(next.notes).keys()) identities.add(`pdf:${id}`);
      }
      return new Map([...previous].filter(([id]) => identities.has(id)));
    });
    latest.current.workspace = next;
    latest.current.drafts = {};
    setWorkspace(next);
    // A fresh workspace must not inherit undo history from discarded drafts or
    // a different notebook that happens to contain the same relative note path.
    setWorkspaceRevision(previous => previous + 1);
    setCursor({ line: 1, column: 1 });
    const welcome = next.notes.find(note => /(^|\/)Welcome to Prism\.md$/i.test(note.path));
    setActivePath(next.notes.some(note => note.path === latest.current.activePath) ? latest.current.activePath : (welcome || next.notes[0])?.path || '');
    setDrafts({});
    setQuery('');
    setNotesNavigation(false);
    setView('note');
    setPreviewNavigation(null);
    setHeadingTarget(undefined);
    setNotice(next.warnings.join(' '));
    window.prism.setDirty(false);
  }, []);

  const initialize = useCallback(async () => {
    setError('');
    try {
      if (!window.prism) throw new Error('Open Prism with npm start to use the desktop notebook.');
      acceptWorkspace(await window.prism.loadWorkspace());
    } catch (cause) { setError(message(cause)); }
  }, [acceptWorkspace]);

  useEffect(() => { void initialize(); }, [initialize]);
  useEffect(() => {
    try { localStorage.setItem('prism.preferences', JSON.stringify(preferences)); } catch { /* Preferences are optional; notes are stored on disk. */ }
  }, [preferences]);
  useEffect(() => { window.prism?.setDirty(Object.keys(drafts).length > 0); }, [drafts]);
  useEffect(() => window.prism?.onCloseRequested(() => setPending('close')), []);
  useEffect(() => {
    if (!window.prism) return;
    let current = true;
    let receivedEvent = false;
    const unsubscribe = window.prism.onWindowStateChanged(state => {
      receivedEvent = true;
      setMaximized(state.maximized);
    });
    void window.prism.getWindowState().then(state => {
      // A native change after the request is newer than the initial snapshot.
      if (current && !receivedEvent) setMaximized(state.maximized);
    }).catch(() => { /* The native events still keep the controls up to date. */ });
    return () => { current = false; unsubscribe(); };
  }, []);
  useEffect(() => { if (view === 'graph') setHeadingTarget(undefined); }, [view]);

  const notes = useMemo(() => (workspace?.notes || []).map(note => Object.hasOwn(drafts, note.path) ? { ...note, content: drafts[note.path] } : note), [workspace, drafts]);
  const active = notes.find(note => note.path === activePath);
  const filtered = useMemo(() => notes.filter(note => `${note.path}\n${note.content}`.toLowerCase().includes(query.trim().toLowerCase())), [notes, query]);
  const backlinks = useMemo(() => active ? getBacklinks(active.path, notes) : [], [active, notes]);
  const pdfBacklinks = useMemo(() => pdfVisited || (view === 'graph' && showGraphPDFs) ? getPDFBacklinks(notes) : undefined, [notes, pdfVisited, view, showGraphPDFs]);
  const pdfGraph = usePDFGraphCatalog(view === 'graph' && showGraphPDFs && !!pdfBacklinks?.size);
  const previewNote = useDeferredValue(active);
  const rendered = useMemo(() => renderMarkdownDocument(previewNote?.content || ''), [previewNote?.content]);
  const html = rendered.html;
  const outline = useMemo(() => {
    if (preferences.mode === 'live') return rendered.headings;
    const document = new DOMParser().parseFromString(html, 'text/html');
    return [...document.querySelectorAll('h1,h2,h3')].map((heading, index) => ({ title: mathTextContent(heading), level: Number(heading.tagName.slice(1)), index }));
  }, [html, rendered.headings, preferences.mode]);
  const words = active?.content.trim().split(/\s+/u).filter(Boolean).length || 0;
  const dirtyCount = Object.keys(drafts).length;

  const openNote = useCallback((path: string, fragment?: string) => {
    setActivePath(path);
    setView('note');
    setCursor({ line: 1, column: 1 });
    setPreviewNavigation({ path, fragment });
    setHeadingTarget(undefined);
    setNotesNavigation(false);
    if (split.visible && notesNavigation) requestAnimationFrame(() => {
      const editor = notesPanel.current?.querySelector<HTMLElement>('.source-pane:not([hidden]) .cm-content');
      (editor ?? notesPanel.current)?.focus({ preventScroll: true });
    });
  }, [split.visible, notesNavigation]);
  const chooseMode = useCallback((mode: Mode) => {
    setHeadingTarget(undefined);
    setView('note');
    setPreferences(previous => ({ ...previous, mode }));
  }, []);
  const openPDFBacklink = (path: string) => {
    if (operation.current || latest.current.busy || document.querySelector('dialog[open]')
      || !latest.current.workspace?.notes.some(note => note.path === path)) return;
    openNote(path);
    switchWorkspace('notes', true);
  };
  useEffect(() => {
    if (!previewNavigation || view !== 'note' || preferences.mode === 'source'
      || !active || previewNavigation.path !== active.path
      || previewNote?.path !== active.path || previewNote.content !== active.content) return;
    const fragment = previewNavigation.fragment;
    if (preferences.mode === 'live') {
      if (fragment) {
        // Use trusted Markdown metadata, excluding arbitrary HTML headings and
        // retaining the renderer's exact duplicate IDs and math-aware labels.
        const heading = rendered.allHeadings.find(item => item.id === fragment)
          ?? rendered.allHeadings.find(item => item.title.trim().toLocaleLowerCase() === fragment.trim().toLocaleLowerCase());
        if (heading) setHeadingTarget({ path: active.path, index: heading.index, request: ++headingRequest.current, allLevels: true });
      } else if (fragment === '') {
        // An empty fragment points to the document's beginning, even when this
        // note is already open and its editor retains a lower scroll position.
        setHeadingTarget({ path: active.path, index: 0, request: ++headingRequest.current, top: true });
      }
      setPreviewNavigation(null);
      return;
    }
    const container = preview.current;
    if (!container) return;
    if (fragment) {
      const target = container.querySelector<HTMLElement>(`[id="${CSS.escape(fragment)}"]`)
        ?? [...container.querySelectorAll<HTMLElement>('h1,h2,h3,h4,h5,h6')]
          .find(heading => mathTextContent(heading).trim().toLocaleLowerCase() === fragment.trim().toLocaleLowerCase());
      if (target) container.scrollTo({
        top: container.scrollTop + target.getBoundingClientRect().top - container.getBoundingClientRect().top - 24,
        behavior: 'smooth',
      });
    } else container.scrollTop = 0;
    setPreviewNavigation(null);
  }, [previewNavigation, view, preferences.mode, active, previewNote, html, rendered.allHeadings]);
  const changeContent = (content: string) => {
    if (!active) return;
    setDrafts(previous => {
      const next = { ...previous };
      const original = workspace?.notes.find(note => note.path === active.path);
      if (original?.content === content) delete next[active.path]; else next[active.path] = content;
      latest.current.drafts = next;
      window.prism.setDirty(Object.keys(next).length > 0);
      return next;
    });
  };

  const save = useCallback(async (all = false): Promise<boolean> => {
    if (operation.current) return false;
    operation.current = true;
    setWorking(true);
    setError('');
    const snapshot = latest.current;
    const paths = Object.keys(snapshot.drafts).filter(path => all || path === snapshot.activePath);
    try {
      for (const path of paths) {
        const original = snapshot.workspace?.notes.find(note => note.path === path);
        if (!original) throw new Error(`Cannot find ${path} in this notebook.`);
        const saved = await window.prism.saveNote(path, snapshot.drafts[path], original.modified);
        setWorkspace(previous => previous ? { ...previous, notes: previous.notes.map(note => note.path === path ? saved : note) } : previous);
        setDrafts(previous => {
          const next = { ...previous };
          if (next[path] === snapshot.drafts[path]) delete next[path];
          latest.current.drafts = next;
          return next;
        });
      }
      if (paths.length) setNotice(all ? 'All changes saved to your notebook.' : 'Saved to your notebook.');
      return true;
    } catch (cause) { setError(message(cause)); return false; }
    finally { operation.current = false; setWorking(false); }
  }, []);

  const runIntent = useCallback(async (intent: Intent) => {
    if (operation.current) return;
    if (intent === 'close') { window.prism.confirmClose(); return; }
    operation.current = true;
    setWorking(true);
    setError('');
    try {
      window.prism.setDirty(false);
      const next = intent === 'open' ? await window.prism.openWorkspace() : await window.prism.refreshWorkspace();
      if (next) acceptWorkspace(next);
    } catch (cause) { setError(message(cause)); }
    finally { window.prism.setDirty(Object.keys(latest.current.drafts).length > 0); operation.current = false; setWorking(false); }
  }, [acceptWorkspace]);

  const requestIntent = useCallback((intent: Intent) => {
    if (operation.current) return;
    if (intent === 'close') { window.prism.windowControl('close'); return; }
    if (Object.keys(latest.current.drafts).length) setPending(intent);
    else void runIntent(intent);
  }, [runIntent]);

  useEffect(() => {
    const keyboard = (event: KeyboardEvent) => {
      if (activeWorkspace !== 'notes') return;
      if (!(event.metaKey || event.ctrlKey) || operation.current || document.querySelector('dialog[open]')) return;
      const key = event.key.toLowerCase();
      if (key === 's') { event.preventDefault(); void save(event.shiftKey); }
      if (key === 'n' && latest.current.workspace) { event.preventDefault(); setNewName(''); setCreating(true); }
      if (key === 'o') { event.preventDefault(); requestIntent('open'); }
      if (key === 'p') { event.preventDefault(); if (split.visible) setNotesNavigation(true); else setFocus(false); requestAnimationFrame(() => search.current?.focus()); }
      if (key === 'g' && event.shiftKey) { event.preventDefault(); setView(previous => previous === 'note' ? 'graph' : 'note'); }
      if (['1', '2', '3', '4'].includes(key)) { event.preventDefault(); chooseMode((['source', 'split', 'preview', 'live'] as Mode[])[Number(key) - 1]); }
    };
    window.addEventListener('keydown', keyboard, true);
    return () => window.removeEventListener('keydown', keyboard, true);
  }, [save, requestIntent, chooseMode, activeWorkspace, split.visible]);

  const create = async () => {
    if (operation.current || !newName.trim()) return;
    operation.current = true;
    setWorking(true);
    setError('');
    try {
      const path = /\.md$/i.test(newName.trim()) ? newName.trim() : newName.trim() + '.md';
      const note = await window.prism.createNote(path);
      setWorkspace(previous => previous ? { ...previous, notes: [...previous.notes, note] } : previous);
      setCreating(false);
      openNote(note.path);
      setPreferences(previous => ({ ...previous, mode: previous.mode === 'preview' ? 'split' : previous.mode }));
      setNotice('New note created. Make it yours.');
    } catch (cause) { setError(message(cause)); }
    finally { operation.current = false; setWorking(false); }
  };

  const openPDFPage = (destination: PDFPageTarget) => {
    if (operation.current || busy || document.querySelector('dialog[open]')) return;
    setError('');
    setPreviewNavigation(null);
    setHeadingTarget(undefined);
    setPageLinkRequest({ ...destination, request: ++nextPageLinkRequest.current });
    switchWorkspace('pdfs');
  };

  const openHref = (href: string, fromPath: string) => {
    if (isPDFPageLink(href)) {
      const destination = parsePDFPageLink(href);
      if (!destination) {
        setError('This PDF page link has an invalid destination or an unsupported version. Edit the link, or open its PDF and insert a new page link.');
        return;
      }
      openPDFPage(destination);
      return;
    }
    const externalHref = href.startsWith('//') ? `https:${href}` : href;
    if (/^https?:\/\//i.test(externalHref) || /^mailto:/i.test(externalHref)) {
      void window.prism.openExternal(externalHref).catch(cause => setError(message(cause)));
      return;
    }
    const target = resolveNoteLink(href, fromPath, notes);
    if (target) openNote(target.note.path, target.fragment ?? (preferences.mode === 'live' ? '' : undefined));
    else setNotice('That linked note is not in this notebook yet. Create it with New note.');
  };

  const insertPageLink = (reference: PDFPageReference) => {
    // The reader can remain mounted while notebook operations replace its note.
    // Use only the current retained editor, never a cached cursor or draft.
    if (!active || view !== 'note' || operation.current || busy || document.querySelector('dialog[open]')) return;
    if (!editor.current?.insertText(formatPDFPageLink(reference))) {
      setError('Finish entering text in your note, then insert the page link again.');
      switchWorkspace('notes');
      return;
    }
    setError('');
    setHeadingTarget(undefined);
    setPreviewNavigation(null);
    setNotesNavigation(false);
    if (preferences.mode === 'preview') chooseMode('source');
    // Restore editor focus only after Notes (and Source in Read mode) is visible.
    // The existing focus request guard respects a newer click in the other pane.
    workspaceFocus.current.notes = notesPanel.current?.querySelector<HTMLElement>('.cm-content') ?? null;
    switchWorkspace('notes');
  };

  const clickPreview = (event: React.MouseEvent<HTMLDivElement>) => {
    const link = (event.target as Element).closest('a');
    if (!link) return;
    event.preventDefault();
    openHref(link.getAttribute('href') || '', previewNote?.path ?? activePath);
  };

  const appStyle = appearanceStyle(preferences);
  const toggleNotesSidebar = () => {
    if (!split.visible) { setFocus(previous => !previous); return; }
    setNotesNavigation(previous => !previous);
    if (!notesNavigation) requestAnimationFrame(() => {
      if (document.activeElement === notesNavigationButton.current) search.current?.focus({ preventScroll: true });
    });
  };

  return <div className={`app-shell ${focus ? 'focus-mode' : ''}`} style={appStyle} data-transparent={preferences.transparent} data-theme={preferences.theme} data-maximized={maximized} data-workspace={activeWorkspace} data-layout={split.visible ? 'split' : 'single'}>
    <header className="titlebar">
      <div className="titlebar-brand"><PrismMark small /><strong>prism</strong><span className="titlebar-divider" /><span>A little space for big ideas.</span></div>
      <nav className="workspace-navigation" aria-label="Workspaces">
        <button aria-label="Notes" aria-pressed={activeWorkspace === 'notes'} disabled={busy} onClick={() => switchWorkspace('notes')}><FileText size={15} />Notes{dirtyCount > 0 && <span className="workspace-unsaved" title={`${dirtyCount} unsaved notes`} />}</button>
        <button aria-label="PDFs" aria-pressed={activeWorkspace === 'pdfs'} disabled={busy} onClick={() => switchWorkspace('pdfs')}><BookOpen size={15} />PDFs</button>
        <button className="workspace-layout-toggle" aria-label="Read & write" aria-pressed={split.requested} disabled={busy || (!split.available && !split.requested)}
          title={!split.available ? 'Widen the window to show Notes and PDFs side by side.' : split.requested ? 'Return to one workspace' : 'Show Notes and PDFs side by side'}
          onClick={() => { setPdfVisited(true); split.setRequested(previous => !previous); }}><Columns2 size={15} />Read &amp; write</button>
      </nav>
      <div className="window-controls"><button aria-label="Minimize window" title="Minimize window" onClick={() => window.prism?.windowControl('minimize')}><Minus size={15} /></button><button aria-label={maximized ? 'Restore window' : 'Maximize window'} title={maximized ? 'Restore window' : 'Maximize window'} onClick={() => window.prism?.windowControl('maximize')}>{maximized ? <Copy size={13} /> : <Square size={13} />}</button><button className="close-window" aria-label="Close window" title="Close window" onClick={() => requestIntent('close')}><X size={17} /></button></div>
    </header>

    <div className="workspace-area" ref={split.area} style={split.style} data-layout={split.visible ? 'split' : 'single'} data-resizing={split.resizing}>
    <div className="app-body" id="notes-workspace" ref={notesPanel} tabIndex={-1} aria-label="Notes workspace" hidden={!split.visible && activeWorkspace !== 'notes'} inert={busy || (!split.visible && activeWorkspace !== 'notes')} aria-busy={busy} data-active={activeWorkspace === 'notes'} data-notes-open={notesNavigation}
      onPointerDownCapture={() => setActiveWorkspace('notes')}
      onFocusCapture={event => { workspaceFocus.current.notes = event.target as HTMLElement; setActiveWorkspace('notes'); }}>
      {split.visible && notesNavigation && <button className="notes-navigation-dismiss" aria-label="Dismiss notes navigation" tabIndex={-1} onClick={() => { setNotesNavigation(false); notesNavigationButton.current?.focus({ preventScroll: true }); }} />}
      {(split.visible || !focus) && <aside id="notes-navigation" className="sidebar" hidden={split.visible && !notesNavigation} inert={split.visible && !notesNavigation}>
        {split.visible && <button className="notes-navigation-close" aria-label="Close notes navigation" onClick={() => { setNotesNavigation(false); notesNavigationButton.current?.focus({ preventScroll: true }); }}><X size={17} />Close</button>}
        <button className="workspace-switch" onClick={() => requestIntent('open')} title="Open a notebook folder (Ctrl+O)"><span className="workspace-icon"><BookOpen size={19} /></span><span><strong>{workspace?.name || 'Your notebook'}</strong><small>LOCAL NOTEBOOK</small></span><ChevronDown size={15} /></button>
        <div className="search-field"><Search size={15} /><input ref={search} value={query} onChange={event => setQuery(event.target.value)} placeholder="Find a note…" aria-label="Search notes" /><kbd>⌘ / Ctrl P</kbd></div>
        <button className={`graph-nav ${view === 'graph' ? 'selected' : ''}`} onClick={() => { setView(previous => previous === 'graph' ? 'note' : 'graph'); if (split.visible) { setNotesNavigation(false); notesNavigationButton.current?.focus({ preventScroll: true }); } }}><GitFork size={17} /><span>Graph view</span><ArrowUpRight size={14} /></button>
        <div className="sidebar-section-label"><span>YOUR NOTES</span><div><button className="icon-button" title="Refresh from disk" aria-label="Refresh notebook" disabled={busy || !workspace} onClick={() => requestIntent('refresh')}><RefreshCw size={14} /></button><button className="icon-button" title="New note (Ctrl+N)" aria-label="New note" disabled={!workspace} onClick={() => { setNewName(''); setCreating(true); }}><Plus size={17} /></button></div></div>
        <div className="note-list-scroll">{filtered.length ? <NoteTree notes={filtered} activePath={view === 'note' ? activePath : ''} drafts={drafts} query={query} onOpen={openNote} /> : <div className="no-notes">{query ? 'No notes match your search.' : workspace ? 'A blank page is a good beginning.' : 'Opening your notebook…'}</div>}</div>
        <button className="new-note-button" disabled={!workspace} onClick={() => { setNewName(''); setCreating(true); }}><Plus size={16} />New note<span>⌘ / Ctrl N</span></button>
        <div className="sidebar-bottom"><button onClick={() => requestIntent('open')} title={workspace?.path}><FolderOpen size={17} /><span>Open notebook</span></button><button onClick={() => setSettings(true)} aria-label="Appearance settings" title="Appearance"><Settings2 size={18} /></button></div>
        <div className="local-label"><span />Saved on your device</div>
      </aside>}

      <main className="workspace-main">
        <div className="document-toolbar">
          <div className="document-location"><button ref={notesNavigationButton} className="icon-button" onClick={toggleNotesSidebar} aria-label={split.visible ? notesNavigation ? 'Hide notes' : 'Show notes' : focus ? 'Show sidebars' : 'Focus mode'} aria-controls={split.visible ? 'notes-navigation' : undefined} aria-expanded={split.visible ? notesNavigation : undefined} title={split.visible ? notesNavigation ? 'Hide notes' : 'Show notes' : focus ? 'Show sidebars' : 'Focus mode'}>{(split.visible ? !notesNavigation : focus) ? <PanelLeftOpen size={18} /> : <PanelLeftClose size={18} />}</button><span className="toolbar-separator" />{view === 'graph' ? <><GitFork size={16} /><span>Connected thoughts</span></> : <><FileText size={16} /><span title={activePath}>{activePath.replace(/\.md$/i, '') || 'Your notebook'}</span>{Object.hasOwn(drafts, activePath) && <span className="unsaved-badge">Edited</span>}</>}</div>
          <div className="toolbar-actions"><button className={`transparency-shortcut ${preferences.transparent ? 'enabled' : ''}`} onClick={() => setSettings(true)} title="Window appearance" aria-label="Window appearance"><Layers3 size={16} /><span>{preferences.transparent ? `${preferences.opacity}%` : 'Appearance'}</span></button><button className="save-button" disabled={busy || !Object.hasOwn(drafts, activePath)} onClick={() => void save()} title="Save note (Ctrl+S)">{busy ? <LoaderCircle className="spin" size={15} /> : <Save size={15} />}<span>Save</span></button></div>
        </div>

        {error && <div className="message-banner error" role="alert"><span>{error}</span>{!workspace && <button onClick={() => void initialize()}>Try again</button>}<button aria-label="Dismiss error" onClick={() => setError('')}><X size={16} /></button></div>}
        {notice && <div className="message-banner notice" role="status"><span>{notice}</span><button aria-label="Dismiss notification" onClick={() => setNotice('')}><X size={14} /></button></div>}

        {view === 'graph' ? <section className="graph-page">
          <div className="graph-page-heading"><div><p className="eyebrow">SEE THE CONNECTIONS</p><h1>Your ideas, together.</h1><p>Follow the connections between your notes and reading.</p></div><button className="subtle-button" onClick={() => setView('note')}><ArrowLeft size={15} />Back to note</button></div>
          <div className="graph-filters">
            <label><input type="checkbox" checked={showGraphPDFs} onChange={event => setShowGraphPDFs(event.target.checked)} />Show PDFs</label>
            {showGraphPDFs && !!pdfBacklinks?.size && <>
              <button className="subtle-button" onClick={pdfGraph.refresh} disabled={pdfGraph.catalog.status === 'loading'}>Refresh PDF titles</button>
              {(pdfGraph.catalog.status === 'idle' || pdfGraph.catalog.status === 'loading') && <span role="status">Loading PDF titles…</span>}
              {pdfGraph.catalog.status === 'error' && <p className="graph-catalog-error" role="status">PDF titles unavailable. {pdfGraph.catalog.error} You can still open notes and follow PDF references.</p>}
            </>}
          </div>
          <Graph notes={notes} activePath={activePath} onOpen={openNote} manualPositions={graphPositions} onMoveNode={moveGraphNode} onResetLayout={resetGraphLayout}
            pdfBacklinks={pdfBacklinks} pdfCatalog={pdfGraph.catalog} showPDFs={showGraphPDFs} onOpenPDF={openPDFPage} />
          <div className="graph-help"><span><i />Note</span><span><i className="active" />Current note</span>{showGraphPDFs && <><span><i className="pdf" />PDF</span><span><i className="missing-pdf" />Missing PDF</span></>}<span>Drag to arrange · Scroll to zoom · Click to open · Arrow keys move a node</span></div>
        </section> : active ? <>
          <div className="note-heading"><div className="note-heading-text"><p className="eyebrow">A SPACE TO THINK CLEARLY</p><h1>{getTitle(active)}</h1><div className="note-meta"><span>Markdown</span><span>·</span><span>{words.toLocaleString()} words</span><span>·</span><span>{Math.max(1, Math.ceil(words / 200))} min read</span></div></div><div className="mode-switch" role="group" aria-label="Editor mode">{([['source', Code2, 'Source', 1], ['split', Columns2, 'Split', 2], ['live', Sparkles, 'Live', 4], ['preview', BookOpen, 'Read', 3]] as const).map(([mode, Icon, label, shortcut]) => <button key={mode} aria-pressed={preferences.mode === mode} className={preferences.mode === mode ? 'active' : ''} title={`${label} mode (Ctrl/⌘+${shortcut})`} onClick={() => chooseMode(mode)}><Icon size={15} /><span>{label}</span></button>)}</div></div>
          <div className={`editor-layout mode-${preferences.mode}`}>
            <section className="source-pane" hidden={preferences.mode === 'preview'} aria-label={preferences.mode === 'live' ? 'Live editor' : 'Source editor'}><div className="pane-label"><span><Code2 size={13} />{preferences.mode === 'live' ? 'LIVE EDITING' : 'MARKDOWN'}</span>{preferences.mode === 'live' && <span className="live-editing-hint">Markers appear on the line you edit. Ctrl+click links to open.</span>}<button className="snippet-help-button" aria-label="Snippet help" onClick={() => setSnippetHelp(true)}>Snippets <kbd>Tab</kbd></button></div><Editor ref={editor} key={`${workspaceRevision}:${active.path}`} path={active.path} content={active.content} textScale={preferences.textScale} theme={preferences.theme} live={preferences.mode === 'live'} customSnippets={customSnippets} headingTarget={headingTarget?.path === active.path ? headingTarget : undefined} onOpenLink={href => openHref(href, active.path)} onChange={changeContent} onCursor={(line, column) => setCursor({ line, column })} /></section>
            {(preferences.mode === 'split' || preferences.mode === 'preview') && <section className="preview-pane" aria-label="Live preview"><div className="pane-label"><span><BookOpen size={13} />{preferences.mode === 'split' ? 'LIVE PREVIEW' : 'READING VIEW'}</span><span className="live-indicator"><span />{Object.hasOwn(drafts, activePath) ? 'Draft' : 'Up to date'}</span></div><div ref={preview} className="markdown-body" onClick={clickPreview} dangerouslySetInnerHTML={{ __html: html }} /></section>}
          </div>
        </> : <div className="empty-workspace"><PrismMark /><p className="eyebrow">MAKE ROOM FOR AN IDEA</p><h1>Your next thought starts here.</h1><p>Create a note, or open a folder of Markdown files to get started.</p><button className="primary-button" disabled={!workspace} onClick={() => { setNewName(''); setCreating(true); }}><FilePlus2 size={17} />Create your first note</button></div>}
      </main>

      {!split.visible && !focus && view === 'note' && active && <ResizableInspector width={preferences.inspectorWidth} onWidthChange={inspectorWidth => setPreferences(previous => ({ ...previous, inspectorWidth }))}>
        <div className="inspector-title"><Sparkles size={16} /><span>IN THIS NOTE</span></div>
        <section className="outline-section"><div className="inspector-section-heading">Outline <span>{outline.length}</span></div><nav aria-label="Note outline">{outline.length ? outline.map(item => <button key={item.index} className={`outline-link level-${item.level}`} onClick={() => { if (previewNote?.path !== active.path || previewNote.content !== active.content) return; if (preferences.mode === 'live') { setHeadingTarget({ path: active.path, index: item.index, request: ++headingRequest.current }); return; } if (preferences.mode === 'source') chooseMode('split'); requestAnimationFrame(() => document.querySelectorAll('.markdown-body h1,.markdown-body h2,.markdown-body h3')[item.index]?.scrollIntoView({ behavior: 'smooth', block: 'start' })); }}><span />{item.title}</button>) : <p className="inspector-empty">Add a heading with # to give your ideas a little structure.</p>}</nav></section>
        <section className="connections-section"><div className="inspector-section-heading">Connections <button className="icon-button" aria-label="Expand graph" onClick={() => setView('graph')}><ArrowUpRight size={15} /></button></div><Graph notes={notes} activePath={activePath} onOpen={openNote} compact /><button className="text-button" onClick={() => setView('graph')}>Explore your graph <ArrowUpRight size={13} /></button></section>
        <section className="backlinks-section"><div className="inspector-section-heading"><span><Link2 size={14} />Backlinks</span><span>{backlinks.length}</span></div>{backlinks.length ? backlinks.map(note => <button className="backlink" key={note.path} onClick={() => openNote(note.path)}><FileText size={14} /><span>{getTitle(note)}</span><ChevronRight size={13} /></button>) : <p className="inspector-empty">Notes that link here will appear here. Connect one with <code>[[{active.path.replace(/\.md$/i, '')}]]</code>.</p>}</section>
        <div className="inspector-tip"><PrismMark small /><p>Good ideas rarely<br />happen in isolation.</p></div>
      </ResizableInspector>}
    </div>

    <div className="workspace-divider" role="separator" tabIndex={split.visible && !busy ? 0 : -1} hidden={!split.visible} inert={busy || !split.visible}
      aria-label="Resize note and PDF panes" aria-orientation="vertical" aria-controls="notes-workspace pdfs-workspace"
      title="Drag to resize. Left/Right arrows adjust width; Home or double-click resets."
      {...split.dividerProps} />

    {pdfVisited && <div className="pdf-panel" id="pdfs-workspace" ref={pdfPanel} tabIndex={-1} aria-label="PDFs workspace" hidden={!split.visible && activeWorkspace !== 'pdfs'} inert={busy || (!split.visible && activeWorkspace !== 'pdfs')} aria-busy={busy} data-active={activeWorkspace === 'pdfs'}
      onPointerDownCapture={() => setActiveWorkspace('pdfs')}
      onFocusCapture={event => { workspaceFocus.current.pdfs = event.target as HTMLElement; setActiveWorkspace('pdfs'); }}>
      <PDFWorkspaceLoader active={activeWorkspace === 'pdfs' && !busy} onAppearance={() => setSettings(true)} pageLinkRequest={pageLinkRequest} onInsertPageLink={insertPageLink} canInsertPageLink={!!active && view === 'note' && !busy} backlinks={pdfBacklinks} onOpenNote={openPDFBacklink} onDocumentsChange={pdfGraph.updateDocuments} />
    </div>}
    </div>

    <footer className="statusbar"><div><span className={`status-dot ${dirtyCount ? 'unsaved' : ''}`} /><span>{busy ? 'Working…' : dirtyCount ? `${dirtyCount} unsaved ${dirtyCount === 1 ? 'note' : 'notes'}` : 'All changes saved'}</span><span className="status-divider" /><span>{notes.length} notes</span></div><div>{activeWorkspace === 'notes' && active && view === 'note' && <><span>Ln {cursor.line}, Col {cursor.column}</span><span className="status-divider" /><span>UTF-8</span><span>Markdown</span></>}<button onClick={() => setSettings(true)}><Layers3 size={12} />{preferences.transparent ? 'Transparent' : 'Opaque'}</button></div></footer>

    {creating && <Modal title="A new place for an idea" onClose={() => !busy && setCreating(false)}><form onSubmit={event => { event.preventDefault(); void create(); }}><label className="field-label" htmlFor="new-note-name">Note name</label><input id="new-note-name" className="text-input" autoFocus value={newName} onChange={event => setNewName(event.target.value)} placeholder="An idea worth keeping" disabled={busy} maxLength={220} /><p className="field-help">Use a path like <code>Ideas/My note</code> to organize it in a folder. The .md extension is added for you.</p>{error && <p className="inline-error" role="alert">{error}</p>}<div className="modal-actions"><button type="button" className="subtle-button" disabled={busy} onClick={() => setCreating(false)}>Cancel</button><button className="primary-button" type="submit" disabled={busy || !newName.trim()}><Plus size={16} />{busy ? 'Creating…' : 'Create note'}</button></div></form></Modal>}

    {snippetHelp && <Modal title="Markdown snippets" onClose={() => setSnippetHelp(false)} className="snippet-help-modal">
      <p className="modal-description">In Source, Split, or Live mode, type <code>/</code> at the start of a line or within prose to see snippets. Use the arrow keys to choose one, then press <kbd>Tab</kbd> to insert it. You can also type a full shortcut, such as <code>/task</code>, and press <kbd>Tab</kbd>.</p>
      <SnippetSettings snippets={customSnippets} onChange={changeCustomSnippets} />
      <h3 className="snippet-builtins-heading">Built-in snippets</h3>
      <dl className="snippet-catalog">{snippetCatalog.map(snippet => <div key={snippet.trigger}><dt><code>{snippet.trigger}</code><strong>{snippet.title}</strong></dt><dd>{snippet.description}</dd></div>)}</dl>
      <p className="field-help"><kbd>Tab</kbd> moves to the next field; <kbd>Shift+Tab</kbd> moves back. <kbd>Esc</kbd> closes suggestions or leaves a snippet. Outside snippets, Tab moves focus as usual.</p>
      <p className="field-help">Shortcuts work after whitespace, punctuation, or Japanese text in prose. Block snippets add line breaks as needed; <code>/link</code> and <code>/wiki</code> insert at the cursor. Snippets stay inactive inside code, HTML, links, and URLs.</p>
      <div className="modal-actions"><button className="primary-button" onClick={() => setSnippetHelp(false)}><Check size={16} />Done</button></div>
    </Modal>}

    {settings && <Modal title="Make a little space" onClose={() => setSettings(false)} className="appearance-modal">
      <p className="modal-description">Settle into a workspace that feels like yours.</p>
      <fieldset className="text-size-setting">
        <legend>Text size</legend>
        <div className="text-size-heading"><output htmlFor="text-size">{preferences.textScale}%</output><button type="button" className="subtle-button" onClick={() => setPreferences(previous => ({ ...previous, textScale: textSize.default }))}>Reset text size</button></div>
        <input id="text-size" type="range" aria-label="Text size" aria-valuetext={`${preferences.textScale}%`} aria-describedby="text-size-help" min={textSize.min} max={textSize.max} step={textSize.step} value={preferences.textScale} onChange={event => setPreferences(previous => ({ ...previous, textScale: Number(event.target.value) }))} />
        <p id="text-size-help" className="field-help">Applies to notes, PDF controls, navigation, and settings.</p>
      </fieldset>
      <ThemeSettings theme={preferences.theme} palettes={{ ...preferences.themeColors, [preferences.theme]: preferences.colors }} onChange={theme => setPreferences(previous => selectTheme(previous, theme))} />
      <ColorSettings key={preferences.theme} colors={preferences.colors} defaultColors={themes[preferences.theme].colors} onChange={colors => setPreferences(previous => ({ ...previous, colors }))} />
      <div className="setting-row"><div><strong>Transparent window</strong><p>See your other windows through Prism.</p></div><button className={`toggle ${preferences.transparent ? 'on' : ''}`} role="switch" aria-checked={preferences.transparent} aria-label="Transparent window" onClick={() => setPreferences(previous => ({ ...previous, transparent: !previous.transparent }))}><span /></button></div>
      <div className={`opacity-setting ${!preferences.transparent ? 'disabled' : ''}`}><div><label htmlFor="opacity">Background opacity</label><output>{preferences.opacity}%</output></div><input id="opacity" type="range" min="25" max="100" step="1" value={preferences.opacity} disabled={!preferences.transparent} onChange={event => setPreferences(previous => ({ ...previous, opacity: Number(event.target.value) }))} /><div className="range-labels"><span>More transparent</span><span>More solid</span></div></div>
      <p className="field-help">Text stays crisp. Transparency depends on your desktop’s window compositor.</p>
      <div className="shortcut-list"><span>Save note <kbd>Ctrl / ⌘ S</kbd></span><span>Find a note <kbd>Ctrl / ⌘ P</kbd></span><span>Change editor mode <kbd>Ctrl / ⌘ 1–4</kbd></span><span>Open graph <kbd>Ctrl / ⌘ Shift G</kbd></span></div>
      <div className="modal-actions"><button className="primary-button" onClick={() => setSettings(false)}><Check size={16} />Done</button></div>
    </Modal>}

    {pending && <Modal title="Keep your latest thoughts?" onClose={() => !busy && setPending(null)}><p className="modal-description">You have changes in {dirtyCount} {dirtyCount === 1 ? 'note' : 'notes'}. Save them before {pending === 'close' ? 'closing Prism' : pending === 'open' ? 'opening another notebook' : 'reloading from disk'}.</p><ul className="unsaved-list">{Object.keys(drafts).map(path => <li key={path}><FileText size={14} />{path}</li>)}</ul>{error && <p className="inline-error" role="alert">{error}</p>}<div className="modal-actions"><button className="subtle-button discard-button" disabled={busy} onClick={() => { const intent = pending; setPending(null); void runIntent(intent); }}>Discard changes</button><button className="subtle-button" disabled={busy} onClick={() => setPending(null)}>Cancel</button><button className="primary-button" disabled={busy} onClick={async () => { const intent = pending; if (await save(true)) { setPending(null); await runIntent(intent); } }}>{busy ? 'Saving…' : 'Save & continue'}</button></div></Modal>}
  </div>;
}

function message(cause: unknown): string {
  return cause instanceof Error ? cause.message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '') : 'Something went wrong. Please try again.';
}
