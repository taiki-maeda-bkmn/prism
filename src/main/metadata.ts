import { spawn } from 'node:child_process';
import { constants, type Stats } from 'node:fs';
import * as fs from 'node:fs/promises';
import { preserveWindowsMetadata } from './windows-metadata';
import { MAX_NOTE_BYTES } from './limits';

function sameIdentity(a: Stats, b: Stats): boolean { return a.dev === b.dev && a.ino === b.ino; }

async function openRegular(file: string, access: number): Promise<fs.FileHandle> {
  const before = await fs.lstat(file);
  if (!before.isFile() || before.isSymbolicLink()) throw new Error('Metadata can only be copied between regular files.');
  const handle = await fs.open(file, access | (constants.O_NOFOLLOW || 0));
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || !sameIdentity(before, opened)) throw new Error('The file changed while its metadata was being read.');
    return handle;
  } catch (error) { await handle.close(); throw error; }
}

async function copyPosixDescriptors(source: fs.FileHandle, destination: fs.FileHandle): Promise<void> {
  const args = process.platform === 'darwin'
    ? ['-p', '/dev/fd/3', '/dev/fd/4']
    : ['--preserve=mode,ownership,xattr', '--', '/proc/self/fd/3', '/proc/self/fd/4'];
  const env = { ...process.env };
  delete env.COPYFILE_DISABLE;
  delete env.COPY_EXTENDED_ATTRIBUTES_DISABLE;
  await new Promise<void>((resolve, reject) => {
    // The paths refer only to inherited, verified file handles. cp never receives
    // notebook paths and cannot follow a replaced destination to another inode.
    const child = spawn('/bin/cp', args, {
      stdio: ['ignore', 'ignore', 'pipe', source.fd, destination.fd],
      env, timeout: 15_000,
    });
    let detail = '';
    child.stderr?.on('data', (chunk: Buffer) => { detail = (detail + chunk.toString()).slice(0, 4096); });
    child.once('error', (cause) => reject(new Error('The system metadata copier is unavailable; the note was not safely copied.', { cause })));
    child.once('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`Could not preserve the note's file metadata${detail.trim() ? `: ${detail.trim()}` : '.'}`));
    });
  });
}

/** The injected descriptor copier lets filesystem failures be tested without runtime switches. */
export function createMetadataCopier(copyDescriptors = copyPosixDescriptors): typeof fs.copyFile {
  return async (source, destination, flags = 0) => {
    if (typeof source !== 'string' || typeof destination !== 'string' || flags !== constants.COPYFILE_EXCL) {
      throw new Error('Metadata copies require exclusive file destinations.');
    }
    const input = await openRegular(source, constants.O_RDONLY);
    let output: fs.FileHandle | undefined;
    let owned: Stats | undefined;
    let failed = false;
    try {
      if ((await input.stat()).size > MAX_NOTE_BYTES) throw new Error('Notes larger than 2 MB cannot be copied.');
      if (process.platform === 'win32') {
        // CopyFileW preserves Windows attributes, streams and resource properties;
        // the explicit descriptor-based step also retains the discretionary ACL.
        await fs.copyFile(source, destination, constants.COPYFILE_EXCL);
        output = await openRegular(destination, constants.O_RDWR);
        owned = await output.stat();
        await preserveWindowsMetadata(input, output);
      } else if (process.platform === 'linux' || process.platform === 'darwin') {
        output = await fs.open(destination, constants.O_CREAT | constants.O_EXCL | constants.O_RDWR, 0o600);
        owned = await output.stat();
        await copyDescriptors(input, output);
        const before = await input.stat();
        const copied = await output.stat();
        if (before.uid !== copied.uid || before.gid !== copied.gid || (before.mode & 0o777) !== (copied.mode & 0o777)) {
          throw new Error('The note’s ownership or permissions could not be preserved.');
        }
      } else throw new Error('Preserving note metadata is not supported on this platform.');
      await output.sync();
      const latest = await fs.lstat(destination);
      if (!latest.isFile() || latest.isSymbolicLink() || !sameIdentity(latest, owned)) throw new Error('The copied note was replaced by another application.');
    } catch (error) {
      // Even the inode we created may now contain another application's edits.
      // Retain failed copies; recovery also keeps the original and complete draft.
      failed = true;
      throw error;
    } finally {
      const closed = await Promise.allSettled([output?.close(), input.close()]);
      if (!failed) {
        const failure = closed.find((result) => result.status === 'rejected');
        if (failure?.status === 'rejected') throw failure.reason;
      }
    }
  };
}

/** Exclusive, independent copies retaining native access controls and extended attributes. */
export const copyFileWithMetadata = createMetadataCopier();
