import { LibraryWorkspace } from './App';
import type { PDFNoteBacklink, PDFPageLinkRequest, PDFPageReference } from '../../../src/shared/pdfLinks';
import type { PDFGraphDocument } from '../../../src/shared/pdfGraph';

interface PDFWorkspaceProps {
  active: boolean;
  visible: boolean;
  onAppearance: () => void;
  pageLinkRequest?: PDFPageLinkRequest | null;
  onInsertPageLink?: (reference: PDFPageReference) => void;
  canInsertPageLink?: boolean;
  backlinks?: ReadonlyMap<string, readonly PDFNoteBacklink[]>;
  onOpenNote?: (path: string) => void;
  onDocumentsChange?: (documents: readonly PDFGraphDocument[]) => void;
  onResearch?: () => void;
  onArxiv?: () => void;
  libraryRevision?: number;
}

export default function PDFWorkspace({ active, visible, ...props }: PDFWorkspaceProps) {
  return <LibraryWorkspace workspaceActive={active} workspaceVisible={visible} {...props} />;
}
