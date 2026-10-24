import { Annotation, EditorState, type Extension, type Range, StateField } from '@codemirror/state';
import { Decoration, type DecorationSet, EditorView, ViewPlugin, WidgetType } from '@codemirror/view';
import { renderMarkdown } from './markdown';
import { isLiveLinkHref, isLiveLinkOpenGesture, liveLinkNavigation } from './liveLinks';
import { type MarkdownTableRange, scanMarkdownTables, tableCellPosition } from './tables';

const composingTable = Annotation.define<boolean>();

class TableWidget extends WidgetType {
  readonly containerKey: string;
  constructor(readonly table: MarkdownTableRange) {
    super();
    this.containerKey = JSON.stringify(table.containers);
  }

  eq(other: TableWidget) {
    return this.table.raw === other.table.raw && this.table.markdown === other.table.markdown
      && this.table.referenceKey === other.table.referenceKey && this.containerKey === other.containerKey;
  }

  toDOM(view: EditorView) {
    const document = view.dom.ownerDocument;
    const element = document.createElement('div');
    element.className = 'cm-live-table';
    element.contentEditable = 'false';
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'cm-live-table-edit';
    button.textContent = 'Edit table';
    const content = document.createElement('div');
    content.className = 'cm-live-table-content';
    const template = document.createElement('template');
    template.innerHTML = renderMarkdown(this.table.markdown, this.table.references);
    // Keep supported links available to Prism's navigation router. Ordinary
    // clicks still reveal the cell source; no anchor navigates the renderer.
    for (const link of template.content.querySelectorAll('a')) {
      const href = link.getAttribute('href');
      if (href === null || !isLiveLinkHref(href)) {
        const label = document.createElement('span');
        label.className = 'cm-live-table-link';
        label.append(...link.childNodes);
        link.replaceWith(label);
        continue;
      }
      link.classList.add('cm-live-link', 'cm-live-table-link');
      link.title = `${link.title ? `${link.title}\n` : ''}Ctrl+click to open (⌘+click on Mac)`;
      link.addEventListener('mousedown', event => {
        if (!isLiveLinkOpenGesture(event)) return;
        event.preventDefault();
        event.stopPropagation();
      });
      link.addEventListener('click', event => {
        event.preventDefault();
        if (!isLiveLinkOpenGesture(event)) return;
        event.stopPropagation();
        if (currentTable()) view.state.facet(liveLinkNavigation)(href);
      });
      link.addEventListener('auxclick', event => {
        event.preventDefault();
        event.stopPropagation();
      });
    }
    for (const image of template.content.querySelectorAll('img')) image.replaceWith(document.createTextNode(image.alt));
    for (const control of template.content.querySelectorAll('select, textarea, button, audio, video, details, summary')) {
      control.replaceWith(document.createTextNode(control.textContent ?? ''));
    }
    for (const child of template.content.querySelectorAll<HTMLElement>('*')) {
      child.removeAttribute('tabindex');
      child.removeAttribute('contenteditable');
      child.removeAttribute('autofocus');
    }
    content.append(template.content);
    // Keep container structure inside the measured block widget. Its source
    // prefixes are included in the replacement and reappear on source reveal.
    let nested: HTMLElement = content;
    for (let index = this.table.containers.length - 1; index >= 0; index--) {
      const container = this.table.containers[index];
      const wrapper = document.createElement('div');
      wrapper.className = `cm-live-table-${container.kind}`;
      if (container.kind === 'list') {
        const marker = document.createElement('span');
        marker.className = 'cm-live-table-list-marker';
        marker.style.width = `${container.indent}ch`;
        if (container.marker !== undefined) {
          marker.textContent = container.marker;
          marker.tabIndex = 0;
          marker.setAttribute('role', 'button');
          marker.setAttribute('aria-label', `Edit list marker: ${container.marker}`);
          marker.title = 'Edit list marker';
          const revealMarker = () => {
            const current = currentTable();
            const currentContainer = current?.containers[index];
            if (!current || currentContainer?.kind !== 'list' || currentContainer.markerOffset === undefined) return;
            view.dispatch({ selection: { anchor: current.from + currentContainer.markerOffset }, scrollIntoView: true });
            view.focus();
          };
          marker.addEventListener('mousedown', event => {
            if (event.button !== 0) return;
            event.preventDefault();
            revealMarker();
          });
          marker.addEventListener('keydown', event => {
            if (event.key !== 'Enter' && event.key !== ' ') return;
            event.preventDefault();
            revealMarker();
          });
        } else marker.setAttribute('aria-hidden', 'true');
        wrapper.append(marker);
      }
      wrapper.append(nested);
      nested = wrapper;
    }
    element.append(button, nested);

    const currentTable = () => {
      if (view.compositionStarted || view.composing || !element.isConnected
        || view.state.field(liveTableState, false)?.pending) return;
      const position = view.posAtDOM(element);
      return getLiveTableRanges(view.state).find(table => table.from === position
        && table.raw === this.table.raw && table.markdown === this.table.markdown
        && table.referenceKey === this.table.referenceKey && JSON.stringify(table.containers) === this.containerKey);
    };
    const reveal = (row = 0, column = 0) => {
      const current = currentTable();
      if (!current) return;
      view.dispatch({ selection: { anchor: tableCellPosition(current, row, column) }, scrollIntoView: true });
      view.focus();
    };
    button.addEventListener('click', () => reveal());
    // Resolve cell indices from the generated table, never user-supplied data
    // attributes. Do not catch scrollbar clicks on the surrounding container.
    const table = content.querySelector('table');
    if (table) {
      Array.from(table.rows).forEach((row, rowIndex) => {
        Array.from(row.cells).forEach((cell, columnIndex) => {
          cell.addEventListener('mousedown', event => {
            if (event.button !== 0) return;
            event.preventDefault();
            reveal(rowIndex, columnIndex);
          });
          cell.addEventListener('click', event => {
            event.preventDefault();
            reveal(rowIndex, columnIndex);
          });
        });
      });
    }
    return element;
  }

  ignoreEvent() { return true; }
}

export interface LiveTableState {
  ranges: readonly MarkdownTableRange[];
  decorations: DecorationSet;
  pending: boolean;
}

function decorationsFor(state: EditorState, ranges: readonly MarkdownTableRange[]): DecorationSet {
  const decorations: Range<Decoration>[] = [];
  for (const table of ranges) {
    const first = state.doc.lineAt(table.from);
    const last = state.doc.lineAt(table.to);
    if (state.selection.ranges.some(selection => selection.from <= last.to && selection.to >= first.from)) continue;
    decorations.push(Decoration.replace({
      widget: new TableWidget(table), block: true, inclusive: false, liveTable: true,
    }).range(table.from, table.to));
  }
  return Decoration.set(decorations, true);
}

export const liveTableState = StateField.define<LiveTableState>({
  create(state) {
    const ranges = scanMarkdownTables(state.doc.toString());
    return { ranges, decorations: decorationsFor(state, ranges), pending: false };
  },
  update(value, transaction) {
    if (transaction.annotation(composingTable) || transaction.isUserEvent('input.type.compose')) {
      // Do not replace the IME-owned DOM, even when a composition forms a table.
      return { ...value, decorations: value.decorations.map(transaction.changes), pending: true };
    }
    if (!value.pending && !transaction.docChanged && !transaction.selection) return value;
    const ranges = transaction.docChanged || value.pending ? scanMarkdownTables(transaction.state.doc.toString()) : value.ranges;
    return { ranges, decorations: decorationsFor(transaction.state, ranges), pending: false };
  },
  provide: field => EditorView.decorations.from(field, value => value.decorations),
});

export function getLiveTableRanges(state: EditorState): readonly MarkdownTableRange[] {
  return state.field(liveTableState, false)?.ranges ?? [];
}

const compositionRefresh = ViewPlugin.fromClass(class {
  timer: ReturnType<typeof setTimeout> | undefined;
  destroyed = false;
  constructor(readonly view: EditorView) {}
  update() {
    if (this.view.state.field(liveTableState).pending) this.schedule();
    else if (this.timer !== undefined) { clearTimeout(this.timer); this.timer = undefined; }
  }
  schedule(delay = 50) {
    if (this.destroyed || this.timer !== undefined) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      if (this.destroyed || !this.view.state.field(liveTableState).pending) return;
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

export function liveTables(getView: () => EditorView | null): Extension {
  return [
    liveTableState,
    EditorState.transactionExtender.of(() => {
      const view = getView();
      return view?.compositionStarted || view?.composing ? { annotations: composingTable.of(true) } : null;
    }),
    compositionRefresh,
  ];
}
