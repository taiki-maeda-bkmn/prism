import type { Note } from '../shared/types';
import type { PDFNoteBacklink, PDFPageTarget } from '../shared/pdfLinks';
import { extractPDFPageLinks, getTitle } from './markdown';

const noteTargets = new WeakMap<Note, { content: string; targets: readonly PDFPageTarget[] }>();

function targetsFor(note: Note): readonly PDFPageTarget[] {
  const cached = noteTargets.get(note);
  if (cached?.content === note.content) return cached.targets;
  const targets = extractPDFPageLinks(note.content);
  noteTargets.set(note, { content: note.content, targets });
  return targets;
}

/**
 * Index only the supplied notebook snapshot, including its overlaid drafts.
 * Unchanged notes reuse tokenization; no path/global catalogue cache can carry
 * citations into another notebook with the same relative filenames.
 */
export function getPDFBacklinks(notes: Note[]): ReadonlyMap<string, readonly PDFNoteBacklink[]> {
  const grouped = new Map<string, Map<string, { note: Note; pages: Set<number> }>>();
  for (const note of notes) {
    for (const target of targetsFor(note)) {
      let references = grouped.get(target.documentId);
      if (!references) grouped.set(target.documentId, references = new Map());
      let reference = references.get(note.path);
      if (!reference) references.set(note.path, reference = { note, pages: new Set() });
      reference.pages.add(target.page);
    }
  }
  const result = new Map<string, readonly PDFNoteBacklink[]>();
  for (const [documentId, references] of grouped) {
    result.set(documentId, [...references.values()]
      .map(({ note, pages }) => ({ path: note.path, title: getTitle(note), pages: [...pages].sort((a, b) => a - b) }))
      .sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  }
  return result;
}
