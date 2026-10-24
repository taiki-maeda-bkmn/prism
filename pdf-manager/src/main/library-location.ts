import path from 'node:path';

interface PDFProfileLocation {
  appData: string;
  isPackaged: boolean;
  override?: string;
}

/** Both launchers use the existing PDF profile for the current OS account. */
export function resolvePDFProfileDirectory({ appData, isPackaged, override }: PDFProfileLocation): string {
  return !isPackaged && override
    ? path.resolve(override)
    : path.join(appData, 'prism-pdf');
}
