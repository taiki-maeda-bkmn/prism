import { Facet, type EditorState, type Extension, type Range, type Text } from '@codemirror/state';
import { syntaxTree } from '@codemirror/language';
import { Decoration, type DecorationSet, EditorView, ViewPlugin, type ViewUpdate, WidgetType } from '@codemirror/view';
import { getMarkdownReferences, renderMarkdown } from './markdown';
import { getLiveMathRanges } from './liveMath';
import { getLiveTableRanges } from './liveTables';

interface Span { from: number; to: number }
export interface LiveLink extends Span { href: string; html: string; labelOffset: number }

export const liveLinkNavigation = Facet.define<(href: string) => void, (href: string) => void>({
  combine: values => values[0] ?? (() => {}),
});

export function isLiveLinkOpenGesture(event: MouseEvent): boolean {
  return event.button === 0 && (event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey;
}

/** Native URL validation remains the final authority for external destinations. */
export function isLiveLinkHref(href: string): boolean {
  if (href.trim() !== href || /[\u0000-\u001f\u007f-\u009f]/.test(href)) return false;
  return !/^[a-z][a-z\d+.-]*:/i.test(href) || /^(?:https?:\/\/|mailto:|prism-note:)/i.test(href);
}

const excluded = new Set(['FencedCode', 'CodeBlock', 'HTMLBlock', 'CommentBlock', 'ProcessingInstructionBlock', 'HTMLTag', 'InlineCode', 'Image', 'LinkReference']);
const cache = new WeakMap<Text, {
  references?: ReturnType<typeof getMarkdownReferences>;
  links: Map<string, LiveLink | null>;
}>();

function touchesSelection(state: EditorState, span: Span): boolean {
  const first = state.doc.lineAt(span.from);
  const last = state.doc.lineAt(span.to);
  return state.selection.ranges.some(selection => selection.from <= last.to && selection.to >= first.from);
}

function renderedLink(state: EditorState, span: Span, wiki = false): LiveLink | null {
  let cached = cache.get(state.doc);
  if (!cached) cache.set(state.doc, cached = { links: new Map() });
  const key = `${span.from}:${span.to}`;
  if (cached.links.has(key)) return cached.links.get(key)!;
  // Use the same parser, references, escaping, and sanitizer as Read mode.
  // Lezer alone also reports unresolved references and wiki fragments as links.
  cached.references ??= getMarkdownReferences(state.doc.toString());
  const raw = state.sliceDoc(span.from, span.to);
  const template = window.document.createElement('template');
  template.innerHTML = renderMarkdown(raw, cached.references);
  const paragraph = template.content.firstElementChild;
  const anchor = paragraph?.firstElementChild;
  let result: LiveLink | null = null;
  if (paragraph?.tagName === 'P' && paragraph.childNodes.length === 1 && anchor?.tagName === 'A'
    && anchor.hasAttribute('href') && isLiveLinkHref(anchor.getAttribute('href')!)) {
    // Keep link labels inert apart from our own activation gesture.
    for (const image of anchor.querySelectorAll('img')) image.replaceWith(window.document.createTextNode(image.alt));
    for (const child of anchor.querySelectorAll('input, button, select, textarea, audio, video, details, summary')) {
      child.replaceWith(window.document.createTextNode(child.textContent ?? ''));
    }
    for (const child of anchor.querySelectorAll('*')) {
      for (const name of ['tabindex', 'contenteditable', 'autofocus']) child.removeAttribute(name);
    }
    result = {
      ...span, href: anchor.getAttribute('href')!, html: anchor.innerHTML,
      labelOffset: wiki ? (raw.includes('|') ? raw.indexOf('|') + 1 : 2) : /^[\[<]/.test(raw) ? 1 : 0,
    };
  }
  cached.links.set(key, result);
  return result;
}

/** Source positions come from the editor tree, never from rendered label lengths. */
export function getLiveLinks(state: EditorState, visibleRanges: readonly Span[]): LiveLink[] {
  const tree = syntaxTree(state);
  // Rendered tables own their anchors. Once any table line is selected, the
  // entire source is revealed and its links use ordinary editor decorations.
  const protectedRanges = [...getLiveMathRanges(state), ...getLiveTableRanges(state).filter(table => !touchesSelection(state, table))];
  const candidates = new Map<string, Span & { wiki?: boolean }>();
  const protectedSpan = (span: Span) => protectedRanges.some(range => range.from < span.to && range.to > span.from);
  for (const visible of visibleRanges) {
    tree.iterate({ from: visible.from, to: visible.to, enter(reference) {
      const node = reference.node;
      if (excluded.has(node.name) || protectedRanges.some(range => range.from <= node.from && range.to >= node.to)) return false;
      if (['Link', 'Autolink', 'URL'].includes(node.name)) {
        if (protectedSpan(node)) return false;
        candidates.set(`${node.from}:${node.to}`, { from: node.from, to: node.to });
        return false;
      }
    } });
    // Wiki links are Prism's extension and are not represented by Lezer as a
    // complete link. Scan only visible lines and validate their syntax context.
    const first = state.doc.lineAt(visible.from).number;
    const last = state.doc.lineAt(visible.to).number;
    for (let number = first; number <= last; number++) {
      const line = state.doc.line(number);
      for (const match of line.text.matchAll(/!?\[\[[^\]\n]+\]\]/g)) {
        if (match[0].startsWith('!')) continue;
        const from = line.from + match.index;
        const to = from + match[0].length;
        let escapes = 0;
        for (let index = from - 1; index >= line.from && state.sliceDoc(index, index + 1) === '\\'; index--) escapes++;
        if (escapes % 2 || protectedSpan({ from, to })) continue;
        let blocked = false;
        for (let node = tree.resolveInner(from + 2, 1); node; node = node.parent!) {
          if (excluded.has(node.name) || (node.name === 'Link' && (node.from < from || node.to > to))) { blocked = true; break; }
        }
        if (!blocked) candidates.set(`${from}:${to}`, { from, to, wiki: true });
      }
    }
  }
  const links: LiveLink[] = [];
  // Prefer complete wiki links over their inner, unresolved Lezer Link node.
  for (const candidate of [...candidates.values()].sort((a, b) => a.from - b.from || b.to - a.to)) {
    if (links.length && candidate.from < links[links.length - 1].to) continue;
    const link = renderedLink(state, candidate, candidate.wiki);
    if (link) links.push(link);
  }
  return links;
}

class LinkWidget extends WidgetType {
  constructor(readonly link: LiveLink) { super(); }
  eq(other: LinkWidget) { return this.link.href === other.link.href && this.link.html === other.link.html && this.link.labelOffset === other.link.labelOffset; }
  toDOM(view: EditorView) {
    const anchor = view.dom.ownerDocument.createElement('a');
    anchor.className = 'cm-live-link';
    anchor.setAttribute('href', this.link.href);
    anchor.setAttribute('title', `Ctrl+click to open (⌘+click on Mac): ${this.link.href}`);
    anchor.contentEditable = 'false';
    anchor.innerHTML = this.link.html;
    const current = () => {
      if (!anchor.isConnected || view.composing || view.compositionStarted) return null;
      const from = view.posAtDOM(anchor);
      return getLiveLinks(view.state, [{ from, to: from }]).find(link => link.from === from && link.href === anchor.getAttribute('href'));
    };
    anchor.addEventListener('mousedown', event => {
      if (event.button === 0) event.preventDefault();
    });
    anchor.addEventListener('click', event => {
      event.preventDefault();
      event.stopPropagation();
      if (event.button !== 0) return;
      const link = current();
      if (!link) return;
      if (isLiveLinkOpenGesture(event)) view.state.facet(liveLinkNavigation)(link.href);
      else {
        view.dispatch({ selection: { anchor: link.from + link.labelOffset }, scrollIntoView: true });
        view.focus();
      }
    });
    anchor.addEventListener('auxclick', event => event.preventDefault());
    anchor.addEventListener('keydown', event => {
      if (event.key !== 'Enter') return;
      event.preventDefault();
      const link = current();
      if (link) view.state.facet(liveLinkNavigation)(link.href);
    });
    return anchor;
  }
  ignoreEvent() { return true; }
}

export function buildLiveLinkDecorations(state: EditorState, visibleRanges: readonly Span[]): DecorationSet {
  const decorations: Range<Decoration>[] = [];
  const tables = getLiveTableRanges(state);
  for (const link of getLiveLinks(state, visibleRanges)) {
    const first = state.doc.lineAt(link.from);
    const last = state.doc.lineAt(link.to);
    const active = touchesSelection(state, link);
    const inTable = tables.some(table => link.from >= table.from && link.to <= table.to);
    if (!active && !inTable && first.number === last.number) {
      decorations.push(Decoration.replace({ widget: new LinkWidget(link), inclusive: false, liveLink: true }).range(link.from, link.to));
    } else {
      // Multiline links and revealed tables keep their complete source geometry.
      // Active lines retain every Markdown character and Ctrl-click targets.
      decorations.push(Decoration.mark({ tagName: 'a', attributes: {
        class: 'cm-live-link', href: link.href, title: `Ctrl+click to open (⌘+click on Mac): ${link.href}`,
      }, liveLink: true }).range(link.from, link.to));
    }
  }
  return Decoration.set(decorations, true);
}

const presentation = ViewPlugin.fromClass(class {
  decorations: DecorationSet;
  pending = false;
  timer: ReturnType<typeof setTimeout> | undefined;
  constructor(readonly view: EditorView) { this.decorations = buildLiveLinkDecorations(view.state, view.visibleRanges); }
  update(update: ViewUpdate) {
    if (!(this.pending || update.docChanged || update.selectionSet || update.viewportChanged || syntaxTree(update.startState) !== syntaxTree(update.state))) return;
    if (this.view.composing || this.view.compositionStarted) {
      this.decorations = this.decorations.map(update.changes);
      this.pending = true;
      this.schedule();
      return;
    }
    this.decorations = buildLiveLinkDecorations(update.state, this.view.visibleRanges);
    this.pending = false;
  }
  schedule() {
    if (this.timer !== undefined) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      if (!this.pending) return;
      if (this.view.composing || this.view.compositionStarted) this.schedule();
      else this.view.dispatch({});
    }, 50);
  }
  destroy() { if (this.timer !== undefined) clearTimeout(this.timer); }
}, {
  decorations: plugin => plugin.decorations,
  eventHandlers: {
    mousedown(event) {
      const anchor = (event.target as Element).closest('a.cm-live-link');
      if (!anchor || !isLiveLinkOpenGesture(event)) return false;
      event.preventDefault();
      return true;
    },
    click(event, view) {
      const anchor = (event.target as Element).closest('a.cm-live-link');
      if (!anchor) return false;
      event.preventDefault();
      if (isLiveLinkOpenGesture(event) && !view.composing && !view.compositionStarted) {
        const position = view.posAtDOM(anchor);
        const link = getLiveLinks(view.state, [{ from: position, to: position }])
          .find(link => link.from <= position && link.to >= position && link.href === anchor.getAttribute('href'));
        if (link) view.state.facet(liveLinkNavigation)(link.href);
      }
      return true;
    },
    auxclick(event) {
      if (!(event.target as Element).closest('a.cm-live-link')) return false;
      event.preventDefault();
      return true;
    },
  },
});

export function liveLinks(onOpenLink: (href: string) => void): Extension {
  return [liveLinkNavigation.of(onOpenLink), presentation];
}
