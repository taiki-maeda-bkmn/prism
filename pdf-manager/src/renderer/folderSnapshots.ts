import type { PDFDocument } from '../shared/types';

/** Merge a catalogue response without rolling back edits received since its request. */
export function mergeFolderSnapshotDocuments(
  current: readonly PDFDocument[],
  incoming: readonly PDFDocument[],
  changesAtRequest: ReadonlyMap<string, number>,
  changesAtResponse: ReadonlyMap<string, number>,
  validFolderIds: ReadonlySet<string>,
  removedDocument?: string,
): PDFDocument[] {
  const currentById = new Map(current.map(document => [document.id, document]));
  const changed = (id: string) => changesAtResponse.get(id) !== changesAtRequest.get(id);
  const incomingIds = new Set(incoming.map(document => document.id));
  const merged = incoming.flatMap(document => {
    if (!changed(document.id)) return [document];
    const latest = currentById.get(document.id);
    return latest ? [latest] : [];
  }).concat(current.filter(document => !incomingIds.has(document.id) && changed(document.id)));
  return merged.filter(document => document.id !== removedDocument).map(document => {
    // Removing a folder must also unfile a document with a newer reading edit.
    // An older load must never restore an assignment to that removed folder.
    if (!document.folderId || validFolderIds.has(document.folderId)) return document;
    const { folderId: _folderId, ...unfiled } = document;
    return unfiled;
  });
}
