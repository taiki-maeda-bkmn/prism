import assert from 'node:assert/strict';
import test from 'node:test';
import type { Note } from '../src/shared/types';
import type { PDFNoteBacklink } from '../src/shared/pdfLinks';
import type { PDFGraphCatalog } from '../src/shared/pdfGraph';
import { buildGraphModel, noteGraphId, pdfGraphId } from '../src/renderer/graphModel';
import { getPDFBacklinks } from '../src/renderer/pdfBacklinks';

const firstId = '12345678-9abc-4234-8234-123456789abc';
const secondId = 'abcdef12-3456-4789-8123-abcdef123456';
const unusedId = '11111111-2222-4333-8444-555555555555';
const note = (path: string, content: string): Note => ({ path, content, modified: 1 });
const citation = (id: string, page: number, title = 'Document') => `[${title}](prism-pdf://v1/documents/${id}?page=${page})`;
const ready = (documents: PDFGraphCatalog['documents']): PDFGraphCatalog => ({ status: 'ready', documents });

test('keeps existing note edges distinct, undirected, deduplicated and independent of the PDF filter', () => {
  const notes = [
    note('Start.md', '# Start\n\n[[Other]] [Again](Other.md) [[Start]] [PDF](/unresolved.pdf)'),
    note('Other.md', '# Other\n\n[[Start]] [Web](https://example.com) [[Missing]]'),
  ];
  const expected = [{ source: 'note:Other.md', target: 'note:Start.md', kind: 'note' }];
  assert.deepEqual(buildGraphModel(notes).edges, expected);
  assert.deepEqual(buildGraphModel(notes, getPDFBacklinks(notes), ready([]), true).edges, expected);
  assert.deepEqual(buildGraphModel(notes).nodes, [
    { id: 'note:Start.md', kind: 'note', path: 'Start.md', title: 'Start' },
    { id: 'note:Other.md', kind: 'note', path: 'Other.md', title: 'Other' },
  ]);
});

test('includes only current-notebook citations and groups one edge per note and PDF with the lowest cited page', () => {
  const notes = [
    note('研究/引用.md', '# 引用\n\n' + [citation(firstId, 10), citation(firstId, 2), citation(firstId, 2), citation(secondId, 5)].join('\n\n')),
    note('Other.md', '# Other\n\n' + citation(firstId, 3)),
  ];
  const backlinks = getPDFBacklinks(notes);
  const catalog = ready([{ id: firstId, title: 'First PDF' }, { id: secondId, title: 'Second PDF' }, { id: unusedId, title: 'Uncited PDF' }]);
  const model = buildGraphModel(notes, backlinks, catalog, true);
  const pdfs = model.nodes.filter(node => node.kind === 'pdf');
  assert.equal(pdfs.length, 2);
  assert.deepEqual(pdfs.find(node => node.documentId === firstId), {
    id: pdfGraphId(firstId), kind: 'pdf', documentId: firstId, title: 'First PDF', availability: 'available', pages: [2, 3, 10], page: 2,
  });
  assert.equal(pdfs.find(node => node.documentId === secondId)?.page, 5);
  assert.deepEqual(model.edges.filter(edge => edge.kind === 'pdf'), [
    { source: noteGraphId('Other.md'), target: pdfGraphId(firstId), kind: 'pdf' },
    { source: noteGraphId('研究/引用.md'), target: pdfGraphId(firstId), kind: 'pdf' },
    { source: noteGraphId('研究/引用.md'), target: pdfGraphId(secondId), kind: 'pdf' },
  ]);
  const hidden = buildGraphModel(notes, backlinks, catalog, false);
  assert.equal(hidden.nodes.length, notes.length);
  assert.equal(hidden.edges.length, 0);
  assert.equal(buildGraphModel([], backlinks, catalog, true).nodes.length, 0);
});

test('namespaced IDs prevent PDF identities from colliding with note paths or duplicate display titles', () => {
  const unusualPath = `pdf:${firstId}`;
  const notes = [
    note(unusualPath, '# Same title\n\n' + citation(firstId, 1)),
    note('Reference.md', '# Same title\n\n' + citation(secondId, 2)),
  ];
  const model = buildGraphModel(notes, getPDFBacklinks(notes), ready([
    { id: firstId, title: 'Same title' }, { id: secondId, title: 'Same title' },
  ]), true);
  assert.equal(model.nodes.length, 4);
  assert.equal(new Set(model.nodes.map(node => node.id)).size, 4);
  assert.equal(model.nodes.filter(node => node.title === 'Same title').length, 4);
  assert.ok(model.nodes.some(node => node.id === `note:pdf:${firstId}` && node.kind === 'note'));
  assert.ok(model.nodes.some(node => node.id === `pdf:${firstId}` && node.kind === 'pdf'));
  assert.deepEqual(model.edges[0], { source: `note:pdf:${firstId}`, target: `pdf:${firstId}`, kind: 'pdf' });
});

test('only a successfully loaded catalogue can identify a missing document', () => {
  const notes = [note('Reading.md', citation(firstId, 2, 'A label cannot resolve this ID'))];
  const backlinks = getPDFBacklinks(notes);
  for (const status of ['idle', 'loading', 'error'] as const) {
    const model = buildGraphModel(notes, backlinks, { status, documents: [{ id: firstId, title: 'Stale title' }], error: 'Library busy' }, true);
    const pdf = model.nodes.find(node => node.kind === 'pdf');
    assert.equal(pdf?.availability, 'unresolved');
    assert.equal(pdf.title, `PDF · ${firstId.slice(0, 8)}`);
    assert.equal(pdf.page, 2);
  }
  assert.equal(buildGraphModel(notes, backlinks, undefined, true).nodes.find(node => node.kind === 'pdf')?.availability, 'unresolved');
  const missing = buildGraphModel(notes, backlinks, ready([]), true).nodes.find(node => node.kind === 'pdf');
  assert.equal(missing?.availability, 'missing');
  assert.equal(missing.title, `Missing PDF · ${firstId.slice(0, 8)}`);
  assert.equal(missing.documentId, firstId);
});

test('title changes and catalogue order do not change graph identity or connection order', () => {
  const notes = [note('Reading.md', `${citation(secondId, 5)} ${citation(firstId, 2)}`)];
  const backlinks = getPDFBacklinks(notes);
  const before = buildGraphModel(notes, backlinks, ready([{ id: firstId, title: 'Before' }, { id: secondId, title: 'Before' }]), true);
  const after = buildGraphModel(notes, backlinks, ready([{ id: secondId, title: 'Changed' }, { id: firstId, title: '名前を変更' }]), true);
  assert.deepEqual(after.nodes.map(node => node.id), before.nodes.map(node => node.id));
  assert.deepEqual(after.edges, before.edges);
  assert.equal(after.nodes.find(node => node.kind === 'pdf' && node.documentId === firstId)?.title, '名前を変更');

  const edited = [note('Reading.md', `${citation(secondId, 3)} ${citation(firstId, 10)}`)];
  const next = buildGraphModel(edited, getPDFBacklinks(edited), ready([]), true);
  assert.deepEqual(next.nodes.map(node => node.id), before.nodes.map(node => node.id));
  assert.deepEqual(next.edges, before.edges);
  assert.equal(next.nodes.filter(node => node.kind === 'pdf').find(node => node.documentId === firstId)?.page, 10);
});

test('replacement imports remain separate from references to removed document IDs', () => {
  const notes = [note('Reading.md', citation(firstId, 2, 'Same title'))];
  const catalog = ready([{ id: secondId, title: 'Same title' }]);
  const model = buildGraphModel(notes, getPDFBacklinks(notes), catalog, true);
  const pdfs = model.nodes.filter(node => node.kind === 'pdf');
  assert.equal(pdfs.length, 1);
  assert.equal(pdfs[0].documentId, firstId);
  assert.equal(pdfs[0].availability, 'missing');
  const changedNotebook = [note('Reading.md', citation(secondId, 1))];
  const changed = buildGraphModel(changedNotebook, getPDFBacklinks(changedNotebook), catalog, true).nodes.filter(node => node.kind === 'pdf');
  assert.equal(changed.length, 1);
  assert.equal(changed[0].documentId, secondId);
  assert.equal(changed[0].availability, 'available');
});

test('ignores stale note paths and invalid destinations, and canonicalizes duplicate ID variants without mutation', () => {
  const pages = Object.freeze([2, 2, 0, -1, 1.5, Infinity, Number.MAX_SAFE_INTEGER + 1]);
  const backlinks = new Map<string, readonly PDFNoteBacklink[]>([
    [firstId, [{ path: 'Other notebook.md', title: 'Stale', pages: [1] }, { path: 'Reading.md', title: 'Reading', pages }]],
    [firstId.toUpperCase(), [{ path: 'Reading.md', title: 'Reading', pages: [3] }]],
    [secondId, [{ path: 'Reading.md', title: 'Reading', pages: [0] }]],
    ['../../secret', [{ path: 'Reading.md', title: 'Reading', pages: [1] }]],
  ]);
  const model = buildGraphModel([note('Reading.md', '# Reading')], backlinks, ready([]), true);
  assert.equal(model.nodes.length, 2);
  const pdf = model.nodes.find(node => node.kind === 'pdf')!;
  assert.equal(pdf.documentId, firstId);
  assert.deepEqual(pdf.pages, [2, 3]);
  assert.equal(model.edges.length, 1);
  assert.equal(pages.length, 7);
});
