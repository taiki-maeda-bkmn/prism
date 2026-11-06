export const MAX_IMPORT_FILES = 100;

/** Resolve only browser File objects backed by files the user supplied. */
export function droppedFilePaths(files: readonly File[], getPath: (file: File) => string): string[] {
  if (!Array.isArray(files) || !files.length || files.length > MAX_IMPORT_FILES) {
    throw new Error(`Import up to ${MAX_IMPORT_FILES} PDF files at a time.`);
  }
  // Array.from visits sparse entries too; a hole must not skip validation.
  return Array.from(files, file => {
    try {
      const filename = getPath(file);
      if (typeof filename === 'string' && filename.length) return filename;
    } catch { /* The native resolver also rejects values that are not File objects. */ }
    throw new Error('Drop PDF files from your file manager, or use Import PDFs.');
  });
}
