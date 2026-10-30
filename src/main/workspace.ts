import { createHash, randomUUID } from 'node:crypto';
import { constants, type Stats } from 'node:fs';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import type { Note, Workspace } from '../shared/types';
import { RECOVERY_DIRECTORY, SaveRecovery, type RecoveryIO } from './recovery';
import { copyFileWithMetadata } from './metadata';
import { MAX_NOTE_BYTES } from './limits';

export { MAX_NOTE_BYTES } from './limits';
export const MAX_NOTES = 2_000;
const MAX_WORKSPACE_BYTES = 64 * 1024 * 1024;
const MAX_ENTRIES = 20_000;
const MAX_DEPTH = 32;
const unsupportedHardLink = new Set(['ENOTSUP', 'EOPNOTSUPP', 'ENOSYS', 'EXDEV', 'EPERM']);
const markdownExtension = /\.(?:md|markdown)$/i;
const ignoredDirectory = (name: string) => name.startsWith('.') || name.toLowerCase() === 'node_modules';
const codeOf = (error: unknown) => (error as NodeJS.ErrnoException)?.code;

type Snapshot = {
  note: Note;
  hash: string;
  mtime: number;
  size: number;
  ino: number;
  dev: number;
  mode: number;
  hasBOM: boolean;
};

type CreateNoteIO = Pick<typeof fs, 'link' | 'copyFile'> & Partial<Pick<typeof fs, 'rename'>> & {
  recoveryCopyFile?: typeof fs.copyFile;
};

export function validateNotePath(value: unknown, create = false): string {
  if (typeof value !== 'string' || !value || value.length > 1024 || value.includes('\\')) {
    throw new Error('Use a relative Markdown path, such as Ideas/My note.md.');
  }
  const segments = value.split('/');
  if (segments.some((segment) => !segment || segment.length > 255 || ignoredDirectory(segment)
    || /[<>:"|?*\u0000-\u001f]/.test(segment) || /[. ]$/.test(segment)
    || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(segment))) {
    throw new Error('That note path contains an unsupported name or leaves the notebook.');
  }
  if (!(create ? /\.md$/i : markdownExtension).test(value)) {
    throw new Error('Notes must use a .md extension.');
  }
  return segments.join('/');
}

function sameFile(a: Snapshot, b: Snapshot): boolean {
  return a.hash === b.hash && a.mtime === b.mtime && a.size === b.size && a.ino === b.ino && a.dev === b.dev;
}

/** All paths received from the renderer are interpreted within this fixed root. */
export class WorkspaceStore {
  readonly root: string;
  private snapshots = new Map<string, Snapshot>();
  private pending: Promise<unknown> = Promise.resolve();

  private constructor(root: string, private readonly identity: Pick<Stats, 'ino' | 'dev'>, private readonly createIO: CreateNoteIO) { this.root = root; }

  static async open(directory: string, createIO: CreateNoteIO = { ...fs, recoveryCopyFile: copyFileWithMetadata }): Promise<WorkspaceStore> {
    const root = await fs.realpath(directory);
    const stat = await fs.lstat(root);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Choose a folder for your notebook.');
    return new WorkspaceStore(root, { ino: stat.ino, dev: stat.dev }, createIO);
  }

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.pending.then(operation);
    this.pending = result.catch(() => undefined);
    return result;
  }

  private recoveryIO(): RecoveryIO {
    return { rename: this.createIO.rename || fs.rename, copyFile: this.createIO.recoveryCopyFile || this.createIO.copyFile };
  }

  private async assertRoot(): Promise<void> {
    const current = await fs.lstat(this.root);
    if (!current.isDirectory() || current.isSymbolicLink()
      || current.ino !== this.identity.ino || current.dev !== this.identity.dev
      || await fs.realpath(this.root) !== this.root) {
      throw new Error('The notebook folder changed. Open the folder again before continuing.');
    }
  }

  private async safeParent(notePath: string, createDirectories = false): Promise<string> {
    let current = this.root;
    await this.assertRoot();
    for (const segment of notePath.split('/').slice(0, -1)) {
      current = path.join(current, segment);
      if (createDirectories) {
        try { await fs.mkdir(current); } catch (error) { if (codeOf(error) !== 'EEXIST') throw error; }
      }
      const stat = await fs.lstat(current);
      if (!stat.isDirectory() || stat.isSymbolicLink() || await fs.realpath(current) !== current) {
        throw new Error('Symbolic links cannot be used as notebook folders.');
      }
    }
    return current;
  }

  private async readSnapshot(notePath: string): Promise<Snapshot> {
    const parent = await this.safeParent(notePath);
    const absolute = path.join(parent, path.basename(notePath));
    const before = await fs.lstat(absolute);
    if (!before.isFile() || before.isSymbolicLink()) throw new Error('Symbolic links and special files are not supported.');
    const handle = await fs.open(absolute, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.ino !== before.ino || stat.dev !== before.dev) throw new Error('This note changed while it was being read. Refresh and try again.');
      if (stat.size > MAX_NOTE_BYTES) throw new Error('Notes larger than 2 MB are skipped.');
      const bytes = Buffer.alloc(Math.min(stat.size + 1, MAX_NOTE_BYTES + 1));
      let length = 0;
      while (length < bytes.length) {
        const result = await handle.read(bytes, length, bytes.length - length, null);
        if (!result.bytesRead) break;
        length += result.bytesRead;
      }
      const after = await handle.stat();
      if (length > MAX_NOTE_BYTES) throw new Error('Notes larger than 2 MB are skipped.');
      if (after.size !== stat.size || after.mtimeMs !== stat.mtimeMs || length !== stat.size) throw new Error('This note changed while it was being read. Refresh and try again.');
      await this.safeParent(notePath);
      const latest = await fs.lstat(absolute);
      if (latest.isSymbolicLink() || latest.ino !== stat.ino || latest.dev !== stat.dev) throw new Error('This note changed while it was being read. Refresh and try again.');
      const hasBOM = length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
      // A UTF-8 signature is file metadata, not part of the first Markdown heading.
      const content = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, length));
      const snapshot: Snapshot = {
        note: { path: notePath, content, modified: stat.mtimeMs },
        hash: createHash('sha256').update(bytes.subarray(0, length)).digest('hex'),
        mtime: stat.mtimeMs, size: stat.size, ino: stat.ino, dev: stat.dev, mode: stat.mode, hasBOM,
      };
      const previous = this.snapshots.get(notePath);
      if (previous) snapshot.note.modified = sameFile(previous, snapshot)
        ? previous.note.modified : Math.max(stat.mtimeMs, previous.note.modified + 0.001);
      return snapshot;
    } finally { await handle.close(); }
  }

  load(): Promise<Workspace> {
    return this.serialize(async () => {
      await this.assertRoot();
      const notes: Note[] = [];
      const warnings: string[] = [];
      const seen = new Set<string>();
      const unverifiedNotes = new Set<string>();
      let visited = 0;
      let recoveryVisits = 0;
      let totalBytes = 0;
      let stopped = false;
      const warn = (message: string) => { if (warnings.length < 40) warnings.push(message); };
      const visit = async (relative: string, depth: number): Promise<void> => {
        if (depth > MAX_DEPTH) { warn(`${relative}: folders deeper than ${MAX_DEPTH} levels are skipped.`); return; }
        const directory = path.join(this.root, relative);
        const info = await fs.lstat(directory);
        if (info.isSymbolicLink() || !info.isDirectory() || await fs.realpath(directory) !== directory) {
          warn(`${relative || 'Notebook'}: symbolic links are skipped.`); return;
        }
        let entries = (await fs.readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name));
        const recovery = entries.find((entry) => entry.name === RECOVERY_DIRECTORY);
        if (recovery) {
          const recoveryRoot = path.join(directory, RECOVERY_DIRECTORY);
          try {
            if (!recovery.isDirectory() || recovery.isSymbolicLink() || await fs.realpath(recoveryRoot) !== recoveryRoot) throw new Error('Recovery directories cannot be symbolic links.');
            const transactions = (await fs.readdir(recoveryRoot, { withFileTypes: true })).sort((a, b) => b.name.localeCompare(a.name));
            let restored = false;
            for (const entry of transactions) {
              if (!/^save-[0-9]+-[a-zA-Z0-9]+$/.test(entry.name)) continue;
              if (++recoveryVisits > MAX_ENTRIES) { warn('Some older recovery records were skipped. They remain available for manual recovery.'); break; }
              const transactionPath = path.join(recoveryRoot, entry.name);
              const recoveryPath = path.relative(this.root, transactionPath);
              let pendingNote: string | undefined;
              try {
                const transaction = await SaveRecovery.open(transactionPath, relative, validateNotePath,
                  () => this.safeParent(relative ? `${relative}/recovery.md` : 'recovery.md'));
                if (!transaction) continue;
                pendingNote = transaction.manifest.notePath;
                if (await transaction.isComplete()) continue;
                const result = await transaction.settle(this.recoveryIO(), MAX_NOTE_BYTES);
                restored ||= result === 'restored';
                if (result === 'unverified') {
                  unverifiedNotes.add(pendingNote);
                  warn(`${pendingNote}: the current file does not match a complete recovery version and was not loaded. Manual recovery is needed; keep this file and inspect the recovery copies before restoring a version. Copies: ${recoveryPath}`);
                  continue;
                }
                warn(`${result === 'restored' ? `Recovered ${transaction.manifest.notePath}.` : `Retained recovery copies for ${transaction.manifest.notePath}.`} Copies: ${recoveryPath}`);
              } catch (error) {
                if (pendingNote) unverifiedNotes.add(pendingNote);
                warn(`${recoveryPath}: ${error instanceof Error ? error.message : 'Recovery needs manual attention.'}${pendingNote ? ` ${pendingNote} was not loaded; manual recovery is needed. Keep this file and inspect these recovery copies before restoring a version.` : ''}`);
              }
            }
            if (restored) entries = (await fs.readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name));
          } catch (error) { warn(`${relative || 'Notebook'}: ${error instanceof Error ? error.message : 'Recovery records could not be read.'}`); }
        }
        for (const entry of entries) {
          if (stopped) return;
          if (++visited > MAX_ENTRIES) { warn(`Notebook scan stopped after ${MAX_ENTRIES.toLocaleString()} entries.`); stopped = true; return; }
          if (ignoredDirectory(entry.name)) continue;
          const notePath = relative ? `${relative}/${entry.name}` : entry.name;
          if (unverifiedNotes.has(notePath)) continue;
          if (entry.isSymbolicLink()) { warn(`${notePath}: symbolic links are skipped.`); continue; }
          if (entry.isDirectory()) {
            try { await visit(notePath, depth + 1); } catch { warn(`${notePath}: this folder could not be read.`); }
          } else if (entry.isFile() && markdownExtension.test(entry.name)) {
            if (notes.length >= MAX_NOTES) { warn(`Only the first ${MAX_NOTES.toLocaleString()} notes are loaded.`); stopped = true; return; }
            try {
              validateNotePath(notePath);
              const snapshot = await this.readSnapshot(notePath);
              if (totalBytes + snapshot.size > MAX_WORKSPACE_BYTES) { warn('Notebook content reached the 64 MB limit. Some notes were skipped.'); stopped = true; return; }
              totalBytes += snapshot.size;
              notes.push(snapshot.note);
              this.snapshots.set(notePath, snapshot);
              seen.add(notePath);
            } catch (error) { warn(`${notePath}: ${error instanceof Error ? error.message : 'This note could not be read.'}`); }
          }
        }
      };
      await visit('', 0);
      await this.assertRoot();
      for (const key of this.snapshots.keys()) if (!seen.has(key)) this.snapshots.delete(key);
      return { name: path.basename(this.root), path: this.root, notes, warnings };
    });
  }

  save(value: unknown, content: unknown, expectedModified: unknown): Promise<Note> {
    return this.serialize(async () => {
      const notePath = validateNotePath(value);
      if (typeof content !== 'string' || Buffer.byteLength(content, 'utf8') > MAX_NOTE_BYTES) throw new Error('A note can contain up to 2 MB of UTF-8 text.');
      if (typeof expectedModified !== 'number' || !Number.isFinite(expectedModified)) throw new Error('Refresh this note before saving.');
      const expected = this.snapshots.get(notePath);
      if (!expected || expected.note.modified !== expectedModified) throw new Error('This note changed since you opened it. Your draft is safe. Refresh before trying again.');
      const diskContent = expected.hasBOM ? `\ufeff${content}` : content;
      if (Buffer.byteLength(diskContent, 'utf8') > MAX_NOTE_BYTES) throw new Error('A note can contain up to 2 MB of UTF-8 text.');
      const current = await this.readSnapshot(notePath);
      if (!sameFile(expected, current)) throw new Error('This note was changed by another application. Your draft is safe; copy it before refreshing.');
      const parent = await this.safeParent(notePath);
      const transaction = await SaveRecovery.prepare(parent, notePath, diskContent, expected.hash,
        () => this.safeParent(notePath));
      const recoveryPath = path.relative(this.root, transaction.directory);
      const capturedPath = path.relative(this.root, transaction.original).split(path.sep).join('/');
      try {
        await transaction.capture(this.recoveryIO());
        const captured = await this.readSnapshot(capturedPath);
        if (!sameFile(expected, captured)) throw new Error('This note changed during saving. The external version was preserved.');
        await transaction.publish(this.recoveryIO());
        if (!sameFile(expected, await this.readSnapshot(capturedPath))) throw new Error('Another application changed the captured note during saving. Both versions were preserved.');
        const saved = await this.readSnapshot(notePath);
        if (saved.hash !== transaction.manifest.draftHash) throw new Error('Another application changed the note immediately after saving.');
        await transaction.complete();
        this.snapshots.set(notePath, saved);
        return saved.note;
      } catch (error) {
        let recoveryWarning = '';
        try {
          const settled = await transaction.settle(this.recoveryIO(), MAX_NOTE_BYTES);
          if (settled === 'unverified') recoveryWarning = ' The current file could not be verified. Manual recovery is needed; keep it and inspect the recovery copies before restoring a version.';
          if (settled === 'restored') {
            // Keep the renderer's version usable when only our restoration changed the inode.
            const captured = await this.readSnapshot(capturedPath);
            const restored = await this.readSnapshot(notePath);
            if (sameFile(expected, captured) && restored.hash === expected.hash && restored.size === expected.size) {
              restored.note.modified = expected.note.modified;
              this.snapshots.set(notePath, restored);
            }
          }
        }
        catch { recoveryWarning = ' Automatic restoration could not finish; reopen the notebook to retry.'; }
        const reason = error instanceof Error ? error.message : 'The note could not be saved.';
        throw new Error(`${reason} Your draft is safe. Recovery copies: ${recoveryPath}.${recoveryWarning}`, { cause: error });
      }
    });
  }

  create(value: unknown, initialContent?: string): Promise<Note> {
    return this.serialize(async () => {
      const notePath = validateNotePath(value, true);
      if (this.snapshots.size >= MAX_NOTES) throw new Error(`A notebook can load up to ${MAX_NOTES.toLocaleString()} notes.`);
      const title = path.basename(notePath, path.extname(notePath));
      const content = initialContent === undefined ? `# ${title}\n\n` : initialContent;
      if (typeof content !== 'string' || Buffer.byteLength(content, 'utf8') > MAX_NOTE_BYTES) throw new Error('A note can contain up to 2 MB of UTF-8 text.');
      const parent = await this.safeParent(notePath, true);
      const target = path.join(parent, path.basename(notePath));
      const temporary = path.join(parent, `.prism-${randomUUID()}.tmp`);
      try {
        const handle = await fs.open(temporary, 'wx', 0o644);
        try { await handle.writeFile(content, 'utf8'); await handle.sync(); } finally { await handle.close(); }
        await this.safeParent(notePath);
        try {
          try { await this.createIO.link(temporary, target); }
          catch (error) {
            if (!unsupportedHardLink.has(codeOf(error) || '')) throw error;
            await this.safeParent(notePath);
            // FAT/exFAT and some network shares cannot publish with a hard link.
            // Exclusive copying still refuses every existing destination.
            await this.createIO.copyFile(temporary, target, constants.COPYFILE_EXCL);
          }
        }
        catch (error) {
          if (codeOf(error) === 'EEXIST') throw new Error('A note already exists at that path. Choose another name.');
          throw error;
        }
        const created = await this.readSnapshot(notePath);
        this.snapshots.set(notePath, created);
        return created.note;
      } finally { await fs.unlink(temporary).catch(() => undefined); }
    });
  }
}

const starterNotes: Record<string, string> = {
  'Welcome to Prism.md': `# Welcome to Prism\n\nA little space for a clearer mind.\n\nPrism is your personal notebook: plain Markdown files, connected ideas, and room to think. Start writing here, or open a folder you already call home.\n\n## Make yourself at home\n\n- **Write your way.** Choose Source, Split, or Read from the toolbar.\n- **Follow a thought.** Link a note with \`[[Connected thinking]]\` and watch your graph grow.\n- **Let the world in.** Turn on transparent mode to see the windows behind Prism.\n- **Keep it yours.** Your notebook lives in ordinary files on your computer.\n\n> A note doesn't need to be finished to be worth keeping.\n\n## A few places to begin\n\nExplore [[Connected thinking]] to see how ideas find each other, take a quick tour of [[Writing in Markdown]], or plant a thought in [[Ideas/Small beginnings|Small beginnings]].\n\n## Today's intention\n\n- [x] Find a quiet place to think\n- [ ] Capture one interesting idea\n- [ ] Connect it to something I already know\n\n---\n\n*Good things begin with a blank page.*\n`,
  'Connected thinking.md': `# Connected thinking\n\nIdeas rarely arrive in a straight line. A thought from this morning might find its other half in a note from last week.\n\n## Give ideas a way to meet\n\nType two square brackets around a note's name: \`[[Welcome to Prism]]\`. Prism connects the two notes and makes the link clickable.\n\nYou can give a link a different label with \`[[Ideas/Small beginnings|a tiny first step]]\`.\n\n## Look at the bigger picture\n\nOpen **Graph** to see the connections in your notebook. Each dot is a note; each line is a thought reaching toward another. Select a dot to open its note.\n\nTry connecting [[Writing in Markdown]] with [[Ideas/Small beginnings]]. A little cluster becomes a map of what matters to you.\n\n> The value of a notebook grows in the space between its pages.\n\nReturn to [[Welcome to Prism]].\n`,
  'Writing in Markdown.md': `# Writing in Markdown\n\nMarkdown keeps the focus on your words. A few small marks add just enough structure.\n\n## The essentials\n\nUse **bold** for emphasis, *italics* for a softer voice, and \`inline code\` for something precise.\n\n### Make a list\n\n- Something you noticed\n- A question worth keeping\n- A thought to return to\n\n### Take one step at a time\n\n1. Write down the thought.\n2. Give it a useful name.\n3. Connect it to [[Connected thinking]].\n\n### Keep track\n\n- [x] Open a new notebook\n- [ ] Write something of your own\n\n### A little structure\n\n| When | What |\n| --- | --- |\n| Morning | Capture an idea |\n| Evening | Find a connection |\n\n\`\`\`javascript\nconst thought = 'Start small, keep going.';\nconsole.log(thought);\n\`\`\`\n\n> Clarity is a kindness to your future self.\n\nReady to write? Try [[Ideas/Small beginnings]] or head back to [[Welcome to Prism]].\n`,
  'Ideas/Small beginnings.md': `# Small beginnings\n\nA place for thoughts that aren't quite ready yet.\n\n## What if…\n\n- A notebook felt like a window instead of a wall?\n- Every interesting question had a place to land?\n- Small, daily notes quietly became something larger?\n\n## A seed to keep\n\nThe best system is the one that makes it easy to begin. Today, one sentence is enough.\n\nTry [[Writing in Markdown]] when your idea needs a little shape. Add a link to [[Connected thinking]] when it finds a friend.\n\n[[Welcome to Prism|Back to the beginning]]\n`,
};

interface StarterNotebookIO {
  mkdir(directory: string, options?: { recursive: boolean }): Promise<unknown>;
  mkdtemp(prefix: string): Promise<string>;
  lstat(file: string): Promise<Stats>;
  realpath(file: string): Promise<string>;
  writeFile(file: string, content: string, options: { encoding: 'utf8'; flag: 'wx'; flush: true }): Promise<void>;
  rename(source: string, destination: string): Promise<void>;
  symlink(target: string, link: string, type: 'dir'): Promise<void>;
  rm(directory: string, options: { recursive: true; force: true }): Promise<void>;
  rmdir(directory: string): Promise<void>;
}

/** Publish a complete starter notebook; existing notebooks are never reseeded. */
export async function ensureStarterNotebook(userData: string, io: StarterNotebookIO = fs): Promise<string> {
  await io.mkdir(userData, { recursive: true });
  const directory = path.join(userData, 'Prism notebook');
  const destinationExists = async () => {
    try { await io.lstat(directory); return true; }
    catch (error) { if (codeOf(error) === 'ENOENT') return false; throw error; }
  };
  if (await destinationExists()) return directory;

  // Interrupted launches leave only a private staging directory; retries start afresh.
  const container = await io.mkdtemp(path.join(userData, '.prism-notebook-'));
  // POSIX keeps the complete notebook behind an exclusively created root alias.
  // The nested name keeps the canonical workspace name friendly after realpath().
  const staging = process.platform === 'win32' ? container : path.join(container, 'Prism notebook');
  let identity: Pick<Stats, 'ino' | 'dev'> | undefined;
  let published = false;
  try {
    identity = await io.lstat(container);
    if (staging !== container) await io.mkdir(staging);
    await io.mkdir(path.join(staging, 'Ideas'));
    for (const [name, content] of Object.entries(starterNotes)) {
      await io.writeFile(path.join(staging, name), content, { encoding: 'utf8', flag: 'wx', flush: true });
    }
    if (await destinationExists()) return directory;
    try {
      // Windows MoveFileEx rejects existing directories, including empty ones.
      // POSIX rename can replace an empty directory, so publish an exclusive alias.
      if (process.platform === 'win32') await io.rename(staging, directory);
      else await io.symlink(path.relative(userData, staging), directory, 'dir');
    }
    catch (error) {
      const code = codeOf(error) || '';
      const aliasUnsupported = process.platform !== 'win32'
        && ['EPERM', 'EACCES', 'EOPNOTSUPP', 'ENOTSUP', 'ENOSYS'].includes(code);
      // Another creator may claim the destination after the preceding check.
      if ((aliasUnsupported || ['EEXIST', 'ENOTEMPTY', 'EPERM', 'EACCES'].includes(code)) && await destinationExists()) return directory;
      if (aliasUnsupported) {
        // Startup persists this complete folder before exposing it to the editor.
        // A crash before persistence leaves only an unused, complete notebook.
        const fallback = await io.realpath(staging);
        published = true;
        return fallback;
      }
      throw error;
    }
    published = true;
    return directory;
  } finally {
    if (!published) {
      try {
        if (!identity) await io.rmdir(container);
        else {
          const current = await io.lstat(container);
          if (current.isDirectory() && current.ino === identity.ino && current.dev === identity.dev) {
            await io.rm(container, { recursive: true, force: true });
          }
        }
      } catch { /* Cleanup never hides the original error or removes the final notebook. */ }
    }
  }
}
