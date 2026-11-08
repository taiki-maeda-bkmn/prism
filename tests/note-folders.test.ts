import test from 'node:test';
import assert from 'node:assert/strict';
import { collectNoteFolders, folderAncestors, matchesNoteFolder, newNotePath } from '../src/renderer/noteFolders';
import type { Note } from '../src/shared/types';

const note = (path: string): Note => ({ path, content: '# Note', modified: 1 });

test('folder inventory keeps empty directories and infers all note parents without duplicates', () => {
  const notes = [note('Root.md'), note('Research/Math/確率.md'), note('Research/Other.md')];
  const inventory = ['Empty', 'Research', 'Empty/Nested', 'Research/Math'];
  assert.deepEqual(collectNoteFolders(notes, inventory), ['Empty', 'Empty/Nested', 'Research', 'Research/Math']);
  assert.deepEqual(collectNoteFolders(notes), ['Research', 'Research/Math']);
  assert.deepEqual(collectNoteFolders([], ['']), []);
  assert.deepEqual(folderAncestors('研究/確率/問題'), ['研究', '研究/確率', '研究/確率/問題']);
  assert.deepEqual(folderAncestors(''), []);
  assert.equal(inventory.length, 4);
});

test('folder filters separate root notes and match path segments rather than similarly named folders', () => {
  for (const path of ['Root.md', 'Ideas/First.md', 'Ideas/Nested/Second.md', 'Ideas 2/Third.md']) {
    assert.equal(matchesNoteFolder(path, null), true);
  }
  assert.equal(matchesNoteFolder('Root.md', ''), true);
  assert.equal(matchesNoteFolder('Ideas/First.md', ''), false);
  assert.equal(matchesNoteFolder('Ideas/First.md', 'Ideas'), true);
  assert.equal(matchesNoteFolder('Ideas/Nested/Second.md', 'Ideas'), true);
  assert.equal(matchesNoteFolder('Ideas 2/Third.md', 'Ideas'), false);
  assert.equal(matchesNoteFolder('Ideas.md', 'Ideas'), false);
  assert.equal(matchesNoteFolder('研究/確率/問題.md', '研究/確率'), true);
  assert.equal(matchesNoteFolder('研究/確率論/問題.md', '研究/確率'), false);
});

test('new notes use the selected folder and preserve explicit relative subpaths', () => {
  assert.equal(newNotePath(' A thought ', ''), 'A thought.md');
  assert.equal(newNotePath('A thought.md', 'Ideas'), 'Ideas/A thought.md');
  assert.equal(newNotePath('A thought.MD', 'Ideas'), 'Ideas/A thought.MD');
  assert.equal(newNotePath('Nested/確率', '研究'), '研究/Nested/確率.md');
  assert.equal(newNotePath('Ideas/First', ''), 'Ideas/First.md');
  // Keep the existing new-note .md behavior; only the main process validates paths.
  assert.equal(newNotePath('../Outside', 'Ideas'), 'Ideas/../Outside.md');
});
