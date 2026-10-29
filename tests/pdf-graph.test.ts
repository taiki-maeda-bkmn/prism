import assert from 'node:assert/strict';
import test from 'node:test';
import type { Note } from '../src/shared/types';
import type { PDFNoteBacklink } from '../src/shared/pdfLinks';
import type { PDFGraphCatalog } from '../src/shared/pdfGraph';
import { buildCompactGraphModel, buildGraphModel, compactNeighborLimit, noteGraphId, pdfGraphId } from '../src/renderer/graphModel';
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

test('compact neighborhoods reserve space for notes and PDFs and count omitted unique neighbors', () => {
  const notes = [
    note('Start.md', '# Start\n\n[[A]] [[B]] [[C]] [[D]] [[A]]\n\n' + [firstId, secondId, unusedId].map(id => citation(id, 2)).join('\n')),
    note('A.md', '# A\n\n[[Start]] [[B]]'), note('B.md', '# B'), note('C.md', '# C'), note('D.md', '# D'),
    note('Elsewhere.md', '# Elsewhere'),
  ];
  const model = buildCompactGraphModel(notes, 'Start.md', getPDFBacklinks(notes), ready([]), true);
  assert.equal(model.nodes.length, 1 + compactNeighborLimit);
  assert.equal(model.nodes[0].id, noteGraphId('Start.md'));
  assert.deepEqual(model.nodes.filter(node => node.kind === 'note').map(node => node.path), ['Start.md', 'A.md', 'B.md']);
  assert.deepEqual(model.nodes.filter(node => node.kind === 'pdf').map(node => node.documentId), [unusedId, firstId]);
  assert.equal(model.omittedCount, 3, 'count unique neighbors, not citations or induced edges');
  assert.equal(model.edges.length, 5, 'existing links between visible note neighbors are retained');
  const visible = new Set(model.nodes.map(node => node.id));
  assert.ok(model.edges.every(edge => visible.has(edge.source) && visible.has(edge.target)));
});

test('compact neighborhoods fill spare slots from either kind without exceeding the limit', () => {
  const notes = [note('Start.md', '[[A]] [[B]] [[C]] [[D]] [[E]]\n' + citation(firstId, 1)),
    ...['A', 'B', 'C', 'D', 'E'].map(name => note(`${name}.md`, `# ${name}`))];
  const mixed = buildCompactGraphModel(notes, 'Start.md', getPDFBacklinks(notes), ready([]), true);
  assert.equal(mixed.nodes.filter(node => node.kind === 'note').length, 4);
  assert.equal(mixed.nodes.filter(node => node.kind === 'pdf').length, 1);
  assert.equal(mixed.omittedCount, 2);
  const noteOnly = buildCompactGraphModel(notes, 'Start.md');
  assert.equal(noteOnly.nodes.length, 5);
  assert.equal(noteOnly.omittedCount, 1);
  const pdfNotes = [note('Start.md', [firstId, secondId, unusedId].map(id => citation(id, 1)).join('\n'))];
  const pdfOnly = buildCompactGraphModel(pdfNotes, 'Start.md', getPDFBacklinks(pdfNotes), ready([]), true);
  assert.equal(pdfOnly.nodes.length, 4);
  assert.equal(pdfOnly.nodes.filter(node => node.kind === 'pdf').length, 3);
  assert.equal(pdfOnly.omittedCount, 0);
});

test('compact PDF destinations use only the active note, excluding neighbor citations and lower pages elsewhere', () => {
  const notes = [
    note('Start.md', '[[Other]]\n' + citation(firstId, 9) + '\n' + citation(firstId, 5)),
    note('Other.md', citation(firstId, 1) + '\n' + citation(secondId, 2)),
  ];
  const backlinks = getPDFBacklinks(notes);
  const compact = buildCompactGraphModel(notes, 'Start.md', backlinks, ready([]), true);
  const pdf = compact.nodes.find(node => node.kind === 'pdf')!;
  assert.equal(compact.nodes.filter(node => node.kind === 'pdf').length, 1);
  assert.equal(pdf.documentId, firstId);
  assert.deepEqual(pdf.pages, [5, 9]);
  assert.equal(pdf.page, 5);
  assert.deepEqual(compact.edges.filter(edge => edge.kind === 'pdf'), [
    { source: noteGraphId('Start.md'), target: pdfGraphId(firstId), kind: 'pdf' },
  ]);
  assert.equal(buildGraphModel(notes, backlinks, ready([]), true).nodes.filter(node => node.kind === 'pdf').find(node => node.documentId === firstId)?.page, 1);
});

test('compact selection stays stable through title changes, duplicate titles, and catalogue availability', () => {
  const notes = [note('Start.md', '[[A]] [[B]] [[C]]\n' + [firstId, secondId, unusedId].map(id => citation(id, 2)).join('\n')),
    ...['A', 'B', 'C'].map(name => note(`${name}.md`, '# Same title'))];
  const backlinks = getPDFBacklinks(notes);
  const before = buildCompactGraphModel(notes, 'Start.md', backlinks, { status: 'idle', documents: [] }, true);
  const renamed = notes.map(item => ({ ...item, content: item.path === 'B.md' ? '# 名前を変更したノート' : item.content }));
  const after = buildCompactGraphModel(renamed, 'Start.md', backlinks, ready([
    { id: firstId, title: '同じ名前' }, { id: unusedId, title: '同じ名前' }, { id: secondId, title: 'Other' },
  ]), true);
  assert.deepEqual(after.nodes.map(node => node.id), before.nodes.map(node => node.id));
  assert.deepEqual(after.edges, before.edges);
  assert.equal(after.omittedCount, before.omittedCount);
  assert.ok(after.nodes.some(node => node.title === '名前を変更したノート'));
});

test('compact graphs replace citations with draft and notebook snapshots without retaining stale neighbors', () => {
  const disk = [note('Start.md', '[[Other]]\n' + citation(firstId, 2)), note('Other.md', '# Other')];
  const draft = [note('Start.md', citation(secondId, 3)), disk[1]];
  const current = buildCompactGraphModel(draft, 'Start.md', getPDFBacklinks(draft), ready([]), true);
  assert.deepEqual(current.nodes.map(node => node.id), [noteGraphId('Start.md'), pdfGraphId(secondId)]);
  assert.equal(current.omittedCount, 0);
  const restored = buildCompactGraphModel(disk, 'Start.md', getPDFBacklinks(disk), ready([]), true);
  assert.deepEqual(restored.nodes.map(node => node.id), [noteGraphId('Start.md'), noteGraphId('Other.md'), pdfGraphId(firstId)]);
  const otherNotebook = [note('Start.md', '# No references')];
  assert.deepEqual(buildCompactGraphModel(otherNotebook, 'Start.md', getPDFBacklinks(otherNotebook), ready([]), true).nodes.map(node => node.id), [noteGraphId('Start.md')]);
});

test('compact graphs handle absent active notes and hidden PDF connections without phantom overflow', () => {
  const notes = [note('Start.md', citation(firstId, 2))];
  const backlinks = getPDFBacklinks(notes);
  assert.deepEqual(buildCompactGraphModel(notes, 'Absent.md', backlinks, ready([]), true), { nodes: [], edges: [], omittedCount: 0 });
  assert.deepEqual(buildCompactGraphModel([], 'Start.md', backlinks, ready([]), true), { nodes: [], edges: [], omittedCount: 0 });
  const hidden = buildCompactGraphModel(notes, 'Start.md', backlinks, ready([]), false);
  assert.equal(hidden.nodes.length, 1);
  assert.equal(hidden.edges.length, 0);
  assert.equal(hidden.omittedCount, 0);
});
