import { useEffect, useRef } from 'react';
import { EditorState } from '@codemirror/state';
import { EditorView, keymap } from '@codemirror/view';
import { basicSetup } from 'codemirror';
import { markdown } from '@codemirror/lang-markdown';
import { defaultHighlightStyle, syntaxHighlighting } from '@codemirror/language';

interface Props {
  path: string;
  content: string;
  onChange: (value: string) => void;
  onCursor: (line: number, column: number) => void;
}

export function Editor({ path, content, onChange, onCursor }: Props) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const handlers = useRef({ onChange, onCursor });
  handlers.current = { onChange, onCursor };

  useEffect(() => {
    if (!host.current) return;
    const editor = new EditorView({
      state: EditorState.create({
        doc: content,
        extensions: [
          basicSetup,
          markdown(),
          syntaxHighlighting(defaultHighlightStyle),
          EditorView.lineWrapping,
          EditorView.contentAttributes.of({ 'aria-label': 'Markdown source', spellcheck: 'true' }),
          keymap.of([{ key: 'Mod-s', run: () => true }]),
          EditorView.updateListener.of(update => {
            if (update.docChanged) handlers.current.onChange(update.state.doc.toString());
            if (update.selectionSet || update.docChanged) {
              const head = update.state.selection.main.head;
              const line = update.state.doc.lineAt(head);
              handlers.current.onCursor(line.number, head - line.from + 1);
            }
          }),
          EditorView.theme({
            '&': { height: '100%', fontSize: '14px', color: '#344640', background: 'transparent' },
            '.cm-scroller': { fontFamily: '"Cascadia Code", "SFMono-Regular", Consolas, monospace', lineHeight: '1.85', overflow: 'auto' },
            '.cm-content': { padding: '27px 0 80px', caretColor: '#2d7562' },
            '.cm-line': { padding: '0 24px 0 10px' },
            '.cm-gutters': { background: 'transparent', color: '#a4aaa2', border: 'none', padding: '0 4px 0 12px' },
            '.cm-activeLineGutter': { background: 'transparent', color: '#426b5c' },
            '.cm-activeLine': { background: '#54856a09' },
            '&.cm-focused': { outline: 'none' },
            '&.cm-focused .cm-selectionBackground, .cm-selectionBackground': { background: '#96b69f55' },
            '.cm-cursor': { borderLeftColor: '#2d7562' },
            '.cm-panels': { background: '#f2f3ee', color: '#344640' },
            '.cm-searchMatch': { background: '#dfc87c66' },
            '.cm-foldPlaceholder': { background: '#e7ece4', border: 'none' },
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
    if (editor && content !== editor.state.doc.toString()) {
      editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: content } });
    }
  }, [content]);

  return <div ref={host} className="editor-host" />;
}
