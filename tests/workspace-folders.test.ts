import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { validateFolderPath, WorkspaceStore } from '../src/main/workspace';

async function fixture(t: TestContext) {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'prism-folders-test-'));
  const root = path.join(temporary, 'Notebook');
  await fs.mkdir(root);
  t.after(() => fs.rm(temporary, { recursive: true, force: true }));
  return { temporary, root, store: await WorkspaceStore.open(root) };
}

test('folder inventory includes empty and nested directories across a restart', async t => {
  const { root, store } = await fixture(t);
  for (const folder of ['Empty', 'Ideas/Empty child', '.hidden/Private', 'node_modules/Package']) {
    await fs.mkdir(path.join(root, folder), { recursive: true });
  }
  await fs.writeFile(path.join(root, 'Ideas/Thought.md'), '# A thought');
  await fs.writeFile(path.join(root, 'Other.txt'), 'An unrelated file');
  const loaded = await store.load();
  assert.deepEqual(loaded.folders, ['Empty', 'Ideas', 'Ideas/Empty child']);
  assert.deepEqual(loaded.notes.map(note => note.path), ['Ideas/Thought.md']);
  assert.deepEqual(loaded.warnings, []);
  assert.deepEqual((await (await WorkspaceStore.open(root)).load()).folders, loaded.folders);
});

test('creates real Japanese folders and discovers folders created for a new note', async t => {
  const { root, store } = await fixture(t);
  assert.equal(await store.createFolder('研究/約定の資料'), '研究/約定の資料');
  assert.equal((await fs.stat(path.join(root, '研究/約定の資料'))).isDirectory(), true);
  assert.deepEqual(await fs.readdir(path.join(root, '研究/約定の資料')), []);
  await store.create('Ideas/Nested/First.md');
  const loaded = await store.load();
  assert.deepEqual(new Set(loaded.folders), new Set(['研究', '研究/約定の資料', 'Ideas', 'Ideas/Nested']));
  assert.deepEqual(loaded.notes.map(note => note.path), ['Ideas/Nested/First.md']);
});

test('duplicate and concurrent folder requests preserve existing files', async t => {
  const { root, store } = await fixture(t);
  await store.createFolder('Research');
  const bytes = Buffer.from('\ufeff# 残す資料\r\n');
  await fs.writeFile(path.join(root, 'Research/Note.md'), bytes);
  await fs.writeFile(path.join(root, 'Occupied'), bytes);
  await assert.rejects(store.createFolder('Research'), /already exists/);
  await assert.rejects(store.createFolder('Occupied'), /already exists/);
  assert.deepEqual(await fs.readFile(path.join(root, 'Research/Note.md')), bytes);
  assert.deepEqual(await fs.readFile(path.join(root, 'Occupied')), bytes);
  const results = await Promise.allSettled([store.createFolder('New'), store.createFolder('New')]);
  assert.deepEqual(results.map(result => result.status), ['fulfilled', 'rejected']);
  assert.deepEqual(await fs.readdir(path.join(root, 'New')), []);
});

test('unsafe and overly deep folder requests fail before creating anything', async t => {
  const { root, store } = await fixture(t);
  const invalid: unknown[] = [undefined, null, {}, '', '.', '..', '../Outside', '/tmp/Outside',
    'Ideas/../../Outside', 'C:\\Outside', 'Ideas\\Nested', 'Ideas//Nested', 'Ideas/', '.hidden',
    'node_modules/Package', 'CON', 'Aux.txt', 'LPT1', 'Ideas.', 'Ideas ', 'Bad?', 'Bad\u0000Name',
    'a'.repeat(256), Array.from({ length: 33 }, () => 'a').join('/')];
  for (const value of invalid) await assert.rejects(store.createFolder(value), Error, String(value));
  assert.deepEqual(await fs.readdir(root), []);
  assert.equal(validateFolderPath(Array.from({ length: 32 }, () => 'a').join('/')).split('/').length, 32);
});

test('folder operations reject symlink or junction parents and skip their inventory', async t => {
  const { root, temporary, store } = await fixture(t);
  const outside = path.join(temporary, 'Outside');
  await fs.mkdir(outside);
  await fs.writeFile(path.join(outside, 'Sentinel.md'), '# Keep');
  await fs.symlink(outside, path.join(root, 'Linked'), 'junction');
  const loaded = await store.load();
  assert.deepEqual(loaded.folders, []);
  assert.deepEqual(loaded.notes, []);
  assert.match(loaded.warnings.join(' '), /symbolic links/i);
  await assert.rejects(store.createFolder('Linked/New'), /symbolic links/i);
  assert.deepEqual(await fs.readdir(outside), ['Sentinel.md']);
  assert.equal(await fs.readFile(path.join(outside, 'Sentinel.md'), 'utf8'), '# Keep');
});

test('a replaced notebook root cannot receive a new folder', async t => {
  const { root, temporary, store } = await fixture(t);
  await store.createFolder('Before');
  const moved = path.join(temporary, 'Moved notebook');
  await fs.rename(root, moved);
  await fs.mkdir(root);
  await assert.rejects(store.createFolder('After'), /notebook folder changed/);
  assert.deepEqual(await fs.readdir(root), []);
  assert.deepEqual(await fs.readdir(moved), ['Before']);
});

test('creating a folder retains note save baselines and detects an external edit', async t => {
  const { root, store } = await fixture(t);
  await fs.writeFile(path.join(root, 'Note.md'), '\ufeff# Original\r\n');
  const [original] = (await store.load()).notes;
  await store.createFolder('First');
  const saved = await store.save('Note.md', '# Saved\r\n', original.modified);
  assert.equal(await fs.readFile(path.join(root, 'Note.md'), 'utf8'), '\ufeff# Saved\r\n');
  const external = '\ufeff# 外部の変更\r\n';
  await fs.writeFile(path.join(root, 'Note.md'), external);
  await store.createFolder('Second/Nested');
  await assert.rejects(store.save('Note.md', '# Unsaved draft\r\n', saved.modified), /changed by another application/);
  assert.equal(await fs.readFile(path.join(root, 'Note.md'), 'utf8'), external);
});

test('folder inventory omits names that cannot be used as destinations', { skip: process.platform === 'win32' }, async t => {
  const { root, store } = await fixture(t);
  await fs.mkdir(path.join(root, 'CON'));
  await fs.mkdir(path.join(root, 'Good'));
  const loaded = await store.load();
  assert.deepEqual(loaded.folders, ['Good']);
  assert.match(loaded.warnings.join(' '), /CON/);
});
