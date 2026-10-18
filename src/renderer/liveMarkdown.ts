import { type EditorState, type Range } from '@codemirror/state';
import { Decoration, type DecorationSet, EditorView, ViewPlugin, type ViewUpdate } from '@codemirror/view';
import { ensureSyntaxTree, syntaxTree } from '@codemirror/language';

interface VisibleRange { from: number; to: number }

const opaqueBlocks = new Set(['FencedCode', 'CodeBlock', 'HTMLBlock', 'CommentBlock', 'ProcessingInstructionBlock', 'Table']);
const opaqueInline = new Set(['Link', 'Image', 'Autolink', 'URL', 'LinkReference', 'LinkTitle']);
const inlineClasses: Readonly<Record<string, string>> = {
  StrongEmphasis: 'cm-live-strong', Emphasis: 'cm-live-emphasis',
  Strikethrough: 'cm-live-strike', InlineCode: 'cm-live-code',
};
const markerNames = new Set(['HeaderMark', 'EmphasisMark', 'StrikethroughMark', 'CodeMark', 'QuoteMark']);
const hiddenMarker = Decoration.replace({ inclusive: false, liveMarker: true });

/**
 * Decorations never rewrite Markdown. Only complete, parsed delimiters on
 * untouched lines disappear; moving a caret or selection onto a line exposes
 * its exact source. Replacements are always contained within one line.
 */
export function buildLiveDecorations(state: EditorState, visibleRanges: readonly VisibleRange[]): DecorationSet {
  const decorations: Range<Decoration>[] = [];
  const markers: { from: number; to: number }[] = [];
  const protectedBlocks: VisibleRange[] = [];
  const seenNodes = new Set<string>();
  const seenLines = new Set<string>();
  const lineSafety = new Map<number, boolean>();
  const tree = syntaxTree(state);

  function lineIsActive(from: number, to: number): boolean {
    // Include both endpoint lines. This also handles reversed selections and
    // every range in a multiple-cursor selection without touching the document.
    return state.selection.ranges.some(range => range.from <= to && range.to >= from);
  }

  function addLine(position: number, className: string) {
    const line = state.doc.lineAt(position);
    const key = `${line.from}:${className}`;
    if (seenLines.has(key)) return;
    seenLines.add(key);
    decorations.push(Decoration.line({ class: className }).range(line.from));
  }

  function addMarker(from: number, to: number) {
    if (from >= to) return;
    const line = state.doc.lineAt(from);
    if (to > line.to || lineIsActive(line.from, line.to)) return;
    let safe = lineSafety.get(line.number);
    if (safe === undefined) {
      // Wiki links are an application extension, so a plain Markdown parser
      // cannot always identify them. Keep their entire line's syntax visible.
      safe = !line.text.includes('[[');
      lineSafety.set(line.number, safe);
    }
    if (safe) markers.push({ from, to });
  }

  for (const visible of visibleRanges) {
    const from = Math.max(0, visible.from);
    const to = Math.min(state.doc.length, visible.to);
    if (from > to) continue;
    tree.iterate({
      from, to,
      enter(reference) {
        const node = reference.node;
        if (opaqueBlocks.has(node.name)) {
          protectedBlocks.push({ from: node.from, to: node.to });
          return false;
        }
        if (opaqueInline.has(node.name)) return false;
        if (node.name === 'HTMLTag') {
          // Inline HTML's text is a sibling of its tags in the syntax tree.
          // Keep that whole containing paragraph/heading literal as well.
          let container = node.parent;
          while (container?.parent && container.name !== 'Paragraph' && !/Heading[1-6]$/.test(container.name)) container = container.parent;
          protectedBlocks.push({ from: container?.from ?? node.from, to: container?.to ?? node.to });
          return false;
        }

        const key = `${node.name}:${node.from}:${node.to}:${from}:${to}`;
        if (seenNodes.has(key)) return;
        seenNodes.add(key);
        const heading = /^(?:ATX|Setext)Heading([1-6])$/.exec(node.name);
        if (heading || node.name === 'Blockquote') {
          const className = heading ? `cm-live-heading-${heading[1]}` : 'cm-live-quote';
          const first = state.doc.lineAt(Math.max(from, node.from)).number;
          const last = state.doc.lineAt(Math.min(to, node.to)).number;
          for (let number = first; number <= last; number++) addLine(state.doc.line(number).from, className);
        }

        const inlineClass = inlineClasses[node.name];
        if (inlineClass) {
          const start = Math.max(from, node.from);
          const end = Math.min(to, node.to);
          if (start < end) decorations.push(Decoration.mark({ class: inlineClass }).range(start, end));
        }

        if (markerNames.has(node.name) && node.from >= from && node.to <= to) {
          const parent = node.parent;
          const supported = node.name === 'QuoteMark'
            || (node.name === 'HeaderMark' && /^(?:ATX|Setext)Heading[1-6]$/.test(parent?.name ?? ''))
            || (node.name === 'CodeMark' && parent?.name === 'InlineCode')
            || (node.name === 'EmphasisMark' && /^(?:StrongEmphasis|Emphasis)$/.test(parent?.name ?? ''))
            || (node.name === 'StrikethroughMark' && parent?.name === 'Strikethrough');
          if (supported) {
            let end = node.to;
            // Remove the structural separating space along with an opening
            // heading/quote marker, without swallowing indentation or newlines.
            if ((node.name === 'QuoteMark' || (node.name === 'HeaderMark' && parent?.name.startsWith('ATX') && node.from === parent.from))
              && /[ \t]/.test(state.sliceDoc(end, end + 1))) end++;
            addMarker(node.from, end);
          }
        }
      },
    });
  }

  const seenMarkers = new Set<string>();
  for (const marker of markers) {
    const line = state.doc.lineAt(marker.from);
    if (protectedBlocks.some(block => block.from <= line.to && block.to >= line.from)) continue;
    const key = `${marker.from}:${marker.to}`;
    if (!seenMarkers.has(key)) decorations.push(hiddenMarker.range(marker.from, marker.to));
    seenMarkers.add(key);
  }
  return Decoration.set(decorations, true);
}

export const liveMarkdown = ViewPlugin.fromClass(class {
  decorations: DecorationSet;
  pending = false;
  destroyed = false;
  timer: ReturnType<typeof setTimeout> | undefined;

  constructor(readonly view: EditorView) {
    this.decorations = buildLiveDecorations(view.state, view.visibleRanges);
  }

  update(update: ViewUpdate) {
    if (!(this.pending || update.docChanged || update.selectionSet || update.viewportChanged
      || syntaxTree(update.startState) !== syntaxTree(update.state))) return;
    if (update.view.compositionStarted || update.view.composing) {
      // Let the platform IME keep ownership of its DOM until composition ends.
      this.decorations = this.decorations.map(update.changes);
      this.pending = true;
      this.scheduleRefresh();
      return;
    }
    this.decorations = buildLiveDecorations(update.state, update.view.visibleRanges);
    this.pending = false;
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
  }

  scheduleRefresh(delay = 50) {
    if (this.destroyed || !this.pending || this.timer !== undefined) return;
    // Chromium's EditContext emits composition events on its own object, so a
    // DOM compositionend observer alone cannot detect every completed edit.
    this.timer = setTimeout(() => {
      this.timer = undefined;
      if (this.destroyed || !this.pending) return;
      if (this.view.compositionStarted || this.view.composing) this.scheduleRefresh();
      else this.view.dispatch({});
    }, delay);
  }

  destroy() {
    this.destroyed = true;
    if (this.timer !== undefined) clearTimeout(this.timer);
  }
}, {
  decorations: plugin => plugin.decorations,
  eventObservers: {
    compositionend() {
      if (this.timer !== undefined) clearTimeout(this.timer);
      this.timer = undefined;
      // Run after CodeMirror has consumed the composition's final DOM change.
      this.scheduleRefresh(0);
    },
  },
});

/** Find the outline's Markdown H1–H3 without confusing fenced examples for headings. */
export function findLiveHeading(state: EditorState, index: number, parseBudget = 50): number | null {
  if (!Number.isInteger(index) || index < 0) return null;
  const tree = ensureSyntaxTree(state, state.doc.length, parseBudget) ?? syntaxTree(state);
  let current = 0;
  let position: number | null = null;
  tree.iterate({
    enter(node) {
      if (position !== null || opaqueBlocks.has(node.name)) return false;
      if (/^(?:ATX|Setext)Heading[1-3]$/.test(node.name) && current++ === index) position = node.from;
    },
  });
  return position;
}
