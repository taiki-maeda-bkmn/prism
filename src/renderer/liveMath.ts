import { Annotation, EditorState, type Extension, type Range, StateField } from '@codemirror/state';
import { Decoration, type DecorationSet, EditorView, ViewPlugin, type ViewUpdate, WidgetType } from '@codemirror/view';
import { type MathRange, renderMath, scanMarkdownMath } from './math';

const composingMath = Annotation.define<boolean>();

/** A rendered formula is only a view over the unchanged Markdown source. */
class MathWidget extends WidgetType {
  constructor(readonly math: MathRange) { super(); }

  eq(other: MathWidget) {
    return this.math.raw === other.math.raw && this.math.tex === other.math.tex && this.math.display === other.math.display;
  }

  toDOM(view: EditorView) {
    const element: HTMLElement = view.dom.ownerDocument.createElement(this.math.display ? 'div' : 'span');
    element.className = `cm-live-math${this.math.display ? ' cm-live-math-display' : ''}`;
    element.contentEditable = 'false';
    element.tabIndex = 0;
    element.setAttribute('role', 'button');
    element.setAttribute('aria-label', `Edit formula: ${this.math.tex.trim()}`);
    element.title = 'Edit formula';
    const rendered = renderMath(this.math.tex, this.math.display);
    if (rendered.ok) element.innerHTML = rendered.html;
    else {
      // Incomplete or unsupported TeX stays readable, with its exact delimiters
      // and a useful error. No generated error HTML is ever inserted.
      element.classList.add('cm-live-math-error', 'prism-math-error');
      element.textContent = this.math.raw;
      element.title = rendered.error;
    }

    const reveal = () => {
      if (view.compositionStarted || view.composing || !element.isConnected) return;
      // Widgets can be reused after earlier text changes. Resolve their current
      // position from the DOM rather than retaining an obsolete source offset.
      const position = view.posAtDOM(element);
      const math = getLiveMathRanges(view.state).find(range => range.from === position && range.raw === this.math.raw);
      if (!math) return;
      const leading = /^\s*/.exec(view.state.sliceDoc(math.contentFrom, math.contentTo))?.[0].length ?? 0;
      const anchor = Math.min(math.contentTo, math.contentFrom + leading);
      view.dispatch({ selection: { anchor }, scrollIntoView: true });
      view.focus();
    };
    element.addEventListener('mousedown', event => {
      if (event.button !== 0) return;
      event.preventDefault();
      reveal();
    });
    element.addEventListener('click', reveal);
    element.addEventListener('focus', reveal);
    element.addEventListener('keydown', event => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        reveal();
      }
    });
    return element;
  }

  ignoreEvent() { return true; }
}

export interface LiveMathState {
  ranges: readonly MathRange[];
  decorations: DecorationSet;
  pending: boolean;
}

function decorationsFor(state: EditorState, ranges: readonly MathRange[]): DecorationSet {
  const decorations: Range<Decoration>[] = [];
  for (const math of ranges) {
    const first = state.doc.lineAt(math.from);
    const last = state.doc.lineAt(math.to);
    // The same convention as Live Markdown: all syntax on a touched line is
    // editable. A selection across a formula reveals every original line.
    if (state.selection.ranges.some(selection => selection.from <= last.to && selection.to >= first.from)) continue;
    decorations.push(Decoration.replace({
      widget: new MathWidget(math), block: math.display, inclusive: false, liveMath: true,
    }).range(math.from, math.to));
  }
  return Decoration.set(decorations, true);
}

export const liveMathState = StateField.define<LiveMathState>({
  create(state) {
    const ranges = scanMarkdownMath(state.doc.toString());
    return { ranges, decorations: decorationsFor(state, ranges), pending: false };
  },
  update(value, transaction) {
    if (transaction.annotation(composingMath) || transaction.isUserEvent('input.type.compose')) {
      return {
        // Mapping preserves the IME's DOM, including EditContext composition.
        ranges: transaction.docChanged ? value.ranges.flatMap(range => {
          const from = transaction.changes.mapPos(range.from, 1);
          const to = transaction.changes.mapPos(range.to, -1);
          if (from >= to) return [];
          const contentFrom = Math.max(from, Math.min(to, transaction.changes.mapPos(range.contentFrom, 1)));
          const contentTo = Math.max(contentFrom, Math.min(to, transaction.changes.mapPos(range.contentTo, -1)));
          return [{ ...range, from, to, contentFrom, contentTo }];
        }) : value.ranges,
        decorations: value.decorations.map(transaction.changes), pending: true,
      };
    }
    if (!value.pending && !transaction.docChanged && !transaction.selection) return value;
    // Parsing belongs to document changes, never ordinary caret movement.
    const ranges = transaction.docChanged || value.pending ? scanMarkdownMath(transaction.state.doc.toString()) : value.ranges;
    return { ranges, decorations: decorationsFor(transaction.state, ranges), pending: false };
  },
  // Direct state decorations may replace whole blocks containing line breaks.
  // ViewPlugin decorations run after viewport calculation and cannot do this.
  provide: field => EditorView.decorations.from(field, value => value.decorations),
});

export function getLiveMathRanges(state: EditorState): readonly MathRange[] {
  return state.field(liveMathState, false)?.ranges ?? [];
}

/** Math ranges are sorted and disjoint, so Markdown nodes need no linear scan. */
export function isWithinLiveMath(ranges: readonly MathRange[], from: number, to: number): boolean {
  let low = 0;
  let high = ranges.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (ranges[middle].from <= from) low = middle + 1;
    else high = middle;
  }
  const range = ranges[low - 1];
  return Boolean(range && from >= range.from && to <= range.to);
}

const compositionRefresh = ViewPlugin.fromClass(class {
  timer: ReturnType<typeof setTimeout> | undefined;
  destroyed = false;

  constructor(readonly view: EditorView) {}

  update(_update: ViewUpdate) {
    if (this.view.state.field(liveMathState).pending) this.schedule();
    else if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
  }

  schedule(delay = 50) {
    if (this.destroyed || this.timer !== undefined) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      if (this.destroyed || !this.view.state.field(liveMathState).pending) return;
      if (this.view.compositionStarted || this.view.composing) this.schedule();
      else this.view.dispatch({});
    }, delay);
  }

  destroy() {
    this.destroyed = true;
    if (this.timer !== undefined) clearTimeout(this.timer);
  }
}, {
  eventObservers: {
    compositionend() {
      if (this.timer !== undefined) clearTimeout(this.timer);
      this.timer = undefined;
      this.schedule(0);
    },
  },
});

export function liveMath(getView: () => EditorView | null): Extension {
  return [
    liveMathState,
    EditorState.transactionExtender.of(() => {
      const view = getView();
      return view?.compositionStarted || view?.composing ? { annotations: composingMath.of(true) } : null;
    }),
    compositionRefresh,
  ];
}
