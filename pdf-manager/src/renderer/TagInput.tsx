import { useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { getTagSuggestions, insertTagSuggestion } from './tagSuggestions';
import './tag-input.css';

interface TagInputProps {
  value: string;
  onChange: (value: string) => void;
  candidates: readonly string[];
  disabled?: boolean;
}

export function TagInput({ value, onChange, candidates, disabled = false }: TagInputProps) {
  const id = useId();
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const composing = useRef(false);
  const pendingCaret = useRef<number | null>(null);
  const [selection, setSelection] = useState({ start: value.length, end: value.length });
  const [open, setOpen] = useState(false);
  const [compositionActive, setCompositionActive] = useState(false);
  const [highlighted, setHighlighted] = useState<string | null>(null);
  const suggestions = useMemo(() => getTagSuggestions(value, selection.start, selection.end, candidates), [value, selection, candidates]);
  const options = suggestions.options.slice(0, 40);
  const expanded = open && !disabled && !compositionActive && options.length > 0;
  const activeIndex = expanded && highlighted !== null ? options.indexOf(highlighted) : -1;

  useLayoutEffect(() => {
    if (pendingCaret.current === null || !input.current) return;
    const caret = pendingCaret.current;
    pendingCaret.current = null;
    input.current.focus({ preventScroll: true });
    input.current.setSelectionRange(caret, caret);
  }, [value]);

  useLayoutEffect(() => {
    if (activeIndex >= 0) list.current?.children[activeIndex]?.scrollIntoView({ block: 'nearest' });
  }, [activeIndex]);

  function readSelection(element: HTMLInputElement) {
    const start = element.selectionStart ?? element.value.length;
    const end = element.selectionEnd ?? start;
    if (selection.start !== start || selection.end !== end) setHighlighted(null);
    setSelection(current => current.start === start && current.end === end ? current : { start, end });
  }

  function choose(tag: string) {
    if (disabled || composing.current || !suggestions.options.includes(tag)) return;
    const replacement = insertTagSuggestion(value, suggestions, tag);
    if (!replacement) return;
    pendingCaret.current = replacement.caret;
    setSelection({ start: replacement.caret, end: replacement.caret });
    setHighlighted(null);
    setOpen(true);
    onChange(replacement.value);
  }

  return <div className="pdf-tag-input">
    <label className="field-label" htmlFor={id}>Tags (comma-separated)
      <input ref={input} id={id} role="combobox" aria-autocomplete="list" aria-expanded={expanded}
        aria-controls={expanded ? `${id}-options` : undefined}
        aria-activedescendant={activeIndex >= 0 ? `${id}-option-${activeIndex}` : undefined}
        aria-describedby={`${id}-help`} autoComplete="off" placeholder="Research, Reading, Work"
        maxLength={800} value={value} disabled={disabled}
        onFocus={event => { readSelection(event.currentTarget); setOpen(true); setHighlighted(null); }}
        onBlur={() => { setOpen(false); setHighlighted(null); }}
        onSelect={event => readSelection(event.currentTarget)}
        onChange={event => { readSelection(event.currentTarget); setHighlighted(null); setOpen(true); onChange(event.target.value); }}
        onCompositionStart={() => { composing.current = true; setCompositionActive(true); setHighlighted(null); }}
        onCompositionEnd={event => { composing.current = false; setCompositionActive(false); readSelection(event.currentTarget); setOpen(true); }}
        onKeyDown={event => {
          if (composing.current || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) {
            // Leave conversion and confirmation keys to the native IME.
            return;
          }
          if (event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return;
          if (event.key === 'Escape' && expanded) {
            event.preventDefault(); event.stopPropagation(); setOpen(false); setHighlighted(null);
          } else if ((event.key === 'ArrowDown' || event.key === 'ArrowUp') && options.length) {
            event.preventDefault(); setOpen(true);
            const index = activeIndex < 0 ? (event.key === 'ArrowDown' ? 0 : options.length - 1)
              : (activeIndex + (event.key === 'ArrowDown' ? 1 : -1) + options.length) % options.length;
            setHighlighted(options[index]);
          } else if (event.key === 'Enter' && activeIndex >= 0) {
            event.preventDefault(); choose(options[activeIndex]);
          }
        }} />
    </label>
    <p id={`${id}-help`} className="pdf-tag-help">Choose an existing tag or type a new one. Use ↑ ↓ and Enter to choose.</p>
    {expanded && <ul ref={list} id={`${id}-options`} className="pdf-tag-options" role="listbox" aria-label="Existing tags">
      {options.map((tag, index) => <li key={tag} id={`${id}-option-${index}`} role="option" aria-selected={index === activeIndex}
        onPointerDown={event => { if (event.button === 0) event.preventDefault(); }}
        onClick={() => choose(tag)}>{tag}</li>)}
    </ul>}
    {expanded && suggestions.options.length > options.length && <p className="pdf-tag-help">Showing {options.length} of {suggestions.options.length} matches. Keep typing to narrow the list.</p>}
  </div>;
}
