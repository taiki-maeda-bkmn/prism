import createDOMPurify from 'dompurify';
import { Marked, Renderer, type Token, type Tokens } from 'marked';
import type { Note } from '../shared/types';
import { renderMath, scanMarkdownMath, type MathRange } from './math';

interface WikiToken extends Tokens.Generic {
  type: 'wikilink';
  target: string;
  label: string;
  embedded: boolean;
}

const escapeHTML = (text: string): string => text.replace(/[&<>"']/g, character => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
})[character]!);
const wikiHref = (target: string): string => `prism-note:${encodeURIComponent(target)}`;

const markdown = new Marked({
  gfm: true,
  breaks: false,
  extensions: [{
    name: 'wikilink',
    level: 'inline',
    start: source => source.search(/!?\[\[/),
    tokenizer(source): WikiToken | undefined {
      const match = /^(!?)\[\[([^\]\n]+)\]\]/.exec(source);
      if (!match) return;
      const separator = match[2].indexOf('|');
      const target = (separator < 0 ? match[2] : match[2].slice(0, separator)).trim();
      if (!target) return;
      return {
        type: 'wikilink', raw: match[0], target,
        label: separator < 0 ? target : match[2].slice(separator + 1).trim(),
        embedded: match[1] === '!',
      };
    },
    renderer(token) {
      const wiki = token as WikiToken;
      if (wiki.embedded) return escapeHTML(wiki.raw);
      return `<a class="wiki-link" href="${wikiHref(wiki.target)}">${escapeHTML(wiki.label)}</a>`;
    },
  }],
});

let purifier: ReturnType<typeof createDOMPurify> | undefined;

function getPurifier(): ReturnType<typeof createDOMPurify> {
  if (purifier) return purifier;
  purifier = createDOMPurify(window);
  purifier.addHook('uponSanitizeElement', (node, data) => {
    if (data.tagName !== 'input') return;
    const input = node as HTMLInputElement;
    if (input.getAttribute('type')?.toLowerCase() !== 'checkbox') {
      input.remove();
      return;
    }
    // Task state is useful Markdown content; arbitrary form controls aren't.
    const checked = input.hasAttribute('checked');
    for (const attribute of [...input.attributes]) input.removeAttribute(attribute.name);
    input.setAttribute('type', 'checkbox');
    input.setAttribute('disabled', '');
    input.setAttribute('aria-label', checked ? 'Completed task' : 'Incomplete task');
    if (checked) input.setAttribute('checked', '');
  });
  return purifier;
}

interface PreparedMath {
  source: string;
  formulas: Map<string, MathRange>;
  headingText: (text: string) => string;
}

/** Hide formulas from Markdown before it can interpret TeX as links or emphasis. */
function prepareMath(content: string): PreparedMath {
  const formulas = new Map<string, MathRange>();
  const ranges = scanMarkdownMath(content);
  if (!ranges.length) return { source: content, formulas, headingText: plainHeading };
  // A note cannot forge a placeholder for trusted HTML: every parse has a fresh
  // identity, and only ranges returned by the math scanner enter this map.
  const nonce = crypto.randomUUID();
  let source = '';
  let position = 0;
  for (const range of ranges) {
    const key = `${nonce}-${formulas.size}`;
    formulas.set(key, range);
    source += content.slice(position, range.from) + `<span data-prism-math="${key}"></span>`;
    position = range.to;
  }
  source += content.slice(position);
  const placeholders = /<span data-prism-math="([a-f0-9-]+)"><\/span>/g;
  return {
    source,
    formulas,
    headingText: text => {
      // Strip Markdown formatting around math, never TeX subscripts or commands.
      const masked = text.replace(placeholders, (whole, key: string) => formulas.has(key) ? `PRISMMATH${key}END` : whole);
      return plainHeading(masked).replace(/PRISMMATH([a-f0-9-]+)END/g, (whole, key: string) => formulas.get(key)?.tex.trim() ?? whole);
    },
  };
}

function mathPlainText(fragment: DocumentFragment, formulas: Map<string, MathRange>): string {
  for (const placeholder of fragment.querySelectorAll('[data-prism-math]')) {
    const math = formulas.get(placeholder.getAttribute('data-prism-math') || '');
    if (math) placeholder.textContent = math.tex.trim();
  }
  return fragment.textContent || '';
}

function restoreMath(fragment: DocumentFragment, formulas: Map<string, MathRange>): void {
  for (const placeholder of fragment.querySelectorAll('[data-prism-math]')) {
    const math = formulas.get(placeholder.getAttribute('data-prism-math') || '');
    if (!math) continue;
    const rendered = renderMath(math.tex, math.display);
    placeholder.removeAttribute('data-prism-math');
    placeholder.className = math.display ? 'prism-math-display' : 'prism-math-inline';
    if (rendered.ok) {
      // This HTML is generated solely by KaTeX with untrusted commands disabled.
      // Restoring after sanitization preserves its geometry without allowing
      // style attributes on any user-authored Markdown or raw HTML.
      placeholder.innerHTML = rendered.html;
    } else {
      placeholder.classList.add('prism-math-error');
      placeholder.setAttribute('title', rendered.error);
      placeholder.textContent = math.raw;
    }
  }
}

export interface MarkdownHeading { title: string; level: number; index: number }

/** Keep editable heading metadata separate from user-supplied HTML attributes. */
export function renderMarkdownDocument(content: string): { html: string; headings: MarkdownHeading[] } {
  const prepared = prepareMath(content);
  const headingIds = new Set<string>();
  const headings: MarkdownHeading[] = [];
  const renderer = new Renderer();
  renderer.heading = function ({ tokens, depth, text }) {
    const base = prepared.headingText(text).toLocaleLowerCase().replace(/[^\p{L}\p{N}_\s-]/gu, '').trim().replace(/\s+/g, '-') || 'heading';
    let id = base;
    let suffix = 1;
    while (headingIds.has(id)) id = `${base}-${suffix++}`;
    headingIds.add(id);
    const inline = this.parser.parseInline(tokens);
    if (depth <= 3) headings.push({
      title: mathPlainText(getPurifier().sanitize(inline, { RETURN_DOM_FRAGMENT: true }), prepared.formulas),
      level: depth,
      index: headings.length,
    });
    return `<h${depth} id="${escapeHTML(id)}">${inline}</h${depth}>\n`;
  };
  const fragment = getPurifier().sanitize(markdown.parse(prepared.source, { async: false, renderer }), {
    RETURN_DOM_FRAGMENT: true,
    ALLOWED_URI_REGEXP: /^(?:(?:https?|mailto|prism-note):|[^a-z]|[a-z+.\-]+(?:[^a-z+.\-:]|$))/i,
    FORBID_TAGS: ['style', 'iframe', 'object', 'embed', 'form', 'button'],
    FORBID_ATTR: ['style'],
  });
  restoreMath(fragment, prepared.formulas);
  const container = window.document.createElement('div');
  container.append(fragment);
  return { html: container.innerHTML, headings };
}

/** Markdown is user content: sanitize after rendering, including raw HTML. */
export function renderMarkdown(content: string): string {
  return renderMarkdownDocument(content).html;
}

function decodePath(path: string): string {
  try { return decodeURIComponent(path); } catch { return path; }
}

function isExternal(target: string): boolean {
  return /^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(target);
}

/**
 * Read actual Markdown tokens so examples inside code and images aren't edges.
 * Wiki targets use their preview href to retain literal filename characters;
 * ordinary Markdown destinations retain their URI path/fragment semantics.
 */
export function extractLinks(content: string): string[] {
  const links = new Set<string>();
  function visit(tokens: Token[]) {
    for (const token of tokens) {
      if (['image', 'code', 'codespan', 'html'].includes(token.type)) continue;
      if (token.type === 'wikilink') {
        const wiki = token as WikiToken;
        if (!wiki.embedded && !isExternal(wiki.target)) links.add(wikiHref(wiki.target));
      } else if (token.type === 'link') {
        const target = (token as Tokens.Link).href;
        // The resolver accepts extensionless and relative paths too. Keep local
        // candidates here and let it filter missing files, assets and ambiguity.
        // A fragment/query alone stays within this note and cannot form an edge.
        if (target.startsWith('prism-note:') || (!isExternal(target) && target.split(/[?#]/, 1)[0])) links.add(target);
        continue;
      }
      if ('tokens' in token && Array.isArray(token.tokens)) visit(token.tokens);
      if (token.type === 'list') for (const item of (token as Tokens.List).items) visit(item.tokens);
      if (token.type === 'table') {
        const table = token as Tokens.Table;
        for (const cell of [...table.header, ...table.rows.flat()]) visit(cell.tokens);
      }
    }
  }
  visit(markdown.lexer(prepareMath(content).source));
  return [...links];
}

function normalize(path: string): string | undefined {
  const parts: string[] = [];
  for (const part of path.replace(/\\/g, '/').split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') {
      if (!parts.length) return undefined;
      parts.pop();
    } else parts.push(part);
  }
  return parts.join('/');
}

const withoutExtension = (path: string): string => path.replace(/\.(?:md|markdown)$/i, '');
const filename = (path: string): string => path.split('/').at(-1) ?? path;

interface LinkIndex {
  exact: Map<string, Note[]>;
  folded: Map<string, Note[]>;
  basenames: Map<string, Note[]>;
}
const indexes = new WeakMap<Note[], LinkIndex>();
const noteLinks = new WeakMap<Note, { content: string; links: string[] }>();
const noteTitles = new WeakMap<Note, { content: string; title: string }>();

function linkIndex(notes: Note[]): LinkIndex {
  const cached = indexes.get(notes);
  if (cached) return cached;
  const index: LinkIndex = { exact: new Map(), folded: new Map(), basenames: new Map() };
  const add = (map: Map<string, Note[]>, key: string, note: Note) => {
    const existing = map.get(key);
    if (existing) existing.push(note); else map.set(key, [note]);
  };
  for (const note of notes) {
    const stem = withoutExtension(note.path);
    add(index.exact, stem, note);
    add(index.folded, stem.toLocaleLowerCase(), note);
    add(index.basenames, filename(stem).toLocaleLowerCase(), note);
  }
  indexes.set(notes, index);
  return index;
}

/** Reuse tokenization for unchanged notes while the active note is edited. */
export function getNoteLinks(note: Note): readonly string[] {
  const cached = noteLinks.get(note);
  if (cached?.content === note.content) return cached.links;
  const links = extractLinks(note.content);
  noteLinks.set(note, { content: note.content, links });
  return links;
}

/** Prefer the current folder, then vault paths, then an unambiguous basename. */
function resolveNotePath(rawPath: string, fromPath: string, notes: Note[]): Note | 'ambiguous' | undefined {
  const path = rawPath.replace(/\\/g, '/');
  if (!path) return notes.find(note => note.path === fromPath);
  const index = linkIndex(notes);
  const directory = fromPath.includes('/') ? fromPath.slice(0, fromPath.lastIndexOf('/') + 1) : '';
  const candidates = path.startsWith('/')
    ? [normalize(path)]
    : [normalize(directory + path), normalize(path)];
  for (const candidate of candidates) {
    if (candidate === undefined) continue;
    const exact = index.exact.get(withoutExtension(candidate)) ?? [];
    if (exact.length === 1) return exact[0];
    if (exact.length > 1) return exact.find(note => note.path === candidate) ?? 'ambiguous';
    const insensitive = index.folded.get(withoutExtension(candidate).toLocaleLowerCase()) ?? [];
    if (insensitive.length === 1) return insensitive[0];
    if (insensitive.length > 1) return 'ambiguous';
  }
  // Explicit folders must not accidentally resolve to a similarly named file elsewhere.
  if (path.includes('/')) return undefined;
  const matches = index.basenames.get(withoutExtension(path).toLocaleLowerCase()) ?? [];
  return matches.length === 1 ? matches[0] : matches.length > 1 ? 'ambiguous' : undefined;
}

export interface ResolvedNoteLink {
  note: Note;
  fragment?: string;
}

/** Resolve a preview/extracted href, preserving its once-decoded destination. */
export function resolveNoteLink(target: string, fromPath: string, notes: Note[]): ResolvedNoteLink | undefined {
  if (target.startsWith('prism-note:')) {
    const raw = decodePath(target.slice(11));
    let path = raw;
    if (isExternal(path)) return undefined;
    // A wiki target is a literal filename, not another URI. In particular, %25
    // remains %25 and ? is never silently removed as a query string. Prefer a
    // real filename containing # before interpreting a suffix as a heading.
    while (true) {
      const match = resolveNotePath(path, fromPath, notes);
      if (match !== undefined) {
        if (match === 'ambiguous') return undefined;
        return path.length === raw.length ? { note: match } : { note: match, fragment: raw.slice(path.length + 1) };
      }
      const fragment = path.lastIndexOf('#');
      if (fragment < 0) return undefined;
      path = path.slice(0, fragment);
    }
  }
  if (isExternal(target)) return undefined;
  // Split URI syntax before decoding: an encoded %23 belongs to the filename.
  const match = resolveNotePath(decodePath(target.split(/[?#]/, 1)[0]), fromPath, notes);
  if (!match || match === 'ambiguous') return undefined;
  const fragment = target.indexOf('#');
  return fragment < 0 ? { note: match } : { note: match, fragment: decodePath(target.slice(fragment + 1)) };
}

/** Graph edges and backlinks depend on the destination note, not its heading. */
export function resolveLink(target: string, fromPath: string, notes: Note[]): Note | undefined {
  return resolveNoteLink(target, fromPath, notes)?.note;
}

export function getTitle(note: Note): string {
  const cached = noteTitles.get(note);
  if (cached?.content === note.content) return cached.title;
  const prepared = prepareMath(note.content);
  const heading = markdown.lexer(prepared.source).find(token => token.type === 'heading' && token.depth === 1) as Tokens.Heading | undefined;
  const title = (heading ? prepared.headingText(heading.text) : '') || withoutExtension(filename(note.path));
  noteTitles.set(note, { content: note.content, title });
  return title;
}

function plainHeading(text: string): string {
  return text
    .replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_match, target: string, label?: string) => label ?? target)
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/<[^>]*>/g, '').replace(/[*_`~]/g, '').trim();
}

export function getBacklinks(path: string, notes: Note[]): Note[] {
  return notes.filter(note => note.path !== path && getNoteLinks(note).some(target => resolveLink(target, note.path, notes)?.path === path));
}
