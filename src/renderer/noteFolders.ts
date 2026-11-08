import type { Note } from '../shared/types';

/** Cumulative paths for a canonical notebook-relative directory; root is ''. */
export function folderAncestors(folder: string): string[] {
  if (!folder) return [];
  const parts = folder.split('/');
  return parts.map((_, index) => parts.slice(0, index + 1).join('/'));
}

/** Include real empty folders as well as parents inferred from the note list. */
export function collectNoteFolders(notes: readonly Note[], inventory: readonly string[] = []): string[] {
  const folders = new Set<string>();
  for (const folder of inventory) for (const ancestor of folderAncestors(folder)) folders.add(ancestor);
  for (const note of notes) {
    const separator = note.path.lastIndexOf('/');
    if (separator !== -1) {
      for (const ancestor of folderAncestors(note.path.slice(0, separator))) folders.add(ancestor);
    }
  }
  return [...folders].sort((a, b) => a.localeCompare(b));
}

/** null means all notes; root means direct root notes; folders include descendants. */
export function matchesNoteFolder(notePath: string, selectedFolder: string | null): boolean {
  return selectedFolder === null || (selectedFolder === '' ? !notePath.includes('/') : notePath.startsWith(`${selectedFolder}/`));
}

/** Compose the chosen destination; filesystem validation remains in the main process. */
export function newNotePath(name: string, folder: string): string {
  const trimmed = name.trim();
  const filename = /\.md$/i.test(trimmed) ? trimmed : `${trimmed}.md`;
  return folder ? `${folder}/${filename}` : filename;
}
