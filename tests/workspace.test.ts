import assert from 'node:assert/strict';
import { constants } from 'node:fs';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import test, { type TestContext } from 'node:test';
import { ensureStarterNotebook, MAX_NOTE_BYTES, validateNotePath, WorkspaceStore } from '../src/main/workspace';
import { isRendererResource, validateExternalURL } from '../src/main/security';

async function fixture(t: TestContext) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'prism-workspace-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return { root, store: await WorkspaceStore.open(root) };
}

function starterHandle(handle: fs.FileHandle, writeFile: (content: string, encoding: 'utf8') => Promise<void>) {
  return { stat: () => handle.stat(), writeFile, sync: () => handle.sync(), close: () => handle.close() };
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

test('a partial starter write is cleaned up so retry creates all four notes', async (t) => {
  const { root } = await fixture(t);
  const failure = Object.assign(new Error('The disk is full.'), { code: 'ENOSPC' });
  let writes = 0;
  await assert.rejects(ensureStarterNotebook(root, {
    ...fs,
    open: async (file, flags) => {
      const handle = await fs.open(file, flags);
      return starterHandle(handle, async (content, encoding) => {
        if (++writes === 2) {
          await handle.writeFile(content.slice(0, 12), encoding);
          throw failure;
        }
        await handle.writeFile(content, encoding);
      });
    },
  }), (error) => error === failure);
  await assert.rejects(fs.stat(path.join(root, 'Prism notebook')), { code: 'ENOENT' });
  const notebook = await ensureStarterNotebook(root);
  const loaded = await (await WorkspaceStore.open(notebook)).load();
  assert.equal(loaded.notes.length, 4);
  assert.ok(loaded.notes.every((note) => note.content.includes('[[') && !note.content.includes('Partial content')));
});

test('a starter subdirectory failure also removes only the newly created notebook', async (t) => {
  const { root } = await fixture(t);
  const failure = Object.assign(new Error('Cannot create Ideas.'), { code: 'ENOSPC' });
  await assert.rejects(ensureStarterNotebook(root, {
    ...fs,
    mkdir: async (directory, options) => {
      if (path.basename(directory) === 'Ideas') throw failure;
      return fs.mkdir(directory, options);
    },
  }), (error) => error === failure);
  await assert.rejects(fs.stat(path.join(root, 'Prism notebook')), { code: 'ENOENT' });
  const notebook = await ensureStarterNotebook(root);
  assert.equal((await (await WorkspaceStore.open(notebook)).load()).notes.length, 4);
});

test('one-time metadata failures after either starter mkdir are rolled back and retry completes', async (t) => {
  for (const target of ['Prism notebook', 'Ideas']) {
    const { root } = await fixture(t);
    const failure = Object.assign(new Error(`Cannot inspect ${target}.`), { code: 'EIO' });
    let failed = false;
    const io = {
      ...fs,
      lstat: async (file: string) => {
        if (!failed && path.basename(file) === target) { failed = true; throw failure; }
        return fs.lstat(file);
      },
    };
    await assert.rejects(ensureStarterNotebook(root, io), (error) => error === failure);
    await assert.rejects(fs.stat(path.join(root, 'Prism notebook')), { code: 'ENOENT' });
    const notebook = await ensureStarterNotebook(root, io);
    assert.equal((await (await WorkspaceStore.open(notebook)).load()).notes.length, 4);
  }
});

test('starter metadata failure preserves foreign content even before ownership can be recorded', async (t) => {
  for (const target of ['Prism notebook', 'Ideas']) {
    const { root } = await fixture(t);
    const failure = new Error(`Metadata failure for ${target}`);
    let foreignFile = '';
    await assert.rejects(ensureStarterNotebook(root, {
      ...fs,
      lstat: async (file) => {
        if (!foreignFile && path.basename(file) === target) {
          foreignFile = path.join(file, 'Keep.md');
          await fs.writeFile(foreignFile, 'My restored note');
          throw failure;
        }
        return fs.lstat(file);
      },
    }), (error) => error === failure);
    assert.equal(await fs.readFile(foreignFile, 'utf8'), 'My restored note');
  }
});

test('a one-time initial file metadata failure recovers ownership and permits a complete retry', async (t) => {
  const { root } = await fixture(t);
  const original = new Error('Initial file metadata read failed');
  let failed = false;
  await assert.rejects(ensureStarterNotebook(root, {
    ...fs,
    open: async (file, flags) => {
      const handle = await fs.open(file, flags);
      return {
        ...starterHandle(handle, (content, encoding) => handle.writeFile(content, encoding)),
        stat: async () => {
          if (!failed) { failed = true; throw original; }
          return handle.stat();
        },
      };
    },
  }), (error) => error === original);
  await assert.rejects(fs.stat(path.join(root, 'Prism notebook')), { code: 'ENOENT' });
  const notebook = await ensureStarterNotebook(root);
  assert.equal((await (await WorkspaceStore.open(notebook)).load()).notes.length, 4);
});

test('unrecoverable file ownership preserves the file and the original metadata error', async (t) => {
  const { root } = await fixture(t);
  const original = new Error('Initial file metadata read failed');
  let attempts = 0;
  await assert.rejects(ensureStarterNotebook(root, {
    ...fs,
    open: async (file, flags) => {
      const handle = await fs.open(file, flags);
      return {
        ...starterHandle(handle, (content, encoding) => handle.writeFile(content, encoding)),
        stat: async () => { if (++attempts === 1) throw original; throw new Error('Ownership recovery failed'); },
      };
    },
  }), (error) => error === original);
  assert.equal(attempts, 2);
  const notebook = path.join(root, 'Prism notebook');
  assert.deepEqual(await fs.readdir(notebook), ['Welcome to Prism.md']);
  assert.equal(await fs.readFile(path.join(notebook, 'Welcome to Prism.md'), 'utf8'), '');
});

test('starter cleanup errors preserve the original failure', async (t) => {
  const { root } = await fixture(t);
  const original = new Error('Original seed failure');
  let cleanupAttempted = false;
  await assert.rejects(ensureStarterNotebook(root, {
    ...fs,
    open: async () => { throw original; },
    rmdir: async () => { cleanupAttempted = true; throw new Error('Cleanup failed'); },
  }), (error) => error === original);
  assert.equal(cleanupAttempted, true);
});

test('an existing empty starter notebook is preserved without seeding or cleanup', async (t) => {
  const { root } = await fixture(t);
  const notebook = path.join(root, 'Prism notebook');
  await fs.mkdir(notebook);
  let cleanupCalls = 0;
  const returned = await ensureStarterNotebook(root, {
    ...fs,
    open: async () => { assert.fail('Existing notebooks must not be seeded.'); },
    unlink: async () => { cleanupCalls++; },
    rmdir: async () => { cleanupCalls++; },
  });
  assert.equal(returned, notebook);
  assert.equal(cleanupCalls, 0);
  assert.deepEqual(await fs.readdir(notebook), []);
});

test('a concurrent starter caller cannot clean up the notebook owned by the winner', async (t) => {
  const { root } = await fixture(t);
  let releaseWrite!: () => void;
  let reportStarted!: () => void;
  const blockedWrite = new Promise<void>((resolve) => { releaseWrite = resolve; });
  const started = new Promise<void>((resolve) => { reportStarted = resolve; });
  const winner = ensureStarterNotebook(root, {
    ...fs,
    open: async (file, flags) => {
      reportStarted();
      await blockedWrite;
      return fs.open(file, flags);
    },
  });
  await started;
  let returned: string;
  let cleanupCalls = 0;
  try {
    returned = await ensureStarterNotebook(root, {
      ...fs,
      open: async () => { assert.fail('The losing caller must not write notes.'); },
      unlink: async () => { cleanupCalls++; },
      rmdir: async () => { cleanupCalls++; },
    });
  } finally { releaseWrite(); }
  assert.equal(await winner, returned);
  assert.equal(cleanupCalls, 0);
  assert.equal((await (await WorkspaceStore.open(returned)).load()).notes.length, 4);
});

test('failed starter cleanup preserves a folder that replaced the directory it created', async (t) => {
  const { root } = await fixture(t);
  const notebook = path.join(root, 'Prism notebook');
  const failure = new Error('Seed failure after the folder was replaced');
  await assert.rejects(ensureStarterNotebook(root, {
    ...fs,
    open: async () => {
      await fs.rename(notebook, path.join(root, 'Original partial notebook'));
      await fs.mkdir(notebook);
      await fs.writeFile(path.join(notebook, 'My notes.md'), 'My existing work');
      throw failure;
    },
  }), (error) => error === failure);
  assert.equal(await fs.readFile(path.join(notebook, 'My notes.md'), 'utf8'), 'My existing work');
});

test('starter rollback preserves a foreign note that caused an exclusive-create conflict', async (t) => {
  const { root } = await fixture(t);
  const notebook = path.join(root, 'Prism notebook');
  await assert.rejects(ensureStarterNotebook(root, {
    ...fs,
    open: async (file, flags) => {
      await fs.writeFile(file, 'My restored welcome');
      return fs.open(file, flags);
    },
  }), { code: 'EEXIST' });
  assert.equal(await fs.readFile(path.join(notebook, 'Welcome to Prism.md'), 'utf8'), 'My restored welcome');
  assert.deepEqual(await fs.readdir(notebook), ['Welcome to Prism.md']);
});

test('starter rollback preserves unrelated files added inside its new directories', async (t) => {
  const { root } = await fixture(t);
  const notebook = path.join(root, 'Prism notebook');
  const failure = new Error('Later seed operation failed');
  let opens = 0;
  await assert.rejects(ensureStarterNotebook(root, {
    ...fs,
    open: async (file, flags) => {
      if (++opens === 2) {
        await fs.writeFile(path.join(notebook, 'Ideas', 'My idea.md'), 'Keep this thought');
        throw failure;
      }
      return fs.open(file, flags);
    },
  }), (error) => error === failure);
  assert.equal(await fs.readFile(path.join(notebook, 'Ideas', 'My idea.md'), 'utf8'), 'Keep this thought');
  await assert.rejects(fs.stat(path.join(notebook, 'Welcome to Prism.md')), { code: 'ENOENT' });
});

test('starter rollback preserves replacements and edits of files it originally created', async (t) => {
  for (const replace of [false, true]) {
    const { root } = await fixture(t);
    const notebook = path.join(root, 'Prism notebook');
    const welcome = path.join(notebook, 'Welcome to Prism.md');
    const failure = new Error('Later seed operation failed');
    let opens = 0;
    await assert.rejects(ensureStarterNotebook(root, {
      ...fs,
      open: async (file, flags) => {
        if (++opens === 2) {
          if (replace) await fs.rename(welcome, path.join(root, 'Original welcome.md'));
          await fs.writeFile(welcome, 'My edited welcome');
          throw failure;
        }
        return fs.open(file, flags);
      },
    }), (error) => error === failure);
    assert.equal(await fs.readFile(welcome, 'utf8'), 'My edited welcome');
  }
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
