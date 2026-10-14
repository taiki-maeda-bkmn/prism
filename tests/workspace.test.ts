import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import test, { type TestContext } from 'node:test';
import { ensureStarterNotebook, MAX_NOTE_BYTES, validateNotePath, WorkspaceStore } from '../src/main/workspace';
import { isRendererResource, validateExternalURL } from '../src/main/security';
import { RECOVERY_DIRECTORY, SaveRecovery } from '../src/main/recovery';

async function fixture(t: TestContext) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'prism-workspace-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return { root, store: await WorkspaceStore.open(root) };
}

async function recoveryDirectories(root: string): Promise<string[]> {
  const directory = path.join(root, RECOVERY_DIRECTORY);
  return (await fs.readdir(directory)).sort().map((name) => path.join(directory, name));
}

async function pendingRecovery(root: string, notePath = 'Note.md') {
  const canonical = await fs.realpath(root);
  const target = path.join(canonical, notePath);
  const original = await fs.readFile(target);
  const hash = createHash('sha256').update(original).digest('hex');
  const transaction = await SaveRecovery.prepare(path.dirname(target), notePath, 'Retained draft', hash,
    (await fs.stat(target)).mode, async () => undefined);
  await transaction.capture(fs);
  return transaction;
}

function interceptStarterPublication(intercept: (publish: () => Promise<void>, destination: string) => Promise<void>) {
  return {
    rename: (source: string, destination: string) => intercept(() => fs.rename(source, destination), destination),
    symlink: (target: string, destination: string, type: 'dir') => intercept(() => fs.symlink(target, destination, type), destination),
  };
}

async function assertPublishedStarter(root: string, notebook: string) {
  const actual = await fs.realpath(notebook);
  assert.equal(path.basename(actual), 'Prism notebook');
  const isAlias = process.platform !== 'win32';
  assert.equal((await fs.lstat(notebook)).isSymbolicLink(), isAlias);
  if (isAlias) assert.equal(path.isAbsolute(await fs.readlink(notebook)), false);
  const expected = isAlias ? [path.basename(path.dirname(actual)), 'Prism notebook'].sort() : ['Prism notebook'];
  assert.deepEqual((await fs.readdir(root)).sort(), expected);
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
  assert.equal(loaded.path, await fs.realpath(root));
  assert.deepEqual(loaded.warnings, []);
});

test('a replacement directory at the same notebook path cannot receive reads or writes', async (t) => {
  const { root } = await fixture(t);
  const notebook = path.join(root, 'Notebook');
  const moved = path.join(root, 'Moved notebook');
  await fs.mkdir(notebook);
  await fs.writeFile(path.join(notebook, 'Note.md'), 'Original notebook');
  const store = await WorkspaceStore.open(notebook);
  const [original] = (await store.load()).notes;
  await fs.rename(notebook, moved);
  await fs.mkdir(notebook);
  // An empty replacement must fail before scanning, too.
  await assert.rejects(store.load(), /notebook folder changed/);
  await assert.rejects(store.create('Ideas/New.md'), /notebook folder changed/);
  assert.deepEqual(await fs.readdir(notebook), []);
  await fs.writeFile(path.join(notebook, 'Note.md'), 'Replacement notebook');
  await assert.rejects(store.load(), /notebook folder changed/);
  await assert.rejects(store.save('Note.md', 'My draft', original.modified), /notebook folder changed/);
  assert.equal(await fs.readFile(path.join(notebook, 'Note.md'), 'utf8'), 'Replacement notebook');
  assert.equal(await fs.readFile(path.join(moved, 'Note.md'), 'utf8'), 'Original notebook');
  const reopened = await WorkspaceStore.open(notebook);
  assert.equal((await reopened.create('New.md')).path, 'New.md');
});

test('saving preserves the previous version and exclusively publishes a draft with its permissions', async (t) => {
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
  assert.deepEqual(await fs.readdir(root), [RECOVERY_DIRECTORY, 'Note.md']);
  const [recovery] = await recoveryDirectories(root);
  assert.equal(await fs.readFile(path.join(recovery, 'original.md'), 'utf8'), '# Before');
  assert.equal(await fs.readFile(path.join(recovery, 'draft.md'), 'utf8'), saved.content);
  assert.equal(await fs.readFile(path.join(recovery, 'complete'), 'utf8'), '1\n');
});

test('an external replacement in the final capture gap is restored without losing the draft', async (t) => {
  const { root } = await fixture(t);
  const target = path.join(root, 'Note.md');
  await fs.writeFile(target, 'Original');
  const store = await WorkspaceStore.open(root, {
    ...fs,
    rename: async (source, destination) => {
      const external = path.join(root, 'external.tmp');
      await fs.writeFile(external, 'External final-gap edit');
      await fs.rename(external, source);
      await fs.rename(source, destination);
    },
  });
  const [original] = (await store.load()).notes;
  await assert.rejects(store.save('Note.md', 'My draft', original.modified), /changed during saving.*Recovery copies/);
  assert.equal(await fs.readFile(target, 'utf8'), 'External final-gap edit');
  const [recovery] = await recoveryDirectories(root);
  assert.equal(await fs.readFile(path.join(recovery, 'original.md'), 'utf8'), 'External final-gap edit');
  assert.equal(await fs.readFile(path.join(recovery, 'draft.md'), 'utf8'), 'My draft');
  await assert.rejects(store.save('Note.md', 'My draft', original.modified), /changed by another application/);
});

test('a competing destination after capture is never overwritten by publication or rollback', async (t) => {
  const { root } = await fixture(t);
  const target = path.join(root, 'Note.md');
  await fs.writeFile(target, 'Original');
  const store = await WorkspaceStore.open(root, {
    ...fs,
    rename: async (source, destination) => {
      await fs.rename(source, destination);
      await fs.writeFile(source, 'Competing writer', { flag: 'wx' });
    },
  });
  const [original] = (await store.load()).notes;
  await assert.rejects(store.save('Note.md', 'My draft', original.modified), /Recovery copies/);
  assert.equal(await fs.readFile(target, 'utf8'), 'Competing writer');
  const [recovery] = await recoveryDirectories(root);
  assert.equal(await fs.readFile(path.join(recovery, 'original.md'), 'utf8'), 'Original');
  assert.equal(await fs.readFile(path.join(recovery, 'draft.md'), 'utf8'), 'My draft');
  assert.equal(await fs.readFile(path.join(recovery, 'complete'), 'utf8'), '1\n');
  assert.equal((await (await WorkspaceStore.open(root)).load()).notes[0].content, 'Competing writer');
});

test('a write through an old open handle during publication is reported and retained', async (t) => {
  const { root } = await fixture(t);
  const target = path.join(root, 'Note.md');
  await fs.writeFile(target, 'Original');
  const handle = await fs.open(target, 'r+');
  t.after(() => handle.close());
  const store = await WorkspaceStore.open(root, {
    ...fs,
    copyFile: async (source, destination, flags) => {
      await fs.copyFile(source, destination, flags);
      if (path.basename(String(source)) === 'draft.md') {
        await handle.truncate(0);
        await handle.writeFile('Late external edit');
        await handle.sync();
      }
    },
  });
  const [original] = (await store.load()).notes;
  await assert.rejects(store.save('Note.md', 'My draft', original.modified), /captured note during saving/);
  const [recovery] = await recoveryDirectories(root);
  assert.equal(await fs.readFile(path.join(recovery, 'original.md'), 'utf8'), 'Late external edit');
  assert.equal(await fs.readFile(target, 'utf8'), 'My draft');
});

test('late writes through the original inode and later live edits cannot alter the retained draft', async (t) => {
  const { root, store } = await fixture(t);
  const target = path.join(root, 'Note.md');
  await fs.writeFile(target, 'Original');
  const handle = await fs.open(target, 'r+');
  t.after(() => handle.close());
  const [original] = (await store.load()).notes;
  await store.save('Note.md', 'My draft', original.modified);
  await handle.truncate(0);
  await handle.writeFile('External edit after save returned');
  await fs.writeFile(target, 'Later live edit');
  const [recovery] = await recoveryDirectories(root);
  assert.equal(await fs.readFile(path.join(recovery, 'original.md'), 'utf8'), 'External edit after save returned');
  assert.equal(await fs.readFile(path.join(recovery, 'draft.md'), 'utf8'), 'My draft');
  assert.equal(await fs.readFile(target, 'utf8'), 'Later live edit');
});

test('failed publication restores an unchanged original and permits retry with the same draft token', async (t) => {
  const { root } = await fixture(t);
  const target = path.join(root, 'Note.md');
  await fs.writeFile(target, 'Original');
  let diskFull = true;
  const store = await WorkspaceStore.open(root, {
    ...fs,
    copyFile: async (source, destination, flags) => {
      assert.equal(flags, constants.COPYFILE_EXCL);
      if (diskFull && path.basename(String(source)) === 'draft.md') throw Object.assign(new Error('Disk full'), { code: 'ENOSPC' });
      await fs.copyFile(source, destination, flags);
    },
  });
  const [original] = (await store.load()).notes;
  await assert.rejects(store.save('Note.md', 'My draft', original.modified), /Disk full/);
  assert.equal(await fs.readFile(target, 'utf8'), 'Original');
  diskFull = false;
  assert.equal((await store.save('Note.md', 'My draft', original.modified)).content, 'My draft');
});

test('failed restoration retains both versions for a fresh store to recover', async (t) => {
  const { root } = await fixture(t);
  const target = path.join(root, 'Note.md');
  await fs.writeFile(target, 'Original');
  const store = await WorkspaceStore.open(root, {
    ...fs,
    copyFile: async () => { throw Object.assign(new Error('Disk full'), { code: 'ENOSPC' }); },
  });
  const [original] = (await store.load()).notes;
  await assert.rejects(store.save('Note.md', 'My draft', original.modified), /Automatic restoration could not finish/);
  await assert.rejects(fs.stat(target), { code: 'ENOENT' });
  const [recovery] = await recoveryDirectories(root);
  assert.equal(await fs.readFile(path.join(recovery, 'draft.md'), 'utf8'), 'My draft');
  await assert.rejects(fs.stat(path.join(recovery, 'complete')), { code: 'ENOENT' });
  const loaded = await (await WorkspaceStore.open(root)).load();
  assert.equal(loaded.notes[0].content, 'Original');
  assert.match(loaded.warnings.join(' '), /Recovered Note.md/);
});

test('restart recovers an interrupted capture in a nested folder and completes it only once', async (t) => {
  const { root } = await fixture(t);
  await fs.mkdir(path.join(root, 'Ideas'));
  const target = path.join(root, 'Ideas', 'Note.md');
  await fs.writeFile(target, '\ufeffOriginal');
  const transaction = await pendingRecovery(root, 'Ideas/Note.md');
  await assert.rejects(fs.stat(target), { code: 'ENOENT' });
  const loaded = await (await WorkspaceStore.open(root)).load();
  assert.deepEqual(loaded.notes.map((note) => [note.path, note.content]), [['Ideas/Note.md', 'Original']]);
  assert.equal(await fs.readFile(target, 'utf8'), '\ufeffOriginal');
  assert.equal(await fs.readFile(transaction.original, 'utf8'), '\ufeffOriginal');
  assert.equal(await fs.readFile(transaction.draft, 'utf8'), 'Retained draft');
  assert.equal(await transaction.isComplete(), true);
  await fs.unlink(target);
  assert.deepEqual((await (await WorkspaceStore.open(root)).load()).notes, []);
});

test('restart after publication before the marker keeps the published note and settles the journal', async (t) => {
  const { root } = await fixture(t);
  await fs.writeFile(path.join(root, 'Note.md'), 'Original');
  const transaction = await pendingRecovery(root);
  await transaction.publish(fs);
  assert.equal(await transaction.isComplete(), false);
  const loaded = await (await WorkspaceStore.open(root)).load();
  assert.equal(loaded.notes[0].content, 'Retained draft');
  assert.equal(await fs.readFile(transaction.original, 'utf8'), 'Original');
  assert.equal(await transaction.isComplete(), true);
});

test('completed recovery history never resurrects a deliberately deleted saved note', async (t) => {
  const { root, store } = await fixture(t);
  const target = path.join(root, 'Note.md');
  await fs.writeFile(target, 'Original');
  const [original] = (await store.load()).notes;
  await store.save('Note.md', 'My draft', original.modified);
  await fs.unlink(target);
  const loaded = await (await WorkspaceStore.open(root)).load();
  assert.deepEqual(loaded.notes, []);
  assert.deepEqual(loaded.warnings, []);
  assert.equal((await recoveryDirectories(root)).length, 1);
});

test('saving works without hard-link support and always copies exclusively', async (t) => {
  const { root } = await fixture(t);
  await fs.writeFile(path.join(root, 'Note.md'), 'Original');
  let copies = 0;
  const store = await WorkspaceStore.open(root, {
    ...fs,
    link: async () => { throw Object.assign(new Error('Unsupported'), { code: 'ENOTSUP' }); },
    copyFile: async (source, destination, flags) => {
      copies++;
      assert.equal(flags, constants.COPYFILE_EXCL);
      await fs.copyFile(source, destination, flags);
    },
  });
  const [original] = (await store.load()).notes;
  assert.equal((await store.save('Note.md', 'My draft', original.modified)).content, 'My draft');
  assert.equal(copies, 1);
});

test('malformed, oversized, or cross-folder recovery manifests cannot create notes or block ordinary notes', async (t) => {
  for (const corrupt of ['traversal', 'wrong-parent', 'hash-array', 'oversized'] as const) {
    const { root } = await fixture(t);
    await fs.writeFile(path.join(root, 'Note.md'), 'Original');
    const transaction = await pendingRecovery(root);
    await fs.writeFile(path.join(root, 'Good.md'), 'Unrelated note');
    const manifest: Record<string, unknown> = { ...transaction.manifest };
    if (corrupt === 'traversal') manifest.notePath = '../Escape.md';
    if (corrupt === 'wrong-parent') manifest.notePath = 'Other/Note.md';
    if (corrupt === 'hash-array') manifest.originalHash = [manifest.originalHash];
    await fs.writeFile(path.join(transaction.directory, 'manifest.json'), corrupt === 'oversized' ? ' '.repeat(8193) : JSON.stringify(manifest));
    const loaded = await (await WorkspaceStore.open(root)).load();
    assert.deepEqual(loaded.notes.map((note) => note.path), ['Good.md']);
    assert.equal(loaded.warnings.length, 1);
    await assert.rejects(fs.stat(path.join(root, 'Note.md')), { code: 'ENOENT' });
    assert.equal(await fs.readFile(transaction.original, 'utf8'), 'Original');
  }
});

test('corrupt completion markers and oversized captured notes are preserved for manual recovery', async (t) => {
  for (const corruptMarker of [true, false]) {
    const { root } = await fixture(t);
    await fs.writeFile(path.join(root, 'Note.md'), 'Original');
    const transaction = await pendingRecovery(root);
    if (corruptMarker) await fs.writeFile(path.join(transaction.directory, 'complete'), 'corrupt');
    else await fs.writeFile(transaction.original, Buffer.alloc(MAX_NOTE_BYTES + 1, 'x'));
    const loaded = await (await WorkspaceStore.open(root)).load();
    assert.deepEqual(loaded.notes, []);
    assert.match(loaded.warnings.join(' '), /manual recovery/);
    await assert.rejects(fs.stat(path.join(root, 'Note.md')), { code: 'ENOENT' });
    assert.equal((await fs.stat(transaction.original)).size, corruptMarker ? 'Original'.length : MAX_NOTE_BYTES + 1);
  }
});

test('symlinks in recovery metadata or captured content cannot be replayed', { skip: process.platform === 'win32' }, async (t) => {
  for (const linked of ['manifest.json', 'original.md', 'complete']) {
    const { root } = await fixture(t);
    await fs.writeFile(path.join(root, 'Note.md'), 'Original');
    const transaction = await pendingRecovery(root);
    const outside = path.join(root, 'Outside.txt');
    await fs.writeFile(outside, linked === 'complete' ? '1\n' : 'Private content');
    const link = path.join(transaction.directory, linked);
    await fs.unlink(link).catch(() => undefined);
    await fs.symlink(outside, link);
    const loaded = await (await WorkspaceStore.open(root)).load();
    assert.deepEqual(loaded.notes, []);
    assert.equal(loaded.warnings.length, 1);
    await assert.rejects(fs.stat(path.join(root, 'Note.md')), { code: 'ENOENT' });
    assert.equal(await fs.readFile(outside, 'utf8'), linked === 'complete' ? '1\n' : 'Private content');
  }
});

test('a symlink recovery root cannot redirect saved copies or replay', { skip: process.platform === 'win32' }, async (t) => {
  const { root, store } = await fixture(t);
  const outside = path.join(root, 'Outside');
  await fs.mkdir(outside);
  await fs.writeFile(path.join(root, 'Note.md'), 'Original');
  await fs.symlink(outside, path.join(root, RECOVERY_DIRECTORY));
  const loaded = await store.load();
  assert.match(loaded.warnings.join(' '), /symbolic links/);
  await assert.rejects(store.save('Note.md', 'My draft', loaded.notes[0].modified), /symbolic link/);
  assert.deepEqual(await fs.readdir(outside), []);
  assert.equal(await fs.readFile(path.join(root, 'Note.md'), 'utf8'), 'Original');
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

test('unsupported hard links fall back to exclusive copy without overwriting notes or leaving temporary files', async (t) => {
  for (const code of ['ENOTSUP', 'EOPNOTSUPP', 'ENOSYS', 'EXDEV', 'EPERM']) {
    const { root } = await fixture(t);
    let copies = 0;
    const store = await WorkspaceStore.open(root, {
      link: async () => { throw Object.assign(new Error('Hard links are unsupported'), { code }); },
      copyFile: async (source, destination, mode) => {
        copies++;
        assert.equal(mode, constants.COPYFILE_EXCL);
        await fs.copyFile(source, destination, mode);
      },
    });
    const created = await store.create('Portable.md');
    assert.equal(created.content, '# Portable\n\n');
    await assert.rejects(store.create('Portable.md'), /already exists/);
    assert.equal(copies, 2);
    assert.equal(await fs.readFile(path.join(root, 'Portable.md'), 'utf8'), created.content);
    assert.deepEqual(await fs.readdir(root), ['Portable.md']);
  }
});

test('exclusive copy preserves a destination created while hard-link installation was failing', async (t) => {
  const { root } = await fixture(t);
  const store = await WorkspaceStore.open(root, {
    link: async (_source, destination) => {
      await fs.writeFile(destination, 'Another application created this note', { flag: 'wx' });
      throw Object.assign(new Error('Hard links are unsupported'), { code: 'ENOTSUP' });
    },
    copyFile: fs.copyFile,
  });
  await assert.rejects(store.create('Shared.md'), /already exists/);
  assert.equal(await fs.readFile(path.join(root, 'Shared.md'), 'utf8'), 'Another application created this note');
  assert.deepEqual(await fs.readdir(root), ['Shared.md']);
});

test('creation preserves original install errors and removes temporary files without touching other notes', async (t) => {
  for (const failCopy of [false, true]) {
    const { root } = await fixture(t);
    await fs.writeFile(path.join(root, 'Existing.md'), 'Keep my work');
    const original = Object.assign(new Error('Install failed'), { code: failCopy ? 'ENOSPC' : 'EIO' });
    let copies = 0;
    const store = await WorkspaceStore.open(root, {
      link: async () => {
        if (failCopy) throw Object.assign(new Error('Hard links are unsupported'), { code: 'ENOTSUP' });
        throw original;
      },
      copyFile: async () => { copies++; throw original; },
    });
    await assert.rejects(store.create('New.md'), (error) => error === original);
    assert.equal(copies, failCopy ? 1 : 0);
    assert.deepEqual(await fs.readdir(root), ['Existing.md']);
    assert.equal(await fs.readFile(path.join(root, 'Existing.md'), 'utf8'), 'Keep my work');
  }
});

test('exclusive-copy fallback rechecks notebook identity before installing a new note', async (t) => {
  const { root } = await fixture(t);
  const notebook = path.join(root, 'Notebook');
  await fs.mkdir(notebook);
  let copies = 0;
  const store = await WorkspaceStore.open(notebook, {
    link: async () => {
      await fs.rename(notebook, path.join(root, 'Moved notebook'));
      await fs.mkdir(notebook);
      throw Object.assign(new Error('Hard links are unsupported'), { code: 'ENOTSUP' });
    },
    copyFile: async () => { copies++; },
  });
  await assert.rejects(store.create('New.md'), /notebook folder changed/);
  assert.equal(copies, 0);
  assert.deepEqual(await fs.readdir(notebook), []);
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

test('recoverable save does not mutate other hard links to the previous file', async (t) => {
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
  assert.equal(loaded.notes[0].content, '# Good');
  assert.equal(loaded.warnings.length, 2);
  await assert.rejects(store.save('Good.md', 'x'.repeat(MAX_NOTE_BYTES + 1), loaded.notes[0].modified), /up to 2 MB/);
  assert.equal(await fs.readFile(path.join(root, 'Good.md'), 'utf8'), '\ufeff# Good');
});

test('UTF-8 BOM is omitted from Markdown content and preserved byte for byte on save', async (t) => {
  const { root, store } = await fixture(t);
  const target = path.join(root, 'Note.md');
  const content = '# First heading\r\n\r\nCafé \ufeff🌈\r\n';
  const bytes = Buffer.from(`\ufeff${content}`, 'utf8');
  await fs.writeFile(target, bytes);
  const [loaded] = (await store.load()).notes;
  assert.equal(loaded.content, content);
  const unchanged = await store.save('Note.md', loaded.content, loaded.modified);
  assert.equal(unchanged.content, content);
  assert.deepEqual(await fs.readFile(target), bytes);
  const editedContent = '# Updated heading\n\nA new thought.';
  const edited = await store.save('Note.md', editedContent, unchanged.modified);
  assert.equal(edited.content, editedContent);
  assert.equal(await fs.readFile(target, 'utf8'), `\ufeff${editedContent}`);
  assert.equal((await store.load()).notes[0].content, editedContent);
  const recoveries = await recoveryDirectories(root);
  assert.equal(recoveries.length, 2);
  for (const recovery of recoveries) {
    assert.deepEqual(await fs.readFile(path.join(recovery, 'original.md')), bytes);
    const draft = await fs.readFile(path.join(recovery, 'draft.md'));
    assert.deepEqual(draft.subarray(0, 3), Buffer.from([0xef, 0xbb, 0xbf]));
    const manifest = JSON.parse(await fs.readFile(path.join(recovery, 'manifest.json'), 'utf8'));
    assert.equal(manifest.draftHash, createHash('sha256').update(draft).digest('hex'));
  }
});

test('the note byte limit includes its preserved UTF-8 BOM', async (t) => {
  const { root, store } = await fixture(t);
  const target = path.join(root, 'Note.md');
  await fs.writeFile(target, '\ufeff# Original');
  const [original] = (await store.load()).notes;
  await assert.rejects(store.save('Note.md', 'x'.repeat(MAX_NOTE_BYTES - 2), original.modified), /up to 2 MB/);
  assert.equal(await fs.readFile(target, 'utf8'), '\ufeff# Original');
  assert.deepEqual(await fs.readdir(root), ['Note.md']);
  const saved = await store.save('Note.md', 'x'.repeat(MAX_NOTE_BYTES - 3), original.modified);
  assert.equal(saved.content.length, MAX_NOTE_BYTES - 3);
  assert.equal((await fs.stat(target)).size, MAX_NOTE_BYTES);
});

test('an external BOM change still conflicts even when the editor text is identical', async (t) => {
  const { root, store } = await fixture(t);
  const target = path.join(root, 'Note.md');
  await fs.writeFile(target, '\ufeff# Heading');
  const [original] = (await store.load()).notes;
  await fs.writeFile(target, '# Heading');
  await assert.rejects(store.save('Note.md', original.content, original.modified), /changed by another application/);
  assert.equal(await fs.readFile(target, 'utf8'), '# Heading');
  const [refreshed] = (await store.load()).notes;
  assert.equal(refreshed.content, original.content);
  await store.save('Note.md', '# Edited', refreshed.modified);
  assert.equal(await fs.readFile(target, 'utf8'), '# Edited');
});

test('BOM metadata survives failed publication, restoration, and retry with the original version token', async (t) => {
  const { root } = await fixture(t);
  const target = path.join(root, 'Note.md');
  await fs.writeFile(target, '\ufeff# Original');
  let failed = false;
  const store = await WorkspaceStore.open(root, {
    ...fs,
    copyFile: async (source, destination, flags) => {
      if (!failed && path.basename(String(source)) === 'draft.md') {
        failed = true;
        throw Object.assign(new Error('Disk full'), { code: 'ENOSPC' });
      }
      await fs.copyFile(source, destination, flags);
    },
  });
  const [original] = (await store.load()).notes;
  await assert.rejects(store.save('Note.md', '# Edited', original.modified), /Disk full/);
  assert.equal(await fs.readFile(target, 'utf8'), '\ufeff# Original');
  const saved = await store.save('Note.md', '# Edited', original.modified);
  assert.equal(saved.content, '# Edited');
  assert.equal(await fs.readFile(target, 'utf8'), '\ufeff# Edited');
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

test('a published starter remains complete when the entire user-data folder moves', async (t) => {
  const { root } = await fixture(t);
  const userData = path.join(root, 'User data');
  const notebook = await ensureStarterNotebook(userData);
  await assertPublishedStarter(userData, notebook);
  const moved = path.join(root, 'Moved user data');
  await fs.rename(userData, moved);
  const reopened = await ensureStarterNotebook(moved);
  assert.equal(reopened, path.join(moved, 'Prism notebook'));
  const loaded = await (await WorkspaceStore.open(reopened)).load();
  assert.equal(loaded.name, 'Prism notebook');
  assert.equal(loaded.notes.length, 4);
  assert.ok(loaded.notes.every((note) => note.content.includes('[[')));
});

test('starter write failure never exposes a partial final notebook and retry publishes all four notes', async (t) => {
  const { root } = await fixture(t);
  const final = path.join(root, 'Prism notebook');
  const original = Object.assign(new Error('Disk full'), { code: 'ENOSPC' });
  let writes = 0;
  await assert.rejects(ensureStarterNotebook(root, {
    ...fs,
    writeFile: async (file, content, options) => {
      await assert.rejects(fs.stat(final), { code: 'ENOENT' });
      if (++writes === 2) {
        await fs.writeFile(file, content.slice(0, 12), options);
        throw original;
      }
      await fs.writeFile(file, content, options);
    },
  }), (error) => error === original);
  assert.deepEqual(await fs.readdir(root), []);
  const notebook = await ensureStarterNotebook(root);
  const loaded = await (await WorkspaceStore.open(notebook)).load();
  assert.equal(loaded.notes.length, 4);
  assert.ok(loaded.notes.every((note) => note.content.includes('[[')));
  await assertPublishedStarter(root, notebook);
});

test('staging directory and metadata failures leave the final notebook absent and permit retry', async (t) => {
  for (const failMetadata of [false, true]) {
    const { root } = await fixture(t);
    const original = new Error('Staging setup failed');
    let failed = false;
    await assert.rejects(ensureStarterNotebook(root, {
      ...fs,
      mkdir: async (directory, options) => {
        if (!failMetadata && path.basename(directory) === 'Ideas') throw original;
        return fs.mkdir(directory, options);
      },
      lstat: async (file) => {
        if (failMetadata && !failed && path.basename(file).startsWith('.prism-notebook-')) {
          failed = true;
          throw original;
        }
        return fs.lstat(file);
      },
    }), (error) => error === original);
    assert.deepEqual(await fs.readdir(root), []);
    const notebook = await ensureStarterNotebook(root);
    assert.equal((await (await WorkspaceStore.open(notebook)).load()).notes.length, 4);
  }
});

test('cleanup failure preserves the original error and abandoned staging does not block retry', async (t) => {
  const { root } = await fixture(t);
  const original = new Error('Original seed failure');
  let staging = '';
  await assert.rejects(ensureStarterNotebook(root, {
    ...fs,
    mkdtemp: async (prefix) => { staging = await fs.mkdtemp(prefix); return staging; },
    writeFile: async () => { throw original; },
    rm: async () => { throw new Error('Cleanup failed'); },
  }), (error) => error === original);
  assert.ok((await fs.stat(staging)).isDirectory());
  await assert.rejects(fs.stat(path.join(root, 'Prism notebook')), { code: 'ENOENT' });
  const notebook = await ensureStarterNotebook(root);
  assert.equal((await (await WorkspaceStore.open(notebook)).load()).notes.length, 4);
  assert.ok((await fs.stat(staging)).isDirectory());
});

test('an abandoned partial staging directory from an interrupted launch is never used as the notebook', async (t) => {
  const { root } = await fixture(t);
  const abandoned = await fs.mkdtemp(path.join(root, '.prism-notebook-'));
  await fs.mkdir(path.join(abandoned, 'Ideas'));
  await fs.writeFile(path.join(abandoned, 'Welcome to Prism.md'), 'Interrupted partial content');
  const notebook = await ensureStarterNotebook(root);
  assert.equal(notebook, path.join(root, 'Prism notebook'));
  const loaded = await (await WorkspaceStore.open(notebook)).load();
  assert.equal(loaded.notes.length, 4);
  assert.ok(loaded.notes.every((note) => note.content.includes('[[')));
  assert.equal(await fs.readFile(path.join(abandoned, 'Welcome to Prism.md'), 'utf8'), 'Interrupted partial content');
});

test('an existing empty final notebook is returned without allocating staging', async (t) => {
  const { root } = await fixture(t);
  const notebook = path.join(root, 'Prism notebook');
  await fs.mkdir(notebook);
  const before = await fs.stat(notebook);
  const returned = await ensureStarterNotebook(root, {
    ...fs,
    mkdtemp: async () => { assert.fail('Existing notebooks must not allocate staging.'); },
  });
  assert.equal(returned, notebook);
  assert.equal((await fs.stat(notebook)).ino, before.ino);
  assert.deepEqual(await fs.readdir(notebook), []);
});

test('a final notebook appearing during staging is preserved, including when it is empty', async (t) => {
  for (const populated of [false, true]) {
    const { root } = await fixture(t);
    const notebook = path.join(root, 'Prism notebook');
    let existing: Awaited<ReturnType<typeof fs.stat>> | undefined;
    const returned = await ensureStarterNotebook(root, {
      ...fs,
      writeFile: async (file, content, options) => {
        if (!existing) {
          await fs.mkdir(notebook);
          if (populated) await fs.writeFile(path.join(notebook, 'My note.md'), 'My own work');
          existing = await fs.stat(notebook);
        }
        await fs.writeFile(file, content, options);
      },
      ...interceptStarterPublication(async () => { assert.fail('Observed existing notebooks must not be replaced.'); }),
    });
    assert.equal(returned, notebook);
    assert.equal((await fs.stat(notebook)).ino, existing!.ino);
    assert.deepEqual(await fs.readdir(root), ['Prism notebook']);
    assert.deepEqual(await fs.readdir(notebook), populated ? ['My note.md'] : []);
    if (populated) assert.equal(await fs.readFile(path.join(notebook, 'My note.md'), 'utf8'), 'My own work');
  }
});

test('empty and populated directories created in the final publication gap retain their identities and contents', async (t) => {
  for (const populated of [false, true]) {
    const { root } = await fixture(t);
    const notebook = path.join(root, 'Prism notebook');
    let existing: Awaited<ReturnType<typeof fs.stat>> | undefined;
    const returned = await ensureStarterNotebook(root, {
      ...fs,
      ...interceptStarterPublication(async (publish, destination) => {
        await fs.mkdir(destination);
        if (populated) await fs.writeFile(path.join(destination, 'Restored.md'), 'Restored user content');
        existing = await fs.stat(destination);
        await publish();
      }),
    });
    assert.equal(returned, notebook);
    const after = await fs.stat(notebook);
    assert.equal(after.ino, existing!.ino);
    assert.equal(after.dev, existing!.dev);
    assert.deepEqual(await fs.readdir(notebook), populated ? ['Restored.md'] : []);
    if (populated) assert.equal(await fs.readFile(path.join(notebook, 'Restored.md'), 'utf8'), 'Restored user content');
    assert.deepEqual(await fs.readdir(root), ['Prism notebook']);
  }
});

test('unexpected publication errors preserve the original error and clean only staging', async (t) => {
  const { root } = await fixture(t);
  const original = Object.assign(new Error('Cannot publish notebook'), { code: 'EIO' });
  await assert.rejects(ensureStarterNotebook(root, {
    ...fs,
    ...interceptStarterPublication(async () => { throw original; }),
  }), (error) => error === original);
  assert.deepEqual(await fs.readdir(root), []);
});

test('unsupported POSIX starter aliases retain and return the complete canonical notebook', { skip: process.platform === 'win32' }, async (t) => {
  for (const code of ['EPERM', 'EACCES', 'EOPNOTSUPP', 'ENOTSUP', 'ENOSYS']) {
    const { root } = await fixture(t);
    await fs.writeFile(path.join(root, 'Unrelated.md'), 'Existing user data');
    const notebook = await ensureStarterNotebook(root, {
      ...fs,
      symlink: async () => { throw Object.assign(new Error('Aliases unsupported'), { code }); },
      rm: async () => { assert.fail('The returned fallback notebook must be retained.'); },
    });
    assert.equal(notebook, await fs.realpath(notebook));
    assert.equal(path.basename(notebook), 'Prism notebook');
    assert.notEqual(notebook, path.join(root, 'Prism notebook'));
    assert.match(path.basename(path.dirname(notebook)), /^\.prism-notebook-/);
    const loaded = await (await WorkspaceStore.open(notebook)).load();
    assert.equal(loaded.name, 'Prism notebook');
    assert.equal(loaded.notes.length, 4);
    assert.ok(loaded.notes.every((note) => note.content.includes('[[')));
    await assert.rejects(fs.lstat(path.join(root, 'Prism notebook')), { code: 'ENOENT' });
    assert.equal(await fs.readFile(path.join(root, 'Unrelated.md'), 'utf8'), 'Existing user data');
    assert.deepEqual((await fs.readdir(root)).sort(), [path.basename(path.dirname(notebook)), 'Unrelated.md'].sort());
  }
});

test('unsupported alias errors preserve a destination created during publication instead of choosing fallback', { skip: process.platform === 'win32' }, async (t) => {
  for (const populated of [false, true]) {
    const { root } = await fixture(t);
    const notebook = path.join(root, 'Prism notebook');
    let existing: Awaited<ReturnType<typeof fs.stat>> | undefined;
    const returned = await ensureStarterNotebook(root, {
      ...fs,
      symlink: async (_target, destination) => {
        await fs.mkdir(destination);
        if (populated) await fs.writeFile(path.join(destination, 'Keep.md'), 'Existing notebook');
        existing = await fs.stat(destination);
        throw Object.assign(new Error('Aliases unsupported'), { code: 'ENOTSUP' });
      },
    });
    assert.equal(returned, notebook);
    const after = await fs.stat(notebook);
    assert.equal(after.ino, existing!.ino);
    assert.equal(after.dev, existing!.dev);
    assert.deepEqual(await fs.readdir(notebook), populated ? ['Keep.md'] : []);
    if (populated) assert.equal(await fs.readFile(path.join(notebook, 'Keep.md'), 'utf8'), 'Existing notebook');
    assert.deepEqual(await fs.readdir(root), ['Prism notebook']);
  }
});

test('Windows publication permission errors count as a race only when a destination exists', { skip: process.platform !== 'win32' }, async (t) => {
  for (const code of ['EPERM', 'EACCES']) {
    for (const destinationExists of [false, true]) {
      const { root } = await fixture(t);
      const notebook = path.join(root, 'Prism notebook');
      const original = Object.assign(new Error('Windows rename was denied'), { code });
      const result = ensureStarterNotebook(root, {
        ...fs,
        ...interceptStarterPublication(async (_publish, destination) => {
          if (destinationExists) {
            await fs.mkdir(destination);
            await fs.writeFile(path.join(destination, 'Keep.md'), 'User content');
          }
          throw original;
        }),
      });
      if (destinationExists) {
        assert.equal(await result, notebook);
        assert.equal(await fs.readFile(path.join(notebook, 'Keep.md'), 'utf8'), 'User content');
      } else await assert.rejects(result, (error) => error === original);
      assert.deepEqual(await fs.readdir(root), destinationExists ? ['Prism notebook'] : []);
    }
  }
});

test('concurrent starter creation publishes one complete notebook and cleans the losing staging', async (t) => {
  const { root } = await fixture(t);
  const [first, second] = await Promise.all([ensureStarterNotebook(root), ensureStarterNotebook(root)]);
  assert.equal(first, second);
  assert.equal((await (await WorkspaceStore.open(first)).load()).notes.length, 4);
  await assertPublishedStarter(root, first);
});

test('staging cleanup preserves a replacement directory containing foreign content', async (t) => {
  const { root } = await fixture(t);
  const original = new Error('Seed failure after staging was replaced');
  let staging = '';
  await assert.rejects(ensureStarterNotebook(root, {
    ...fs,
    mkdtemp: async (prefix) => { staging = await fs.mkdtemp(prefix); return staging; },
    writeFile: async () => {
      await fs.rename(staging, `${staging}-moved`);
      await fs.mkdir(staging);
      await fs.writeFile(path.join(staging, 'Keep.md'), 'Foreign content');
      throw original;
    },
  }), (error) => error === original);
  assert.equal(await fs.readFile(path.join(staging, 'Keep.md'), 'utf8'), 'Foreign content');
  await assert.rejects(fs.stat(path.join(root, 'Prism notebook')), { code: 'ENOENT' });
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
    const aliasRoot = path.join(root, 'renderer-alias');
    await fs.symlink(rendererRoot, aliasRoot, 'dir');
    assert.equal(await isRendererResource(pathToFileURL(path.join(aliasRoot, 'app.js')).href, aliasRoot), true);
  }
});

test('external links accept web URLs and mailto with normal recipients and message fields', () => {
  assert.equal(validateExternalURL('https://example.com'), 'https://example.com/');
  assert.equal(validateExternalURL('http://example.com/notes?q=hello'), 'http://example.com/notes?q=hello');
  for (const url of [
    'mailto:writer@example.com',
    'mailto:writer+notes@example.com,reader@example.org?subject=Hello%20Prism&body=First%20line%0D%0ASecond%20line',
    'mailto:writer@example.com?cc=editor+notes@example.com&bcc=reader@example.org,reviewer@example.org',
    'mailto:writer@example.com?subject=%E3%81%93%E3%82%93%E3%81%AB%E3%81%A1%E3%81%AF&body=One%0ATwo',
  ]) assert.equal(validateExternalURL(url), url);
});

test('external links reject unsafe schemes, credentials, malformed mailto, and attachment headers', () => {
  for (const url of [
    'file:///etc/passwd', 'javascript:alert(1)', 'shell:open', 'data:text/html,hello',
    'https://user:password@example.com', 'mailto:', 'mailto:not-an-address',
    'mailto:writer@example.com,', 'mailto://writer@example.com', 'mailto:a..b@example.com',
    'mailto:writer@example.com#fragment', 'mailto:writer%0A@example.com',
    'mailto:writer@example.com?attach=/etc/passwd', 'mailto:writer@example.com?attachment=file:///etc/passwd',
    'mailto:writer@example.com?from=other@example.com', 'mailto:writer@example.com?cc=not-an-address',
    'mailto:writer@example.com?subject=hello%0D%0ABcc:other@example.com',
    'mailto:writer@example.com?body=hello%00world', 'mailto:writer@example.com?body=hello%09world',
    'mailto:writer@example.com?subject=first&SUBJECT=second', 'mailto:writer@example.com?subject=%ZZ',
    'mailto:writer@example.com?subject', 'mailto:writer@example.com\n',
  ]) assert.throws(() => validateExternalURL(url), Error, url);
  assert.throws(() => validateExternalURL(null));
});
