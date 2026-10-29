import { useId, useState } from 'react';
import { ChevronDown, ChevronRight, FileText, Link2 } from 'lucide-react';
import type { PDFNoteBacklink } from '../../../src/shared/pdfLinks';

interface Props {
  backlinks: readonly PDFNoteBacklink[];
  pageCount: number | null;
  currentPage: number;
  onOpenNote: (path: string) => void;
  onOpenPage: (page: number) => void;
}

/** Notebook references stay independent of PDF loading and password state. */
export function PdfBacklinks({ backlinks, pageCount, currentPage, onOpenNote, onOpenPage }: Props) {
  const [expanded, setExpanded] = useState(false);
  const id = useId();
  return <div className="pdf-backlinks">
    <button className="pdf-backlinks-toggle" aria-label="Linked notes" aria-expanded={expanded}
      aria-controls={`${id}-list`} aria-describedby={`${id}-count`} onClick={() => setExpanded(value => !value)}>
      <Link2 size={16} /><span>Linked notes</span>
      <span id={`${id}-count`} className="pdf-backlinks-count">{backlinks.length} {backlinks.length === 1 ? 'note' : 'notes'}</span>
      {expanded ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
    </button>
    <div id={`${id}-list`} className="pdf-backlinks-list" role="region" aria-label="Linked notes for this PDF" hidden={!expanded}>
      {backlinks.length ? <ul>{backlinks.map(note => <li className="pdf-backlink" key={note.path}>
        <button className="pdf-backlink-note" aria-label={`Open note ${note.path}`} title={note.path} onClick={() => onOpenNote(note.path)}>
          <FileText size={16} /><span><strong>{note.title}</strong><small>{note.path}</small></span>
        </button>
        <div className="pdf-backlink-pages" aria-label={`Cited pages in ${note.path}`}>
          {note.pages.map(page => {
            const unavailable = pageCount !== null && page > pageCount;
            return <button key={page} aria-label={`Page ${page} cited by ${note.path}`} aria-current={pageCount !== null && page === currentPage ? 'page' : undefined}
              disabled={pageCount === null || unavailable} onClick={() => onOpenPage(page)}
              title={unavailable ? `This PDF has ${pageCount} pages. Edit the reference in the note.` : pageCount === null ? 'Load or unlock this PDF to visit the cited page.' : `Go to page ${page}`}>
              Page {page}{unavailable ? ' · unavailable' : ''}
            </button>;
          })}
        </div>
      </li>)}</ul> : <p className="pdf-backlinks-empty">No notes in this notebook link to this PDF yet. Use <strong>Insert page link</strong> to add a reference.</p>}
    </div>
  </div>;
}
