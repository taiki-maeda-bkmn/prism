import path from 'node:path';
import { MAX_IMPORT_FILES } from '../shared/fileImports';

/** Validate the complete IPC batch before reading or publishing any document. */
export function validateImportPaths(paths: unknown): asserts paths is string[] {
  if (!Array.isArray(paths) || paths.length > MAX_IMPORT_FILES || Array.from(paths).some(filename => typeof filename !== 'string')) {
    throw new Error(`Import up to ${MAX_IMPORT_FILES} PDF files at a time.`);
  }
  if (paths.some(filename => !filename.length || filename.length > 32_768 || filename.includes('\0') || !path.isAbsolute(filename))) {
    throw new Error('Choose files with absolute paths on this computer.');
  }
}
