import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type DragEvent, type FormEvent, type ReactNode } from 'react';
import { ArrowDownUp, ArrowUpRight, BookOpen, Check, ChevronRight, Clock3, FileText, Folder, FolderOpen, GripVertical, Grid2X2, HardDrive, Library, Link2, List, LoaderCircle, Maximize2, Minus, MoreHorizontal, PanelLeft, Plus, Search, ShieldCheck, SlidersHorizontal, Sparkles, Star, Tag, Trash2, X } from 'lucide-react';
import type { DocumentPatch, LibrarySnapshot, PDFDocument, PDFFolder } from '../shared/types';
import type { PDFNoteBacklink, PDFPageLinkRequest, PDFPageReference } from '../../../src/shared/pdfLinks';
import type { PDFGraphDocument } from '../../../src/shared/pdfGraph';
import { PdfReader, PdfThumbnail } from './PdfReader';
import { URLImportDialog } from './URLImportDialog';
import { TagInput } from './TagInput';
import { mergeFolderSnapshotDocuments } from './folderSnapshots';
import './styles.css';

type Filter = 'all' | 'recent' | 'favorites' | 'unfiled' | `folder:${string}` | `tag:${string}`;
type FolderDialog = { kind: 'create' } | { kind: 'edit' | 'remove'; id: string };
const documentDragType = 'application/x-prism-pdf-document';
const message = (error: unknown) => error instanceof Error ? error.message.replace(/^Error invoking remote method '[^']+': Error: /, '') : 'Something went wrong. Please try again.';
export const formatSize = (bytes: number) => bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
const dateLabel = (value: string) => new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', year: 'numeric' }).format(new Date(value));
function savedAppearance() {
  try {
    const value = JSON.parse(localStorage.getItem('prism-pdf-appearance') || '{}');
    return { transparent: value.transparent === true, opacity: typeof value.opacity === 'number' && Number.isFinite(value.opacity) ? Math.min(100, Math.max(25, value.opacity)) : 85 };
  } catch { return { transparent: false, opacity: 85 }; }
}

function Modal({ title, onClose, children, active }: { title: string; onClose: () => void; children: ReactNode; active: boolean }) {
  const ref = useRef<HTMLDialogElement>(null);
  useLayoutEffect(() => {
    const dialog = ref.current;
    if (active) dialog?.showModal(); else dialog?.close();
    // Close before unmounting so the browser restores the invoking control.
    return () => dialog?.close();
  }, [active]);
  return <dialog ref={ref} className="modal" aria-labelledby="modal-title" onCancel={event => { event.preventDefault(); onClose(); }}>
    <header><h2 id="modal-title">{title}</h2><button className="icon-button" aria-label="Close dialog" onClick={onClose}><X size={18} /></button></header>
    {children}
  </dialog>;
}

export function App() { return <LibraryWorkspace />; }

export interface LibraryWorkspaceProps {
  /** Whether PDF shortcuts currently own the keyboard focus. */
  workspaceActive?: boolean;
  /** Whether the pane is shown and interactive, including beside focused notes. */
  workspaceVisible?: boolean;
  onAppearance?: () => void;
  pageLinkRequest?: PDFPageLinkRequest | null;
  onInsertPageLink?: (reference: PDFPageReference) => void;
  canInsertPageLink?: boolean;
  backlinks?: ReadonlyMap<string, readonly PDFNoteBacklink[]>;
  onOpenNote?: (path: string) => void;
  onDocumentsChange?: (documents: readonly PDFGraphDocument[]) => void;
  onResearch?: () => void;
  onArxiv?: () => void;
  libraryRevision?: number;
}

/** Mounted once per workspace visit session so filters and password sessions survive hiding. */
export function LibraryWorkspace({ workspaceActive = true, workspaceVisible = workspaceActive, onAppearance, pageLinkRequest, onInsertPageLink, canInsertPageLink = false, backlinks, onOpenNote, onDocumentsChange, onResearch, onArxiv, libraryRevision = 0 }: LibraryWorkspaceProps) {
  const integrated = !!onAppearance;
  const [documents, setDocuments] = useState<PDFDocument[]>([]);
  const [folders, setFolders] = useState<PDFFolder[]>([]);
  const foldersRef = useRef<PDFFolder[]>([]);
  const folderRevision = useRef(0);
  const [folderDialog, setFolderDialog] = useState<FolderDialog | null>(null);
  const [folderName, setFolderName] = useState('');
  const [folderError, setFolderError] = useState('');
  const [folderBusy, setFolderBusy] = useState(false);
  const folderBusyRef = useRef(false);
  const [movingId, setMovingId] = useState<string | null>(null);
  const movingRef = useRef(false);
  const dragRef = useRef<{ id: string; token: string } | null>(null);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const fileDragRef = useRef(false);
  const [draggingFiles, setDraggingFiles] = useState(false);
  const [libraryDropTarget, setLibraryDropTarget] = useState(false);
  const suppressOpen = useRef<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [warnings, setWarnings] = useState<string[]>([]);
  const [notice, setNotice] = useState<{ text: string; error: boolean } | null>(null);
  const [importing, setImporting] = useState(false);
  const importingRef = useRef(false);
  const navigationRevision = useRef(0);
  const visibleRef = useRef(workspaceVisible);
  visibleRef.current = workspaceVisible;
  const [urlImportOpen, setURLImportOpen] = useState(false);
  const loadRequest = useRef(0);
  const documentChanges = useRef(new Map<string, number>());
  const [filter, setFilter] = useState<Filter>('all');
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState('newest');
  const [layout, setLayout] = useState<'grid' | 'list'>('grid');
  const [activeId, setActiveId] = useState<string | null>(null);
  const [readerLinkRequest, setReaderLinkRequest] = useState<PDFPageLinkRequest | null>(null);
  const [missingLink, setMissingLink] = useState<PDFPageLinkRequest | null>(null);
  const handledLink = useRef<number | null>(null);
  const latestLink = useRef(pageLinkRequest);
  latestLink.current = pageLinkRequest;
  const [editingId, setEditingId] = useState<string | null>(null);
  const [title, setTitle] = useState('');
  const [tags, setTags] = useState('');
  const [detailFolder, setDetailFolder] = useState('');
  const [modalError, setModalError] = useState('');
  const [saving, setSaving] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [appearanceOpen, setAppearanceOpen] = useState(false);
  const [appearance, setAppearance] = useState(savedAppearance);
  const searchRef = useRef<HTMLInputElement>(null);
  const workspaceRef = useRef<HTMLDivElement>(null);
  const navigationRef = useRef<HTMLElement>(null);
  const navigationToggle = useRef<HTMLButtonElement>(null);
  const [compact, setCompact] = useState(false);
  const [navigationOpen, setNavigationOpen] = useState(false);

  useLayoutEffect(() => {
    const element = workspaceRef.current;
    if (!integrated || !element) return;
    const measure = () => {
      const width = element.getBoundingClientRect().width;
      // Hidden workspaces retain their last layout and reader session.
      if (width > 0) setCompact(width <= 900);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [integrated]);

  useLayoutEffect(() => {
    setNavigationOpen(false);
    if (compact && navigationRef.current?.contains(document.activeElement)) navigationToggle.current?.focus();
  }, [compact]);

  const closeNavigation = useCallback((restoreFocus = false) => {
    setNavigationOpen(false);
    if (restoreFocus) navigationToggle.current?.focus({ preventScroll: true });
  }, []);

  const cancelPageLink = useCallback(() => {
    // User navigation takes precedence even while the library is still opening.
    // Retaining the handled identity prevents later catalogue updates replaying it.
    handledLink.current = latestLink.current?.request ?? null;
    setReaderLinkRequest(null);
    setMissingLink(null);
  }, []);
  const openDocument = (id: string | null) => { navigationRevision.current++; cancelPageLink(); setActiveId(id); };

  useEffect(() => {
    if (!compact || !navigationOpen) return;
    const frame = requestAnimationFrame(() => {
      if (!dragRef.current && !fileDragRef.current && workspaceRef.current?.contains(document.activeElement)) navigationRef.current?.querySelector<HTMLButtonElement>('nav button')?.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(frame);
  }, [compact, navigationOpen]);

  const recordDocumentChange = useCallback((id: string) => {
    documentChanges.current.set(id, (documentChanges.current.get(id) ?? 0) + 1);
  }, []);
  const snapshotBaseline = useCallback(() => ({ documents: new Map(documentChanges.current), folders: folderRevision.current }), []);
  const applySnapshot = useCallback((library: LibrarySnapshot, baseline: ReturnType<typeof snapshotBaseline>, mutation?: { folder?: boolean; removedDocument?: string }) => {
    // Folder mutations invalidate older loads; document edits received while a
    // snapshot was in flight retain their newer title, tags, and reader state.
    if (mutation?.folder || baseline.folders === folderRevision.current) {
      foldersRef.current = library.folders;
      setFolders(library.folders);
    }
    if (mutation?.folder) folderRevision.current += 1;
    const validFolders = new Set(foldersRef.current.map(folder => folder.id));
    const receivedChanges = new Map(documentChanges.current);
    setDocuments(current => mergeFolderSnapshotDocuments(current, library.documents, baseline.documents, receivedChanges, validFolders, mutation?.removedDocument));
    setWarnings(library.warnings);
  }, [snapshotBaseline]);
  const load = useCallback(async (quiet = false) => {
    const request = ++loadRequest.current;
    const baseline = snapshotBaseline();
    if (!quiet) { setLoading(true); setLoadError(''); }
    try {
      const library = await window.prismPdf.loadLibrary();
      if (request !== loadRequest.current) return;
      applySnapshot(library, baseline);
    } catch (error) {
      if (request !== loadRequest.current) return;
      if (quiet) setNotice({ text: `The PDF library could not be refreshed. ${message(error)}`, error: true });
      else setLoadError(message(error));
    } finally { if (request === loadRequest.current) setLoading(false); }
  }, [applySnapshot, snapshotBaseline]);
  useEffect(() => { void load(); }, [load, libraryRevision]);
  useEffect(() => {
    if (!loading && !loadError) onDocumentsChange?.(documents);
  }, [documents, loading, loadError, onDocumentsChange]);
  useEffect(() => { if (integrated) return; try { localStorage.setItem('prism-pdf-appearance', JSON.stringify(appearance)); } catch { /* Appearance can still be used for this session. */ } }, [appearance, integrated]);

  useEffect(() => {
    if (!pageLinkRequest || pageLinkRequest.request === handledLink.current || loading || loadError) return;
    handledLink.current = pageLinkRequest.request;
    closeNavigation();
    setMissingLink(null);
    if (!documents.some(document => document.id === pageLinkRequest.documentId)) {
      setReaderLinkRequest(null);
      setMissingLink(pageLinkRequest);
      return;
    }
    setEditingId(null);
    if (!folderBusyRef.current) setFolderDialog(null);
    setReaderLinkRequest(pageLinkRequest);
    setActiveId(pageLinkRequest.documentId);
  }, [pageLinkRequest, loading, loadError, documents, closeNavigation]);

  const canImportFiles = useCallback((forDrop = false) => (forDrop ? workspaceVisible : workspaceActive) && !importingRef.current && !loading && !loadError
    && !movingRef.current && !folderBusyRef.current && !editingId && !folderDialog && !urlImportOpen
    && !document.querySelector('dialog[open]'), [workspaceActive, workspaceVisible, loading, loadError, editingId, folderDialog, urlImportOpen]);
  const importFiles = useCallback(async (files?: File[], requestedFolderId?: string | null) => {
    if (!canImportFiles(files !== undefined)) return;
    importingRef.current = true;
    const folderId = requestedFolderId === undefined ? (filter.startsWith('folder:') ? filter.slice(7) : null) : requestedFolderId;
    const destination = folderId ? foldersRef.current.find(folder => folder.id === folderId)?.name ?? 'the selected folder' : 'Unfiled';
    const destinationFilter: Filter = folderId ? `folder:${folderId}` : requestedFolderId === null || filter === 'unfiled' ? 'unfiled' : 'all';
    cancelPageLink();
    const linkAtImport = latestLink.current?.request;
    const navigationAtImport = navigationRevision.current;
    const baseline = snapshotBaseline();
    closeNavigation();
    setImporting(true);
    if (files) setNotice({ text: `Importing PDFs into ${destination}…`, error: false });
    try {
      const result = files ? await window.prismPdf.importDroppedDocuments(files, folderId) : await window.prismPdf.importDocuments(folderId);
      applySnapshot(result.library, baseline);
      result.importedIds.forEach(recordDocumentChange);
      if (result.importedIds.length || result.duplicateCount || result.errors.length) {
        const parts: string[] = [];
        if (result.importedIds.length) parts.push(`${result.importedIds.length} PDF${result.importedIds.length === 1 ? '' : 's'} added to ${destination}. Originals were kept.`);
        if (result.duplicateCount) parts.push(`${result.duplicateCount} already in your library. Existing folders and details are unchanged.`);
        parts.push(...result.errors);
        setNotice({ text: parts.join(' '), error: result.errors.length > 0 });
      }
      // Finishing an older import must not replace newer reader/filter navigation.
      if (result.importedIds.length && latestLink.current?.request === linkAtImport
        && navigationRevision.current === navigationAtImport && visibleRef.current) {
        setFilter(folderId && !foldersRef.current.some(folder => folder.id === folderId) ? 'unfiled' : destinationFilter);
        setQuery(''); setActiveId(null);
      }
    } catch (error) { setNotice({ text: message(error), error: true }); }
    finally { importingRef.current = false; setImporting(false); }
  }, [canImportFiles, filter, closeNavigation, cancelPageLink, recordDocumentChange, snapshotBaseline, applySnapshot]);

  const completeURLImport = useCallback((document: PDFDocument) => {
    recordDocumentChange(document.id);
    // Duplicate imports must not replace newer title, tag, or reading edits.
    setDocuments(current => current.some(item => item.id === document.id) ? current : [...current, document]);
    void load(true);
  }, [load, recordDocumentChange]);

  const update = useCallback(async (id: string, patch: DocumentPatch) => {
    const updated = await window.prismPdf.updateDocument(id, patch);
    recordDocumentChange(id);
    // A response started before a folder removal must not resurrect membership.
    if (updated.folderId && !foldersRef.current.some(folder => folder.id === updated.folderId)) delete updated.folderId;
    setDocuments(current => current.map(document => document.id === id ? updated : document));
    return updated;
  }, [recordDocumentChange]);
  const active = documents.find(document => document.id === activeId);
  const editing = documents.find(document => document.id === editingId);
  const readingUpdate = useCallback((patch: { lastPage?: number; pageCount?: number }) => {
    if (activeId) void update(activeId, patch).catch(error => setNotice({ text: message(error), error: true }));
  }, [activeId, update]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!workspaceActive || editingId || document.querySelector('dialog[open]') || event.defaultPrevented) return;
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'o') { event.preventDefault(); void importFiles(); }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); closeNavigation(); searchRef.current?.focus(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [importFiles, editingId, workspaceActive, closeNavigation]);

  const tagCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const document of documents) for (const tag of document.tags) counts.set(tag, (counts.get(tag) ?? 0) + 1);
    return [...counts.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [documents]);
  const tagCandidates = useMemo(() => tagCounts.map(([tag]) => tag), [tagCounts]);
  const favorites = documents.filter(document => document.favorite).length;
  const recentCount = documents.filter(document => document.lastOpenedAt).length;
  const filtered = useMemo(() => {
    const terms = query.toLocaleLowerCase().trim().split(/\s+/).filter(Boolean);
    return documents.filter(document => {
      if (filter === 'favorites' && !document.favorite) return false;
      if (filter === 'recent' && !document.lastOpenedAt) return false;
      if (filter === 'unfiled' && document.folderId) return false;
      if (filter.startsWith('folder:') && document.folderId !== filter.slice(7)) return false;
      if (filter.startsWith('tag:') && !document.tags.includes(filter.slice(4))) return false;
      const haystack = `${document.title} ${document.filename} ${document.arxivId || ''} ${document.tags.join(' ')}`.toLocaleLowerCase();
      return terms.every(term => haystack.includes(term));
    }).sort((a, b) => {
      if (sort === 'name') return a.title.localeCompare(b.title);
      if (sort === 'size') return b.size - a.size;
      if (filter === 'recent') return (b.lastOpenedAt ?? '').localeCompare(a.lastOpenedAt ?? '');
      return b.importedAt.localeCompare(a.importedAt);
    });
  }, [documents, filter, query, sort]);

  const folderCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const document of documents) counts.set(document.folderId ?? '', (counts.get(document.folderId ?? '') ?? 0) + 1);
    return counts;
  }, [documents]);
  const orderedFolders = useMemo(() => [...folders].sort((a, b) => a.name.localeCompare(b.name)), [folders]);
  const selectedFolder = filter.startsWith('folder:') ? folders.find(folder => folder.id === filter.slice(7)) : undefined;
  const heading = filter === 'unfiled' ? 'Unfiled' : filter.startsWith('folder:') ? selectedFolder?.name ?? 'Folder' : filter === 'all'  ? 'All documents' : filter === 'recent' ? 'Recently opened' : filter === 'favorites' ? 'Favorites' : filter.slice(4);
  const selectFilter = (value: Filter) => { setFilter(value); openDocument(null); setQuery(''); closeNavigation(compact && navigationOpen); };
  const edit = (document: PDFDocument) => { navigationRevision.current++; setEditingId(document.id); setTitle(document.title); setTags(document.tags.join(', ')); setDetailFolder(document.folderId ?? ''); setRemoving(false); setModalError(''); };
  const closeModal = () => { if (!saving) { setEditingId(null); setRemoving(false); } };
  const favorite = async (document: PDFDocument) => {
    try { await update(document.id, { favorite: !document.favorite }); }
    catch (error) { setNotice({ text: message(error), error: true }); }
  };
  const saveDetails = async (event: FormEvent) => {
    event.preventDefault(); if (!editing || saving) return;
    setSaving(true); setModalError('');
    try { await update(editing.id, { title: title.trim(), tags: tags.split(',').map(tag => tag.trim()).filter(Boolean), folderId: detailFolder || null }); setEditingId(null); }
    catch (error) { setModalError(message(error)); }
    finally { setSaving(false); }
  };
  const remove = async () => {
    if (!editing || saving) return;
    setSaving(true); setModalError('');
    try {
      const baseline = snapshotBaseline();
      const result = await window.prismPdf.removeDocument(editing.id);
      applySnapshot(result, baseline, { removedDocument: editing.id });
      recordDocumentChange(editing.id);
      setActiveId(current => current === editing.id ? null : current);
      setEditingId(null); setRemoving(false);
      setNotice({ text: 'Removed from your library. Your original PDF and stored copy were kept.', error: false });
    } catch (error) { setModalError(message(error)); }
    finally { setSaving(false); }
  };
  const nativeAction = async (kind: 'open' | 'reveal', id: string) => {
    try { if (kind === 'open') await window.prismPdf.openDocument(id); else await window.prismPdf.revealDocument(id); }
    catch (error) { setModalError(message(error)); }
  };
  const openFolderDialog = (folder?: PDFFolder) => {
    if (folderBusyRef.current || movingRef.current || importingRef.current || loading || loadError) return;
    setFolderDialog(folder ? { kind: 'edit', id: folder.id } : { kind: 'create' });
    setFolderName(folder?.name ?? ''); setFolderError(''); closeNavigation(compact && navigationOpen);
  };
  const closeFolderDialog = () => { if (!folderBusyRef.current) setFolderDialog(null); };
  const saveFolder = async (event?: FormEvent) => {
    event?.preventDefault();
    if (!folderDialog || folderBusyRef.current) return;
    folderBusyRef.current = true; setFolderBusy(true); setFolderError('');
    const operation = folderDialog;
    const baseline = snapshotBaseline();
    try {
      const result = operation.kind === 'create' ? await window.prismPdf.createFolder(folderName)
        : operation.kind === 'remove' ? await window.prismPdf.removeFolder(operation.id)
          : await window.prismPdf.renameFolder(operation.id, folderName);
      applySnapshot(result, baseline, { folder: true });
      if (operation.kind === 'remove') setFilter(current => current === `folder:${operation.id}` ? 'unfiled' : current);
      setFolderDialog(null);
      setNotice({ text: operation.kind === 'remove' ? 'Folder removed. Its PDFs are now in Unfiled.' : operation.kind === 'create' ? 'Folder created. Drag a PDF into it, or choose Folder in document details.' : 'Folder renamed.', error: false });
    } catch (error) { setFolderError(message(error)); }
    finally { folderBusyRef.current = false; setFolderBusy(false); }
  };
  const clearDrag = useCallback(() => {
    dragRef.current = null; fileDragRef.current = false;
    setDraggingId(null); setDropTarget(null); setDraggingFiles(false); setLibraryDropTarget(false);
  }, []);
  useEffect(() => {
    // Focus changes count as newer navigation, but a shown PDF pane can accept
    // an external file drop while the adjacent note retains keyboard focus.
    if (!workspaceActive) navigationRevision.current++;
    if (!workspaceVisible) clearDrag();
    window.addEventListener('blur', clearDrag);
    window.addEventListener('dragend', clearDrag);
    window.addEventListener('drop', clearDrag);
    const cancel = (event: KeyboardEvent) => { if (event.key === 'Escape') clearDrag(); };
    window.addEventListener('keydown', cancel);
    return () => {
      window.removeEventListener('blur', clearDrag);
      window.removeEventListener('dragend', clearDrag);
      window.removeEventListener('drop', clearDrag);
      window.removeEventListener('keydown', cancel);
    };
  }, [workspaceActive, workspaceVisible, clearDrag]);
  const beginDrag = (event: DragEvent<HTMLElement>, id: string) => {
    if (movingRef.current || folderBusyRef.current || importingRef.current || !workspaceActive || (event.target as Element).closest('.card-actions, .document-tags')) { event.preventDefault(); return; }
    const token = crypto.randomUUID();
    dragRef.current = { id, token }; suppressOpen.current = id;
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData(documentDragType, token);
    setDraggingId(id);
  };
  const internalDrag = (event: DragEvent) => !!dragRef.current && event.dataTransfer.types.includes(documentDragType) && !event.dataTransfer.types.includes('Files');
  const externalDrag = (event: DragEvent) => event.dataTransfer.types.includes('Files') && !event.dataTransfer.types.includes(documentDragType);
  const rememberFileDrag = () => { fileDragRef.current = true; setDraggingFiles(true); };
  const moveDocument = async (id: string, folderId: string | null) => {
    const document = documents.find(item => item.id === id);
    if (!document || (document.folderId ?? null) === folderId || movingRef.current || folderBusyRef.current || importingRef.current || !workspaceActive) return;
    const destination = folderId ? folders.find(folder => folder.id === folderId) : null;
    if (folderId && !destination) return;
    movingRef.current = true; setMovingId(id);
    try {
      await update(id, { folderId });
      setNotice({ text: `Moved “${document.title}” to ${destination?.name ?? 'Unfiled'}.`, error: false });
    } catch (error) { setNotice({ text: `The PDF could not be moved. ${message(error)}`, error: true }); }
    finally { movingRef.current = false; setMovingId(null); }
  };
  const folderDropProps = (folderId: string | null) => ({
    onDragOver: (event: DragEvent<HTMLButtonElement>) => {
      const fileDrop = externalDrag(event) && canImportFiles(true);
      if (!fileDrop && (!internalDrag(event) || movingRef.current || folderBusyRef.current || importingRef.current || !workspaceActive || document.querySelector('dialog[open]'))) return;
      event.preventDefault(); event.stopPropagation();
      event.dataTransfer.dropEffect = fileDrop ? 'copy' : 'move';
      if (fileDrop) rememberFileDrag();
      setLibraryDropTarget(false); setDropTarget(folderId ?? '');
    },
    onDragLeave: (event: DragEvent<HTMLButtonElement>) => {
      if (!(event.relatedTarget instanceof Node) || !event.currentTarget.contains(event.relatedTarget)) setDropTarget(current => current === (folderId ?? '') ? null : current);
    },
    onDrop: (event: DragEvent<HTMLButtonElement>) => {
      event.preventDefault(); event.stopPropagation();
      // Read File objects while the drop data store is accessible; the preload
      // resolves their native paths before starting the asynchronous import.
      const files = externalDrag(event) && canImportFiles(true) ? Array.from(event.dataTransfer.files) : null;
      const drag = dragRef.current;
      const accepted = internalDrag(event) && drag && event.dataTransfer.getData(documentDragType) === drag.token && !document.querySelector('dialog[open]');
      clearDrag();
      if (files) void importFiles(files, folderId);
      else if (accepted) void moveDocument(drag.id, folderId);
    },
  });
  const folderItem = (folder: PDFFolder | null) => {
    const id = folder?.id ?? '';
    const value: Filter = folder ? `folder:${id}` : 'unfiled';
    return <div className="pdf-folder-row" key={id}>
      <button {...folderDropProps(folder?.id ?? null)} className={`nav-item pdf-folder-target ${filter === value && !active ? 'selected' : ''} ${dropTarget === id ? 'pdf-drop-target' : ''}`} onClick={() => selectFilter(value)} aria-current={filter === value && !active ? 'page' : undefined} aria-label={folder ? `Folder ${folder.name}` : 'Unfiled'} title={folder?.name ?? 'Unfiled'}>
        <Folder size={18} /><span className="truncate">{folder?.name ?? 'Unfiled'}</span><span className="nav-count">{folderCounts.get(id) ?? 0}</span>
      </button>
      {folder && <button className="pdf-folder-manage" aria-label={`Manage folder ${folder.name}`} title={`Manage folder ${folder.name}`} disabled={folderBusy || !!movingId || loading || importing} onClick={() => openFolderDialog(folder)}><MoreHorizontal size={17} /></button>}
    </div>;
  };
  const navItem = (value: Filter, label: string, icon: ReactNode, count: number) => <button className={`nav-item ${filter === value && !active ? 'selected' : ''}`} onClick={() => selectFilter(value)} aria-current={filter === value && !active ? 'page' : undefined} aria-label={label}>
    {icon}<span>{label}</span><span className="nav-count">{count}</span>
  </button>;

  return <div ref={workspaceRef} className={`pdf-workspace ${integrated ? 'pdf-integrated' : 'pdf-standalone app-shell'}`} data-compact={compact} data-transparent={integrated ? undefined : appearance.transparent} style={integrated ? undefined : { '--surface-alpha': appearance.transparent ? appearance.opacity / 100 : 1 } as CSSProperties}
    onDragEnter={event => { if (externalDrag(event) && canImportFiles(true)) rememberFileDrag(); }}
    onDragOver={event => { event.preventDefault(); event.dataTransfer.dropEffect = 'none'; setDropTarget(null); setLibraryDropTarget(false); }}
    onDragLeave={event => {
      if (!(event.relatedTarget instanceof Node) || !event.currentTarget.contains(event.relatedTarget)) {
        // Preserve the internal drag token until drop/end, so leaving and
        // re-entering the window can still complete an existing library move.
        fileDragRef.current = false; setDraggingFiles(false); setLibraryDropTarget(false); setDropTarget(null);
      }
    }}
    onDrop={event => { event.preventDefault(); clearDrag(); }}
    onKeyDownCapture={event => { if (compact && navigationOpen && event.key === 'Escape' && !document.querySelector('dialog[open]')) { event.preventDefault(); event.stopPropagation(); clearDrag(); closeNavigation(true); } }}>
    {compact && navigationOpen && <button className="pdf-navigation-dismiss" aria-label="Dismiss library navigation" tabIndex={-1} onClick={() => closeNavigation(true)} />}
    <aside id="pdf-library-navigation" ref={navigationRef} className="sidebar" hidden={compact && !navigationOpen} inert={compact && !navigationOpen}>
      {compact && <button className="pdf-navigation-close" aria-label="Close library navigation" onClick={() => closeNavigation(true)}><X size={17} />Close</button>}
      {!integrated && <div className="brand"><span className="brand-mark"><Library size={23} strokeWidth={1.7} /></span><span>prism<span className="brand-pdf">PDF</span></span></div>}
      <div className="workspace-label"><span className="workspace-avatar">P</span><div>Personal library<small>Your space for documents</small></div></div>
      <nav className="library-nav" aria-label="Library">
        <p className="section-label">LIBRARY</p>
        {navItem('all', 'All documents', <Library size={18} />, documents.length)}
        {navItem('recent', 'Recently opened', <Clock3 size={18} />, recentCount)}
        {navItem('favorites', 'Favorites', <Star size={18} />, favorites)}
        <div className="pdf-folders-heading"><p className="section-label">FOLDERS</p><button aria-label="New folder" title="New folder" disabled={folderBusy || !!movingId || loading || !!loadError || importing} onClick={() => openFolderDialog()}><Plus size={17} /></button></div>
        <p className="pdf-folder-hint" id="pdf-folder-help">Drop PDF files here to import copies. Drag library PDFs to move them, or use Folder in document details.</p>
        <div className={`pdf-folders ${draggingId || draggingFiles ? 'pdf-folders-dragging' : ''}`} aria-label="PDF folders">{folderItem(null)}{orderedFolders.map(folderItem)}</div>
        <div className="tags-heading"><p className="section-label">YOUR TAGS</p><Tag size={13} /></div>
        {tagCounts.length ? tagCounts.map(([tag, count], index) => <button key={tag} className={`nav-item tag-item ${filter === `tag:${tag}` && !active ? 'selected' : ''}`} onClick={() => selectFilter(`tag:${tag}`)} aria-label={`Tag ${tag}`}><span className={`tag-dot tone-${index % 4}`} /><span className="truncate">{tag}</span><span className="nav-count">{count}</span></button>) : <p className="tag-hint">Add tags in document details<br />to keep things organized.</p>}
      </nav>
      <button className="appearance-button" onClick={() => onAppearance ? onAppearance() : setAppearanceOpen(value => !value)} aria-expanded={integrated ? undefined : appearanceOpen}><SlidersHorizontal size={15} />Appearance</button>
      {!integrated && appearanceOpen && <div className="appearance-panel"><label><span>Transparent window</span><input type="checkbox" role="switch" checked={appearance.transparent} onChange={event => setAppearance(current => ({ ...current, transparent: event.target.checked }))} /></label><label className="opacity-label">Background opacity<span>{appearance.opacity}%</span><input type="range" min="25" max="100" step="1" value={appearance.opacity} disabled={!appearance.transparent} onChange={event => setAppearance(current => ({ ...current, opacity: Number(event.target.value) }))} /></label></div>}
      <div className="local-card"><HardDrive size={18} /><div>Made for your desktop<small>Private. Local. All yours.</small></div><span className="online-dot" /></div>
      <div className="sidebar-footer"><span>{documents.length} documents</span><span>{documents.length ? formatSize(documents.reduce((sum, document) => sum + document.size, 0)) : '0 KB'}</span></div>
    </aside>
    <div className="workspace">
      <header className={integrated ? "pdf-library-heading" : "titlebar"}>
        {compact && <button ref={navigationToggle} className="pdf-library-toggle" aria-label="Library navigation" aria-controls="pdf-library-navigation" aria-expanded={navigationOpen} onDragEnter={event => {
          if (externalDrag(event) && canImportFiles(true)) { rememberFileDrag(); setNavigationOpen(true); }
          else if (internalDrag(event)) setNavigationOpen(true);
        }} onClick={() => setNavigationOpen(value => !value)}><PanelLeft size={17} /><span>Library</span></button>}
        <div className="breadcrumb"><span>Workspace</span><ChevronRight size={13} /><strong>{active ? active.title : 'My library'}</strong></div>
        <label className="search-box"><Search size={16} /><input ref={searchRef} aria-label="Search library" placeholder="Search your library…" value={query} onChange={event => { setQuery(event.target.value); openDocument(null); }} /><kbd>{window.prismPdf.platform === 'darwin' ? '⌘' : 'Ctrl'} K</kbd></label>
        {!integrated && <div className="window-controls"><button aria-label="Minimize window" onClick={() => window.prismPdf.windowControl('minimize')}><Minus size={14} /></button><button aria-label="Maximize or restore window" onClick={() => window.prismPdf.windowControl('maximize')}><Maximize2 size={13} /></button><button aria-label="Close window" onClick={() => window.prismPdf.windowControl('close')}><X size={16} /></button></div>}
      </header>
      {notice && <div className={`notice ${notice.error ? 'notice-error' : ''}`} role={notice.error ? 'alert' : 'status'}><span>{notice.text}</span><button aria-label="Dismiss notification" onClick={() => setNotice(null)}><X size={16} /></button></div>}
      {missingLink && <div className="notice notice-error pdf-link-notice" role="alert" aria-label="PDF link unavailable">
        <span>This linked PDF is not in this library. It may have been removed or belong to another profile. Close Prism before restoring its library backup, or open a PDF and insert a replacement link.</span>
        <div className="pdf-link-actions"><button onClick={() => selectFilter('all')}>Browse library</button><button aria-label="Dismiss PDF link error" onClick={cancelPageLink}><X size={16} /></button></div>
      </div>}
      {warnings.length > 0 && <details className="warnings"><summary>{warnings.length} library warning{warnings.length === 1 ? '' : 's'}</summary>{warnings.map((warning, index) => <p key={index}>{warning}</p>)}</details>}
      {active ? <PdfReader key={active.id} workspaceActive={workspaceActive} document={active} onUpdate={readingUpdate} onClose={() => openDocument(null)} pageLinkRequest={readerLinkRequest?.documentId === active.id ? readerLinkRequest : null} onInsertPageLink={onInsertPageLink} canInsertPageLink={canInsertPageLink} backlinks={backlinks?.get(active.id)} onOpenNote={onOpenNote} /> : <main className={`library-content ${libraryDropTarget ? 'pdf-file-drop-target' : ''}`} aria-describedby="pdf-file-drop-help"
        onDragOver={event => {
          if (!externalDrag(event) || !canImportFiles(true)) return;
          event.preventDefault(); event.stopPropagation(); event.dataTransfer.dropEffect = 'copy';
          rememberFileDrag(); setDropTarget(null); setLibraryDropTarget(true);
        }}
        onDragLeave={event => { if (!(event.relatedTarget instanceof Node) || !event.currentTarget.contains(event.relatedTarget)) setLibraryDropTarget(false); }}
        onDrop={event => {
          event.preventDefault(); event.stopPropagation();
          const files = externalDrag(event) && canImportFiles(true) ? Array.from(event.dataTransfer.files) : null;
          clearDrag();
          if (files) void importFiles(files);
        }}>
        <div className="page-heading"><div><div className="eyebrow">A LITTLE ORDER. A LOT OF CLARITY.</div><h1>{heading}</h1><p>{filter === 'all' ? 'Everything you need, all in one place.' : filter === 'favorites' ? 'The documents you come back to.' : filter === 'recent' ? 'Pick up right where you left off.' : 'A collection of things that belong together.'}</p></div><div className="library-heading-actions">{onArxiv && <button className="secondary-button" onClick={onArxiv} disabled={importing || loading}><Search size={17} />Search arXiv</button>}{onResearch && <button className="secondary-button" onClick={onResearch} disabled={importing || loading}><BookOpen size={17} />Rates &amp; Execution</button>}<button className="secondary-button" onClick={() => { closeNavigation(); setURLImportOpen(true); }} disabled={importing || loading || !!loadError}><Link2 size={17} />Import from URL</button><button className="primary-button" onClick={() => void importFiles()} disabled={importing || loading || !!loadError}>{importing ? <LoaderCircle className="spin" size={17} /> : <Plus size={19} />}{importing ? 'Importing…' : 'Import PDFs'}</button></div></div>
        <div className={`pdf-file-drop-hint ${libraryDropTarget ? 'active' : ''}`} id="pdf-file-drop-help"><FolderOpen size={20} /><div><strong>Drop PDFs into {selectedFolder?.name ?? 'Unfiled'}</strong><span>Copies are added to your library. Originals stay where they are.</span></div></div>
        <div className="library-toolbar"><div className="result-label"><FileText size={16} /><strong>{query ? 'Search results' : 'PDF documents'}</strong><span className="count-badge">{filtered.length}</span></div><div className="view-options"><ArrowDownUp size={14} /><select aria-label="Sort documents" value={sort} onChange={event => setSort(event.target.value)}><option value="newest">{filter === 'recent' ? 'Last opened' : 'Date added'}</option><option value="name">Name</option><option value="size">File size</option></select><span className="toolbar-divider" /><div className="layout-buttons"><button className={layout === 'grid' ? 'active' : ''} aria-label="Grid view" aria-pressed={layout === 'grid'} onClick={() => setLayout('grid')}><Grid2X2 size={16} /></button><button className={layout === 'list' ? 'active' : ''} aria-label="List view" aria-pressed={layout === 'list'} onClick={() => setLayout('list')}><List size={18} /></button></div></div></div>
        {loading ? <div className="empty-state" role="status"><LoaderCircle className="spin" size={30} /><h2>Opening your library…</h2></div> : loadError ? <div className="empty-state" role="alert"><FolderOpen size={36} /><h2>Your library couldn’t be opened</h2><p>{loadError}</p><button className="secondary-button" onClick={() => void load()}>Try again</button></div> : !documents.length ? <div className="empty-state welcome-state"><div className="paper-stack" aria-hidden="true"><div className="paper-back" /><div className="paper-front"><span className="pdf-badge">PDF</span><FileText size={45} strokeWidth={1} /><div className="paper-lines" /></div><span className="paper-spark"><Sparkles size={22} /></span></div><h2>A home for your PDFs.</h2><p>Bring your research, reading, and everyday documents<br />together in a space that stays yours.</p><button className="primary-button" onClick={() => void importFiles()} disabled={importing}><Plus size={18} />Import your first PDF</button><span className="privacy-note"><ShieldCheck size={14} />Stored on this device. No account needed.</span></div> : !filtered.length ? <div className="empty-state"><Search size={34} /><h2>{query ? 'No matching documents' : 'Nothing here just yet'}</h2><p>{query ? 'Try another title, filename, or tag.' : filter === 'favorites' ? 'Star a document to keep it close at hand.' : filter === 'recent' ? 'Open a PDF and find it here next time.' : filter === 'unfiled' || filter.startsWith('folder:') ? 'Move a PDF here from All documents by dragging it onto this folder, or use Folder in document details.' : 'Add this tag to a document to see it here.'}</p>{query && <button className="secondary-button" onClick={() => setQuery('')}>Clear search</button>}</div> : <div className={`documents documents-${layout}`} aria-label="Documents">
          {filtered.map((document, index) => <article key={document.id} data-document-id={document.id} className={`document-card ${draggingId === document.id ? 'pdf-document-dragging' : ''}`} draggable={!movingId && !folderBusy && !importing} aria-busy={movingId === document.id} onDragStart={event => beginDrag(event, document.id)} onDragEnd={clearDrag} onPointerDownCapture={() => { suppressOpen.current = null; }} onClickCapture={event => { if (event.detail > 0 && suppressOpen.current === document.id) { event.preventDefault(); event.stopPropagation(); suppressOpen.current = null; } }}>
            <span className="pdf-drag-handle" title="Drag to a folder. You can also use Folder in document details." aria-hidden="true"><GripVertical size={15} /></span>
            {layout === 'grid' ? <button className={`document-preview preview-tone-${index % 4}`} aria-label={`Open ${document.title}`} onClick={() => openDocument(document.id)}><PdfThumbnail document={document} /><span className="preview-open"><BookOpen size={16} />Read document</span></button> : <button className="list-file-icon" aria-label={`Open ${document.title}`} onClick={() => openDocument(document.id)}><FileText size={24} /></button>}
            <div className="document-info"><button className="document-title" onClick={() => openDocument(document.id)} title={document.title}>{document.title}</button><div className="document-meta"><span>{formatSize(document.size)}</span><span>·</span><span>{document.pageCount ? `${document.pageCount} page${document.pageCount === 1 ? '' : 's'}` : 'PDF document'}</span></div>{document.tags.length > 0 && <div className="document-tags">{document.tags.slice(0, 2).map(tag => <button key={tag} onClick={() => selectFilter(`tag:${tag}`)}>{tag}</button>)}{document.tags.length > 2 && <span>+{document.tags.length - 2}</span>}</div>}</div>
            {layout === 'list' && <span className="document-date">{dateLabel(document.importedAt)}</span>}
            <div className="card-actions"><button className={`icon-button favorite-button ${document.favorite ? 'is-favorite' : ''}`} aria-label={`${document.favorite ? 'Unfavorite' : 'Favorite'} ${document.title}`} aria-pressed={document.favorite} onClick={() => void favorite(document)}><Star size={16} fill={document.favorite ? 'currentColor' : 'none'} /></button><button className="icon-button details-button" aria-label={`Details for ${document.title}`} onClick={() => edit(document)}><MoreHorizontal size={19} /></button></div>
          </article>)}
        </div>}
        {!loading && !loadError && documents.length > 0 && <footer className="library-footer"><span>Showing {filtered.length} of {documents.length} documents</span><span><ShieldCheck size={13} />Your library stays on this device</span></footer>}
      </main>}
    </div>
    {urlImportOpen && <URLImportDialog active={workspaceActive} onClose={() => setURLImportOpen(false)} onComplete={completeURLImport} onRefresh={() => void load(true)} onOpenPDF={id => { setURLImportOpen(false); openDocument(id); }} />}
    {folderDialog && <Modal title={folderDialog.kind === 'create' ? 'New folder' : folderDialog.kind === 'remove' ? 'Remove folder?' : 'Edit folder'} onClose={closeFolderDialog} active={workspaceActive}>
      {folderDialog.kind === 'remove' ? <>
        <p className="modal-description">Remove <strong>{folders.find(folder => folder.id === folderDialog.id)?.name ?? folderName}</strong>? Its PDFs will move to Unfiled. Your PDFs, tags, favorites, reading positions, and note links will be kept.</p>
        {folderError && <p className="form-error" role="alert">{folderError}</p>}
        <div className="modal-actions"><button className="secondary-button" disabled={folderBusy} onClick={() => { setFolderDialog({ kind: 'edit', id: folderDialog.id }); setFolderError(''); }}>Keep folder</button><button className="danger-button" disabled={folderBusy} onClick={() => void saveFolder()}>{folderBusy ? 'Removing…' : 'Remove folder'}</button></div>
      </> : <form onSubmit={saveFolder}>
        <label className="field-label">Folder name<input autoFocus={workspaceActive} required maxLength={80} value={folderName} onChange={event => setFolderName(event.target.value)} disabled={folderBusy} /></label>
        {folderError && <p className="form-error" role="alert">{folderError}</p>}
        <div className="modal-actions">
          {folderDialog.kind === 'edit' && <button type="button" className="remove-link" disabled={folderBusy} onClick={() => { setFolderDialog({ kind: 'remove', id: folderDialog.id }); setFolderError(''); }}><Trash2 size={16} />Remove folder</button>}
          <button type="button" className="secondary-button" disabled={folderBusy} onClick={closeFolderDialog}>Cancel</button>
          <button className="primary-button" disabled={folderBusy || !folderName.trim()}>{folderBusy ? <LoaderCircle className="spin" size={16} /> : <Check size={16} />}{folderBusy ? 'Saving…' : folderDialog.kind === 'create' ? 'Create folder' : 'Save folder'}</button>
        </div>
      </form>}
    </Modal>}
    {editing && <Modal title={removing ? 'Remove from library?' : 'Edit document'} onClose={closeModal} active={workspaceActive}>
      {removing ? <><p className="modal-description">Remove <strong>{editing.title}</strong> from the library? Your original PDF and stored copy will be kept. This removes its tags, favorite, and reading position from the catalog.</p>{modalError && <p className="form-error" role="alert">{modalError}</p>}<div className="modal-actions"><button className="secondary-button" disabled={saving} onClick={() => setRemoving(false)}>Keep document</button><button className="danger-button" disabled={saving} onClick={() => void remove()}>{saving ? 'Removing…' : 'Remove document'}</button></div></> : <form onSubmit={saveDetails}>
        <label className="field-label">Document title<input autoFocus={workspaceActive} required maxLength={200} value={title} onChange={event => setTitle(event.target.value)} /></label>
        <TagInput key={editing.id} value={tags} onChange={setTags} candidates={tagCandidates} disabled={saving} />
        <label className="field-label">Folder<select value={detailFolder} onChange={event => setDetailFolder(event.target.value)}><option value="">Unfiled</option>{orderedFolders.map(folder => <option key={folder.id} value={folder.id}>{folder.name}</option>)}</select></label>
        <div className="file-facts"><span>Original filename<strong>{editing.filename}</strong></span><span>Added<strong>{dateLabel(editing.importedAt)}</strong></span><span>File size<strong>{formatSize(editing.size)}</strong></span></div>
        <div className="native-actions"><button type="button" onClick={() => void nativeAction('open', editing.id)}><ArrowUpRight size={15} />Open in default app</button><button type="button" onClick={() => void nativeAction('reveal', editing.id)}><FolderOpen size={15} />Show library copy</button></div>
        {modalError && <p className="form-error" role="alert">{modalError}</p>}
        <div className="modal-actions"><button type="button" className="remove-link" onClick={() => { setRemoving(true); setModalError(''); }} disabled={saving}><Trash2 size={16} />Remove</button><button type="button" className="secondary-button" onClick={closeModal} disabled={saving}>Cancel</button><button className="primary-button" disabled={saving || !title.trim()}>{saving ? <LoaderCircle className="spin" size={16} /> : <Check size={16} />}{saving ? 'Saving…' : 'Save changes'}</button></div>
      </form>}
    </Modal>}
  </div>;
}
