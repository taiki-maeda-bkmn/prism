import { LibraryWorkspace } from './App';
import type { PDFNoteBacklink, PDFPageLinkRequest, PDFPageReference } from '../../../src/shared/pdfLinks';

interface PDFWorkspaceProps {
  active: boolean;
  onAppearance: () => void;
  pageLinkRequest?: PDFPageLinkRequest | null;
  onInsertPageLink?: (reference: PDFPageReference) => void;
  canInsertPageLink?: boolean;
  backlinks?: ReadonlyMap<string, readonly PDFNoteBacklink[]>;
  onOpenNote?: (path: string) => void;
}

export default function PDFWorkspace({ active, ...props }: PDFWorkspaceProps) {
  return <LibraryWorkspace workspaceActive={active} {...props} />;
}
