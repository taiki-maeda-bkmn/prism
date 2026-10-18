import { markdownLanguage } from '@codemirror/lang-markdown';
import katex from 'katex';

export interface MathRange {
  from: number;
  to: number;
  contentFrom: number;
  contentTo: number;
  tex: string;
  display: boolean;
  raw: string;
}

export type MathRenderResult = { ok: true; html: string } | { ok: false; error: string };
export const MAX_MATH_LENGTH = 20_000;

function escapedAt(source: string, position: number): boolean {
  let backslashes = 0;
  while (position > 0 && source[--position] === '\\') backslashes++;
  return backslashes % 2 === 1;
}

/** Match delimiters without consuming escaped dollars, prices, or another line of inline prose. */
export function matchMathAt(source: string, from = 0): MathRange | undefined {
  return matchMath(source, from, (delimiter, start, limit) => {
    const found = source.slice(start, limit).indexOf(delimiter);
    return found < 0 ? -1 : start + found;
  });
}

function matchMath(source: string, from: number, next: (delimiter: string, start: number, limit: number) => number): MathRange | undefined {
  if (escapedAt(source, from)) return;
  let opening: string;
  let closing: string;
  let display: boolean;
  if (source.startsWith('$$', from)) {
    if (source[from - 1] === '$' || source[from + 2] === '$') return;
    opening = closing = '$$';
    display = true;
  } else if (source[from] === '$') {
    if (source[from - 1] === '$' || /\s/.test(source[from + 1] ?? ' ')) return;
    opening = closing = '$';
    display = false;
  } else if (source.startsWith('\\[', from) || source.startsWith('\\(', from)) {
    opening = source.slice(from, from + 2);
    display = opening === '\\[';
    closing = display ? '\\]' : '\\)';
  } else return;

  const contentFrom = from + opening.length;
  // Bound searches for incomplete input as well as KaTeX work on complete input.
  const limit = Math.min(source.length, contentFrom + MAX_MATH_LENGTH + closing.length);
  for (let at = next(closing, contentFrom, limit); at >= 0 && at < limit; at = next(closing, at + closing.length, limit)) {
    if (!display && /[\r\n]/.test(source.slice(contentFrom, at))) return;
    if (escapedAt(source, at)) continue;
    if (closing === '$' && (source[at + 1] === '$' || /\s/.test(source[at - 1] ?? ' ') || /\d/.test(source[at + 1] ?? ''))) return;
    if (closing === '$$' && source[at + 2] === '$') continue;
    const tex = source.slice(contentFrom, at);
    if (!tex.trim()) return;
    const to = at + closing.length;
    return { from, to, contentFrom, contentTo: at, tex, display, raw: source.slice(from, to) };
  }
}

const protectedBlocks = new Set(['FencedCode', 'CodeBlock', 'HTMLBlock', 'CommentBlock', 'ProcessingInstructionBlock']);
const protectedInline = new Set(['InlineCode', 'Link', 'Image', 'Autolink', 'URL', 'LinkReference', 'LinkTitle']);

let lastScan: { source: string; ranges: MathRange[] } | undefined;

/** Locate math in Markdown prose; examples, HTML and note destinations remain literal. */
export function scanMarkdownMath(source: string): MathRange[] {
  if (lastScan?.source === source) return lastScan.ranges;
  const ranges = scanMath(source);
  // Preview, title, graph and Live mode often request the same current note.
  // Keep only one input, so editing never retains the history of a large note.
  lastScan = { source, ranges };
  return ranges;
}

function scanMath(source: string): MathRange[] {
  if (!/\$|\\[([]/.test(source)) return [];
  const excluded: Array<{ from: number; to: number; block: boolean }> = [];
  const htmlTags: Array<{ from: number; to: number; parentTo: number; name: string; closing: boolean; standalone: boolean }> = [];
  const tree = markdownLanguage.parser.parse(source);
  tree.iterate({
    enter(node) {
      if (protectedBlocks.has(node.name) || protectedInline.has(node.name)) {
        excluded.push({ from: node.from, to: node.to, block: protectedBlocks.has(node.name) && node.name !== 'CodeBlock' });
        return false;
      }
      if (node.name === 'HTMLTag') {
        const tag = source.slice(node.from, node.to);
        const match = /^<\s*(\/?)\s*([a-z][\w-]*)\b/i.exec(tag);
        excluded.push({ from: node.from, to: node.to, block: false });
        if (match) htmlTags.push({
          from: node.from, to: node.to, parentTo: node.node.parent?.to ?? node.to,
          name: match[2].toLowerCase(), closing: Boolean(match[1]),
          standalone: /\/\s*>$/.test(tag) || /^(area|base|br|col|embed|hr|img|input|link|meta|param|source|track|wbr)$/i.test(match[2]),
        });
      }
    },
  });
  // Protect actual inline HTML containers, leaving neighboring Markdown math
  // intact. Tags/attributes alone are protected even when an element is void.
  const openTags = new Map<string, typeof htmlTags>();
  for (const tag of htmlTags) {
    if (tag.standalone) continue;
    const stack = openTags.get(tag.name) ?? [];
    if (!tag.closing) {
      stack.push(tag);
      openTags.set(tag.name, stack);
      continue;
    }
    // Every opening tag is popped once, including unmatched earlier paragraphs.
    // A long run of mismatched closing names must not scan all prior openings.
    while (stack.length && stack[stack.length - 1].parentTo < tag.to) {
      const open = stack.pop()!;
      excluded.push({ from: open.from, to: open.parentTo, block: false });
    }
    const open = stack.pop();
    if (open) excluded.push({ from: open.from, to: tag.to, block: false });
  }
  for (const stack of openTags.values()) {
    for (const open of stack) excluded.push({ from: open.from, to: open.parentTo, block: false });
  }
  // Wiki links are an application extension, so the base Markdown grammar does
  // not always recognize their full target/alias as a protected link.
  let wikiStart: number | undefined;
  for (const match of source.matchAll(/\[\[|\]\]|[\r\n]/g)) {
    if (match[0] === '[[') wikiStart ??= source[match.index - 1] === '!' ? match.index - 1 : match.index;
    else {
      if (match[0] === ']]' && wikiStart !== undefined) excluded.push({ from: wikiStart, to: match.index + 2, block: false });
      wikiStart = undefined;
    }
  }
  excluded.sort((a, b) => a.from - b.from || b.to - a.to);
  // Index closing delimiters once. Repeated incomplete \( or \[ sequences in
  // a large note must not repeatedly search the remaining document.
  const delimiters = new Map<string, number[]>([['$', []], ['$$', []], ['\\)', []], ['\\]', []]]);
  for (const match of source.matchAll(/\$|\\[)\]]/g)) {
    if (escapedAt(source, match.index)) continue;
    delimiters.get(match[0])?.push(match.index);
    if (match[0] === '$' && source[match.index + 1] === '$') delimiters.get('$$')!.push(match.index);
  }
  const nextDelimiter = (delimiter: string, start: number, limit: number): number => {
    const positions = delimiters.get(delimiter)!;
    let low = 0;
    let high = positions.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (positions[middle] < start) low = middle + 1; else high = middle;
    }
    return low < positions.length && positions[low] < limit ? positions[low] : -1;
  };
  const blocks = excluded.filter(range => range.block);
  const ranges: MathRange[] = [];
  let excludedIndex = 0;
  let blockIndex = 0;
  for (let from = 0; from < source.length; from++) {
    while (excludedIndex < excluded.length && excluded[excludedIndex].to <= from) excludedIndex++;
    const protectedRange = excluded[excludedIndex];
    if (protectedRange && protectedRange.from <= from) {
      from = protectedRange.to - 1;
      continue;
    }
    if (source[from] !== '$' && !(source[from] === '\\' && (source[from + 1] === '[' || source[from + 1] === '('))) continue;
    const range = matchMath(source, from, nextDelimiter);
    if (!range) continue;
    while (blockIndex < blocks.length && blocks[blockIndex].to <= from) blockIndex++;
    if (blocks[blockIndex]?.from < range.to) continue;
    if (range.display) {
      // Container prefixes belong to Markdown, not TeX. Preserve every source
      // offset and the original raw text for editing; normalize only rendering.
      let quoteDepth = 0;
      for (let node = tree.resolveInner(range.from, 1); node; node = node.parent!) {
        if (node.name === 'Blockquote') quoteDepth++;
      }
      if (quoteDepth) {
        range.tex = range.tex.replace(/(\r\n|\r|\n)([^\r\n]*)/g, (_whole, newline: string, line: string) => {
          for (let depth = 0; depth < quoteDepth; depth++) {
            const quote = /^[ \t]*>[ \t]?/.exec(line);
            if (!quote) break;
            line = line.slice(quote[0].length);
          }
          return newline + line;
        });
      }
    }
    ranges.push(range);
    from = range.to - 1;
  }
  return ranges;
}

/** Only KaTeX-generated HTML is trusted; note HTML never receives these privileges. */
export function renderMath(tex: string, display: boolean): MathRenderResult {
  if (tex.length > MAX_MATH_LENGTH) return { ok: false, error: `Formula exceeds the ${MAX_MATH_LENGTH.toLocaleString('en-US')} character limit.` };
  try {
    return {
      ok: true,
      html: katex.renderToString(tex, {
        displayMode: display,
        output: 'htmlAndMathml',
        throwOnError: true,
        trust: false,
        strict: 'ignore',
        maxExpand: 1_000,
        maxSize: 20,
        // KaTeX mutates this object for \\gdef: no state may escape an expression.
        macros: {},
      }),
    };
  } catch (error) {
    // Errors can contain the original unescaped source. Callers must use
    // textContent or HTML escaping when presenting this diagnostic.
    return { ok: false, error: error instanceof Error ? error.message : 'Unable to render this formula.' };
  }
}

/** Heading labels should contain a formula once, rather than every KaTeX layer. */
export function mathTextContent(element: Element): string {
  const copy = element.cloneNode(true) as Element;
  for (const formula of copy.querySelectorAll('.katex')) {
    const tex = formula.querySelector('annotation[encoding="application/x-tex"]')?.textContent;
    if (tex !== undefined && tex !== null) formula.replaceWith(copy.ownerDocument.createTextNode(tex.trim()));
  }
  return copy.textContent || '';
}
