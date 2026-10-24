import { type ChangeSpec, type EditorState, type Range, Transaction } from '@codemirror/state';
import { isolateHistory } from '@codemirror/commands';
import { Decoration, type DecorationSet, EditorView, ViewPlugin, type ViewUpdate, WidgetType } from '@codemirror/view';
import { ensureSyntaxTree, syntaxTree } from '@codemirror/language';
import { getLiveMathRanges, isWithinLiveMath } from './liveMath';
import { getLiveTableRanges } from './liveTables';
import { isWithinMarkdownTable } from './tables';

interface VisibleRange { from: number; to: number }

const opaqueBlocks = new Set(['FencedCode', 'CodeBlock', 'HTMLBlock', 'CommentBlock', 'ProcessingInstructionBlock', 'Table']);
const opaqueInline = new Set(['Link', 'Image', 'Autolink', 'URL', 'LinkReference', 'LinkTitle']);
const inlineClasses: Readonly<Record<string, string>> = {
  StrongEmphasis: 'cm-live-strong', Emphasis: 'cm-live-emphasis',
  Strikethrough: 'cm-live-strike', InlineCode: 'cm-live-code',
};
const markerNames = new Set(['HeaderMark', 'EmphasisMark', 'StrikethroughMark', 'CodeMark', 'QuoteMark']);
const hiddenMarker = Decoration.replace({ inclusive: false, liveMarker: true });

/** Toggle only a parsed task marker, never a lookalike inside code or HTML. */
export function liveTaskChange(state: EditorState, position: number, checked: boolean): ChangeSpec | null {
  if (state.readOnly || !Number.isInteger(position) || position < 0 || position + 3 > state.doc.length) return null;
  const marker = state.sliceDoc(position, position + 3);
  if (!/^\[[ xX]\]$/.test(marker)) return null;
  const tree = ensureSyntaxTree(state, position + 3, 20);
  const node = tree?.resolveInner(position + 1, 1);
  if (node?.name !== 'TaskMarker' || node.from !== position || node.to !== position + 3) return null;
  if ((marker[1].toLowerCase() === 'x') === checked) return null;
  return { from: position + 1, to: position + 2, insert: checked ? 'x' : ' ' };
}

class TaskCheckboxWidget extends WidgetType {
  constructor(readonly checked: boolean, readonly label: string, readonly markerOffset: number, readonly disabled: boolean) { super(); }

  eq(other: TaskCheckboxWidget) {
    return this.checked === other.checked && this.label === other.label
      && this.markerOffset === other.markerOffset && this.disabled === other.disabled;
  }

  updateDOM(dom: HTMLElement) {
    const input = dom as HTMLInputElement;
    input.checked = this.checked;
    input.disabled = this.disabled;
    input.setAttribute('aria-label', `Toggle task: ${this.label}`);
    input.dataset.markerOffset = String(this.markerOffset);
    return true;
  }

  toDOM(view: EditorView) {
    const input = view.dom.ownerDocument.createElement('input');
    input.type = 'checkbox';
    input.className = 'cm-live-task-checkbox';
    input.contentEditable = 'false';
    this.updateDOM(input);
    // Keep the editing selection on pointer clicks. Keyboard focus still uses
    // the native checkbox, including Space and its checked announcement.
    input.addEventListener('mousedown', event => event.preventDefault());
    input.addEventListener('change', () => {
      // Resolve the current DOM position instead of capturing an offset that
      // becomes stale when preceding text is edited or decorations are mapped.
      const position = view.posAtDOM(input) + Number(input.dataset.markerOffset);
      const change = !view.compositionStarted && !view.composing
        ? liveTaskChange(view.state, position, input.checked) : null;
      if (change) view.dispatch({ changes: change, annotations: [Transaction.userEvent.of('input'), isolateHistory.of('full')] });
      else input.checked = view.state.sliceDoc(position + 1, position + 2).toLowerCase() === 'x';
    });
    return input;
  }

  ignoreEvent() { return true; }
}

class CodeLanguageWidget extends WidgetType {
  constructor(readonly language: string) { super(); }
  eq(other: CodeLanguageWidget) { return this.language === other.language; }
  toDOM(view: EditorView) {
    const label = view.dom.ownerDocument.createElement('span');
    label.className = 'cm-live-code-language';
    label.textContent = this.language;
    // The label replaces the visible fence only. Clicking it still places the
    // editor caret on that source line so the full fence becomes editable.
    label.setAttribute('aria-hidden', 'true');
    return label;
  }
  ignoreEvent() { return false; }
}

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
  const mathRanges = getLiveMathRanges(state);
  const tableRanges = getLiveTableRanges(state);

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
        // TeX contains Markdown-looking underscores, stars, and even headings.
        // Neither rendered formulas nor their editable source use those marks.
        if (isWithinLiveMath(mathRanges, node.from, node.to)) return false;
        // Tables detected with math masking may be ordinary prose in this
        // unmasked tree. Keep their complete source visible when revealed.
        if (isWithinMarkdownTable(tableRanges, node.from, node.to)) return false;
        if (node.name === 'FencedCode' || node.name === 'CodeBlock') {
          protectedBlocks.push({ from: node.from, to: node.to });
          const first = state.doc.lineAt(node.from);
          const last = state.doc.lineAt(node.to);
          const fences = node.name === 'FencedCode' ? node.getChildren('CodeMark') : [];
          const closing = fences.length > 1 ? fences[fences.length - 1] : null;
          const visibleFirst = state.doc.lineAt(Math.max(from, node.from)).number;
          const visibleLast = state.doc.lineAt(Math.min(to, node.to)).number;
          for (let number = visibleFirst; number <= visibleLast; number++) {
            const line = state.doc.line(number);
            addLine(line.from, 'cm-live-codeblock');
            if (number === first.number) addLine(line.from, 'cm-live-codeblock-start');
            if (number === last.number && (node.name === 'CodeBlock' || closing)) addLine(line.from, 'cm-live-codeblock-end');
          }
          if (node.name === 'FencedCode') {
            const opening = fences[0];
            if (opening && opening.from >= from && first.to <= to && !lineIsActive(first.from, first.to)) {
              const info = node.getChild('CodeInfo');
              const language = info ? state.sliceDoc(info.from, info.to).trim().split(/\s+/)[0] : 'plain text';
              decorations.push(Decoration.replace({
                widget: new CodeLanguageWidget(language || 'plain text'), inclusive: false, liveMarker: true, liveFence: true,
              }).range(opening.from, first.to));
            }
            if (closing && closing.from >= from && closing.to <= to && !lineIsActive(last.from, last.to)) {
              decorations.push(Decoration.replace({ inclusive: false, liveMarker: true, liveFence: true }).range(closing.from, closing.to));
              addLine(last.from, 'cm-live-codeblock-end-collapsed');
            }
          }
          return false;
        }
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
        if (node.name === 'TaskMarker' && node.from >= from && node.to <= to) {
          const line = state.doc.lineAt(node.from);
          const active = lineIsActive(line.from, line.to);
          const listMarker = node.parent?.parent?.getChild('ListMark');
          // Leave indentation and enclosing quote markers in place. Only the
          // task's own list marker and checkbox become the rendered control.
          const start = !active && listMarker && listMarker.from >= line.from
            && /^\s*$/.test(state.sliceDoc(listMarker.to, node.from)) ? listMarker.from : node.from;
          const widget = new TaskCheckboxWidget(
            state.sliceDoc(node.from + 1, node.to - 1).toLowerCase() === 'x',
            state.sliceDoc(node.to, line.to).trim() || 'Untitled task', node.from - start, state.readOnly,
          );
          addLine(line.from, 'cm-live-task');
          decorations.push(active
            ? Decoration.widget({ widget, side: -1, liveTask: true }).range(start)
            : Decoration.replace({ widget, inclusive: false, liveMarker: true, liveTask: true }).range(start, node.to));
        }
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
    if (!(this.pending || update.docChanged || update.selectionSet || update.viewportChanged || update.startState.readOnly !== update.state.readOnly
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

/** Find outline or fragment headings without confusing fenced examples for headings. */
export function findLiveHeading(state: EditorState, index: number, parseBudget = 50, maxLevel: 3 | 6 = 3): number | null {
  if (!Number.isInteger(index) || index < 0) return null;
  const tree = ensureSyntaxTree(state, state.doc.length, parseBudget) ?? syntaxTree(state);
  const mathRanges = getLiveMathRanges(state);
  let current = 0;
  let position: number | null = null;
  tree.iterate({
    enter(node) {
      if (position !== null || opaqueBlocks.has(node.name) || isWithinLiveMath(mathRanges, node.from, node.to)) return false;
      const heading = /^(?:ATX|Setext)Heading([1-6])$/.exec(node.name);
      if (heading && Number(heading[1]) <= maxLevel && current++ === index) position = node.from;
    },
  });
  return position;
}
