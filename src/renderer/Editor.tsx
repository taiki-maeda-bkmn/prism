import { useEffect, useRef } from 'react';
import { EditorState } from '@codemirror/state';
import { EditorView, keymap } from '@codemirror/view';
import { basicSetup } from 'codemirror';
import { markdown } from '@codemirror/lang-markdown';
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { tags } from '@lezer/highlight';

// CSS variables update in place, keeping the current selection and undo history
// intact when the user changes colors while writing.
const markdownHighlight = HighlightStyle.define([
  { tag: tags.heading, color: 'var(--link)', fontWeight: 'bold' },
  { tag: tags.emphasis, fontStyle: 'italic' },
  { tag: tags.strong, fontWeight: 'bold' },
  { tag: tags.strikethrough, textDecoration: 'line-through' },
  { tag: [tags.link, tags.url], color: 'var(--link)', textDecoration: 'underline' },
  { tag: [tags.quote, tags.comment, tags.meta], color: 'var(--muted)' },
  { tag: [tags.monospace, tags.keyword, tags.string, tags.atom, tags.bool, tags.number, tags.tagName], color: 'var(--accent-soft)' },
  { tag: tags.invalid, color: 'var(--danger)' },
]);

interface Props {
  path: string;
  content: string;
  onChange: (value: string) => void;
  onCursor: (line: number, column: number) => void;
}

function detectLineEnding(content: string, fallback = '\n'): string {
  return /\r\n|\r|\n/.exec(content)?.[0] ?? fallback;
}

export function Editor({ path, content, onChange, onCursor }: Props) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const lineEnding = useRef('\n');
  const synchronizing = useRef(false);
  const handlers = useRef({ onChange, onCursor });
  handlers.current = { onChange, onCursor };

  useEffect(() => {
    if (!host.current) return;
    lineEnding.current = detectLineEnding(content);
    const editor = new EditorView({
      state: EditorState.create({
        doc: content,
        // Leave lineSeparator unset so typed/pasted LF, CRLF and CR all become
        // real lines. Serialize using the note's convention instead of forcing
        // a facet that would only recognize one exact input separator.
        extensions: [
          basicSetup,
          markdown(),
          syntaxHighlighting(markdownHighlight),
          EditorView.lineWrapping,
          EditorView.contentAttributes.of({ 'aria-label': 'Markdown source', spellcheck: 'true' }),
          keymap.of([{ key: 'Mod-s', run: () => true }]),
          EditorView.updateListener.of(update => {
            if (update.docChanged && !synchronizing.current) {
              handlers.current.onChange(update.state.doc.sliceString(0, update.state.doc.length, lineEnding.current));
            }
            if (update.selectionSet || update.docChanged) {
              const head = update.state.selection.main.head;
              const line = update.state.doc.lineAt(head);
              handlers.current.onCursor(line.number, head - line.from + 1);
            }
          }),
          EditorView.theme({
            '&': { height: '100%', fontSize: '14px', color: 'var(--text)', background: 'transparent' },
            '.cm-scroller': { fontFamily: '"Cascadia Code", "SFMono-Regular", Consolas, monospace', lineHeight: '1.85', overflow: 'auto' },
            '.cm-content': { padding: '27px 0 80px', caretColor: 'var(--text)' },
            '.cm-line': { padding: '0 24px 0 10px' },
            '.cm-gutters': { background: 'transparent', color: 'var(--muted)', border: 'none', padding: '0 4px 0 12px' },
            '.cm-activeLineGutter': { background: 'transparent', color: 'var(--link)' },
            '.cm-activeLine': { background: 'var(--tint)' },
            '&.cm-focused': { outline: 'none' },
            '&.cm-focused .cm-selectionBackground, .cm-selectionBackground': { background: 'var(--selection)' },
            '.cm-selectionMatch': { background: 'var(--hover)' },
            '.cm-cursor': { borderLeftColor: 'var(--text)' },
            '.cm-panels': { background: 'var(--background)', color: 'var(--text)' },
            '.cm-panels-top': { borderBottom: '1px solid var(--border)' },
            '.cm-panels-bottom': { borderTop: '1px solid var(--border)' },
            '.cm-textfield': { background: 'var(--background)', color: 'var(--text)', border: '1px solid var(--border-strong)' },
            '.cm-button': { background: 'var(--tint)', color: 'var(--text)', border: '1px solid var(--border-strong)' },
            '.cm-button:active': { background: 'var(--hover)' },
            '.cm-search input[type=checkbox]': { accentColor: 'var(--accent)' },
            '.cm-searchMatch': { background: 'var(--warning-tint)', outline: '1px solid var(--warning)' },
            '.cm-searchMatch-selected': { background: 'var(--selection)', outline: '1px solid var(--accent)' },
            '&.cm-focused .cm-matchingBracket': { background: 'var(--selection)' },
            '&.cm-focused .cm-nonmatchingBracket': { background: 'var(--danger-tint)' },
            '.cm-foldPlaceholder': { background: 'var(--tint)', color: 'var(--muted)', border: 'none' },
            '.cm-tooltip': { background: 'var(--background)', color: 'var(--text)', border: '1px solid var(--border-strong)' },
            '.cm-tooltip-autocomplete > ul > li[aria-selected]': { background: 'var(--accent)', color: 'var(--accent-contrast)' },
          }),
        ],
      }),
      parent: host.current,
    });
    view.current = editor;
    return () => { editor.destroy(); view.current = null; };
    // A note gets its own undo history. Content updates are applied below.
  }, [path]);

  useEffect(() => {
    const editor = view.current;
    if (!editor) return;
    // Adopt external newline changes even when the visible text is identical.
    // Keep the existing convention if an edit temporarily removes every break.
    lineEnding.current = detectLineEnding(content, lineEnding.current);
    if (content.replace(/\r\n?/g, '\n') !== editor.state.doc.toString()) {
      synchronizing.current = true;
      try {
        editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: content } });
      } finally {
        synchronizing.current = false;
      }
    }
  }, [content]);

  return <div ref={host} className="editor-host" />;
}
