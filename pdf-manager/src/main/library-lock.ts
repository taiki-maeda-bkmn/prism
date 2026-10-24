import { type Stats } from 'node:fs';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const owners = new Set<string>();
const inUse = () => new Error('This PDF library is already open in another Prism window. Close that app, then retry.');
const changed = () => new Error('The PDF library lock changed. Close all Prism apps and reopen the library before continuing.');

function ordinaryFile(info: Stats): boolean {
  return info.isFile() && !info.isSymbolicLink() && info.nlink === 1;
}

/**
 * A permanent SQLite sidecar supplies a kernel-backed, process-lifetime mutex.
 * It contains no catalogue data. A crash releases ownership without PID files,
 * timeouts, heartbeats, or deleting a supposedly stale lock.
 */
export class LibraryLock {
  private constructor(
    readonly root: string,
    private readonly filename: string,
    private readonly identity: Stats,
    private database: DatabaseSync | undefined,
  ) {}

  static async acquire(directory: string): Promise<LibraryLock> {
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    const original = await fs.lstat(directory);
    if (!original.isDirectory() || original.isSymbolicLink()) throw new Error('The PDF library folder must be an ordinary directory.');
    const root = await fs.realpath(directory);
    if (owners.has(root)) throw inUse();
    owners.add(root);
    const filename = path.join(root, '.prism-library-lock.sqlite');
    let database: DatabaseSync | undefined;
    try {
      let before: Stats | undefined;
      try { before = await fs.lstat(filename); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      if (before && !ordinaryFile(before)) throw changed();
      database = new DatabaseSync(filename);
      database.exec('BEGIN EXCLUSIVE');
      const identity = await fs.lstat(filename);
      if (!ordinaryFile(identity) || (before && (before.dev !== identity.dev || before.ino !== identity.ino))) throw changed();
      // Never open/read/close this file through fs: on POSIX, closing an unrelated
      // descriptor for the same inode can release SQLite's advisory locks.
      // Keep the sidecar in place even after release; SQLite handles recovery.
      return new LibraryLock(root, filename, identity, database);
    } catch (error) {
      database?.close();
      owners.delete(root);
      const code = (error as { errcode?: number }).errcode;
      if (code === 5 || code === 6) throw inUse();
      throw error;
    }
  }

  async assertOwned(): Promise<void> {
    if (!this.database) throw new Error('The PDF library is closed. Reopen it before continuing.');
    let current: Stats;
    try { current = await fs.lstat(this.filename); } catch { throw changed(); }
    if (!ordinaryFile(current) || current.dev !== this.identity.dev || current.ino !== this.identity.ino) throw changed();
  }

  release(): void {
    if (!this.database) return;
    this.database.close();
    this.database = undefined;
    owners.delete(this.root);
  }
}
