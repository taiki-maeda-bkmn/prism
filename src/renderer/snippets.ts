import { Prec, StateEffect, StateField, EditorState, type Extension } from '@codemirror/state';
import { EditorView, keymap } from '@codemirror/view';
import { ensureSyntaxTree } from '@codemirror/language';
import { isolateHistory } from '@codemirror/commands';
import {
  acceptCompletion, autocompletion, clearSnippet, closeCompletion, completionKeymap,
  nextSnippetField, pickedCompletion, prevSnippetField, selectedCompletion, snippet,
  type Completion, type CompletionContext, type CompletionResult,
} from '@codemirror/autocomplete';

export interface MarkdownSnippet {
  trigger: string;
  title: string;
  description: string;
  template: string;
  block: boolean;
}

export const snippetCatalog: readonly MarkdownSnippet[] = [
  { trigger: '/h1', title: 'Heading 1', description: 'A large heading.', template: '# ${1:Heading}\n${0}', block: true },
  { trigger: '/h2', title: 'Heading 2', description: 'A section heading.', template: '## ${1:Heading}\n${0}', block: true },
  { trigger: '/task', title: 'Task', description: 'An unchecked task.', template: '- [ ] ${1:Task}\n${0}', block: true },
  { trigger: '/quote', title: 'Quote', description: 'A block quote.', template: '> ${1:Quote}\n${0}', block: true },
  { trigger: '/code', title: 'Code block', description: 'A fenced block with language and code fields.', template: '```${1:language}\n${2:code}\n```\n${0}', block: true },
  { trigger: '/table', title: 'Table', description: 'Two columns with a header and a row.', template: '| ${1:Column 1} | ${2:Column 2} |\n| --- | --- |\n| ${3:Value 1} | ${4:Value 2} |\n${0}', block: true },
  { trigger: '/link', title: 'Link', description: 'A label and web address.', template: '[${1:label}](${2:https://example.com})${0}', block: false },
  { trigger: '/wiki', title: 'Note link', description: 'A link to another note in this notebook.', template: '[[${1:Note name}]]${0}', block: false },
];

interface SnippetContext {
  from: number;
  to: number;
  query: string;
  block: boolean;
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
  const match = /\/[a-z0-9]*$/.exec(before);
  if (!match || (match.index > 0 && !/\s/.test(before[match.index - 1]))) return null;
  const after = state.sliceDoc(pos, line.to);
  if (/^[\p{L}\p{N}_/\-]/u.test(after)) return null;
  const from = line.from + match.index;
  const dismissed = state.field(dismissedContext, false);
  if (dismissed?.from === from && dismissed.to === pos && dismissed.query === match[0]) return null;

  // Fail closed if a large document has not yet been parsed to the caret.
  const tree = ensureSyntaxTree(state, pos, 50);
  if (!tree) return null;
  let inlineFrom = line.from;
  for (const position of [from, pos]) {
    for (let node = tree.resolveInner(position, -1); node; node = node.parent!) {
      if (excludedNodes.has(node.name)) return null;
      if (node.name === 'Paragraph' || node.name.startsWith('ATXHeading') || node.name.startsWith('SetextHeading')) {
        inlineFrom = Math.min(inlineFrom, node.from);
      }
    }
  }
  if (insideUnfinishedMarkup(state.sliceDoc(inlineFrom, from))) return null;
  return {
    from, to: pos, query: match[0],
    block: /^ {0,3}$/.test(before.slice(0, match.index)) && /^\s*$/.test(after),
  };
}

const completions: readonly Completion[] = snippetCatalog.map(definition => {
  const insert = snippet(definition.template);
  return {
    label: definition.trigger,
    detail: definition.title,
    info: definition.description,
    type: 'text',
    apply(view, completion, from, to) {
      const context = findSnippetContext(view.state);
      if (composing(view) || !context || context.from !== from || context.to !== to
        || !definition.trigger.startsWith(context.query) || (definition.block && !context.block)) return;
      insert(view, completion, from, to);
    },
  };
});

export function snippetCompletionSource(context: CompletionContext): CompletionResult | null {
  if (composing(context.view)) return null;
  const match = findSnippetContext(context.state, context.pos);
  if (!match) return null;
  const options = completions.filter((completion, index) => completion.label.startsWith(match.query)
    && (!snippetCatalog[index].block || match.block));
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
  const selectedDefinition = snippetCatalog.find(definition => definition.trigger === selected?.label);
  if (selectedDefinition && selectedDefinition.trigger.startsWith(context.query)
    && (!selectedDefinition.block || context.block) && acceptCompletion(view)) return true;
  // A complete trigger works even before the asynchronous popup has opened.
  const index = snippetCatalog.findIndex(definition => definition.trigger === context.query && (!definition.block || context.block));
  if (index < 0) return false;
  const completion = completions[index];
  if (typeof completion.apply !== 'function') return false;
  completion.apply(view, completion, context.from, context.to);
  closeCompletion(view);
  return true;
}

export function dismissSnippets(view: EditorView): boolean {
  if (composing(view)) return false;
  const context = findSnippetContext(view.state);
  const hasOptions = context && snippetCatalog.some(definition => definition.trigger.startsWith(context.query) && (!definition.block || context.block));
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
