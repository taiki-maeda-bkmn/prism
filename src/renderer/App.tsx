import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { ArrowLeft, ArrowUpRight, BookOpen, Check, ChevronDown, ChevronRight, Code2, Columns2, FilePlus2, FileText, Folder, FolderOpen, GitFork, Layers3, Link2, LoaderCircle, Maximize2, Minus, PanelLeftClose, PanelLeftOpen, Plus, RefreshCw, Save, Search, Settings2, Sparkles, X } from 'lucide-react';
import type { Note, Workspace } from '../shared/types';
import { Editor } from './Editor';
import { Graph } from './Graph';
import { getBacklinks, getTitle, renderMarkdown, resolveLink } from './markdown';

type Mode = 'source' | 'split' | 'preview';
type Intent = 'open' | 'refresh' | 'close';
interface Preferences { mode: Mode; transparent: boolean; opacity: number; }
const defaults: Preferences = { mode: 'split', transparent: false, opacity: 82 };

function readPreferences(): Preferences {
  try {
    const value = JSON.parse(localStorage.getItem('prism.preferences') || '{}');
    return {
      mode: ['source', 'split', 'preview'].includes(value.mode) ? value.mode : defaults.mode,
      transparent: value.transparent === true,
      opacity: typeof value.opacity === 'number' && Number.isFinite(value.opacity) ? Math.min(100, Math.max(25, value.opacity)) : defaults.opacity,
    };
  } catch { return defaults; }
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
  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const [activePath, setActivePath] = useState('');
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [preferences, setPreferences] = useState(readPreferences);
  const [view, setView] = useState<'note' | 'graph'>('note');
  const [query, setQuery] = useState('');
  const [focus, setFocus] = useState(false);
  const [settings, setSettings] = useState(false);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');
  const [pending, setPending] = useState<Intent | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [cursor, setCursor] = useState({ line: 1, column: 1 });
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
      if (focusBeforeIO.current?.isConnected && !document.querySelector('dialog[open]')) focusBeforeIO.current.focus({ preventScroll: true });
      focusBeforeIO.current = null;
    });
    return () => cancelAnimationFrame(frame);
  }, [busy]);

  const acceptWorkspace = useCallback((next: Workspace) => {
    latest.current.workspace = next;
    latest.current.drafts = {};
    setWorkspace(next);
    const welcome = next.notes.find(note => /(^|\/)Welcome to Prism\.md$/i.test(note.path));
    setActivePath(next.notes.some(note => note.path === latest.current.activePath) ? latest.current.activePath : (welcome || next.notes[0])?.path || '');
    setDrafts({});
    setQuery('');
    setView('note');
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

  const notes = useMemo(() => (workspace?.notes || []).map(note => Object.hasOwn(drafts, note.path) ? { ...note, content: drafts[note.path] } : note), [workspace, drafts]);
  const active = notes.find(note => note.path === activePath);
  const filtered = useMemo(() => notes.filter(note => `${note.path}\n${note.content}`.toLowerCase().includes(query.trim().toLowerCase())), [notes, query]);
  const backlinks = useMemo(() => active ? getBacklinks(active.path, notes) : [], [active, notes]);
  const previewContent = useDeferredValue(active?.content || '');
  const html = useMemo(() => renderMarkdown(previewContent), [previewContent]);
  const outline = useMemo(() => {
    const document = new DOMParser().parseFromString(html, 'text/html');
    return [...document.querySelectorAll('h1,h2,h3')].map((heading, index) => ({ title: heading.textContent || '', level: Number(heading.tagName.slice(1)), index }));
  }, [html]);
  const words = active?.content.trim().split(/\s+/u).filter(Boolean).length || 0;
  const dirtyCount = Object.keys(drafts).length;

  const openNote = useCallback((path: string) => { setActivePath(path); setView('note'); setCursor({ line: 1, column: 1 }); }, []);
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
      if (!(event.metaKey || event.ctrlKey) || operation.current || document.querySelector('dialog[open]')) return;
      const key = event.key.toLowerCase();
      if (key === 's') { event.preventDefault(); void save(event.shiftKey); }
      if (key === 'n') { event.preventDefault(); setNewName(''); setCreating(true); }
      if (key === 'o') { event.preventDefault(); requestIntent('open'); }
      if (key === 'p') { event.preventDefault(); setFocus(false); requestAnimationFrame(() => search.current?.focus()); }
      if (key === 'g' && event.shiftKey) { event.preventDefault(); setView(previous => previous === 'note' ? 'graph' : 'note'); }
      if (['1', '2', '3'].includes(key)) { event.preventDefault(); setView('note'); setPreferences(previous => ({ ...previous, mode: (['source', 'split', 'preview'] as Mode[])[Number(key) - 1] })); }
    };
    window.addEventListener('keydown', keyboard, true);
    return () => window.removeEventListener('keydown', keyboard, true);
  }, [save, requestIntent]);

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

  const clickPreview = (event: React.MouseEvent<HTMLDivElement>) => {
    const link = (event.target as Element).closest('a');
    if (!link) return;
    event.preventDefault();
    const href = link.getAttribute('href') || '';
    if (/^https?:\/\//i.test(href) || /^mailto:/i.test(href)) {
      void window.prism.openExternal(href).catch(cause => setError(message(cause)));
      return;
    }
    if (href.startsWith('#')) {
      let id = href.slice(1);
      try { id = decodeURIComponent(id); } catch { /* Keep malformed fragments literal. */ }
      const target = document.querySelector('.markdown-body')?.querySelector(`[id="${CSS.escape(id)}"]`);
      target?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      return;
    }
    const target = resolveLink(href, activePath, notes);
    if (target) openNote(target.path);
    else setNotice('That linked note is not in this notebook yet. Create it with New note.');
  };

  const alpha = preferences.transparent ? preferences.opacity / 100 : 1;
  const appStyle = { '--surface-alpha': alpha } as CSSProperties;

  return <div className={`app-shell ${focus ? 'focus-mode' : ''}`} style={appStyle} data-transparent={preferences.transparent}>
    <header className="titlebar">
      <div className="titlebar-brand"><PrismMark small /><strong>prism</strong><span className="titlebar-divider" /><span>A little space for big ideas.</span></div>
      <div className="window-controls"><button aria-label="Minimize window" onClick={() => window.prism?.windowControl('minimize')}><Minus size={15} /></button><button aria-label="Expand or restore window" onClick={() => window.prism?.windowControl('expand')}><Maximize2 size={13} /></button><button className="close-window" aria-label="Close window" onClick={() => requestIntent('close')}><X size={17} /></button></div>
    </header>

    <div className="app-body" inert={busy} aria-busy={busy}>
      {!focus && <aside className="sidebar">
        <button className="workspace-switch" onClick={() => requestIntent('open')} title="Open a notebook folder (Ctrl+O)"><span className="workspace-icon"><BookOpen size={19} /></span><span><strong>{workspace?.name || 'Your notebook'}</strong><small>LOCAL NOTEBOOK</small></span><ChevronDown size={15} /></button>
        <div className="search-field"><Search size={15} /><input ref={search} value={query} onChange={event => setQuery(event.target.value)} placeholder="Find a note…" aria-label="Search notes" /><kbd>⌘ / Ctrl P</kbd></div>
        <button className={`graph-nav ${view === 'graph' ? 'selected' : ''}`} onClick={() => setView(previous => previous === 'graph' ? 'note' : 'graph')}><GitFork size={17} /><span>Graph view</span><ArrowUpRight size={14} /></button>
        <div className="sidebar-section-label"><span>YOUR NOTES</span><div><button className="icon-button" title="Refresh from disk" aria-label="Refresh notebook" disabled={busy || !workspace} onClick={() => requestIntent('refresh')}><RefreshCw size={14} /></button><button className="icon-button" title="New note (Ctrl+N)" aria-label="New note" disabled={!workspace} onClick={() => { setNewName(''); setCreating(true); }}><Plus size={17} /></button></div></div>
        <div className="note-list-scroll">{filtered.length ? <NoteTree notes={filtered} activePath={view === 'note' ? activePath : ''} drafts={drafts} query={query} onOpen={openNote} /> : <div className="no-notes">{query ? 'No notes match your search.' : workspace ? 'A blank page is a good beginning.' : 'Opening your notebook…'}</div>}</div>
        <button className="new-note-button" disabled={!workspace} onClick={() => { setNewName(''); setCreating(true); }}><Plus size={16} />New note<span>⌘ / Ctrl N</span></button>
        <div className="sidebar-bottom"><button onClick={() => requestIntent('open')} title={workspace?.path}><FolderOpen size={17} /><span>Open notebook</span></button><button onClick={() => setSettings(true)} aria-label="Appearance settings" title="Appearance"><Settings2 size={18} /></button></div>
        <div className="local-label"><span />Saved on your device</div>
      </aside>}

      <main className="workspace-main">
        <div className="document-toolbar">
          <div className="document-location"><button className="icon-button" onClick={() => setFocus(previous => !previous)} aria-label={focus ? 'Show sidebars' : 'Focus mode'} title={focus ? 'Show sidebars' : 'Focus mode'}>{focus ? <PanelLeftOpen size={18} /> : <PanelLeftClose size={18} />}</button><span className="toolbar-separator" />{view === 'graph' ? <><GitFork size={16} /><span>Connected thoughts</span></> : <><FileText size={16} /><span title={activePath}>{activePath.replace(/\.md$/i, '') || 'Your notebook'}</span>{Object.hasOwn(drafts, activePath) && <span className="unsaved-badge">Edited</span>}</>}</div>
          <div className="toolbar-actions"><button className={`transparency-shortcut ${preferences.transparent ? 'enabled' : ''}`} onClick={() => setSettings(true)} title="Window appearance" aria-label="Window appearance"><Layers3 size={16} /><span>{preferences.transparent ? `${preferences.opacity}%` : 'Appearance'}</span></button><button className="save-button" disabled={busy || !Object.hasOwn(drafts, activePath)} onClick={() => void save()} title="Save note (Ctrl+S)">{busy ? <LoaderCircle className="spin" size={15} /> : <Save size={15} />}<span>Save</span></button></div>
        </div>

        {error && <div className="message-banner error" role="alert"><span>{error}</span>{!workspace && <button onClick={() => void initialize()}>Try again</button>}<button aria-label="Dismiss error" onClick={() => setError('')}><X size={16} /></button></div>}
        {notice && <div className="message-banner notice" role="status"><span>{notice}</span><button aria-label="Dismiss notification" onClick={() => setNotice('')}><X size={14} /></button></div>}

        {view === 'graph' ? <section className="graph-page"><div className="graph-page-heading"><div><p className="eyebrow">SEE THE CONNECTIONS</p><h1>Your ideas, together.</h1><p>Every note is a starting point. Follow a connection to see where it leads.</p></div><button className="subtle-button" onClick={() => setView('note')}><ArrowLeft size={15} />Back to note</button></div><Graph notes={notes} activePath={activePath} onOpen={openNote} /><div className="graph-help"><span><i />Note</span><span><i className="active" />Current note</span><span>Drag to explore · Scroll to zoom · Select a note to open</span></div></section> : active ? <>
          <div className="note-heading"><div className="note-heading-text"><p className="eyebrow">A SPACE TO THINK CLEARLY</p><h1>{getTitle(active)}</h1><div className="note-meta"><span>Markdown</span><span>·</span><span>{words.toLocaleString()} words</span><span>·</span><span>{Math.max(1, Math.ceil(words / 200))} min read</span></div></div><div className="mode-switch" role="group" aria-label="Editor mode">{([['source', Code2, 'Source'], ['split', Columns2, 'Split'], ['preview', BookOpen, 'Read']] as const).map(([mode, Icon, label], index) => <button key={mode} aria-pressed={preferences.mode === mode} className={preferences.mode === mode ? 'active' : ''} title={`${label} mode (Ctrl+${index + 1})`} onClick={() => setPreferences(previous => ({ ...previous, mode }))}><Icon size={15} /><span>{label}</span></button>)}</div></div>
          <div className={`editor-layout mode-${preferences.mode}`}>
            {preferences.mode !== 'preview' && <section className="source-pane" aria-label="Source editor"><div className="pane-label"><span><Code2 size={13} />MARKDOWN</span><span>.md</span></div><Editor key={active.path} path={active.path} content={active.content} onChange={changeContent} onCursor={(line, column) => setCursor({ line, column })} /></section>}
            {preferences.mode !== 'source' && <section className="preview-pane" aria-label="Live preview"><div className="pane-label"><span><BookOpen size={13} />{preferences.mode === 'split' ? 'LIVE PREVIEW' : 'READING VIEW'}</span><span className="live-indicator"><span />{Object.hasOwn(drafts, activePath) ? 'Draft' : 'Up to date'}</span></div><div className="markdown-body" onClick={clickPreview} dangerouslySetInnerHTML={{ __html: html }} /></section>}
          </div>
        </> : <div className="empty-workspace"><PrismMark /><p className="eyebrow">MAKE ROOM FOR AN IDEA</p><h1>Your next thought starts here.</h1><p>Create a note, or open a folder of Markdown files to get started.</p><button className="primary-button" disabled={!workspace} onClick={() => { setNewName(''); setCreating(true); }}><FilePlus2 size={17} />Create your first note</button></div>}
      </main>

      {!focus && view === 'note' && active && <aside className="inspector">
        <div className="inspector-title"><Sparkles size={16} /><span>IN THIS NOTE</span></div>
        <section className="outline-section"><div className="inspector-section-heading">Outline <span>{outline.length}</span></div><nav aria-label="Note outline">{outline.length ? outline.map(item => <button key={item.index} className={`outline-link level-${item.level}`} onClick={() => { if (preferences.mode === 'source') setPreferences(previous => ({ ...previous, mode: 'split' })); requestAnimationFrame(() => document.querySelectorAll('.markdown-body h1,.markdown-body h2,.markdown-body h3')[item.index]?.scrollIntoView({ behavior: 'smooth', block: 'start' })); }}><span />{item.title}</button>) : <p className="inspector-empty">Add a heading with # to give your ideas a little structure.</p>}</nav></section>
        <section className="connections-section"><div className="inspector-section-heading">Connections <button className="icon-button" aria-label="Expand graph" onClick={() => setView('graph')}><ArrowUpRight size={15} /></button></div><Graph notes={notes} activePath={activePath} onOpen={openNote} compact /><button className="text-button" onClick={() => setView('graph')}>Explore your graph <ArrowUpRight size={13} /></button></section>
        <section className="backlinks-section"><div className="inspector-section-heading"><span><Link2 size={14} />Backlinks</span><span>{backlinks.length}</span></div>{backlinks.length ? backlinks.map(note => <button className="backlink" key={note.path} onClick={() => openNote(note.path)}><FileText size={14} /><span>{getTitle(note)}</span><ChevronRight size={13} /></button>) : <p className="inspector-empty">Notes that link here will appear here. Connect one with <code>[[{active.path.replace(/\.md$/i, '')}]]</code>.</p>}</section>
        <div className="inspector-tip"><PrismMark small /><p>Good ideas rarely<br />happen in isolation.</p></div>
      </aside>}
    </div>

    <footer className="statusbar"><div><span className={`status-dot ${dirtyCount ? 'unsaved' : ''}`} /><span>{busy ? 'Working…' : dirtyCount ? `${dirtyCount} unsaved ${dirtyCount === 1 ? 'note' : 'notes'}` : 'All changes saved'}</span><span className="status-divider" /><span>{notes.length} notes</span></div><div>{active && view === 'note' && <><span>Ln {cursor.line}, Col {cursor.column}</span><span className="status-divider" /><span>UTF-8</span><span>Markdown</span></>}<button onClick={() => setSettings(true)}><Layers3 size={12} />{preferences.transparent ? 'Transparent' : 'Opaque'}</button></div></footer>

    {creating && <Modal title="A new place for an idea" onClose={() => !busy && setCreating(false)}><form onSubmit={event => { event.preventDefault(); void create(); }}><label className="field-label" htmlFor="new-note-name">Note name</label><input id="new-note-name" className="text-input" autoFocus value={newName} onChange={event => setNewName(event.target.value)} placeholder="An idea worth keeping" disabled={busy} maxLength={220} /><p className="field-help">Use a path like <code>Ideas/My note</code> to organize it in a folder. The .md extension is added for you.</p>{error && <p className="inline-error" role="alert">{error}</p>}<div className="modal-actions"><button type="button" className="subtle-button" disabled={busy} onClick={() => setCreating(false)}>Cancel</button><button className="primary-button" type="submit" disabled={busy || !newName.trim()}><Plus size={16} />{busy ? 'Creating…' : 'Create note'}</button></div></form></Modal>}

    {settings && <Modal title="Make a little space" onClose={() => setSettings(false)} className="appearance-modal"><p className="modal-description">Settle into a workspace that feels like yours.</p><div className="appearance-preview" style={{ background: `rgba(228, 234, 222, ${alpha})` }}><PrismMark /><span>Clarity, in your own way.</span></div><div className="setting-row"><div><strong>Transparent window</strong><p>See your other windows through Prism.</p></div><button className={`toggle ${preferences.transparent ? 'on' : ''}`} role="switch" aria-checked={preferences.transparent} aria-label="Transparent window" onClick={() => setPreferences(previous => ({ ...previous, transparent: !previous.transparent }))}><span /></button></div><div className={`opacity-setting ${!preferences.transparent ? 'disabled' : ''}`}><div><label htmlFor="opacity">Background opacity</label><output>{preferences.opacity}%</output></div><input id="opacity" type="range" min="25" max="100" step="1" value={preferences.opacity} disabled={!preferences.transparent} onChange={event => setPreferences(previous => ({ ...previous, opacity: Number(event.target.value) }))} /><div className="range-labels"><span>More transparent</span><span>More solid</span></div></div><p className="field-help">Text stays crisp. Transparency depends on your desktop’s window compositor.</p><div className="shortcut-list"><span>Save note <kbd>Ctrl / ⌘ S</kbd></span><span>Find a note <kbd>Ctrl / ⌘ P</kbd></span><span>Change editor mode <kbd>Ctrl / ⌘ 1–3</kbd></span><span>Open graph <kbd>Ctrl / ⌘ Shift G</kbd></span></div><div className="modal-actions"><button className="primary-button" onClick={() => setSettings(false)}><Check size={16} />Done</button></div></Modal>}

    {pending && <Modal title="Keep your latest thoughts?" onClose={() => !busy && setPending(null)}><p className="modal-description">You have changes in {dirtyCount} {dirtyCount === 1 ? 'note' : 'notes'}. Save them before {pending === 'close' ? 'closing Prism' : pending === 'open' ? 'opening another notebook' : 'reloading from disk'}.</p><ul className="unsaved-list">{Object.keys(drafts).map(path => <li key={path}><FileText size={14} />{path}</li>)}</ul>{error && <p className="inline-error" role="alert">{error}</p>}<div className="modal-actions"><button className="subtle-button discard-button" disabled={busy} onClick={() => { const intent = pending; setPending(null); void runIntent(intent); }}>Discard changes</button><button className="subtle-button" disabled={busy} onClick={() => setPending(null)}>Cancel</button><button className="primary-button" disabled={busy} onClick={async () => { const intent = pending; if (await save(true)) { setPending(null); await runIntent(intent); } }}>{busy ? 'Saving…' : 'Save & continue'}</button></div></Modal>}
  </div>;
}

function message(cause: unknown): string {
  return cause instanceof Error ? cause.message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '') : 'Something went wrong. Please try again.';
}
