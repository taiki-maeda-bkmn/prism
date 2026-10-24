import { snippetCatalog, type MarkdownSnippet } from './snippetDefinitions';

export const customSnippetLimits = { count: 100, title: 80, description: 240, template: 20_000 } as const;
const storageKey = 'prism.snippets';

export function validateCustomSnippet(candidate: MarkdownSnippet, others: readonly MarkdownSnippet[]): string | null {
  if (!/^\/[a-z][a-z0-9_-]{0,31}$/.test(candidate.trigger)) {
    return 'Use / followed by a lowercase letter, then letters, numbers, hyphens or underscores (up to 32 characters).';
  }
  if ([...snippetCatalog, ...others].some(item => item.trigger === candidate.trigger)) return 'That shortcut is already in use. Choose another one.';
  if (!candidate.title.trim() || candidate.title.length > customSnippetLimits.title) return 'Enter a name of 1–80 characters.';
  if (candidate.description.length > customSnippetLimits.description) return 'Keep the description within 240 characters.';
  if (!candidate.template.trim() || candidate.template.length > customSnippetLimits.template) return 'Enter a template of 1–20,000 characters.';
  if (/\0/.test(candidate.template)) return 'Remove null characters from the template.';
  if (!candidate.block && /[\r\n]/.test(candidate.template)) return 'Snippets used inside a sentence must fit on one line.';
  return null;
}

function isSnippet(value: unknown): value is MarkdownSnippet {
  if (!value || typeof value !== 'object') return false;
  const item = value as Record<string, unknown>;
  return ['trigger', 'title', 'description', 'template'].every(key => typeof item[key] === 'string') && typeof item.block === 'boolean';
}

function normalize(item: MarkdownSnippet): MarkdownSnippet {
  return { trigger: item.trigger, title: item.title.trim(), description: item.description.trim(), template: item.template.replace(/\r\n?/g, '\n'), block: item.block };
}

export function parseCustomSnippets(serialized: string | null): MarkdownSnippet[] {
  try {
    const value: unknown = JSON.parse(serialized || 'null');
    if (!value || typeof value !== 'object') return [];
    const stored = value as Record<string, unknown>;
    if (stored.version !== 1 || !Array.isArray(stored.snippets)) return [];
    const result: MarkdownSnippet[] = [];
    for (const candidate of stored.snippets.slice(0, customSnippetLimits.count)) {
      if (isSnippet(candidate) && !validateCustomSnippet(candidate, result)) result.push(normalize(candidate));
    }
    return result;
  } catch { return []; }
}

export function readCustomSnippets(): MarkdownSnippet[] {
  try { return parseCustomSnippets(localStorage.getItem(storageKey)); }
  catch { return []; }
}

// Persist before publishing a changed catalog to the editor. Failed writes are
// reported in the form, so a template is never presented as saved when it isn't.
export function saveCustomSnippets(snippets: readonly MarkdownSnippet[]): string | null {
  if (snippets.length > customSnippetLimits.count) return 'You can save up to 100 custom snippets.';
  for (const [index, candidate] of snippets.entries()) {
    if (!isSnippet(candidate)) return 'The snippet is incomplete.';
    const error = validateCustomSnippet(candidate, snippets.slice(0, index));
    if (error) return error;
  }
  try {
    localStorage.setItem(storageKey, JSON.stringify({ version: 1, snippets: snippets.map(normalize) }));
    return null;
  } catch { return 'Could not save snippets on this device. Your changes are still here; please try again.'; }
}
