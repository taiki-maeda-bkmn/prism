import { createHash, randomUUID } from 'node:crypto';
import { constants, type Stats } from 'node:fs';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import type { DocumentPatch, ImportResult, LibrarySnapshot, PDFDocument } from '../shared/types';

export const MAX_PDF_BYTES = 100 * 1024 * 1024;
export const MAX_DOCUMENTS = 2_000;
const MAX_CATALOG_BYTES = 8 * 1024 * 1024;
const MAX_IMPORT_BATCH = 100;
const idPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const hashPattern = /^[a-f0-9]{64}$/;
const controls = /[\u0000-\u001f\u007f-\u009f]/;
const documentKeys = ['id', 'title', 'filename', 'size', 'sha256', 'importedAt', 'updatedAt', 'tags', 'favorite', 'lastOpenedAt', 'lastPage', 'pageCount'];

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
function validTags(value: unknown): value is string[] {
  return Array.isArray(value) && value.length <= 12 && value.every(tag => text(tag, 40))
    && new Set(value.map(tag => tag.toLocaleLowerCase())).size === value.length;
}
function validDocument(value: unknown): value is PDFDocument {
  if (!object(value) || Object.keys(value).length !== documentKeys.length || !documentKeys.every(key => Object.hasOwn(value, key))) return false;
  return typeof value.id === 'string' && idPattern.test(value.id) && text(value.title, 200)
    && text(value.filename, 255) && !/[\\/]/.test(value.filename) && /\.pdf$/i.test(value.filename)
    && typeof value.size === 'number' && Number.isSafeInteger(value.size) && value.size >= 8 && value.size <= MAX_PDF_BYTES
    && typeof value.sha256 === 'string' && hashPattern.test(value.sha256)
    && timestamp(value.importedAt) && timestamp(value.updatedAt) && validTags(value.tags)
    && typeof value.favorite === 'boolean' && (value.lastOpenedAt === null || timestamp(value.lastOpenedAt))
    && page(value.lastPage) && (value.pageCount === null || page(value.pageCount))
    && (value.pageCount === null || value.lastPage <= value.pageCount);
}

function parseCatalog(bytes: Uint8Array): PDFDocument[] {
  const corrupt = () => new Error('The PDF catalog is damaged or unsupported. Its contents were left untouched; restore catalog.json from a backup before trying again.');
  let value: unknown;
  try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); } catch { throw corrupt(); }
  if (!object(value) || Object.keys(value).length !== 2 || value.version !== 1 || !Array.isArray(value.documents)
    || value.documents.length > MAX_DOCUMENTS || !value.documents.every(validDocument)) throw corrupt();
  const documents = value.documents as PDFDocument[];
  if (new Set(documents.map(document => document.id)).size !== documents.length
    || new Set(documents.map(document => document.sha256)).size !== documents.length) throw corrupt();
  return documents;
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
  private catalogHash: string | null;
  private operations: Promise<unknown> = Promise.resolve();

  private constructor(root: string, rootIdentity: Stats, filesIdentity: Stats, documents: PDFDocument[], catalogHash: string | null) {
    this.root = root;
    this.filesDirectory = path.join(root, 'documents');
    this.catalogPath = path.join(root, 'catalog.json');
    this.rootIdentity = rootIdentity;
    this.filesIdentity = filesIdentity;
    this.documents = documents;
    this.catalogHash = catalogHash;
  }

  static async open(directory: string): Promise<LibraryStore> {
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
    return new LibraryStore(root, await fs.stat(root), filesIdentity, bytes ? parseCatalog(bytes) : [], bytes ? digest(bytes) : null);
  }

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operations.then(operation);
    this.operations = result.catch(() => undefined);
    return result;
  }

  private async checkDirectories(): Promise<void> {
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

  private snapshot(): LibrarySnapshot {
    return { documents: this.documents.map(document => ({ ...document, tags: [...document.tags] })), warnings: [] };
  }

  private lookup(id: unknown): PDFDocument {
    if (typeof id !== 'string' || !idPattern.test(id)) throw new Error('Unknown PDF document.');
    const document = this.documents.find(candidate => candidate.id === id);
    if (!document) throw new Error('Unknown PDF document.');
    return document;
  }

  private async commit(documents: PDFDocument[]): Promise<void> {
    await this.checkCatalog();
    const bytes = Buffer.from(JSON.stringify({ version: 1, documents }, null, 2) + '\n');
    if (bytes.length > MAX_CATALOG_BYTES) throw new Error('The PDF catalog has reached its size limit.');
    const temporary = path.join(this.root, `.catalog-${randomUUID()}.tmp`);
    const handle = await fs.open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
    try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
    // Failed writes retain their private temporary files; never remove a file another process may have changed.
    await this.checkCatalog();
    await fs.rename(temporary, this.catalogPath);
    this.catalogHash = digest(bytes);
    this.documents = documents;
  }

  load(): Promise<LibrarySnapshot> {
    return this.serialize(async () => {
      await this.checkCatalog();
      const warnings: string[] = [];
      for (const document of this.documents) {
        try {
          const file = await fs.lstat(path.join(this.filesDirectory, `${document.id}.pdf`));
          if (!file.isFile() || file.isSymbolicLink() || file.size !== document.size) warnings.push(`${document.filename}: its managed copy is unavailable or changed.`);
        } catch { warnings.push(`${document.filename}: its managed copy is unavailable.`); }
      }
      return { ...this.snapshot(), warnings };
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
          const output = await fs.open(destination, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
          try { await output.writeFile(bytes); await output.sync(); } finally { await output.close(); }
          const now = new Date().toISOString();
          const document: PDFDocument = {
            id, title: filename.replace(/\.pdf$/i, '').slice(0, 200).trim() || 'Untitled PDF', filename,
            size: bytes.length, sha256, importedAt: now, updatedAt: now, tags: [], favorite: false,
            lastOpenedAt: null, lastPage: 1, pageCount: null,
          };
          await this.commit([...this.documents, document]);
          importedIds.push(id);
        } catch (error) { errors.push(`${filename}: ${message(error)}`); }
      }
      return { library: this.snapshot(), importedIds, duplicateCount, errors };
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
      if (!object(patch) || !Object.keys(patch).length || Object.keys(patch).some(key => !['title', 'tags', 'favorite', 'lastPage', 'pageCount'].includes(key))) throw new Error('Unsupported PDF metadata update.');
      const normalized = { ...patch } as DocumentPatch;
      if (Object.hasOwn(patch, 'title')) {
        if (typeof patch.title !== 'string' || !text(patch.title.trim(), 200)) throw new Error('Use a title between 1 and 200 characters.');
        normalized.title = patch.title.trim();
      }
      if (Object.hasOwn(patch, 'tags')) {
        if (!Array.isArray(patch.tags) || patch.tags.some(tag => typeof tag !== 'string')) throw new Error('Tags must be text.');
        const tags = patch.tags.map(tag => (tag as string).trim()).filter(Boolean);
        normalized.tags = tags.filter((tag, index) => tags.findIndex(other => other.toLocaleLowerCase() === tag.toLocaleLowerCase()) === index);
        if (!validTags(normalized.tags)) throw new Error('Use up to 12 tags, each between 1 and 40 characters.');
      }
      if (Object.hasOwn(patch, 'favorite') && typeof patch.favorite !== 'boolean') throw new Error('Favorite must be true or false.');
      if (Object.hasOwn(patch, 'lastPage') && !page(patch.lastPage)) throw new Error('Choose a valid page number.');
      if (Object.hasOwn(patch, 'pageCount') && patch.pageCount !== null && !page(patch.pageCount)) throw new Error('Choose a valid page count.');
      const now = new Date().toISOString();
      const updated = { ...document, ...normalized, updatedAt: now,
        lastOpenedAt: Object.hasOwn(patch, 'lastPage') ? now : document.lastOpenedAt };
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
