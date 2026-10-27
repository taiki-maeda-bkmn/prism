import { useEffect, useImperativeHandle, useRef, type Ref } from 'react';
import { Compartment, EditorState, Transaction } from '@codemirror/state';
import { closeCompletion } from '@codemirror/autocomplete';
import { isolateHistory } from '@codemirror/commands';
import { EditorView, keymap } from '@codemirror/view';
import { basicSetup } from 'codemirror';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { languages } from '@codemirror/language-data';
import { HighlightStyle, syntaxHighlighting, syntaxTreeAvailable } from '@codemirror/language';
import { tags } from '@lezer/highlight';
import { customSnippetConfiguration, markdownSnippets, type MarkdownSnippet } from './snippets';
import { findLiveHeading, liveMarkdown } from './liveMarkdown';
import { liveMath } from './liveMath';
import { liveTables } from './liveTables';
import { liveLinks } from './liveLinks';
import type { ThemeId } from './appearance';

// A theme facet change also invalidates cached font/caret measurements when
// the surrounding Live-mode CSS changes the editor's typography and gutters.
const livePresentation = (getView: () => EditorView | null, onOpenLink: (href: string) => void) => [liveMarkdown, liveMath(getView), liveTables(getView), liveLinks(onOpenLink), EditorView.theme({ '&': { '--prism-live': '1' } })];

// Color tokens update in place. Font size uses a compartment below so the editor
// refreshes its measurements while preserving selection and undo history.
const markdownHighlight = HighlightStyle.define([
  { tag: tags.heading, color: 'var(--link)', fontWeight: 'bold' },
  { tag: tags.emphasis, fontStyle: 'italic' },
  { tag: tags.strong, fontWeight: 'bold' },
  { tag: tags.strikethrough, textDecoration: 'line-through' },
  { tag: [tags.link, tags.url], color: 'var(--link)', textDecoration: 'underline' },
  { tag: [tags.quote, tags.comment, tags.meta], color: 'var(--muted)' },
  { tag: [tags.monospace, tags.string, tags.tagName], color: 'var(--accent-soft)' },
  { tag: tags.keyword, color: 'var(--link)', fontWeight: '600' },
  { tag: [tags.atom, tags.bool, tags.number], color: 'var(--warning)' },
  { tag: tags.invalid, color: 'var(--danger)' },
]);

export interface EditorHandle {
  /** Insert into the retained main selection without replacing editor history. */
  insertText: (text: string) => boolean;
}

interface Props {
  ref?: Ref<EditorHandle>;
  path: string;
  content: string;
  textScale: number;
  customSnippets: readonly MarkdownSnippet[];
  theme: ThemeId;
  live?: boolean;
  headingTarget?: { index: number; request: number; allLevels?: boolean; top?: boolean };
  onOpenLink: (href: string) => void;
  onChange: (value: string) => void;
  onCursor: (line: number, column: number) => void;
}

function detectLineEnding(content: string, fallback = '\n'): string {
  return /\r\n|\r|\n/.exec(content)?.[0] ?? fallback;
}

export function Editor({ ref, path, content, textScale, customSnippets, theme, live = false, headingTarget, onOpenLink, onChange, onCursor }: Props) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const textSize = useRef(new Compartment());
  const snippets = useRef(new Compartment());
  const presentation = useRef(new Compartment());
  const lastHeadingRequest = useRef<number | null>(null);
  const lineEnding = useRef('\n');
  const synchronizing = useRef(false);
  const handlers = useRef({ onChange, onCursor, onOpenLink });
  handlers.current = { onChange, onCursor, onOpenLink };

  useImperativeHandle(ref, () => ({
    insertText(text) {
      const editor = view.current;
      if (!editor || editor.composing || editor.compositionStarted || editor.state.readOnly) return false;
      closeCompletion(editor);
      const { from, to } = editor.state.selection.main;
      const insertion = editor.state.toText(text);
      editor.dispatch({
        changes: { from, to, insert: insertion },
        selection: { anchor: from + insertion.length },
        annotations: [Transaction.userEvent.of('input'), isolateHistory.of('full')],
        scrollIntoView: true,
      });
      return true;
    },
  }), []);

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
          markdownSnippets,
          snippets.current.of(customSnippetConfiguration.of(customSnippets)),
          basicSetup,
          markdown({ base: markdownLanguage, codeLanguages: languages }),
          syntaxHighlighting(markdownHighlight),
          textSize.current.of(EditorView.theme({ '&': { fontSize: `${14 * textScale / 100}px` } })),
          EditorView.lineWrapping,
          presentation.current.of([
            live ? livePresentation(() => view.current, href => handlers.current.onOpenLink(href)) : [],
            EditorView.contentAttributes.of({ 'aria-label': live ? 'Live Markdown editor' : 'Markdown source', spellcheck: 'true' }),
          ]),
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
            '&': { height: '100%', color: 'var(--text)', background: 'transparent' },
            '.cm-scroller': { fontFamily: 'var(--font-mono)', lineHeight: '1.85', overflow: 'auto' },
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
            '.cm-snippetField': { background: 'var(--selection)' },
            '.cm-snippetFieldPosition': { borderLeftColor: 'var(--accent)' },
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

  useEffect(() => {
    const editor = view.current;
    if (!editor) return;
    closeCompletion(editor);
    editor.dispatch({ effects: snippets.current.reconfigure(customSnippetConfiguration.of(customSnippets)) });
  }, [customSnippets]);

  useEffect(() => {
    // Reconfigure only the font theme: this invalidates CodeMirror's measured
    // line/cursor geometry even on short notes, keeping its state and history.
    // Theme changes also change Live-mode font families through the shell CSS.
    view.current?.dispatch({ effects: textSize.current.reconfigure(
      EditorView.theme({ '&': { fontSize: `${14 * textScale / 100}px` } }),
    ) });
  }, [textScale, theme]);

  useEffect(() => {
    view.current?.dispatch({ effects: presentation.current.reconfigure([
      live ? livePresentation(() => view.current, href => handlers.current.onOpenLink(href)) : [],
      EditorView.contentAttributes.of({ 'aria-label': live ? 'Live Markdown editor' : 'Markdown source', spellcheck: 'true' }),
    ]) });
  }, [live]);

  useEffect(() => {
    const editor = view.current;
    if (!editor || !live || !headingTarget || lastHeadingRequest.current === headingTarget.request) return;
    lastHeadingRequest.current = headingTarget.request;
    const requestedDocument = editor.state.doc;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const navigate = () => {
      if (cancelled || view.current !== editor || editor.state.doc !== requestedDocument) return;
      const position = headingTarget.top ? 0 : findLiveHeading(editor.state, headingTarget.index, 15, headingTarget.allLevels ? 6 : 3);
      if (position !== null) {
        editor.dispatch({ selection: { anchor: position }, effects: EditorView.scrollIntoView(position, { y: 'start', yMargin: 24 }) });
        editor.focus();
      } else if (!syntaxTreeAvailable(editor.state, editor.state.doc.length)) {
        // Distant headings can lie beyond the background parser's viewport.
        // Advance parsing in small tasks so large notes do not freeze the UI.
        timer = setTimeout(navigate, 16);
      }
    };
    navigate();
    return () => { cancelled = true; if (timer !== undefined) clearTimeout(timer); };
  }, [headingTarget, live, path]);

  return <div ref={host} className="editor-host" />;
}
