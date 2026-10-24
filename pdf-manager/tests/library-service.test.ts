import assert from 'node:assert/strict';
import { fork, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test, { type TestContext } from 'node:test';
import { LibraryStore, type LibraryWriteIO } from '../src/main/library';
import { PDFLibraryService } from '../src/main/library-service';

const pdf = Buffer.from('%PDF-1.7\n1 0 obj\n<< /Type /Catalog >>\nendobj\n%%EOF\n');
const busy = /already|another|in use|locked/i;
const closed = /closed|closing/i;

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

async function fixture(t: TestContext) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'prism-pdf-service-'));
  const root = path.join(directory, 'library');
  const source = path.join(directory, '日本語の資料.pdf');
  await fs.writeFile(source, pdf);
  const cleanup: Array<() => Promise<unknown>> = [];
  t.after(async () => {
    const results = await Promise.allSettled(cleanup.reverse().map(action => action()));
    await fs.rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    for (const result of results) if (result.status === 'rejected') throw result.reason;
  });
  const service = (location = root, io: Partial<LibraryWriteIO> = {}) => {
    const owner = new PDFLibraryService(location, io);
    cleanup.push(() => owner.close());
    return owner;
  };
  return { directory, root, source, cleanup, service };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;
type ChildResult = { type: 'ready' } | { type: 'rejected'; message: string };

function startOwner(f: Fixture, root = f.root) {
  // Execute this bundled test module without --test. The child branch exercises
  // the same service as Electron, including its filesystem validation and retry.
  const child: ChildProcess = fork(fileURLToPath(import.meta.url), ['--pdf-library-owner', root], {
    env: { ...process.env, NODE_TEST_CONTEXT: undefined },
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  });
  let stderr = '';
  child.stderr?.on('data', bytes => { stderr += String(bytes); });
  const exited = new Promise<void>(resolve => child.once('exit', () => resolve()));
  const result = new Promise<ChildResult>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('The PDF library child did not answer. ' + stderr)), 10_000);
    child.once('error', error => { clearTimeout(timeout); reject(error); });
    child.once('message', value => { clearTimeout(timeout); resolve(value as ChildResult); });
    child.once('exit', () => { clearTimeout(timeout); reject(new Error('The PDF library child exited before answering. ' + stderr)); });
  });
  f.cleanup.push(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await exited;
  });
  return { child, result, exited };
}

if (process.argv[2] === '--pdf-library-owner') {
  const service = new PDFLibraryService(process.argv[3]);
  try {
    await service.load();
    process.on('message', () => {
      void service.close().then(() => process.disconnect?.());
    });
    process.send?.({ type: 'ready' } satisfies ChildResult);
  } catch (error) {
    await service.close();
    process.send?.({ type: 'rejected', message: error instanceof Error ? error.message : String(error) } satisfies ChildResult,
      () => process.disconnect?.());
  }
} else {
  test('a lazy service can close without creating a library and refuses all later operations', async t => {
    const f = await fixture(t);
    const service = f.service();
    await Promise.all([service.close(), service.close()]);
    await assert.rejects(fs.stat(f.root), { code: 'ENOENT' });
    await assert.rejects(service.load(), closed);
    await assert.rejects(service.import([]), closed);
    await assert.rejects(service.read('anything'), closed);
    await assert.rejects(service.update('anything', { favorite: true }), closed);
    await assert.rejects(service.remove('anything'), closed);
    await assert.rejects(service.withDocumentPath('anything', () => assert.fail('A closed service reached the shell.')), closed);
  });

  test('closing during the first lazy open finishes the accepted load and releases ownership', async t => {
    const f = await fixture(t);
    const service = f.service();
    const opening = service.load();
    const closing = service.close();
    await assert.rejects(service.load(), closed);
    assert.deepEqual((await opening).documents, []);
    await closing;
    assert.deepEqual((await f.service().load()).documents, []);
  });

  test('concurrent first requests share one owner and failed contenders cannot release its process lock', { timeout: 20_000 }, async t => {
    const f = await fixture(t);
    const owner = f.service();
    const loads = await Promise.all(Array.from({ length: 8 }, () => owner.load()));
    loads.forEach(snapshot => assert.deepEqual(snapshot.documents, []));
    const contender = f.service();
    for (let attempt = 0; attempt < 3; attempt++) await assert.rejects(contender.load(), busy);
    await contender.close();
    const outside = startOwner(f);
    const result = await outside.result;
    assert.equal(result.type, 'rejected');
    if (result.type === 'rejected') assert.match(result.message, busy);
    await outside.exited;
    assert.deepEqual((await owner.import([f.source])).errors, []);
    assert.equal((await owner.load()).documents.length, 1);
  });

  test('another process cannot open an owned library and the same service retries after graceful release', { timeout: 20_000 }, async t => {
    const f = await fixture(t);
    const child = startOwner(f);
    assert.deepEqual(await child.result, { type: 'ready' });
    const contender = f.service();
    await assert.rejects(contender.load(), busy);
    child.child.send('close');
    await child.exited;
    const imported = await contender.import([f.source]);
    assert.deepEqual(imported.errors, []);
    assert.equal(imported.importedIds.length, 1);
  });

  test('an abruptly killed owner releases the library without removing its lock file or losing documents', { timeout: 20_000 }, async t => {
    const f = await fixture(t);
    const seed = await LibraryStore.open(f.root);
    const document = (await seed.import([f.source])).library.documents[0];
    const catalog = await fs.readFile(path.join(f.root, 'catalog.json'));
    const child = startOwner(f);
    assert.deepEqual(await child.result, { type: 'ready' });
    const sidecar = path.join(f.root, '.prism-library-lock.sqlite');
    const lockIdentity = await fs.stat(sidecar);
    const contender = f.service();
    await assert.rejects(contender.load(), busy);
    child.child.kill('SIGKILL');
    await child.exited;
    assert.deepEqual((await contender.load()).documents, [document]);
    const recoveredIdentity = await fs.stat(sidecar);
    assert.equal(recoveredIdentity.ino, lockIdentity.ino);
    assert.equal(recoveredIdentity.dev, lockIdentity.dev);
    assert.deepEqual(await fs.readFile(path.join(f.root, 'catalog.json')), catalog);
    assert.deepEqual(Buffer.from(await contender.read(document.id)), pdf);
  });

  test('different library directories have independent owners', async t => {
    const f = await fixture(t);
    const left = f.service();
    const right = f.service(path.join(f.directory, 'another-library'));
    const imports = await Promise.all([left.import([f.source]), right.import([f.source])]);
    imports.forEach(result => {
      assert.deepEqual(result.errors, []);
      assert.equal(result.importedIds.length, 1);
    });
    assert.notEqual(imports[0].importedIds[0], imports[1].importedIds[0]);
  });

  test('a parent-directory alias cannot acquire a second owner of the same library', async t => {
    const f = await fixture(t);
    const owner = f.service();
    await owner.load();
    const alias = path.join(f.directory, 'profile-alias');
    try { await fs.symlink(f.directory, alias, process.platform === 'win32' ? 'junction' : 'dir'); }
    catch (error) {
      if (process.platform === 'win32' && ['EPERM', 'EACCES'].includes((error as NodeJS.ErrnoException).code ?? '')) {
        t.skip('Creating directory links requires permission on this Windows host.');
        return;
      }
      throw error;
    }
    await assert.rejects(f.service(path.join(alias, 'library')).load(), busy);
    assert.deepEqual((await owner.load()).documents, []);
  });

  test('existing catalog bytes, document IDs, metadata and managed PDFs survive opening without migration', async t => {
    const f = await fixture(t);
    const legacy = await LibraryStore.open(f.root);
    const id = (await legacy.import([f.source])).importedIds[0];
    const document = await legacy.update(id, { title: '研究ノート', tags: ['Research', '日本語'], favorite: true, pageCount: 12, lastPage: 7 });
    const catalog = await fs.readFile(path.join(f.root, 'catalog.json'));
    const copy = path.join(f.root, 'documents', `${id}.pdf`);
    const service = f.service();
    assert.deepEqual((await service.load()).documents, [document]);
    assert.deepEqual(Buffer.from(await service.read(id)), pdf);
    await service.withDocumentPath(id, filename => { assert.equal(filename, copy); });
    assert.deepEqual(await fs.readFile(path.join(f.root, 'catalog.json')), catalog);
    assert.deepEqual(await fs.readFile(copy), pdf);
    const duplicate = await service.import([f.source]);
    assert.equal(duplicate.duplicateCount, 1);
    assert.deepEqual(duplicate.importedIds, []);
    assert.deepEqual(duplicate.library.documents, [document]);
    assert.deepEqual(await fs.readFile(path.join(f.root, 'catalog.json')), catalog);
    assert.deepEqual((await service.remove(id)).documents, []);
    assert.deepEqual(await fs.readFile(copy), pdf, 'Removing an entry retains the managed PDF.');
    assert.deepEqual(await fs.readFile(f.source), pdf, 'The imported source remains untouched.');
  });

  test('a damaged catalog remains untouched, releases ownership, and can be retried after repair', async t => {
    const f = await fixture(t);
    await fs.mkdir(f.root);
    const catalog = path.join(f.root, 'catalog.json');
    const damaged = Buffer.from('{unfinished');
    await fs.writeFile(catalog, damaged);
    const first = f.service();
    const second = f.service();
    await assert.rejects(first.load(), /damaged|unsupported/);
    await assert.rejects(second.load(), /damaged|unsupported/, 'A failed open must release its ownership.');
    assert.deepEqual(await fs.readFile(catalog), damaged);
    await fs.writeFile(catalog, JSON.stringify({ version: 1, documents: [] }));
    assert.deepEqual((await second.load()).documents, []);
    await assert.rejects(first.load(), busy);
    await second.close();
    assert.deepEqual((await first.load()).documents, []);
  });

  test('non-ordinary and corrupt lock files are refused without overwriting them', async t => {
    const f = await fixture(t);
    const sidecar = path.join(f.root, '.prism-library-lock.sqlite');
    await fs.mkdir(sidecar, { recursive: true });
    const service = f.service();
    await assert.rejects(service.load(), /lock changed/);
    assert.equal((await fs.stat(sidecar)).isDirectory(), true);
    await fs.rmdir(sidecar);
    const damaged = Buffer.from('This is not a SQLite database.');
    await fs.writeFile(sidecar, damaged);
    await assert.rejects(service.load(), /not a database|malformed|corrupt/i);
    // Acquisition has failed and released the descriptor before this check.
    assert.deepEqual(await fs.readFile(sidecar), damaged);
    await fs.unlink(sidecar);
    assert.deepEqual((await service.load()).documents, []);
  });

  test('a replaced lock file prevents the old owner from publishing metadata', async t => {
    const f = await fixture(t);
    const owner = f.service();
    const document = (await owner.import([f.source])).library.documents[0];
    const catalog = path.join(f.root, 'catalog.json');
    const before = await fs.readFile(catalog);
    const sidecar = path.join(f.root, '.prism-library-lock.sqlite');
    try { await fs.rename(sidecar, path.join(f.root, 'displaced-lock.sqlite')); }
    catch (error) {
      if (process.platform === 'win32' && ['EPERM', 'EACCES', 'EBUSY'].includes((error as NodeJS.ErrnoException).code ?? '')) {
        t.skip('This Windows filesystem prevents renaming an open SQLite lock.');
        return;
      }
      throw error;
    }
    // This is a different inode; do not open or read the displaced, owned lock.
    await fs.writeFile(sidecar, '');
    await assert.rejects(owner.update(document.id, { title: 'Must not be published' }), /lock changed/);
    assert.deepEqual(await fs.readFile(catalog), before);
    await owner.close();
    assert.deepEqual((await f.service().load()).documents, [document]);
  });

  test('close drains accepted writes before unlocking and rejects requests admitted after closing begins', { timeout: 20_000 }, async t => {
    const f = await fixture(t);
    const seed = await LibraryStore.open(f.root);
    const id = (await seed.import([f.source])).importedIds[0];
    const entered = deferred();
    const release = deferred();
    let pause = true;
    const service = f.service(f.root, {
      rename: async (source, destination) => {
        if (pause) { pause = false; entered.resolve(); await release.promise; }
        await fs.rename(source, destination);
      },
    });
    await service.load();
    const first = service.update(id, { title: 'Saved during shutdown' });
    let closing: Promise<void> | undefined;
    let second: ReturnType<PDFLibraryService['update']> | undefined;
    try {
      await entered.promise;
      second = service.update(id, { favorite: true });
      let didClose = false;
      closing = service.close().then(() => { didClose = true; });
      await assert.rejects(service.update(id, { title: 'Too late' }), closed);
      const contender = f.service();
      await assert.rejects(contender.load(), busy);
      assert.equal(didClose, false, 'Ownership must survive the paused catalog publication.');
      release.resolve();
      await Promise.all([first, second, closing]);
      const recovered = (await contender.load()).documents[0];
      assert.equal(recovered.title, 'Saved during shutdown');
      assert.equal(recovered.favorite, true);
      assert.equal(recovered.id, id);
    } finally {
      release.resolve();
      await Promise.allSettled([first, second, closing].filter(promise => promise !== undefined));
    }
  });
}
