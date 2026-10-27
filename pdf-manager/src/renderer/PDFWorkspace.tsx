import { LibraryWorkspace } from './App';
import type { PDFPageLinkRequest, PDFPageReference } from '../../../src/shared/pdfLinks';

interface PDFWorkspaceProps {
  active: boolean;
  onAppearance: () => void;
  pageLinkRequest?: PDFPageLinkRequest | null;
  onInsertPageLink?: (reference: PDFPageReference) => void;
  canInsertPageLink?: boolean;
}

export default function PDFWorkspace({ active, ...props }: PDFWorkspaceProps) {
  return <LibraryWorkspace workspaceActive={active} {...props} />;
}
