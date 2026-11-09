import { useId, useLayoutEffect, useRef } from 'react';
import { X } from 'lucide-react';
import { defaultMarkdownLayout, moreWritingSpace, type MarkdownLayout } from './markdownLayout';

const options: { key: keyof MarkdownLayout; label: string; help: string }[] = [
  {
    key: 'heading',
    label: 'Document heading',
    help: 'Show the large title and note details. When hidden, editor modes move to the compact toolbar.',
  },
  {
    key: 'paneLabels',
    label: 'Editor labels and hints',
    help: 'Show the label and hint bars above the editor and preview.',
  },
  {
    key: 'saveNotifications',
    label: 'Save notifications',
    help: 'Show the saved confirmation banner. Errors and warnings stay visible.',
  },
  {
    key: 'topicTools',
    label: 'Topic tools',
    help: 'Show New topic and Move tab to in Notes and Read & write. Your tabs stay available when these tools are hidden.',
  },
  {
    key: 'compact',
    label: 'Compact spacing',
    help: 'Reduce spacing in the editor controls and document heading.',
  },
];

export function MarkdownLayoutSettings({ layout, onChange, onClose }: {
  layout: MarkdownLayout;
  onChange: (value: MarkdownLayout) => void;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const id = useId();
  useLayoutEffect(() => {
    const element = dialog.current;
    if (element && !element.open) element.showModal();
    return () => { if (element?.open) element.close(); };
  }, []);

  return <dialog ref={dialog} className="modal markdown-layout-modal" aria-label="Markdown layout" onCancel={event => {
    event.preventDefault();
    onClose();
  }}>
    <div className="modal-heading">
      <h2>Markdown layout</h2>
      <button type="button" className="icon-button" aria-label="Close dialog" onClick={onClose}><X size={18} /></button>
    </div>
    <p className="modal-description">Choose how much space the editor controls use. Changes apply immediately and are remembered.</p>
    <div className="markdown-layout-presets">
      <button type="button" className="subtle-button" onClick={() => onChange(moreWritingSpace(layout))}>More writing space</button>
      <button type="button" className="subtle-button" onClick={() => onChange({ ...defaultMarkdownLayout })}>Reset layout</button>
    </div>
    <div className="markdown-layout-options">
      {options.map(({ key, label, help }) => <label className="markdown-layout-option" key={key}>
        <input type="checkbox" checked={layout[key]} aria-labelledby={`${id}-${key}-label`} aria-describedby={`${id}-${key}-help`}
          onChange={event => onChange({ ...layout, [key]: event.currentTarget.checked })} />
        <span>
          <strong id={`${id}-${key}-label`}>{label}</strong>
          <span className="field-help" id={`${id}-${key}-help`}>{help}</span>
        </span>
      </label>)}
    </div>
    <p className="field-help">Layout changes do not affect your notes, drafts, or saving.</p>
    <div className="modal-actions"><button type="button" className="primary-button" onClick={onClose}>Done</button></div>
  </dialog>;
}
