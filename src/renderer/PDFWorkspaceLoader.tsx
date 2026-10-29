import { Component, lazy, Suspense, useMemo, useState, type ReactNode } from 'react';
import type { PDFNoteBacklink, PDFPageLinkRequest, PDFPageReference } from '../shared/pdfLinks';

class LoadBoundary extends Component<{ children: ReactNode; retry: () => void }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() {
    if (this.state.failed) return <div className="workspace-loading" role="alert">
      <p>The PDF workspace couldn’t be opened. Try again or return to Notes.</p>
      <button className="primary-button" onClick={this.props.retry}>Try again</button>
    </div>;
    return this.props.children;
  }
}

interface PDFWorkspaceLoaderProps {
  active: boolean;
  onAppearance: () => void;
  pageLinkRequest?: PDFPageLinkRequest | null;
  onInsertPageLink?: (reference: PDFPageReference) => void;
  canInsertPageLink?: boolean;
  backlinks?: ReadonlyMap<string, readonly PDFNoteBacklink[]>;
  onOpenNote?: (path: string) => void;
}

/** Load PDF.js on the first PDF visit; the parent retains this tree afterward. */
export function PDFWorkspaceLoader(props: PDFWorkspaceLoaderProps) {
  const [attempt, setAttempt] = useState(0);
  const Workspace = useMemo(() => lazy(() => import('../../pdf-manager/src/renderer/PDFWorkspace')), [attempt]);
  return <LoadBoundary key={attempt} retry={() => setAttempt(previous => previous + 1)}>
    <Suspense fallback={<div className="workspace-loading" role="status">Opening PDFs…</div>}>
      <Workspace {...props} />
    </Suspense>
  </LoadBoundary>;
}
