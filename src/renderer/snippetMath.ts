import type { EditorState } from '@codemirror/state';
import type { Tree } from '@lezer/common';
import { MAX_MATH_LENGTH, matchMathAt } from './math';

export interface SnippetMathContext {
  from: number;
  contentFrom: number;
  display: boolean;
}

const protectedNodes = new Set([
  'FencedCode', 'CodeBlock', 'InlineCode', 'HTMLBlock', 'HTMLTag', 'CommentBlock', 'ProcessingInstructionBlock',
  'Link', 'Image', 'Autolink', 'URL', 'LinkTitle', 'LinkReference',
]);
const physicalBlocks = new Set(['FencedCode', 'HTMLBlock', 'CommentBlock', 'ProcessingInstructionBlock']);
const hardCaretNodes = new Set([...physicalBlocks, 'InlineCode', 'HTMLTag']);
let lastContext: { doc: EditorState['doc']; tree: Tree; from: number; to: number; context: SnippetMathContext | null } | undefined;

/** Identify the TeX being edited, including an equation without its closing delimiter yet. */
export function findSnippetMathContext(state: EditorState, from: number, to: number, tree: Tree): SnippetMathContext | null {
  // Completion lookup, Tab handling, and insertion can ask about the same
  // immutable document in succession. Retain only the most recent lookup.
  if (lastContext?.doc === state.doc && lastContext.tree === tree && lastContext.from === from && lastContext.to === to) return lastContext.context;
  const context = scanSnippetMathContext(state, from, to, tree);
  lastContext = { doc: state.doc, tree, from, to, context };
  return context;
}

function scanSnippetMathContext(state: EditorState, from: number, to: number, tree: Tree): SnippetMathContext | null {
  for (const position of [from, to]) {
    for (let node = tree.resolveInner(position, -1); node; node = node.parent!) {
      if (hardCaretNodes.has(node.name)) return null;
    }
  }

  // Scan delimiters from real document boundaries. Starting in an arbitrary
  // slice can mistake an earlier equation's closing dollar for a new opener.
  // This scans text/tree nodes linearly, and never reparses the Markdown.
  const source = state.sliceDoc(0, Math.min(state.doc.length, to + MAX_MATH_LENGTH + 2));
  const before = source.slice(0, from);
  if (!before.includes('$') && !before.includes('\\(') && !before.includes('\\[')) return null;
  const protectedRanges: Array<{ from: number; to: number; name: string }> = [];
  const paragraphs: number[] = [];
  tree.iterate({
    to,
    enter(reference) {
      if (protectedNodes.has(reference.name)) {
        protectedRanges.push({ from: reference.from, to: reference.to, name: reference.name });
        return false;
      }
      if (reference.name === 'Paragraph' || reference.name.startsWith('ATXHeading') || reference.name.startsWith('SetextHeading')) {
        paragraphs.push(reference.from);
      }
    },
  });

  let active: (SnippetMathContext & { closing: string }) | null = null;
  let protectedIndex = 0;
  let paragraphIndex = 0;
  let brackets = 0;
  let destinationDepth = 0;
  let codeWidth = 0;
  let tag = false;
  let tagQuote: string | null = null;
  let tagTerminator = '>';
  const resetProse = () => { brackets = 0; destinationDepth = 0; codeWidth = 0; tag = false; tagQuote = null; };

  for (let index = 0; index < to; index++) {
    let newParagraph = false;
    while (paragraphIndex < paragraphs.length && paragraphs[paragraphIndex] <= index) {
      newParagraph = true;
      paragraphIndex++;
    }
    if (newParagraph && !active) resetProse();
    while (protectedIndex < protectedRanges.length && protectedRanges[protectedIndex].to <= index) protectedIndex++;
    const protectedRange = protectedRanges[protectedIndex];
    if (protectedRange && protectedRange.from <= index) {
      // Fenced code and HTML terminate an unfinished equation. A Markdown
      // Link or indented CodeBlock inside an equation may instead be TeX.
      if (!active || physicalBlocks.has(protectedRange.name)) {
        active = null;
        if (physicalBlocks.has(protectedRange.name) || protectedRange.name === 'CodeBlock') resetProse();
        index = protectedRange.to - 1;
        continue;
      }
    }
    if (active && index - active.contentFrom > MAX_MATH_LENGTH) active = null;

    const char = source[index];
    if (active) {
      if (!active.display && (char === '\n' || char === '\r')) { active = null; resetProse(); continue; }
      if (source.startsWith(active.closing, index)) {
        const dollarWidthMatches = active.closing[0] !== '$'
          || source[index - 1] !== '$' && source[index + active.closing.length] !== '$';
        if (dollarWidthMatches) {
          index += active.closing.length - 1;
          active = null;
          continue;
        }
      }
      if (char === '\\') index++;
      continue;
    }

    if (tag) {
      if (tagTerminator !== '>') {
        if (source.startsWith(tagTerminator, index)) { tag = false; index += tagTerminator.length - 1; }
      } else if (tagQuote) {
        if (char === tagQuote) tagQuote = null;
      } else if (char === '"' || char === "'") tagQuote = char;
      else if (char === '>') tag = false;
      continue;
    }
    if (char === '`') {
      let end = index + 1;
      while (source[end] === '`') end++;
      const width = end - index;
      if (!codeWidth) codeWidth = width;
      else if (codeWidth === width) codeWidth = 0;
      index = end - 1;
      continue;
    }
    if (codeWidth) continue;

    if (!brackets && !destinationDepth) {
      let opening: string | null = null;
      if (char === '$' && source[index - 1] !== '$') {
        if (source[index + 1] === '$') {
          if (source[index + 2] !== '$') opening = '$$';
        } else if (!/\s/.test(source[index + 1] ?? ' ')) {
          // A complete $5$ is an equation; an unfinished $5 amount remains
          // ordinary prose, so currency cannot consume later snippets.
          if (!/\d/.test(source[index + 1]) || matchMathAt(source, index)) opening = '$';
        }
      } else if (char === '\\' && (source[index + 1] === '(' || source[index + 1] === '[')) {
        opening = source.slice(index, index + 2);
      }
      if (opening) {
        active = {
          from: index, contentFrom: index + opening.length,
          display: opening === '$$' || opening === '\\[',
          closing: opening === '\\(' ? '\\)' : opening === '\\[' ? '\\]' : opening,
        };
        index += opening.length - 1;
        continue;
      }
    }
    if (char === '\\') { index++; continue; }
    if (char === '<' && /[A-Za-z!/?]/.test(source[index + 1] ?? '')) {
      tag = true;
      tagTerminator = source.startsWith('<!--', index) ? '-->'
        : source.startsWith('<![CDATA[', index) ? ']]>' : source.startsWith('<?', index) ? '?>' : '>';
    } else if (char === '[') brackets++;
    else if (char === ']') {
      brackets = Math.max(0, brackets - 1);
      if (source[index + 1] === '(') { destinationDepth++; index++; }
    } else if (destinationDepth && char === '(') destinationDepth++;
    else if (destinationDepth && char === ')') destinationDepth--;
  }
  if (!active || from < active.contentFrom || to - active.contentFrom > MAX_MATH_LENGTH) return null;
  return { from: active.from, contentFrom: active.contentFrom, display: active.display };
}
