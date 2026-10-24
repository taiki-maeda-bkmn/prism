import { Facet, Prec, StateEffect, StateField, EditorState, type Extension } from '@codemirror/state';
import { EditorView, keymap } from '@codemirror/view';
import { ensureSyntaxTree } from '@codemirror/language';
import { isolateHistory } from '@codemirror/commands';
import {
  acceptCompletion, autocompletion, clearSnippet, closeCompletion, completionKeymap,
  nextSnippetField, pickedCompletion, prevSnippetField, selectedCompletion, snippet,
  type Completion, type CompletionContext, type CompletionResult,
} from '@codemirror/autocomplete';

import { snippetCatalog, type MarkdownSnippet } from './snippetDefinitions';
import { MAX_MATH_LENGTH, matchMathAt } from './math';
export { snippetCatalog, type MarkdownSnippet } from './snippetDefinitions';

interface SnippetContext {
  from: number;
  to: number;
  query: string;
  allowBlock: boolean;
}

const dismissContext = StateEffect.define<SnippetContext>();
const dismissedContext = StateField.define<SnippetContext | null>({
  create: () => null,
  update(value, transaction) {
    // Editing or moving the caret starts a new request. Escape followed by Tab
    // at the untouched trigger must continue to behave like ordinary Tab.
    if (transaction.docChanged || !transaction.startState.selection.eq(transaction.newSelection)) value = null;
    for (const effect of transaction.effects) if (effect.is(dismissContext)) value = effect.value;
    return value;
  },
});

const excludedNodes = new Set([
  'FencedCode', 'CodeBlock', 'InlineCode', 'HTMLBlock', 'HTMLTag', 'CommentBlock',
  'Link', 'Image', 'Autolink', 'URL', 'LinkTitle', 'LinkReference',
]);
const inlineFormatting = new Set(['Emphasis', 'StrongEmphasis', 'Strikethrough', 'Table', 'TableHeader', 'TableRow', 'TableCell']);
const japaneseCharacter = /[\p{Script_Extensions=Han}\p{Script_Extensions=Hiragana}\p{Script_Extensions=Katakana}]/u;

function atProseBoundary(before: string, from: number): boolean {
  if (!from) return true;
  const prefix = before.slice(0, from);
  const previous = Array.from(prefix.slice(-2)).at(-1)!;
  if (/\s/.test(previous)) return true;
  // Japanese words have no separating spaces. Punctuation is also a useful
  // boundary, but slashes in paths, URLs, and escaped literals are not triggers.
  if (!japaneseCharacter.test(previous) && !/[\p{P}\p{S}]/u.test(previous)) return false;
  let tokenStart = prefix.length;
  while (tokenStart > 0 && !/\s/.test(prefix[tokenStart - 1])) tokenStart--;
  const token = prefix.slice(tokenStart);
  return !/[\\/]|[\w+.-]:/.test(token) && previous !== '_';
}

function composing(view: EditorView | undefined): boolean {
  // compositionStarted also covers the interval before the IME's first edit.
  return Boolean(view && (view.compositionStarted || view.composing));
}

// Incomplete inline markup often parses as ordinary prose. Avoid interpreting
// slash words while the user is still writing a code span, tag, or link.
function insideUnfinishedMarkup(text: string): boolean {
  let codeWidth = 0;
  let brackets = 0;
  let destinationDepth = 0;
  let tag = false;
  let tagQuote: string | null = null;
  let tagTerminator = '>';
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (tag) {
      if (tagTerminator !== '>') {
        if (text.startsWith(tagTerminator, index)) {
          tag = false;
          index += tagTerminator.length - 1;
        }
        continue;
      }
      if (tagQuote) {
        if (char === tagQuote) tagQuote = null;
      } else if (char === '"' || char === "'") tagQuote = char;
      else if (char === '>') tag = false;
      continue;
    }
    if (char === '\\' && !codeWidth) { index++; continue; }
    if (char === '`') {
      let end = index + 1;
      while (text[end] === '`') end++;
      const width = end - index;
      if (!codeWidth) codeWidth = width;
      else if (codeWidth === width) codeWidth = 0;
      index = end - 1;
      continue;
    }
    if (codeWidth) continue;
    if (char === '<' && /[A-Za-z!/?]/.test(text[index + 1] ?? '')) {
      tag = true;
      tagTerminator = text.startsWith('<!--', index) ? '-->'
        : text.startsWith('<![CDATA[', index) ? ']]>'
          : text.startsWith('<?', index) ? '?>' : '>';
      continue;
    }
    if (char === '[') brackets++;
    if (char === ']') {
      brackets = Math.max(0, brackets - 1);
      if (text[index + 1] === '(') { destinationDepth++; index++; }
    } else if (destinationDepth && char === '(') destinationDepth++;
    else if (destinationDepth && char === ')') destinationDepth--;
  }
  return codeWidth > 0 || brackets > 0 || destinationDepth > 0 || tag;
}

export function findSnippetContext(state: EditorState, pos = state.selection.main.head): SnippetContext | null {
  const selection = state.selection;
  if (state.readOnly || selection.ranges.length !== 1 || !selection.main.empty || selection.main.head !== pos) return null;
  const line = state.doc.lineAt(pos);
  const before = state.sliceDoc(line.from, pos);
  const match = /\/[a-z0-9_-]*$/.exec(before);
  if (!match || !atProseBoundary(before, match.index)) return null;
  const after = state.sliceDoc(pos, line.to);
  if (/^[\p{L}\p{N}_/\-]/u.test(after) && !japaneseCharacter.test(String.fromCodePoint(after.codePointAt(0)!))) return null;
  const from = line.from + match.index;
  const dismissed = state.field(dismissedContext, false);
  if (dismissed?.from === from && dismissed.to === pos && dismissed.query === match[0]) return null;

  // Fail closed if a large document has not yet been parsed to the caret.
  const tree = ensureSyntaxTree(state, pos, 50);
  if (!tree) return null;
  let inlineFrom = line.from;
  let allowBlock = true;
  for (const position of [from, pos]) {
    for (let node = tree.resolveInner(position, -1); node; node = node.parent!) {
      if (excludedNodes.has(node.name)) return null;
      if (inlineFormatting.has(node.name)) allowBlock = false;
      if (node.name === 'Paragraph' || node.name.startsWith('ATXHeading') || node.name.startsWith('SetextHeading')) {
        inlineFrom = Math.min(inlineFrom, node.from);
      }
    }
  }
  if (insideUnfinishedMarkup(state.sliceDoc(inlineFrom, from))) return null;
  // Cursor templates can fill inline formatting or equations. A separate
  // Markdown block would split the surrounding delimiters across paragraphs.
  if (allowBlock) {
    // Search only nearby delimiters, using the document's existing syntax tree
    // to exclude code/HTML. Reparsing a sliced document can misread a closing
    // fence at the slice's start as an opening fence and hide the real equation.
    const mathStart = Math.max(0, from - MAX_MATH_LENGTH - 2);
    const mathSource = state.sliceDoc(mathStart, Math.min(state.doc.length, pos + MAX_MATH_LENGTH + 2));
    const hasClosingParenthesis = mathSource.includes('\\)');
    const hasClosingBracket = mathSource.includes('\\]');
    let mathEnd = 0;
    for (const opening of mathSource.slice(0, from - mathStart).matchAll(/\$|\\[([]/g)) {
      if (opening.index < mathEnd || opening[0] === '\\(' && !hasClosingParenthesis || opening[0] === '\\[' && !hasClosingBracket) continue;
      let protectedOpening = false;
      for (let node = tree.resolveInner(mathStart + opening.index, 1); node; node = node.parent!) {
        if (excludedNodes.has(node.name)) { protectedOpening = true; break; }
      }
      if (protectedOpening) continue;
      const math = matchMathAt(mathSource, opening.index);
      if (math) mathEnd = math.to;
      if (math && from - mathStart >= math.contentFrom && pos - mathStart <= math.contentTo) { allowBlock = false; break; }
    }
  }
  return {
    from, to: pos, query: match[0],
    allowBlock,
  };
}

function matches(definition: MarkdownSnippet, context: SnippetContext): boolean {
  return definition.trigger.startsWith(context.query) && (!definition.block || context.allowBlock);
}

function createCompletion(definition: MarkdownSnippet): Completion {
  const insert = snippet(definition.template);
  return {
    label: definition.trigger,
    detail: definition.title,
    info: definition.description,
    type: 'text',
    apply(view, completion, from, to) {
      const context = findSnippetContext(view.state);
      if (!view.state.facet(customSnippetConfiguration).some(entry => entry.completion === completion)
        || composing(view) || !context || context.from !== from || context.to !== to
        || !matches(definition, context)) return;
      const line = view.state.doc.lineAt(from);
      const prefix = definition.block && /\S/.test(view.state.sliceDoc(line.from, from)) ? '\n\n' : '';
      const suffix = definition.block && /\S/.test(view.state.sliceDoc(to, line.to)) ? '\n\n' : '';
      // One snippet transaction keeps the surrounding prose, placeholder
      // positions, and undo together, including when a block splits a line.
      const apply = prefix || suffix ? snippet(prefix + definition.template + suffix) : insert;
      apply(view, completion, from, to);
    },
  };
}

// Reconfigure this facet to change templates without replacing the editor or
// its undo history. Compile templates only when the catalog changes.
export const customSnippetConfiguration = Facet.define<readonly MarkdownSnippet[], readonly { definition: MarkdownSnippet; completion: Completion }[]>({
  combine: inputs => [...snippetCatalog, ...inputs.flat()].map(definition => ({ definition, completion: createCompletion(definition) })),
});

export function snippetCompletionSource(context: CompletionContext): CompletionResult | null {
  if (composing(context.view)) return null;
  const match = findSnippetContext(context.state, context.pos);
  if (!match) return null;
  const options = context.state.facet(customSnippetConfiguration)
    .filter(({ definition }) => matches(definition, match))
    .map(({ completion }) => completion);
  if (!options.length) return null;
  return {
    from: match.from,
    to: match.to,
    options,
    filter: false,
    // Refresh synchronously on each edit. Backspacing can broaden the prefix,
    // and moving into markup must invalidate an already visible suggestion.
    update: (_current, _from, _to, next) => snippetCompletionSource(next),
  };
}

export function expandSnippet(view: EditorView): boolean {
  if (composing(view) || view.state.readOnly) return false;
  if (nextSnippetField(view)) return true;
  const context = findSnippetContext(view.state);
  if (!context) return false;
  const selected = selectedCompletion(view.state);
  const catalog = view.state.facet(customSnippetConfiguration);
  const selectedDefinition = catalog.find(({ completion }) => completion === selected)?.definition;
  if (selectedDefinition && matches(selectedDefinition, context) && acceptCompletion(view)) return true;
  // A complete trigger works even before the asynchronous popup has opened.
  const completion = catalog.find(({ definition }) => definition.trigger === context.query && matches(definition, context))?.completion;
  if (!completion) return false;
  if (typeof completion.apply !== 'function') return false;
  completion.apply(view, completion, context.from, context.to);
  closeCompletion(view);
  return true;
}

export function dismissSnippets(view: EditorView): boolean {
  if (composing(view)) return false;
  const context = findSnippetContext(view.state);
  const hasOptions = context && view.state.facet(customSnippetConfiguration).some(({ definition }) => matches(definition, context));
  const cleared = clearSnippet(view);
  const closed = closeCompletion(view);
  if (hasOptions) view.dispatch({ effects: dismissContext.of(context) });
  return Boolean(cleared || closed || hasOptions);
}

export const markdownSnippets: Extension = [
  dismissedContext,
  autocompletion({
    override: [snippetCompletionSource],
    defaultKeymap: false,
    activateOnTypingDelay: 0,
    interactionDelay: 0,
    icons: false,
    tooltipClass: () => 'prism-snippet-completions',
  }),
  Prec.highest(keymap.of([
    { key: 'Tab', run: expandSnippet, shift: view => !composing(view) && prevSnippetField(view) },
    { key: 'Escape', run: dismissSnippets },
    { key: 'Enter', run: view => { if (!composing(view)) closeCompletion(view); return false; } },
    ...completionKeymap.filter(binding => binding.key !== 'Escape' && binding.key !== 'Enter'),
  ])),
  EditorState.transactionExtender.of(transaction => transaction.annotation(pickedCompletion)
    ? { annotations: isolateHistory.of('full') } : null),
];
