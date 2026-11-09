import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';
import { BookOpen, ChevronDown, ChevronRight, FileText, Pencil, Plus, X } from 'lucide-react';
import { addTabGroup, moveTab, removeTabGroup, renameTabGroup, TAB_LIMITS, toggleTabGroup, type DocumentTab, type TabGroup, type TabSession } from './documentTabState';
import './document-tabs.css';

interface DocumentTabsProps {
  session: TabSession;
  /** The focused pane may instead show the library or graph. */
  activeKey: string | null;
  labels: ReadonlyMap<string, { title: string; detail: string; dirty?: boolean }>;
  disabled: boolean;
  onSelect: (key: string) => void;
  onClose: (key: string) => void;
  onChange: (update: (state: TabSession) => TabSession) => void;
}

type TopicDialog = { kind: 'create' } | { kind: 'rename' | 'remove'; id: string };

export function DocumentTabs({ session, activeKey, labels, disabled, onSelect, onClose, onChange }: DocumentTabsProps) {
  const [dialog, setDialog] = useState<TopicDialog | null>(null);
  const [name, setName] = useState('');
  const [error, setError] = useState('');
  const dialogRef = useRef<HTMLDialogElement>(null);
  const rows = useRef<HTMLDivElement>(null);
  const addButton = useRef<HTMLButtonElement>(null);
  const active = session.tabs.find(tab => tab.key === activeKey);
  const targetGroup = session.groups.find(group => group.id === session.targetGroupId);
  const dialogGroup = dialog && dialog.kind !== 'create' ? session.groups.find(group => group.id === dialog.id) : undefined;
  const dialogTitle = dialog?.kind === 'create' ? 'New topic' : dialog?.kind === 'rename' ? 'Rename topic' : 'Remove topic';

  useEffect(() => {
    const element = dialogRef.current;
    if (!dialog || !element) return;
    element.showModal();
    return () => element.close();
  }, [dialog]);

  useLayoutEffect(() => {
    const container = rows.current;
    if (!container || !activeKey) return;
    // Only scroll this strip, never a reader/editor or the application window.
    const button = [...container.querySelectorAll<HTMLElement>('[role="tab"]')].find(element => element.dataset.tabKey === activeKey);
    if (!button || !button.getClientRects().length) return;
    const strip = container.getBoundingClientRect();
    const tab = button.getBoundingClientRect();
    if (tab.top < strip.top) container.scrollTop -= strip.top - tab.top + 4;
    else if (tab.bottom > strip.bottom) container.scrollTop += tab.bottom - strip.bottom + 4;
  }, [activeKey, session.tabs, session.groups]);

  const beginTopic = (next: TopicDialog, initial = '') => {
    setName(initial); setError(''); setDialog(next);
  };
  const closeDialog = () => {
    if (disabled) return;
    setDialog(null); setError('');
    requestAnimationFrame(() => {
      if (document.activeElement === document.body) addButton.current?.focus({ preventScroll: true });
    });
  };
  const applyTopic = () => {
    if (!dialog || disabled) return;
    const update = (state: TabSession) => dialog.kind === 'create' ? addTabGroup(state, name)
      : dialog.kind === 'rename' ? renameTabGroup(state, dialog.id, name) : removeTabGroup(state, dialog.id);
    try {
      // Validate before asking React to apply an updater, so a bad name remains
      // an inline form error instead of throwing during a render.
      update(session);
      onChange(update);
      closeDialog();
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'This topic could not be updated.'); }
  };

  const keyboard = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!(event.target instanceof HTMLElement) || event.target.getAttribute('role') !== 'tab') return;
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    const buttons = [...(rows.current?.querySelectorAll<HTMLButtonElement>('[role="tab"]:not(:disabled)') ?? [])]
      .filter(button => button.getClientRects().length > 0);
    const index = buttons.indexOf(event.target as HTMLButtonElement);
    if (index < 0 || !buttons.length) return;
    event.preventDefault();
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1
      : (index + (event.key === 'ArrowRight' ? 1 : -1) + buttons.length) % buttons.length;
    // Focus and selection stay separate: Enter/Space activates the tab.
    buttons[next].focus({ preventScroll: true });
    const container = rows.current!;
    const top = container.getBoundingClientRect().top;
    const rect = buttons[next].getBoundingClientRect();
    if (rect.top < top) container.scrollTop -= top - rect.top + 4;
    else if (rect.bottom > top + container.clientHeight) container.scrollTop += rect.bottom - top - container.clientHeight + 4;
  };

  const tab = (entry: DocumentTab) => {
    const label = labels.get(entry.key) ?? { title: entry.id, detail: entry.id };
    const kind = entry.kind === 'note' ? 'Markdown' : 'PDF';
    return <div className="document-tab" key={entry.key} data-tab-key={entry.key} data-selected={entry.key === activeKey}>
      <button type="button" className="document-tab-select" role="tab" aria-selected={entry.key === activeKey}
        aria-label={`${label.title} · ${kind}${label.dirty ? ' · Unsaved changes' : ''}`} aria-controls={entry.kind === 'note' ? 'notes-workspace' : 'pdfs-workspace'}
        data-tab-key={entry.key} title={`${label.detail}\n${kind}${label.dirty ? ' · Unsaved changes' : ''}`}
        disabled={disabled} onClick={() => onSelect(entry.key)}>
        {entry.kind === 'note' ? <FileText size={14} /> : <BookOpen size={14} />}
        <span className="document-tab-title">{label.title}</span>
        {label.dirty && <span className="document-tab-dirty" aria-hidden="true" />}
      </button>
      <button type="button" className="document-tab-close" aria-label={`Close tab ${label.title}`} title="Close tab" disabled={disabled} onClick={() => onClose(entry.key)}><X size={13} /></button>
    </div>;
  };

  const group = (group: TabGroup | null) => {
    const entries = session.tabs.filter(tab => tab.groupId === (group?.id ?? null));
    if (!group && !entries.length) return null;
    return <section className="document-tab-group" key={group ? `topic:${group.id}` : 'ungrouped'} data-group-id={group?.id ?? ''} aria-label={group ? `Topic ${group.name}` : 'Ungrouped tabs'}>
      {(group || session.groups.length > 0) && <div className="document-tab-group-heading" data-target={session.targetGroupId === (group?.id ?? null)}>
        {group && <button type="button" className="document-topic-collapse" disabled={disabled} aria-label={`${group.collapsed ? 'Expand' : 'Collapse'} topic ${group.name}`} aria-expanded={!group.collapsed}
          onClick={() => onChange(state => toggleTabGroup(state, group.id))}>{group.collapsed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}</button>}
        <button type="button" className="document-topic-name" disabled={disabled} aria-label={`Use topic ${group?.name ?? 'Ungrouped'} for new tabs`} aria-pressed={session.targetGroupId === (group?.id ?? null)}
          title="Open new documents in this topic" onClick={() => onChange(state => ({ ...state, targetGroupId: group?.id ?? null }))}>{group?.name ?? 'Ungrouped'}<span>{entries.length}</span></button>
        {group && <div className="document-topic-actions">
          <button type="button" disabled={disabled} aria-label={`Rename topic ${group.name}`} title="Rename topic" onClick={() => beginTopic({ kind: 'rename', id: group.id }, group.name)}><Pencil size={12} /></button>
          <button type="button" disabled={disabled} aria-label={`Remove topic ${group.name}`} title="Remove topic; keep its tabs" onClick={() => beginTopic({ kind: 'remove', id: group.id })}><X size={13} /></button>
        </div>}
      </div>}
      <div className="document-tab-row" role="tablist" aria-label={group ? `${group.name} tabs` : 'Open documents'} hidden={group?.collapsed}>
        {entries.map(tab)}
        {group && entries.length === 0 && <span className="document-topic-empty">Open a note or PDF in this topic.</span>}
      </div>
    </section>;
  };

  return <>
    <div className="document-tabs" aria-label="Document tabs" aria-busy={disabled}>
      <div className="document-tabs-tools">
        <button ref={addButton} type="button" className="document-topic-add" disabled={disabled || session.groups.length >= TAB_LIMITS.groups} onClick={() => beginTopic({ kind: 'create' })}><Plus size={14} />New topic</button>
        <label className="document-tab-move"><span>Move tab to</span><select aria-label="Move tab to topic" disabled={disabled || !active} value={active?.groupId ?? ''}
          onChange={event => { const groupId = event.target.value || null; if (active) onChange(state => moveTab(state, active.key, groupId)); }}>
          <option value="">Ungrouped</option>{session.groups.map(group => <option key={group.id} value={group.id}>{group.name}</option>)}
        </select></label>
        <span className="document-tabs-destination" title={`New tabs open in ${targetGroup?.name ?? 'Ungrouped'}`}>New tabs: {targetGroup?.name ?? 'Ungrouped'}</span>
      </div>
      <div ref={rows} className="document-tabs-scroll" onKeyDown={keyboard}>
        {group(null)}{session.groups.map(group)}
        {!session.tabs.length && !session.groups.length && <p className="document-tabs-empty">Open a note or PDF to start a tab.</p>}
      </div>
    </div>
    {dialog && <dialog ref={dialogRef} className="modal document-topic-dialog" aria-label={dialogTitle} onCancel={event => { event.preventDefault(); closeDialog(); }}>
      <div className="modal-heading"><h2>{dialogTitle}</h2><button type="button" className="icon-button" disabled={disabled} aria-label="Close dialog" onClick={closeDialog}><X size={18} /></button></div>
      <form onSubmit={event => { event.preventDefault(); applyTopic(); }}>
        {dialog.kind === 'remove' ? <p className="modal-description">Remove “{dialogGroup?.name}”? Its tabs will stay open in Ungrouped. Files are kept.</p> : <>
          <label className="field-label" htmlFor="document-topic-name">Topic name</label>
          <input id="document-topic-name" className="text-input" autoFocus value={name} disabled={disabled} maxLength={TAB_LIMITS.name} onChange={event => { setName(event.target.value); setError(''); }} placeholder="Research, trading, ideas…" />
          <p className="field-help">Keep related Markdown notes and PDFs together. New documents open in the selected topic.</p>
        </>}
        {error && <p className="inline-error" role="alert">{error}</p>}
        <div className="modal-actions"><button type="button" className="subtle-button" disabled={disabled} onClick={closeDialog}>Cancel</button>
          <button type="submit" className="primary-button" disabled={disabled || (dialog.kind !== 'remove' && !name.trim())}>{dialog.kind === 'create' ? 'Create topic' : dialog.kind === 'rename' ? 'Rename topic' : 'Remove topic'}</button></div>
      </form>
    </dialog>}
  </>;
}
