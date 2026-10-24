import { useEffect, useId, useRef, useState } from 'react';
import { Check, Pencil, Plus, Trash2 } from 'lucide-react';
import { customSnippetLimits, validateCustomSnippet } from './customSnippets';
import type { MarkdownSnippet } from './snippetDefinitions';

interface Props {
  snippets: readonly MarkdownSnippet[];
  onChange: (snippets: MarkdownSnippet[]) => string | null;
}

const blankSnippet = (): MarkdownSnippet => ({ trigger: '/', title: '', description: '', template: '', block: true });

export function SnippetSettings({ snippets, onChange }: Props) {
  const id = useId();
  const name = useRef<HTMLInputElement>(null);
  const [draft, setDraft] = useState<MarkdownSnippet | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [status, setStatus] = useState('');
  const formOpen = draft !== null;

  useEffect(() => { if (formOpen) name.current?.focus(); }, [formOpen]);

  const startEditing = (snippet?: MarkdownSnippet) => {
    setDraft(snippet ? { ...snippet } : blankSnippet());
    setEditing(snippet?.trigger ?? null);
    setDeleting(null);
    setError('');
    setStatus('');
  };
  const update = (patch: Partial<MarkdownSnippet>) => {
    setDraft(previous => previous ? { ...previous, ...patch } : previous);
    setError('');
  };
  const cancel = () => { setDraft(null); setEditing(null); setError(''); };

  return <section className="custom-snippets" aria-labelledby={`${id}-heading`}>
    <div className="custom-snippets-heading">
      <h3 id={`${id}-heading`}>Your snippets</h3>
      {!draft && <button type="button" className="subtle-button" disabled={snippets.length >= customSnippetLimits.count} onClick={() => startEditing()}><Plus size={15} />Add snippet</button>}
    </div>
    <p className="field-help">Save reusable Markdown for all your notebooks on this device.</p>
    {!draft && !snippets.length && <p className="custom-snippets-empty">Add a template for a meeting, a journal entry, or something you write often.</p>}
    {!draft && snippets.length >= customSnippetLimits.count && <p className="field-help">You have reached the limit of {customSnippetLimits.count} custom snippets. Edit or delete one to make room.</p>}

    {!draft && snippets.length > 0 && <ul className="custom-snippet-list">{snippets.map(snippet => <li key={snippet.trigger}>
      <div className="custom-snippet-summary"><div><code>{snippet.trigger}</code><strong>{snippet.title}</strong></div><p>{snippet.description || (snippet.block ? 'On an empty line' : 'Also inside a sentence')}</p></div>
      <div className="custom-snippet-actions">
        <button type="button" className="subtle-button" aria-label={`Edit ${snippet.trigger}`} onClick={() => startEditing(snippet)}><Pencil size={14} />Edit</button>
        <button type="button" className="subtle-button" aria-label={`Delete ${snippet.trigger}`} onClick={() => { setDeleting(snippet.trigger); setError(''); setStatus(''); }}><Trash2 size={14} />Delete</button>
      </div>
      {deleting === snippet.trigger && <div className="snippet-delete-confirmation">
        <p>Delete <code>{snippet.trigger}</code>?</p>
        <div className="custom-snippet-actions"><button type="button" className="subtle-button" onClick={() => { setDeleting(null); setError(''); }}>Cancel deletion</button><button type="button" className="subtle-button" onClick={() => {
          const failure = onChange(snippets.filter(item => item.trigger !== snippet.trigger));
          if (failure) { setError(failure); return; }
          setDeleting(null);
          setError('');
          setStatus(`Deleted ${snippet.trigger}.`);
        }}>Delete snippet</button></div>
      </div>}
    </li>)}</ul>}

    {draft && <form className="snippet-form" noValidate onSubmit={event => {
      event.preventDefault();
      const candidate = { ...draft, trigger: draft.trigger.trim(), title: draft.title.trim(), description: draft.description.trim() };
      const others = snippets.filter(snippet => snippet.trigger !== editing);
      const invalid = validateCustomSnippet(candidate, others);
      if (invalid) { setError(invalid); return; }
      const next = editing ? snippets.map(snippet => snippet.trigger === editing ? candidate : snippet) : [...snippets, candidate];
      const failure = onChange(next);
      if (failure) { setError(failure); return; }
      cancel();
      setStatus(`Saved ${candidate.trigger}.`);
    }}>
      <h4>{editing ? `Edit ${editing}` : 'New snippet'}</h4>
      <div className="snippet-form-fields">
        <div><label className="field-label" htmlFor={`${id}-name`}>Name</label><input ref={name} id={`${id}-name`} className="text-input" value={draft.title} maxLength={customSnippetLimits.title} onChange={event => update({ title: event.target.value })} placeholder="Meeting notes" /></div>
        <div><label className="field-label" htmlFor={`${id}-shortcut`}>Shortcut</label><input id={`${id}-shortcut`} className="text-input snippet-shortcut-input" value={draft.trigger} maxLength={33} onChange={event => update({ trigger: event.target.value })} placeholder="/meeting" spellCheck={false} autoComplete="off" autoCapitalize="off" aria-describedby={`${id}-shortcut-help`} /></div>
      </div>
      <p id={`${id}-shortcut-help`} className="field-help">Start with a lowercase letter after /. Use up to 32 letters, digits, underscores, or hyphens. Each shortcut must be unique.</p>
      <label className="field-label" htmlFor={`${id}-description`}>Description (optional)</label><input id={`${id}-description`} className="text-input" value={draft.description} maxLength={customSnippetLimits.description} onChange={event => update({ description: event.target.value })} placeholder="A short agenda and action items" />
      <label className="field-label snippet-template-label" htmlFor={`${id}-template`}>Template</label><textarea id={`${id}-template`} className="text-input snippet-template-input" rows={7} value={draft.template} maxLength={customSnippetLimits.template} onChange={event => update({ template: event.target.value })} placeholder={'## ${1:Meeting}\n\n- [ ] ${2:Action}\n${0}'} spellCheck={false} aria-describedby={`${id}-template-help`} />
      <p id={`${id}-template-help`} className="field-help">Write Markdown, with optional fields such as <code>{'${1:Text}'}</code> and <code>{'${2:More text}'}</code>. Tab moves through fields; <code>{'${0}'}</code> marks the final cursor position. To insert literal braces, write <code>{'\\{'}</code> and <code>{'\\}'}</code>.</p>
      <label className="snippet-inline-option"><input type="checkbox" checked={!draft.block} onChange={event => update({ block: !event.target.checked })} />Allow inside a sentence</label>
      <p className="field-help">Otherwise, the shortcut only expands on an empty line. Sentence snippets also work after a space in prose.</p>
      {error && <p className="inline-error" role="alert">{error}</p>}
      <div className="modal-actions"><button type="button" className="subtle-button" onClick={cancel}>Cancel editing</button><button type="submit" className="primary-button"><Check size={15} />Save snippet</button></div>
    </form>}
    {!draft && error && <p className="inline-error" role="alert">{error}</p>}
    {status && <p className="snippet-status field-help" role="status">{status}</p>}
  </section>;
}
