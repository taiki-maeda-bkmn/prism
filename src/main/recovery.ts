import { createHash, randomUUID } from 'node:crypto';
import { constants, type Stats } from 'node:fs';
import * as fs from 'node:fs/promises';
import path from 'node:path';

export const RECOVERY_DIRECTORY = '.prism-recovery';
const codeOf = (error: unknown) => (error as NodeJS.ErrnoException)?.code;
const digest = (content: string) => createHash('sha256').update(content, 'utf8').digest('hex');
type Identity = Pick<Stats, 'ino' | 'dev'>;
export type RecoveryIO = Pick<typeof fs, 'rename' | 'copyFile'>;
interface Manifest { version: 1; notePath: string; originalHash: string; draftHash: string; }

async function directoryIdentity(directory: string): Promise<Stats> {
  const stat = await fs.lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || await fs.realpath(directory) !== directory) {
    throw new Error('The recovery directory changed or contains a symbolic link.');
  }
  return stat;
}

async function readRecord(file: string): Promise<string> {
  const before = await fs.lstat(file);
  if (!before.isFile() || before.isSymbolicLink() || before.size > 8192) throw new Error('Invalid recovery record.');
  const handle = await fs.open(file, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
  try {
    const opened = await handle.stat();
    if (opened.ino !== before.ino || opened.dev !== before.dev || !opened.isFile()) throw new Error('The recovery record changed.');
    const buffer = Buffer.alloc(8193);
    let length = 0;
    while (length < buffer.length) {
      const result = await handle.read(buffer, length, buffer.length - length, null);
      if (!result.bytesRead) break;
      length += result.bytesRead;
    }
    if (length > 8192) throw new Error('Invalid recovery record.');
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, length));
  } finally { await handle.close(); }
}

/** A journal is retained after completion; only unfinished journals can restore missing notes. */
export class SaveRecovery {
  readonly original: string;
  readonly draft: string;
  readonly target: string;

  private constructor(
    readonly directory: string,
    readonly manifest: Manifest,
    private readonly directoryID: Identity,
    private readonly recoveryID: Identity,
    private readonly checkParent: () => Promise<unknown>,
  ) {
    this.original = path.join(directory, 'original.md');
    this.draft = path.join(directory, 'draft.md');
    this.target = path.join(path.dirname(path.dirname(directory)), path.basename(manifest.notePath));
  }

  static async prepare(parent: string, notePath: string, content: string, originalHash: string, mode: number, checkParent: () => Promise<unknown>): Promise<SaveRecovery> {
    await checkParent();
    const recoveryRoot = path.join(parent, RECOVERY_DIRECTORY);
    try { await fs.mkdir(recoveryRoot, { mode: 0o700 }); }
    catch (error) { if (codeOf(error) !== 'EEXIST') throw error; }
    const recoveryID = await directoryIdentity(recoveryRoot);
    const directory = await fs.mkdtemp(path.join(recoveryRoot, `save-${Date.now()}-`));
    const directoryID = await directoryIdentity(directory);
    const manifest: Manifest = { version: 1, notePath, originalHash, draftHash: digest(content) };
    const transaction = new SaveRecovery(directory, manifest, directoryID, recoveryID, checkParent);
    await transaction.guard();
    await fs.writeFile(path.join(directory, 'manifest.json'), JSON.stringify(manifest), { encoding: 'utf8', flag: 'wx', mode: 0o600, flush: true });
    const handle = await fs.open(transaction.draft, 'wx', 0o600);
    try {
      await handle.writeFile(content, 'utf8');
      await handle.chmod(mode & 0o777);
      await handle.sync();
    } finally { await handle.close(); }
    return transaction;
  }

  static async open(directory: string, relativeParent: string, validatePath: (value: unknown) => string, checkParent: () => Promise<unknown>): Promise<SaveRecovery | null> {
    await checkParent();
    const recoveryID = await directoryIdentity(path.dirname(directory));
    const directoryID = await directoryIdentity(directory);
    let text: string;
    try { text = await readRecord(path.join(directory, 'manifest.json')); }
    catch (error) { if (codeOf(error) === 'ENOENT') return null; throw error; }
    const value: unknown = JSON.parse(text);
    if (!value || typeof value !== 'object' || Array.isArray(value)
      || Object.keys(value).sort().join(',') !== 'draftHash,notePath,originalHash,version') throw new Error('Invalid recovery manifest.');
    const manifest = value as Manifest;
    const notePath = validatePath(manifest.notePath);
    if (manifest.version !== 1 || path.posix.dirname(notePath) !== (relativeParent || '.')
      || typeof manifest.originalHash !== 'string' || typeof manifest.draftHash !== 'string'
      || !/^[a-f0-9]{64}$/.test(manifest.originalHash) || !/^[a-f0-9]{64}$/.test(manifest.draftHash)) {
      throw new Error('Invalid recovery manifest.');
    }
    return new SaveRecovery(directory, manifest, directoryID, recoveryID, checkParent);
  }

  async guard(): Promise<void> {
    await this.checkParent();
    const root = await directoryIdentity(path.dirname(this.directory));
    const current = await directoryIdentity(this.directory);
    if (root.ino !== this.recoveryID.ino || root.dev !== this.recoveryID.dev
      || current.ino !== this.directoryID.ino || current.dev !== this.directoryID.dev) throw new Error('The recovery directory was replaced.');
  }

  async isComplete(): Promise<boolean> {
    await this.guard();
    try {
      if (await readRecord(path.join(this.directory, 'complete')) !== '1\n') throw new Error('Invalid recovery completion marker; copies were preserved for manual recovery.');
      return true;
    }
    catch (error) { if (codeOf(error) === 'ENOENT') return false; throw error; }
  }

  async complete(): Promise<void> {
    if (await this.isComplete()) return;
    const temporary = path.join(this.directory, `.complete-${randomUUID()}.tmp`);
    try {
      await fs.writeFile(temporary, '1\n', { flag: 'wx', mode: 0o600, flush: true });
      await this.guard();
      await fs.rename(temporary, path.join(this.directory, 'complete'));
    } finally { await fs.unlink(temporary).catch(() => undefined); }
  }

  async capture(io: RecoveryIO): Promise<void> {
    await this.guard();
    try { await fs.lstat(this.original); throw new Error('This recovery record already contains an original note.'); }
    catch (error) { if (codeOf(error) !== 'ENOENT') throw error; }
    await io.rename(this.target, this.original);
  }

  async publish(io: RecoveryIO): Promise<void> {
    await this.guard();
    const draft = await fs.lstat(this.draft);
    if (!draft.isFile() || draft.isSymbolicLink()) throw new Error('The recovery draft is not a regular file.');
    // Keep draft.md separate from the live inode so later edits cannot change the retained draft.
    await io.copyFile(this.draft, this.target, constants.COPYFILE_EXCL);
    await this.flushTarget();
  }

  private async flushTarget(): Promise<void> {
    await this.guard();
    const before = await fs.lstat(this.target);
    if (!before.isFile() || before.isSymbolicLink()) throw new Error('The published note is not a regular file.');
    // Windows requires a writable handle for FlushFileBuffers; no bytes are changed here.
    const access = process.platform === 'win32' ? constants.O_RDWR : constants.O_RDONLY;
    const handle = await fs.open(this.target, access | (constants.O_NOFOLLOW || 0));
    try {
      const opened = await handle.stat();
      if (!opened.isFile() || opened.ino !== before.ino || opened.dev !== before.dev) throw new Error('The published note changed before it could be flushed.');
      await handle.sync();
    } finally { await handle.close(); }
  }

  async settle(io: RecoveryIO, maximumNoteBytes: number): Promise<'complete' | 'restored' | 'present' | 'uncaptured'> {
    if (await this.isComplete()) return 'complete';
    let original: Stats;
    try { original = await fs.lstat(this.original); }
    catch (error) {
      if (codeOf(error) !== 'ENOENT') throw error;
      await this.complete();
      return 'uncaptured';
    }
    if (!original.isFile() || original.isSymbolicLink()) throw new Error('The captured recovery note is not a regular file; it was preserved for manual recovery.');
    if (original.size > maximumNoteBytes) throw new Error('The captured recovery note exceeds the note size limit; it was preserved for manual recovery.');
    await this.guard();
    let result: 'restored' | 'present' = 'restored';
    try { await io.copyFile(this.original, this.target, constants.COPYFILE_EXCL); }
    catch (error) { if (codeOf(error) === 'EEXIST') result = 'present'; else throw error; }
    if (result === 'restored') await this.flushTarget();
    await this.complete();
    return result;
  }
}
