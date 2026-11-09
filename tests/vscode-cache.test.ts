import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test, { type TestContext } from 'node:test';
import { readLastUsedVSCodeTheme } from '../src/main/vscode-cache';

const theme = {
  id: 'vs-dark theme-研究', label: '研究 Theme', settingsId: '研究 Theme',
  colorMap: { 'editor.background': '#123456', 'editor.foreground': '#eee', 'textLink.foreground': '#789abc80' },
};

async function fixture(t: TestContext) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'prism-vscode-cache-test-'));
  // Keep cleanup assertions independent of other processes importing themes.
  t.mock.method(os, 'tmpdir', () => root);
  t.after(async () => {
    assert.deepEqual((await fs.readdir(root)).filter(name => name.startsWith('prism-vscode-cache-snapshot-')), []);
    await fs.rm(root, { recursive: true, force: true });
  });
  let index = 0;
  const create = (value: string | Uint8Array | null = JSON.stringify(theme), schema = 'CREATE TABLE ItemTable (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB)') => {
    const file = path.join(root, `state-${index++}.vscdb`);
    const db = new DatabaseSync(file);
    try {
      db.exec(schema);
      db.prepare('INSERT INTO ItemTable (key, value) VALUES (?, ?)').run('colorThemeData', value);
    } finally { db.close(); }
    return file;
  };
  return { root, create };
}

test('reads only the last-used palette from JSON text or UTF-8 BLOB and removes private snapshots', async t => {
  const { create } = await fixture(t);
  for (const value of [JSON.stringify(theme), Buffer.from(JSON.stringify(theme))]) {
    const file = create(value);
    const db = new DatabaseSync(file);
    db.prepare('INSERT INTO ItemTable VALUES (?, ?)').run('unrelated-private-key', 'x'.repeat(3 * 1024 * 1024));
    db.close();
    assert.deepEqual(await readLastUsedVSCodeTheme(file), { name: theme.label, settingsId: theme.settingsId, colors: theme.colorMap });
  }
});

test('rejects missing, non-file, corrupt and oversized databases without leaving snapshots', async t => {
  const { root } = await fixture(t);
  await assert.rejects(readLastUsedVSCodeTheme(path.join(root, 'missing.vscdb')), /ENOENT/);
  await assert.rejects(readLastUsedVSCodeTheme(root), /regular file/);
  const file = path.join(root, 'invalid.vscdb');
  await fs.writeFile(file, 'This is not a SQLite database.');
  await assert.rejects(readLastUsedVSCodeTheme(file), /not a database/);
  await fs.truncate(file, 16 * 1024 * 1024 + 1);
  await assert.rejects(readLastUsedVSCodeTheme(file), /16 MB or smaller/);
});

test('rejects missing cache keys, duplicate keys, views, virtual tables and unsupported schemas', async t => {
  const { root, create } = await fixture(t);
  const missingKey = create();
  const db = new DatabaseSync(missingKey);
  db.exec('DELETE FROM ItemTable');
  db.close();
  await assert.rejects(readLastUsedVSCodeTheme(missingKey), /not found/);
  const duplicates = create(JSON.stringify(theme), 'CREATE TABLE ItemTable (key TEXT, value BLOB)');
  const duplicateDb = new DatabaseSync(duplicates);
  duplicateDb.prepare('INSERT INTO ItemTable VALUES (?, ?)').run('colorThemeData', JSON.stringify(theme));
  duplicateDb.close();
  await assert.rejects(readLastUsedVSCodeTheme(duplicates), /not found/);
  for (const [name, schema] of [
    ['missing', 'CREATE TABLE Other (key TEXT, value BLOB)'],
    ['view', 'CREATE VIEW ItemTable AS SELECT 1 AS key, 2 AS value'],
    ['virtual', 'CREATE VIRTUAL TABLE ItemTable USING fts5(key, value)'],
    ['columns', 'CREATE TABLE ItemTable (other TEXT)'],
    ['generated', 'CREATE TABLE ItemTable (key TEXT, value TEXT GENERATED ALWAYS AS (hex(zeroblob(100))))'],
  ]) {
    const file = path.join(root, `${name}.vscdb`);
    const other = new DatabaseSync(file);
    other.exec(schema);
    other.close();
    await assert.rejects(readLastUsedVSCodeTheme(file), /supported storage table|no such column/);
  }
});

test('rejects null, malformed, non-UTF-8 and oversized cached values', async t => {
  const { create } = await fixture(t);
  await assert.rejects(readLastUsedVSCodeTheme(create(null)), /invalid value/);
  await assert.rejects(readLastUsedVSCodeTheme(create('{"id":')), /invalid UTF-8 JSON/);
  await assert.rejects(readLastUsedVSCodeTheme(create(Buffer.from([0x7b, 0xff, 0x7d]))), /invalid UTF-8 JSON/);
  const file = create();
  const invalidText = Buffer.from(JSON.stringify({ ...theme, label: 'INVALID_BYTE' }));
  invalidText[invalidText.indexOf('INVALID_BYTE')] = 0xff;
  const db = new DatabaseSync(file);
  db.prepare('UPDATE ItemTable SET value=CAST(? AS TEXT)').run(invalidText);
  db.close();
  await assert.rejects(readLastUsedVSCodeTheme(file), /invalid UTF-8 JSON/);
  await assert.rejects(readLastUsedVSCodeTheme(create(' '.repeat(2 * 1024 * 1024 + 1))), /2 MB or smaller/);
});

test('validates cached identity, bounded names and color-map shape before accepting a palette', async t => {
  const { create } = await fixture(t);
  for (const value of [null, [], 1, {},
    { ...theme, id: '' }, { ...theme, id: 'x'.repeat(1025) },
    { ...theme, label: null }, { ...theme, label: 'x'.repeat(257) },
    { ...theme, settingsId: '\nTheme' }, { ...theme, settingsId: '   ' },
    { ...theme, colorMap: null }, { ...theme, colorMap: [] },
  ]) await assert.rejects(readLastUsedVSCodeTheme(create(JSON.stringify(value))), /unsupported format/);
  for (const colorMap of [
    { 'editor.background': null }, { 'editor.background': 'default' }, { 'editor.background': 'url(https://example.test)' },
    { 'editor.background': {} }, { ['x'.repeat(257)]: '#fff' },
    Object.fromEntries(Array.from({ length: 4097 }, (_, index) => [`color.${index}`, '#fff'])),
  ]) await assert.rejects(readLastUsedVSCodeTheme(create(JSON.stringify({ ...theme, colorMap }))), /invalid colors/);
  for (const colorMap of [{}, { 'unused.color': '#fff' }]) {
    await assert.rejects(readLastUsedVSCodeTheme(create(JSON.stringify({ ...theme, colorMap }))), /no supported Prism colors/);
  }
});

async function fileState(file: string) {
  const info = await fs.stat(file);
  return { bytes: await fs.readFile(file), size: info.size, modified: info.mtimeMs, changed: info.ctimeMs };
}

test('leaves original database bytes and metadata unchanged, including read-only files', async t => {
  const { root, create } = await fixture(t);
  const file = create();
  await fs.chmod(file, 0o400);
  t.after(() => fs.chmod(file, 0o600).catch(() => {}));
  const before = await fileState(file);
  await readLastUsedVSCodeTheme(file);
  assert.deepEqual(await fileState(file), before);
  assert.deepEqual(await fs.readdir(root), [path.basename(file)]);
});

test('includes committed WAL colors without changing the original database, WAL or shared memory', async t => {
  const { root, create } = await fixture(t);
  const file = create();
  const db = new DatabaseSync(file);
  try {
    db.exec('PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0;');
    const updated = { ...theme, label: 'WAL Theme', colorMap: { 'editor.background': '#abcdef' } };
    db.prepare('UPDATE ItemTable SET value=? WHERE key=?').run(JSON.stringify(updated), 'colorThemeData');
    const files = [file, `${file}-wal`, `${file}-shm`];
    const before = await Promise.all(files.map(fileState));
    assert.deepEqual(await readLastUsedVSCodeTheme(file), { name: updated.label, settingsId: updated.settingsId, colors: updated.colorMap });
    assert.deepEqual(await Promise.all(files.map(fileState)), before);
    assert.deepEqual((await fs.readdir(root)).sort(), files.map(file => path.basename(file)).sort());
  } finally { db.close(); }
});

test('rejects active rollback journals and oversized or non-file WAL sources', async t => {
  const { create } = await fixture(t);
  const file = create();
  await fs.writeFile(`${file}-journal`, 'active transaction');
  await assert.rejects(readLastUsedVSCodeTheme(file), /VS Code is updating/);
  await fs.truncate(`${file}-journal`, 0);
  assert.equal((await readLastUsedVSCodeTheme(file)).name, theme.label);
  await fs.writeFile(`${file}-wal`, '');
  await fs.truncate(`${file}-wal`, 16 * 1024 * 1024 + 1);
  await assert.rejects(readLastUsedVSCodeTheme(file), /16 MB or smaller/);
  await fs.rm(`${file}-wal`);
  await fs.mkdir(`${file}-wal`);
  await assert.rejects(readLastUsedVSCodeTheme(file), /regular file/);
});
