import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import test, { type TestContext } from 'node:test';
import { ensureStarterNotebook, MAX_NOTE_BYTES, validateNotePath, WorkspaceStore } from '../src/main/workspace';
import { isRendererResource } from '../src/main/security';

async function fixture(t: TestContext) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'prism-workspace-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return { root, store: await WorkspaceStore.open(root) };
}

test('loads nested Markdown notes while ignoring hidden and dependency directories', async (t) => {
  const { root, store } = await fixture(t);
  await fs.mkdir(path.join(root, 'Ideas'));
  await fs.mkdir(path.join(root, '.private'));
  await fs.mkdir(path.join(root, 'node_modules'));
  await fs.writeFile(path.join(root, 'Welcome.md'), '# Hello');
  await fs.writeFile(path.join(root, 'Ideas', 'Thought.markdown'), '# A thought');
  await fs.writeFile(path.join(root, '.private', 'Secret.md'), 'Hidden');
  await fs.writeFile(path.join(root, 'node_modules', 'Dependency.md'), 'Dependency');
  await fs.writeFile(path.join(root, 'picture.txt'), 'Not Markdown');
  const loaded = await store.load();
  assert.deepEqual(loaded.notes.map((note) => note.path).sort(), ['Ideas/Thought.markdown', 'Welcome.md']);
  assert.equal(loaded.path, root);
  assert.deepEqual(loaded.warnings, []);
});

test('saving atomically replaces the note and preserves its permissions', async (t) => {
  const { root, store } = await fixture(t);
  const target = path.join(root, 'Note.md');
  await fs.writeFile(target, '# Before');
  await fs.chmod(target, 0o660);
  const [original] = (await store.load()).notes;
  const saved = await store.save(original.path, '# After\n\nA thought.', original.modified);
  assert.equal(saved.content, '# After\n\nA thought.');
  assert.equal(await fs.readFile(target, 'utf8'), saved.content);
  assert.ok(saved.modified > original.modified);
  if (process.platform !== 'win32') assert.equal((await fs.stat(target)).mode & 0o777, 0o660);
  assert.deepEqual(await fs.readdir(root), ['Note.md']);
});

test('an external modification is never overwritten', async (t) => {
  const { root, store } = await fixture(t);
  await fs.writeFile(path.join(root, 'Note.md'), 'Original');
  const [original] = (await store.load()).notes;
  await fs.writeFile(path.join(root, 'Note.md'), 'External change');
  await assert.rejects(store.save('Note.md', 'My draft', original.modified), /changed by another application/);
  assert.equal(await fs.readFile(path.join(root, 'Note.md'), 'utf8'), 'External change');
  assert.deepEqual(await fs.readdir(root), ['Note.md']);
});

test('content fingerprints detect external changes with preserved timestamps and size', async (t) => {
  const { root, store } = await fixture(t);
  const target = path.join(root, 'Note.md');
  await fs.writeFile(target, 'Original');
  // Use an exact second to avoid filesystem conversion rounding in this test.
  const fixedTime = new Date('2025-01-01T00:00:00.000Z');
  await fs.utimes(target, fixedTime, fixedTime);
  const [original] = (await store.load()).notes;
  await fs.writeFile(target, 'External');
  await fs.utimes(target, fixedTime, fixedTime);
  assert.equal((await fs.stat(target)).mtimeMs, original.modified);
  await assert.rejects(store.save('Note.md', 'My draft', original.modified), /changed by another application/);
  assert.equal(await fs.readFile(target, 'utf8'), 'External');
});

test('concurrent saves are serialized and a stale draft cannot replace a newer save', async (t) => {
  const { root, store } = await fixture(t);
  await fs.writeFile(path.join(root, 'Note.md'), 'Original');
  const [original] = (await store.load()).notes;
  const results = await Promise.allSettled([
    store.save('Note.md', 'First draft', original.modified),
    store.save('Note.md', 'Stale draft', original.modified),
  ]);
  assert.equal(results[0].status, 'fulfilled');
  assert.equal(results[1].status, 'rejected');
  assert.equal(await fs.readFile(path.join(root, 'Note.md'), 'utf8'), 'First draft');
});

test('a deleted note is not recreated by a stale save', async (t) => {
  const { root, store } = await fixture(t);
  await fs.writeFile(path.join(root, 'Note.md'), 'Original');
  const [original] = (await store.load()).notes;
  await fs.unlink(path.join(root, 'Note.md'));
  await assert.rejects(store.save('Note.md', 'Draft', original.modified));
  assert.deepEqual(await fs.readdir(root), []);
});

test('create adds nested Markdown notes without replacing an existing file', async (t) => {
  const { root, store } = await fixture(t);
  const created = await store.create('Ideas/A new thought.md');
  assert.equal(created.path, 'Ideas/A new thought.md');
  assert.equal(created.content, '# A new thought\n\n');
  await assert.rejects(store.create(created.path), /already exists/);
  assert.equal(await fs.readFile(path.join(root, created.path), 'utf8'), created.content);
  assert.deepEqual(await fs.readdir(path.join(root, 'Ideas')), ['A new thought.md']);
});

test('concurrent creates claim a filename exclusively', async (t) => {
  const { root, store } = await fixture(t);
  const results = await Promise.allSettled([store.create('One.md'), store.create('One.md')]);
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal(results.filter((result) => result.status === 'rejected').length, 1);
  assert.deepEqual(await fs.readdir(root), ['One.md']);
});

test('unsafe paths and unsupported names are rejected before writing', async (t) => {
  const { root, store } = await fixture(t);
  for (const invalid of ['../escape.md', '/tmp/escape.md', 'Ideas/../../escape.md', 'C:\\escape.md', 'Ideas\\escape.md', '.private/secret.md', 'node_modules/note.md', 'Ideas//note.md', 'CON.md', 'name?.md', 'Note.txt', 'Note.markdown', 'Note.md ', 'Ideas./Note.md']) {
    await assert.rejects(store.create(invalid), Error, invalid);
  }
  assert.throws(() => validateNotePath({ path: 'Note.md' }));
  assert.deepEqual(await fs.readdir(root), []);
});

test('file and directory symlinks are not followed for reading or creation', { skip: process.platform === 'win32' }, async (t) => {
  const { root, store } = await fixture(t);
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'prism-outside-test-'));
  t.after(() => fs.rm(outside, { recursive: true, force: true }));
  await fs.writeFile(path.join(outside, 'Secret.md'), 'Private');
  await fs.symlink(outside, path.join(root, 'Outside'));
  await fs.symlink(path.join(outside, 'Secret.md'), path.join(root, 'Linked.md'));
  const loaded = await store.load();
  assert.equal(loaded.notes.length, 0);
  assert.equal(loaded.warnings.length, 2);
  await assert.rejects(store.create('Outside/New.md'), /Symbolic links/);
  await assert.rejects(store.create('Linked.md'), /already exists/);
  assert.deepEqual(await fs.readdir(outside), ['Secret.md']);
  assert.equal(await fs.readFile(path.join(outside, 'Secret.md'), 'utf8'), 'Private');
});

test('replacing a loaded note with a symlink cannot redirect a save', { skip: process.platform === 'win32' }, async (t) => {
  const { root, store } = await fixture(t);
  await fs.writeFile(path.join(root, 'Note.md'), 'Original');
  await fs.writeFile(path.join(root, 'Other.txt'), 'Other content');
  const [original] = (await store.load()).notes;
  await fs.unlink(path.join(root, 'Note.md'));
  await fs.symlink(path.join(root, 'Other.txt'), path.join(root, 'Note.md'));
  await assert.rejects(store.save('Note.md', 'Draft', original.modified), /Symbolic links/);
  assert.equal(await fs.readFile(path.join(root, 'Other.txt'), 'utf8'), 'Other content');
});

test('atomic save does not mutate other hard links to the previous file', async (t) => {
  const { root, store } = await fixture(t);
  await fs.writeFile(path.join(root, 'Note.md'), 'Original');
  await fs.link(path.join(root, 'Note.md'), path.join(root, 'Archive.txt'));
  const [original] = (await store.load()).notes;
  await store.save('Note.md', 'New content', original.modified);
  assert.equal(await fs.readFile(path.join(root, 'Archive.txt'), 'utf8'), 'Original');
});

test('oversized and non-UTF-8 notes are skipped with warnings', async (t) => {
  const { root, store } = await fixture(t);
  await fs.writeFile(path.join(root, 'Large.md'), Buffer.alloc(MAX_NOTE_BYTES + 1, 'x'));
  await fs.writeFile(path.join(root, 'Binary.md'), Buffer.from([0xff, 0xfe, 0xf0]));
  await fs.writeFile(path.join(root, 'Good.md'), '\ufeff# Good');
  const loaded = await store.load();
  assert.deepEqual(loaded.notes.map((note) => note.path), ['Good.md']);
  assert.equal(loaded.notes[0].content, '\ufeff# Good');
  assert.equal(loaded.warnings.length, 2);
  await assert.rejects(store.save('Good.md', 'x'.repeat(MAX_NOTE_BYTES + 1), loaded.notes[0].modified), /up to 2 MB/);
  assert.equal(await fs.readFile(path.join(root, 'Good.md'), 'utf8'), '\ufeff# Good');
});

test('refresh invalidates a stale version and allows saving the refreshed note', async (t) => {
  const { root, store } = await fixture(t);
  await fs.writeFile(path.join(root, 'Note.md'), 'Original');
  const [original] = (await store.load()).notes;
  await fs.writeFile(path.join(root, 'Note.md'), 'Updated outside');
  const [refreshed] = (await store.load()).notes;
  await assert.rejects(store.save('Note.md', 'Old draft', original.modified), /changed since you opened/);
  const saved = await store.save('Note.md', 'New draft', refreshed.modified);
  assert.equal(saved.content, 'New draft');
});

test('starter notebook is linked and existing notes are never reseeded', async (t) => {
  const { root } = await fixture(t);
  const notebook = await ensureStarterNotebook(root);
  const store = await WorkspaceStore.open(notebook);
  const loaded = await store.load();
  assert.equal(loaded.notes.length, 4);
  assert.ok(loaded.notes.every((note) => note.content.includes('[[')));
  await fs.writeFile(path.join(notebook, 'Welcome to Prism.md'), 'My own welcome');
  await fs.unlink(path.join(notebook, 'Connected thinking.md'));
  assert.equal(await ensureStarterNotebook(root), notebook);
  assert.equal(await fs.readFile(path.join(notebook, 'Welcome to Prism.md'), 'utf8'), 'My own welcome');
  await assert.rejects(fs.stat(path.join(notebook, 'Connected thinking.md')), { code: 'ENOENT' });
});

test('renderer resource policy only allows bundled assets', async (t) => {
  const { root } = await fixture(t);
  const rendererRoot = path.join(root, 'renderer');
  await fs.mkdir(rendererRoot);
  await fs.writeFile(path.join(rendererRoot, 'app.js'), 'app');
  await fs.writeFile(path.join(root, 'Private.md'), 'Private note');
  assert.equal(await isRendererResource(pathToFileURL(path.join(rendererRoot, 'app.js')).href, rendererRoot), true);
  for (const url of [pathToFileURL(path.join(root, 'Private.md')).href, pathToFileURL(rendererRoot).href, 'https://example.com/tracker.png', 'data:text/html,hello', 'not a url', 'file://remote-server/share/note.md']) {
    assert.equal(await isRendererResource(url, rendererRoot), false, url);
  }
  if (process.platform !== 'win32') {
    await fs.symlink(path.join(root, 'Private.md'), path.join(rendererRoot, 'leak.md'));
    assert.equal(await isRendererResource(pathToFileURL(path.join(rendererRoot, 'leak.md')).href, rendererRoot), false);
  }
});
