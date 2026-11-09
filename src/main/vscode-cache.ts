import { constants, type Stats } from 'node:fs';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { mapVSCodeColors } from './vscode-theme';

const MAX_DATABASE_BYTES = 16 * 1024 * 1024;
const MAX_THEME_BYTES = 2 * 1024 * 1024;
const changed = () => new Error('The VS Code theme cache changed while it was being read. Try importing again.');
const missing = (error: unknown) => (error as NodeJS.ErrnoException)?.code === 'ENOENT';
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);

function sameFile(before: Stats, after: Stats): boolean {
  return before.dev === after.dev && before.ino === after.ino && before.size === after.size
    && before.mtimeMs === after.mtimeMs && before.ctimeMs === after.ctimeMs;
}

interface Source {
  file: string;
  handle: fs.FileHandle;
  info: Stats;
}

async function openSource(file: string, optional = false): Promise<Source | undefined> {
  let handle: fs.FileHandle;
  try { handle = await fs.open(file, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0)); }
  catch (error) { if (optional && missing(error)) return undefined; throw error; }
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw new Error('The VS Code theme cache must be a regular file.');
    if (info.size > MAX_DATABASE_BYTES) throw new Error('The VS Code theme cache and its journal must each be 16 MB or smaller.');
    return { file, handle, info };
  } catch (error) { await handle.close(); throw error; }
}

async function snapshot(databasePath: string, destination: string): Promise<void> {
  const paths = [databasePath, `${databasePath}-wal`, `${databasePath}-journal`];
  const sources: (Source | undefined)[] = [];
  try {
    // Capture every source's identity before copying any bytes. SQLite only
    // opens the private copy: read-only WAL connections can still write shm.
    for (let index = 0; index < paths.length; index++) sources.push(await openSource(paths[index], index > 0));
    if (sources[2]?.info.size) throw new Error('VS Code is updating its theme cache. Try importing again after it finishes.');
    for (let index = 0; index < 2; index++) {
      const source = sources[index];
      if (!source) continue;
      const buffer = Buffer.alloc(source.info.size + 1);
      let length = 0;
      while (length < buffer.length) {
        const { bytesRead } = await source.handle.read(buffer, length, buffer.length - length, length);
        if (!bytesRead) break;
        length += bytesRead;
      }
      if (length !== source.info.size) throw changed();
      await fs.writeFile(`${destination}${index ? '-wal' : ''}`, buffer.subarray(0, length), { flag: 'wx', mode: 0o600 });
    }
    for (let index = 0; index < paths.length; index++) {
      let current: Stats | undefined;
      try { current = await fs.stat(paths[index]); }
      catch (error) { if (!missing(error)) throw error; }
      const source = sources[index];
      if (!source) { if (current) throw changed(); }
      else if (!current || !sameFile(source.info, current) || !sameFile(source.info, await source.handle.stat())) throw changed();
    }
  } finally { await Promise.all(sources.map(source => source?.handle.close())); }
}

function parseCachedTheme(raw: string | Uint8Array): { name: string; settingsId: string; colors: Record<string, unknown> } {
  let value: unknown;
  try {
    const text = typeof raw === 'string' ? raw : new TextDecoder('utf-8', { fatal: true }).decode(raw);
    value = JSON.parse(text);
  } catch { throw new Error('The last-used VS Code theme cache contains invalid UTF-8 JSON.'); }
  const validName = (name: unknown, limit: number): name is string => typeof name === 'string'
    && !!name.trim() && name.length <= limit && !/[\u0000-\u001f\u007f]/.test(name);
  if (!record(value) || !validName(value.id, 1024) || !validName(value.label, 256)
    || !validName(value.settingsId, 256) || !record(value.colorMap)) {
    throw new Error('The last-used VS Code theme cache has an unsupported format.');
  }
  const entries = Object.entries(value.colorMap);
  if (entries.length > 4096 || entries.some(([key, color]) => !key || key.length > 256
    || typeof color !== 'string' || !/^#(?:[\da-f]{3}|[\da-f]{4}|[\da-f]{6}|[\da-f]{8})$/i.test(color))) {
    throw new Error('The last-used VS Code theme cache contains invalid colors.');
  }
  const colors = Object.fromEntries(entries);
  if (!Object.keys(mapVSCodeColors(colors).colors).length) throw new Error('The last-used VS Code theme has no supported Prism colors.');
  return { name: value.label.trim(), settingsId: value.settingsId.trim(), colors };
}

/** Read the default profile's last saved base palette, never other storage keys.
 * VS Code stores custom colors in settings.json, not in colorThemeData.
 */
export async function readLastUsedVSCodeTheme(databasePath: string): Promise<{ name: string; settingsId: string; colors: Record<string, unknown> }> {
  // Keep an unavailable SQLite runtime from preventing Prism itself starting.
  const { DatabaseSync } = await import('node:sqlite');
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'prism-vscode-cache-snapshot-'));
  try {
    const copy = path.join(directory, 'state.vscdb');
    await snapshot(databasePath, copy);
    const database = new DatabaseSync(copy, { readOnly: true, allowExtension: false, timeout: 100 });
    try {
      database.exec('PRAGMA query_only=ON; PRAGMA trusted_schema=OFF;');
      const schema = database.prepare('SELECT type, sql FROM sqlite_schema WHERE name = ?').get('ItemTable');
      if (schema?.type !== 'table' || typeof schema.sql !== 'string' || !/^\s*CREATE\s+TABLE\b/i.test(schema.sql)) {
        throw new Error('The VS Code theme cache does not contain a supported storage table.');
      }
      const columns = database.prepare("PRAGMA table_xinfo('ItemTable')").all();
      if (['key', 'value'].some(name => !columns.some(column => column.name === name && column.hidden === 0))) {
        throw new Error('The VS Code theme cache does not contain a supported storage table.');
      }
      const rows = database.prepare(`SELECT length(CAST(value AS BLOB)) AS bytes,
        CASE WHEN typeof(value) IN ('text', 'blob') AND length(CAST(value AS BLOB)) <= ? THEN CAST(value AS BLOB) END AS value
        FROM ItemTable WHERE key = ? LIMIT 2`).all(MAX_THEME_BYTES, 'colorThemeData');
      if (rows.length !== 1) throw new Error('The last-used VS Code theme was not found in its cache.');
      if (typeof rows[0].bytes === 'number' && rows[0].bytes > MAX_THEME_BYTES) throw new Error('The last-used VS Code theme must be 2 MB or smaller.');
      const raw = rows[0].value;
      if (typeof raw !== 'string' && !(raw instanceof Uint8Array)) throw new Error('The last-used VS Code theme cache contains an invalid value.');
      return parseCachedTheme(raw);
    } finally { database.close(); }
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
}
