import { createHash, randomUUID } from 'node:crypto';
import { constants, type Stats } from 'node:fs';
import * as fs from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import path from 'node:path';
import type { DocumentPatch, ImportResult, LibrarySnapshot, PDFDocument, PDFFolder } from '../shared/types';
import { baseArxivId, normalizeArxivId } from '../../../src/shared/arxiv';

export const MAX_PDF_BYTES = 100 * 1024 * 1024;
export const MAX_DOCUMENTS = 2_000;
export const MAX_FOLDERS = 200;
const MAX_CATALOG_BYTES = 8 * 1024 * 1024;
const MAX_IMPORT_BATCH = 100;
const idPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const hashPattern = /^[a-f0-9]{64}$/;
const controls = /[\u0000-\u001f\u007f-\u009f]/;
const documentKeys = ['id', 'title', 'filename', 'size', 'sha256', 'importedAt', 'updatedAt', 'tags', 'favorite', 'lastOpenedAt', 'lastPage', 'pageCount'];
interface Catalog { version: 1 | 2; documents: PDFDocument[]; folders: PDFFolder[] }

export interface ArxivImportMetadata { arxivId: string; title: string; tags: string[] }
export interface ArxivImportResult { document: PDFDocument; duplicate: boolean; warning?: string }
export interface DownloadedPDFImport { filename: string; bytes: Uint8Array }
export interface DownloadedPDFImportResult { document: PDFDocument; duplicate: boolean }

/** Narrow filesystem seam for deterministic write/publication failure tests. */
export interface LibraryWriteIO {
  createFile(filename: string): Promise<FileHandle>;
  rename(source: string, destination: string): Promise<void>;
}
const defaultWriteIO: LibraryWriteIO = {
  createFile: filename => fs.open(filename, constants.O_CREAT | constants.O_EXCL | constants.O_RDWR, 0o600),
  rename: fs.rename,
};

function digest(bytes: Uint8Array): string { return createHash('sha256').update(bytes).digest('hex'); }
function message(error: unknown): string { return error instanceof Error ? error.message : 'An unexpected filesystem error occurred.'; }
function sameFile(left: Stats, right: Stats): boolean { return left.dev === right.dev && left.ino === right.ino; }
function object(value: unknown): value is Record<string, unknown> { return !!value && typeof value === 'object' && !Array.isArray(value); }
function text(value: unknown, limit: number): value is string { return typeof value === 'string' && value.length > 0 && value.length <= limit && value.trim() === value && !controls.test(value); }
function timestamp(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  try { return new Date(value).toISOString() === value; } catch { return false; }
}
function page(value: unknown): value is number { return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1 && value <= 1_000_000; }
function validTagShape(value: unknown): value is string[] {
  return Array.isArray(value) && value.length <= 12 && value.every(tag => text(tag, 40));
}
function validTags(value: unknown): value is string[] {
  return validTagShape(value)
    && new Set(value.map(tag => tag.toLowerCase())).size === value.length;
}
function validFolderName(value: unknown): value is string {
  return text(value, 80) && value.normalize('NFC') === value && value !== '.' && value !== '..' && !/[\\/]/.test(value);
}
function folderName(value: unknown): string {
  if (typeof value !== 'string' || controls.test(value)) throw new Error('Use a folder name between 1 and 80 characters without slashes.');
  const name = value.normalize('NFC').trim();
  if (!validFolderName(name)) throw new Error('Use a folder name between 1 and 80 characters without slashes.');
  return name;
}
function validFolder(value: unknown): value is PDFFolder {
  return object(value) && Object.keys(value).length === 2 && typeof value.id === 'string'
    && idPattern.test(value.id) && validFolderName(value.name);
}
function validDocument(value: unknown): value is PDFDocument {
  if (!object(value) || !documentKeys.every(key => Object.hasOwn(value, key))
    || Object.keys(value).some(key => !documentKeys.includes(key) && key !== 'arxivId' && key !== 'folderId')
    || (Object.hasOwn(value, 'folderId') && (typeof value.folderId !== 'string' || !idPattern.test(value.folderId)))
    || (Object.hasOwn(value, 'arxivId') && (typeof value.arxivId !== 'string' || normalizeArxivId(value.arxivId) !== value.arxivId))) return false;
  return typeof value.id === 'string' && idPattern.test(value.id) && text(value.title, 200)
    && text(value.filename, 255) && !/[\\/]/.test(value.filename) && /\.pdf$/i.test(value.filename)
    && typeof value.size === 'number' && Number.isSafeInteger(value.size) && value.size >= 8 && value.size <= MAX_PDF_BYTES
    && typeof value.sha256 === 'string' && hashPattern.test(value.sha256)
    && timestamp(value.importedAt) && timestamp(value.updatedAt) && validTags(value.tags)
    && typeof value.favorite === 'boolean' && (value.lastOpenedAt === null || timestamp(value.lastOpenedAt))
    && page(value.lastPage) && (value.pageCount === null || page(value.pageCount))
    && (value.pageCount === null || value.lastPage <= value.pageCount);
}

function parseCatalog(bytes: Uint8Array): Catalog {
  const corrupt = () => new Error('The PDF catalog is damaged or unsupported. Its contents were left untouched; restore catalog.json from a backup before trying again.');
  let value: unknown;
  try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); } catch { throw corrupt(); }
  if (!object(value) || ![1, 2].includes(value.version as number) || !Array.isArray(value.documents)
    || value.documents.length > MAX_DOCUMENTS) throw corrupt();
  const version = value.version as 1 | 2;
  if (Object.keys(value).length !== (version === 1 ? 2 : 3)) throw corrupt();
  const folders: PDFFolder[] = [];
  if (version === 2) {
    if (!Array.isArray(value.folders) || value.folders.length > MAX_FOLDERS || !value.folders.every(validFolder)) throw corrupt();
    folders.push(...value.folders);
    if (new Set(folders.map(folder => folder.id)).size !== folders.length
      || new Set(folders.map(folder => folder.name.toLowerCase())).size !== folders.length) throw corrupt();
  }
  const folderIds = new Set(folders.map(folder => folder.id));
  const documents: PDFDocument[] = [];
  for (const candidate of value.documents) {
    if (!object(candidate) || !validTagShape(candidate.tags)) throw corrupt();
    const originalTags = candidate.tags;
    const stableUnique = new Set(originalTags.map(tag => tag.toLowerCase())).size === originalTags.length;
    // Migration requires uniqueness under one complete legacy casing rule.
    // Ordinary duplicates are invalid in every locale and must remain errors.
    if (!stableUnique && !['tr', 'az', 'lt'].some(locale =>
      new Set(originalTags.map(tag => tag.toLocaleLowerCase(locale))).size === originalTags.length)) throw corrupt();
    // Earlier catalogs used the OS locale for uniqueness. Normalize collisions
    // in memory, preserving the first spelling; the next normal write persists
    // this form. Check original bounds first and retain original bytes on disk.
    const seen = new Set<string>();
    const tags = candidate.tags.filter(tag => {
      const folded = tag.toLowerCase();
      if (seen.has(folded)) return false;
      seen.add(folded);
      return true;
    });
    const document = { ...candidate, tags };
    if (!validDocument(document) || (Object.hasOwn(document, 'folderId')
      && (version !== 2 || !folderIds.has(document.folderId!)))) throw corrupt();
    documents.push(document);
  }
  const sources = documents.filter(document => document.arxivId).map(document => baseArxivId(document.arxivId));
  if (new Set(documents.map(document => document.id)).size !== documents.length
    || new Set(documents.map(document => document.sha256)).size !== documents.length
    || new Set(sources).size !== sources.length) throw corrupt();
  return { version, documents, folders };
}

/** Read from one checked handle, bounded even if another process grows the file. */
async function readRegularFile(filename: string, limit: number): Promise<Buffer> {
  const before = await fs.lstat(filename);
  if (!before.isFile() || before.isSymbolicLink()) throw new Error('Only ordinary files can be opened; symbolic links are not imported.');
  if (before.size > limit) throw new Error(`The file is larger than the ${Math.round(limit / 1024 / 1024)} MB limit.`);
  const handle = await fs.open(filename, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || !sameFile(before, opened) || opened.size !== before.size || opened.size > limit) throw new Error('The file changed while it was being opened. Try again.');
    const bytes = Buffer.alloc(opened.size);
    let offset = 0;
    while (offset < bytes.length) {
      const result = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (result.bytesRead === 0) throw new Error('The file changed while it was being read. Try again.');
      offset += result.bytesRead;
    }
    const extra = await handle.read(Buffer.alloc(1), 0, 1, bytes.length);
    const after = await handle.stat();
    if (extra.bytesRead || after.size !== opened.size || after.mtimeMs !== opened.mtimeMs || after.ctimeMs !== opened.ctimeMs) throw new Error('The file changed while it was being read. Try again.');
    return bytes;
  } finally { await handle.close(); }
}

export class LibraryStore {
  readonly root: string;
  private readonly filesDirectory: string;
  private readonly catalogPath: string;
  private readonly rootIdentity: Stats;
  private readonly filesIdentity: Stats;
  private documents: PDFDocument[];
  private folders: PDFFolder[];
  private catalogVersion: 1 | 2;
  private catalogHash: string | null;
  private operations: Promise<unknown> = Promise.resolve();
  private readonly writeIO: LibraryWriteIO;

  private constructor(root: string, rootIdentity: Stats, filesIdentity: Stats, catalog: Catalog, catalogHash: string | null, writeIO: LibraryWriteIO,
    private readonly checkOwnership: () => Promise<void>) {
    this.root = root;
    this.filesDirectory = path.join(root, 'documents');
    this.catalogPath = path.join(root, 'catalog.json');
    this.rootIdentity = rootIdentity;
    this.filesIdentity = filesIdentity;
    this.documents = catalog.documents;
    this.folders = catalog.folders;
    this.catalogVersion = catalog.version;
    this.catalogHash = catalogHash;
    this.writeIO = writeIO;
  }

  static async open(directory: string, writeIO: Partial<LibraryWriteIO> = {}, checkOwnership: () => Promise<void> = async () => undefined): Promise<LibraryStore> {
    await checkOwnership();
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    const original = await fs.lstat(directory);
    if (!original.isDirectory() || original.isSymbolicLink()) throw new Error('The PDF library folder must be an ordinary directory.');
    const root = await fs.realpath(directory);
    const filesDirectory = path.join(root, 'documents');
    await fs.mkdir(filesDirectory, { mode: 0o700 }).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; });
    const filesIdentity = await fs.lstat(filesDirectory);
    if (!filesIdentity.isDirectory() || filesIdentity.isSymbolicLink()) throw new Error('The PDF documents folder must be an ordinary directory.');
    let bytes: Buffer | null = null;
    try { bytes = await readRegularFile(path.join(root, 'catalog.json'), MAX_CATALOG_BYTES); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    return new LibraryStore(root, await fs.stat(root), filesIdentity, bytes ? parseCatalog(bytes) : { version: 1, documents: [], folders: [] }, bytes ? digest(bytes) : null,
      { ...defaultWriteIO, ...writeIO }, checkOwnership);
  }

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operations.then(operation);
    this.operations = result.catch(() => undefined);
    return result;
  }

  private async checkDirectories(): Promise<void> {
    await this.checkOwnership();
    const [root, files] = await Promise.all([fs.lstat(this.root), fs.lstat(this.filesDirectory)]);
    if (!root.isDirectory() || root.isSymbolicLink() || !sameFile(root, this.rootIdentity)
      || !files.isDirectory() || files.isSymbolicLink() || !sameFile(files, this.filesIdentity)) {
      throw new Error('The PDF library folder changed. Reopen the application before continuing.');
    }
  }

  private async checkCatalog(): Promise<void> {
    await this.checkDirectories();
    let current: Buffer | null = null;
    try { current = await readRegularFile(this.catalogPath, MAX_CATALOG_BYTES); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    if ((current ? digest(current) : null) !== this.catalogHash) throw new Error('The PDF catalog changed outside this application. Reopen Prism PDF to load it safely.');
  }

  private async snapshot(): Promise<LibrarySnapshot> {
    const warnings: string[] = [];
    for (const document of this.documents) {
      try {
        const file = await fs.lstat(path.join(this.filesDirectory, `${document.id}.pdf`));
        if (!file.isFile() || file.isSymbolicLink() || file.size !== document.size) warnings.push(`${document.filename}: its managed copy is unavailable or changed.`);
      } catch { warnings.push(`${document.filename}: its managed copy is unavailable.`); }
    }
    return { documents: this.documents.map(document => ({ ...document, tags: [...document.tags] })),
      folders: this.folders.map(folder => ({ ...folder })), warnings };
  }

  private lookup(id: unknown): PDFDocument {
    if (typeof id !== 'string' || !idPattern.test(id)) throw new Error('Unknown PDF document.');
    const document = this.documents.find(candidate => candidate.id === id);
    if (!document) throw new Error('Unknown PDF document.');
    return document;
  }

  private lookupFolder(id: unknown): PDFFolder {
    if (typeof id !== 'string' || !idPattern.test(id)) throw new Error('Unknown PDF folder.');
    const folder = this.folders.find(candidate => candidate.id === id);
    if (!folder) throw new Error('Unknown PDF folder.');
    return folder;
  }

  private uniqueFolderName(value: unknown, exceptId?: string): string {
    const name = folderName(value);
    if (this.folders.some(folder => folder.id !== exceptId && folder.name.toLowerCase() === name.toLowerCase())) {
      throw new Error('A folder with this name already exists. Choose another name.');
    }
    return name;
  }

  /** Remove only an unpublished file still owned by this handle with our bytes. */
  private async discardUnpublished(filename: string, handle: FileHandle, expected: Uint8Array, documentId?: string): Promise<boolean> {
    try {
      await this.checkDirectories();
      if (documentId) {
        // A failed/uncertain rename or an external catalog edit may already refer
        // to this PDF. Unknown or damaged catalog contents must retain its copy.
        let catalog: Buffer | null = null;
        try { catalog = await readRegularFile(this.catalogPath, MAX_CATALOG_BYTES); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
        if (catalog && parseCatalog(catalog).documents.some(document => document.id === documentId)) return false;
      }
      const owned = await handle.stat();
      let named: Stats;
      try { named = await fs.lstat(filename); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true; throw error; }
      if (!owned.isFile() || !named.isFile() || named.isSymbolicLink() || !sameFile(owned, named)
        || owned.size > expected.length) return false;
      // A short write contains a prefix of the import. Preserve external edits
      // to the same inode as well as replacements with another inode.
      const chunk = Buffer.alloc(Math.min(64 * 1024, owned.size));
      let offset = 0;
      while (offset < owned.size) {
        const { bytesRead } = await handle.read(chunk, 0, Math.min(chunk.length, owned.size - offset), offset);
        if (!bytesRead || !chunk.subarray(0, bytesRead).equals(expected.subarray(offset, offset + bytesRead))) return false;
        offset += bytesRead;
      }
      const after = await handle.stat();
      await this.checkDirectories();
      const current = await fs.lstat(filename);
      if (!current.isFile() || current.isSymbolicLink() || !sameFile(owned, after) || !sameFile(owned, current)
        || after.size !== owned.size || after.mtimeMs !== owned.mtimeMs || after.ctimeMs !== owned.ctimeMs
        || current.size !== owned.size || current.mtimeMs !== owned.mtimeMs || current.ctimeMs !== owned.ctimeMs) return false;
      // Node has no conditional unlink-by-inode API: the documented directory/
      // pathname race remains. These checks avoid deleting observed replacements.
      await fs.unlink(filename);
      return true;
    } catch { return false; }
  }

  private async failedPublication(error: unknown, filename: string, handle: FileHandle, expected: Uint8Array, documentId?: string): Promise<Error> {
    const removed = await this.discardUnpublished(filename, handle, expected, documentId);
    return new Error(message(error) + (removed ? '' : ' A file was retained for recovery at ' + filename + '.'));
  }

  private async commit(documents: PDFDocument[], folders = this.folders, version = this.catalogVersion): Promise<void> {
    await this.checkCatalog();
    const catalog = version === 1 ? { version, documents } : { version, documents, folders };
    const bytes = Buffer.from(JSON.stringify(catalog, null, 2) + '\n');
    if (bytes.length > MAX_CATALOG_BYTES) throw new Error('The PDF catalog has reached its size limit.');
    const temporary = path.join(this.root, `.catalog-${randomUUID()}.tmp`);
    const hash = digest(bytes);
    const handle = await this.writeIO.createFile(temporary);
    try {
      await handle.writeFile(bytes);
      await handle.sync();
      await this.checkCatalog();
      await this.writeIO.rename(temporary, this.catalogPath);
      this.catalogHash = hash;
      this.documents = documents;
      this.folders = folders;
      this.catalogVersion = version;
    } catch (error) {
      throw await this.failedPublication(error, temporary, handle, bytes);
    } finally {
      // A successful, flushed publication stays successful even if releasing the
      // descriptor fails. Callers must never roll it back after catalog commit.
      await handle.close().catch(() => undefined);
    }
  }

  load(): Promise<LibrarySnapshot> {
    return this.serialize(async () => {
      await this.checkCatalog();
      return this.snapshot();
    });
  }

  createFolder(value: unknown): Promise<LibrarySnapshot> {
    return this.serialize(async () => {
      await this.checkCatalog();
      const name = this.uniqueFolderName(value);
      if (this.folders.length >= MAX_FOLDERS) throw new Error(`The library can contain up to ${MAX_FOLDERS} folders.`);
      await this.commit(this.documents, [...this.folders, { id: randomUUID(), name }], 2);
      return this.snapshot();
    });
  }

  renameFolder(id: unknown, value: unknown): Promise<LibrarySnapshot> {
    return this.serialize(async () => {
      await this.checkCatalog();
      const folder = this.lookupFolder(id);
      const name = this.uniqueFolderName(value, folder.id);
      if (folder.name !== name) await this.commit(this.documents, this.folders.map(candidate => candidate.id === folder.id ? { ...candidate, name } : candidate));
      return this.snapshot();
    });
  }

  removeFolder(id: unknown): Promise<LibrarySnapshot> {
    return this.serialize(async () => {
      await this.checkCatalog();
      const folder = this.lookupFolder(id);
      const now = new Date().toISOString();
      const documents = this.documents.map(document => {
        if (document.folderId !== folder.id) return document;
        const updated = { ...document, updatedAt: now };
        delete updated.folderId;
        return updated;
      });
      await this.commit(documents, this.folders.filter(candidate => candidate.id !== folder.id));
      return this.snapshot();
    });
  }

  import(paths: readonly string[]): Promise<ImportResult> {
    return this.serialize(async () => {
      if (!Array.isArray(paths) || paths.length > MAX_IMPORT_BATCH || paths.some(filename => typeof filename !== 'string')) throw new Error('Import up to 100 PDF files at a time.');
      await this.checkCatalog();
      const importedIds: string[] = [];
      const errors: string[] = [];
      let duplicateCount = 0;
      for (const source of paths) {
        const filename = path.basename(source);
        try {
          if (!text(filename, 255) || !/\.pdf$/i.test(filename) || /[\\/]/.test(filename)) throw new Error('Choose a file with a .pdf extension and an ordinary filename.');
          const bytes = await readRegularFile(source, MAX_PDF_BYTES);
          if (!/^%PDF-\d\.\d/.test(bytes.subarray(0, 8).toString('ascii'))) throw new Error('The file does not have a valid PDF header.');
          const sha256 = digest(bytes);
          const duplicate = this.documents.find(document => document.sha256 === sha256);
          if (duplicate) {
            try { await this.bytes(duplicate); }
            catch { throw new Error('The existing library copy is missing or changed. Remove its library entry, then import this PDF again.'); }
            duplicateCount++;
            continue;
          }
          if (this.documents.length >= MAX_DOCUMENTS) throw new Error(`The library can contain up to ${MAX_DOCUMENTS.toLocaleString()} PDFs.`);
          await this.checkCatalog();
          const id = randomUUID();
          const destination = path.join(this.filesDirectory, `${id}.pdf`);
          const output = await this.writeIO.createFile(destination);
          try {
            await output.writeFile(bytes);
            await output.sync();
            const now = new Date().toISOString();
            const document: PDFDocument = {
              id, title: filename.replace(/\.pdf$/i, '').slice(0, 200).trim() || 'Untitled PDF', filename,
              size: bytes.length, sha256, importedAt: now, updatedAt: now, tags: [], favorite: false,
              lastOpenedAt: null, lastPage: 1, pageCount: null,
            };
            await this.commit([...this.documents, document]);
            importedIds.push(id);
          } catch (error) {
            throw await this.failedPublication(error, destination, output, bytes, id);
          } finally {
            await output.close().catch(() => undefined);
          }
        } catch (error) { errors.push(`${filename}: ${message(error)}`); }
      }
      return { library: await this.snapshot(), importedIds, duplicateCount, errors };
    });
  }

  /** Publish downloaded bytes without persisting the source URL or changing duplicates. */
  importDownloaded(input: DownloadedPDFImport): Promise<DownloadedPDFImportResult> {
    return this.serialize(async () => {
      if (!object(input) || !text(input.filename, 255) || /[\\/:*?"<>|]/.test(input.filename)
        || !/\.pdf$/i.test(input.filename)) throw new Error('The downloaded PDF filename is invalid.');
      if (!(input.bytes instanceof Uint8Array) || input.bytes.byteLength < 8
        || input.bytes.byteLength > MAX_PDF_BYTES) throw new Error('The downloaded PDF must be between 8 bytes and 100 MB.');
      const filename = input.filename;
      const bytes = Buffer.from(input.bytes);
      if (!/^%PDF-\d\.\d/.test(bytes.subarray(0, 8).toString('ascii'))) throw new Error('The download does not have a valid PDF header.');
      await this.checkCatalog();
      const sha256 = digest(bytes);
      const duplicate = this.documents.find(document => document.sha256 === sha256);
      if (duplicate) {
        try { await this.bytes(duplicate); }
        catch { throw new Error('The existing library copy is missing or changed. Remove its library entry, then import this paper again.'); }
        await this.checkCatalog();
        return { document: { ...duplicate, tags: [...duplicate.tags] }, duplicate: true };
      }
      if (this.documents.length >= MAX_DOCUMENTS) throw new Error(`The library can contain up to ${MAX_DOCUMENTS.toLocaleString()} PDFs.`);
      const id = randomUUID();
      const destination = path.join(this.filesDirectory, `${id}.pdf`);
      const output = await this.writeIO.createFile(destination);
      try {
        await output.writeFile(bytes);
        await output.sync();
        const now = new Date().toISOString();
        const document: PDFDocument = {
          id, filename, title: filename.replace(/\.pdf$/i, '').slice(0, 200).trim() || 'Untitled PDF',
          size: bytes.length, sha256, importedAt: now, updatedAt: now,
          tags: [], favorite: false, lastOpenedAt: null, lastPage: 1, pageCount: null,
        };
        await this.commit([...this.documents, document]);
        return { document: { ...document, tags: [...document.tags] }, duplicate: false };
      } catch (error) {
        throw await this.failedPublication(error, destination, output, bytes, id);
      } finally { await output.close().catch(() => undefined); }
    });
  }

  /** Import a trusted downloader result while retaining ownership and write order. */
  importArxiv(input: ArxivImportMetadata, download: () => Promise<Uint8Array>): Promise<ArxivImportResult> {
    return this.serialize(async () => {
      const arxivId = object(input) ? normalizeArxivId(input.arxivId) : null;
      if (!arxivId || typeof download !== 'function') throw new Error('Choose a valid arXiv paper.');
      if (typeof input.title !== 'string' || !text(input.title.trim(), 500)) throw new Error('The paper title is missing or invalid.');
      if (!Array.isArray(input.tags) || input.tags.length > 30
        || input.tags.some(tag => typeof tag !== 'string' || !text(tag.trim(), 100))) throw new Error('The paper topics are invalid.');
      const title = input.title.trim().slice(0, 200).trim();
      const requestedTags = input.tags.map(tag => tag.trim().slice(0, 40).trim())
        .filter((tag, index, tags) => tags.findIndex(other => other.toLowerCase() === tag.toLowerCase()) === index);
      const mergeTags = (existing: string[]) => {
        const combined = [...existing];
        for (const tag of requestedTags) if (!combined.some(other => other.toLowerCase() === tag.toLowerCase())) combined.push(tag);
        return { tags: combined.slice(0, 12), truncated: combined.length > 12 };
      };
      const tagWarning = 'Only the first 12 tags fit in the PDF library.';
      const reuse = async (document: PDFDocument): Promise<ArxivImportResult> => {
        try { await this.bytes(document); }
        catch { throw new Error('The existing library copy is missing or changed. Remove its library entry, then import this paper again.'); }
        await this.checkCatalog();
        const { tags, truncated } = mergeTags(document.tags);
        // A hash match can connect a previously local PDF to its source, but a
        // different saved source or version must never be silently rewritten.
        const source = document.arxivId ?? arxivId;
        const changed = source !== document.arxivId || tags.length !== document.tags.length;
        const updated = changed ? { ...document, arxivId: source, tags, updatedAt: new Date().toISOString() } : document;
        if (changed) await this.commit(this.documents.map(candidate => candidate.id === document.id ? updated : candidate));
        const warnings = [
          ...(truncated ? [tagWarning] : []),
          ...(source !== arxivId ? [`Reused the saved PDF for arXiv ${source}; its source and contents were preserved.`] : []),
        ];
        return { document: { ...updated, tags: [...updated.tags] }, duplicate: true,
          ...(warnings.length ? { warning: warnings.join(' ') } : {}) };
      };

      await this.checkCatalog();
      const existing = this.documents.find(document => document.arxivId && baseArxivId(document.arxivId) === baseArxivId(arxivId));
      if (existing) return reuse(existing);
      const downloaded = await download();
      if (!(downloaded instanceof Uint8Array) || downloaded.byteLength < 8
        || downloaded.byteLength > MAX_PDF_BYTES) throw new Error('The downloaded PDF must be between 8 bytes and 100 MB.');
      const bytes = Buffer.from(downloaded);
      if (!/^%PDF-\d\.\d/.test(bytes.subarray(0, 8).toString('ascii'))) throw new Error('The download does not have a valid PDF header.');
      await this.checkCatalog();
      const sha256 = digest(bytes);
      const duplicate = this.documents.find(document => document.sha256 === sha256);
      if (duplicate) return reuse(duplicate);
      if (this.documents.length >= MAX_DOCUMENTS) throw new Error(`The library can contain up to ${MAX_DOCUMENTS.toLocaleString()} PDFs.`);
      const id = randomUUID();
      const filename = `arxiv-${arxivId.replace('/', '-')}.pdf`;
      const destination = path.join(this.filesDirectory, `${id}.pdf`);
      const output = await this.writeIO.createFile(destination);
      const { tags, truncated } = mergeTags([]);
      try {
        await output.writeFile(bytes);
        await output.sync();
        const now = new Date().toISOString();
        const document: PDFDocument = {
          id, title, filename, arxivId, size: bytes.length, sha256, importedAt: now, updatedAt: now,
          tags, favorite: false, lastOpenedAt: null, lastPage: 1, pageCount: null,
        };
        await this.commit([...this.documents, document]);
        return { document: { ...document, tags: [...document.tags] }, duplicate: false,
          ...(truncated ? { warning: tagWarning } : {}) };
      } catch (error) {
        throw await this.failedPublication(error, destination, output, bytes, id);
      } finally { await output.close().catch(() => undefined); }
    });
  }

  private async bytes(document: PDFDocument): Promise<Buffer> {
    await this.checkDirectories();
    const bytes = await readRegularFile(path.join(this.filesDirectory, `${document.id}.pdf`), MAX_PDF_BYTES);
    if (bytes.length !== document.size || digest(bytes) !== document.sha256) throw new Error('The managed PDF changed outside this application. Remove its library entry and import your original PDF again.');
    return bytes;
  }

  read(id: unknown): Promise<Uint8Array> {
    return this.serialize(async () => {
      await this.checkCatalog();
      const document = this.lookup(id);
      const bytes = await this.bytes(document);
      return new Uint8Array(bytes);
    });
  }

  update(id: unknown, patch: unknown): Promise<PDFDocument> {
    return this.serialize(async () => {
      await this.checkCatalog();
      const document = this.lookup(id);
      if (!object(patch) || !Object.keys(patch).length || Object.keys(patch).some(key => !['title', 'tags', 'favorite', 'lastPage', 'pageCount', 'folderId'].includes(key))) throw new Error('Unsupported PDF metadata update.');
      const normalized = { ...patch } as DocumentPatch;
      if (Object.hasOwn(patch, 'title')) {
        if (typeof patch.title !== 'string' || !text(patch.title.trim(), 200)) throw new Error('Use a title between 1 and 200 characters.');
        normalized.title = patch.title.trim();
      }
      if (Object.hasOwn(patch, 'tags')) {
        if (!Array.isArray(patch.tags) || patch.tags.some(tag => typeof tag !== 'string')) throw new Error('Tags must be text.');
        const tags = patch.tags.map(tag => (tag as string).trim()).filter(Boolean);
        normalized.tags = tags.filter((tag, index) => tags.findIndex(other => other.toLowerCase() === tag.toLowerCase()) === index);
        if (!validTags(normalized.tags)) throw new Error('Use up to 12 tags, each between 1 and 40 characters.');
      }
      if (Object.hasOwn(patch, 'favorite') && typeof patch.favorite !== 'boolean') throw new Error('Favorite must be true or false.');
      if (Object.hasOwn(patch, 'lastPage') && !page(patch.lastPage)) throw new Error('Choose a valid page number.');
      if (Object.hasOwn(patch, 'pageCount') && patch.pageCount !== null && !page(patch.pageCount)) throw new Error('Choose a valid page count.');
      if (Object.hasOwn(patch, 'folderId') && patch.folderId !== null) this.lookupFolder(patch.folderId);
      // A repeated drop onto the current folder is not a metadata edit.
      if (Object.keys(patch).length === 1 && Object.hasOwn(patch, 'folderId')
        && (document.folderId ?? null) === patch.folderId) return { ...document, tags: [...document.tags] };
      const nextFolder = normalized.folderId;
      delete normalized.folderId;
      const now = new Date().toISOString();
      const updated = { ...document, ...normalized, updatedAt: now,
        lastOpenedAt: Object.hasOwn(patch, 'lastPage') ? now : document.lastOpenedAt };
      if (Object.hasOwn(patch, 'folderId')) {
        if (nextFolder === null) delete updated.folderId;
        else updated.folderId = nextFolder;
      }
      if (updated.pageCount !== null && updated.lastPage > updated.pageCount) {
        if (Object.hasOwn(patch, 'lastPage')) throw new Error('The page number is beyond the end of this PDF.');
        updated.lastPage = updated.pageCount;
      }
      if (!validDocument(updated)) throw new Error('The PDF metadata update is invalid.');
      await this.commit(this.documents.map(candidate => candidate.id === document.id ? updated : candidate));
      return { ...updated, tags: [...updated.tags] };
    });
  }

  withDocumentPath(id: unknown, action: (filename: string) => Promise<void> | void): Promise<void> {
    return this.serialize(async () => {
      await this.checkCatalog();
      const document = this.lookup(id);
      await this.bytes(document);
      await action(path.join(this.filesDirectory, `${document.id}.pdf`));
    });
  }

  remove(id: unknown): Promise<LibrarySnapshot> {
    return this.serialize(async () => {
      await this.checkCatalog();
      const document = this.lookup(id);
      await this.commit(this.documents.filter(candidate => candidate.id !== document.id));
      // Keep the managed copy as well as the original. Removing an entry is reversible
      // by importing the retained PDF from the library's documents directory.
      return this.snapshot();
    });
  }
}
