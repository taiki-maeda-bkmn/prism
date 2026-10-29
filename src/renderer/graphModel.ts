import type { Note } from '../shared/types';
import type { PDFGraphCatalog } from '../shared/pdfGraph';
import { parsePDFPageLink, type PDFNoteBacklink } from '../shared/pdfLinks';
import { getNoteLinks, getTitle, resolveLink } from './markdown';

export interface GraphNoteNode { id: string; kind: 'note'; path: string; title: string }
export interface GraphPDFNode {
  id: string;
  kind: 'pdf';
  documentId: string;
  title: string;
  availability: 'available' | 'missing' | 'unresolved';
  pages: readonly number[];
  /** The lowest cited page is the deterministic document-opening destination. */
  page: number;
}
export type GraphNode = GraphNoteNode | GraphPDFNode;
export interface GraphEdge { source: string; target: string; kind: 'note' | 'pdf' }
export interface GraphModel { nodes: GraphNode[]; edges: GraphEdge[] }
export interface CompactGraphModel extends GraphModel { omittedCount: number }
export const compactNeighborLimit = 4;

export const noteGraphId = (path: string): string => `note:${path}`;
export const pdfGraphId = (documentId: string): string => `pdf:${documentId}`;

/** Reference identities come from the notebook, never catalogue display titles. */
export function buildGraphModel(
  notes: Note[],
  pdfBacklinks?: ReadonlyMap<string, readonly PDFNoteBacklink[]>,
  pdfCatalog?: PDFGraphCatalog,
  showPDFs = false,
): GraphModel {
  const nodes: GraphNode[] = notes.map(note => ({ id: noteGraphId(note.path), kind: 'note', path: note.path, title: getTitle(note) }));
  const unique = new Map<string, GraphEdge>();
  for (const note of notes) {
    for (const target of getNoteLinks(note)) {
      const resolved = resolveLink(target, note.path, notes);
      if (!resolved || resolved.path === note.path) continue;
      const pair = [noteGraphId(note.path), noteGraphId(resolved.path)].sort();
      unique.set(JSON.stringify(pair), { source: pair[0], target: pair[1], kind: 'note' });
    }
  }
  if (!showPDFs || !pdfBacklinks?.size) return { nodes, edges: [...unique.values()] };

  const paths = new Set(notes.map(note => note.path));
  const references = new Map<string, { paths: Set<string>; pages: Set<number> }>();
  for (const [rawId, backlinks] of pdfBacklinks) {
    const identity = parsePDFPageLink(`prism-pdf://v1/documents/${rawId}?page=1`);
    if (!identity) continue;
    for (const backlink of backlinks) {
      if (!paths.has(backlink.path)) continue;
      const pages = backlink.pages.filter(page => Number.isSafeInteger(page) && page > 0);
      if (!pages.length) continue;
      let reference = references.get(identity.documentId);
      if (!reference) references.set(identity.documentId, reference = { paths: new Set(), pages: new Set() });
      reference.paths.add(backlink.path);
      for (const page of pages) reference.pages.add(page);
    }
  }
  const documents = new Map(pdfCatalog?.status === 'ready'
    ? pdfCatalog.documents.map(document => [document.id.toLowerCase(), document] as const) : []);
  for (const [documentId, reference] of [...references].sort(([a], [b]) => a.localeCompare(b))) {
    const document = documents.get(documentId);
    const availability = document ? 'available' : pdfCatalog?.status === 'ready' ? 'missing' : 'unresolved';
    const title = document?.title || `${availability === 'missing' ? 'Missing PDF' : 'PDF'} · ${documentId.slice(0, 8)}`;
    const pages = [...reference.pages].sort((a, b) => a - b);
    const id = pdfGraphId(documentId);
    nodes.push({ id, kind: 'pdf', documentId, title, availability, pages, page: pages[0] });
    for (const path of [...reference.paths].sort()) {
      const source = noteGraphId(path);
      unique.set(JSON.stringify([source, id]), { source, target: id, kind: 'pdf' });
    }
  }
  return { nodes, edges: [...unique.values()] };
}

/** Keep a small, balanced neighborhood and page destinations local to this note. */
export function buildCompactGraphModel(
  notes: Note[],
  activePath: string,
  pdfBacklinks?: ReadonlyMap<string, readonly PDFNoteBacklink[]>,
  pdfCatalog?: PDFGraphCatalog,
  showPDFs = false,
): CompactGraphModel {
  const activeId = noteGraphId(activePath);
  if (!notes.some(note => note.path === activePath)) return { nodes: [], edges: [], omittedCount: 0 };
  // Reduce before aggregation: another note's lower page must not replace the
  // page cited here, and a neighbor's PDFs are not direct neighbors of this note.
  const localPDFs = showPDFs && pdfBacklinks ? new Map([...pdfBacklinks].map(([id, backlinks]) =>
    [id, backlinks.filter(backlink => backlink.path === activePath)] as const)) : undefined;
  const model = buildGraphModel(notes, localPDFs, pdfCatalog, showPDFs);
  const neighborIds = new Set<string>();
  for (const edge of model.edges) {
    if (edge.source === activeId) neighborIds.add(edge.target);
    else if (edge.target === activeId) neighborIds.add(edge.source);
  }
  const byId = (a: GraphNode, b: GraphNode) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  const neighbors = model.nodes.filter(node => neighborIds.has(node.id)).sort(byId);
  // Reserve two slots of each kind, then let either kind use spare capacity.
  // Identity ordering remains stable through title/catalogue changes.
  const selected = [
    ...neighbors.filter(node => node.kind === 'note').slice(0, 2),
    ...neighbors.filter(node => node.kind === 'pdf').slice(0, 2),
  ];
  const visible = new Set([activeId, ...selected.map(node => node.id)]);
  for (const node of neighbors) {
    if (selected.length >= compactNeighborLimit) break;
    if (!visible.has(node.id)) { selected.push(node); visible.add(node.id); }
  }
  return {
    nodes: [model.nodes.find(node => node.id === activeId)!, ...selected.sort(byId)],
    edges: model.edges.filter(edge => visible.has(edge.source) && visible.has(edge.target)),
    omittedCount: neighbors.length - selected.length,
  };
}
