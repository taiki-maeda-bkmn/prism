import type { ResearchImportRequest, ResearchImportResult, ResearchReview } from '../shared/research';
import { formatPDFPageLink } from '../shared/pdfLinks';
import { researchReviewURL, type ResearchClient } from './research-client';
import type { PDFLibraryService } from '../../pdf-manager/src/main/library-service';
import { MAX_NOTE_BYTES } from './limits';
import { WorkspaceStore } from './workspace';

const markerPrefix = '<!-- prism-research:v1 ';
const reason = (error: unknown) => error instanceof Error ? error.message : 'An unexpected error occurred.';
const plain = (value: string) => value.replace(/[\r\n]/g, ' ').replace(/[\\`*_[\]<>#]/g, '\\$&');

export function researchFolderSegment(value: string): string {
  const segment = Array.from(value).slice(0, 60).join('').replace(/[<>:"/\\|?*\u0000-\u001f\u007f-\u009f]/g, '_').replace(/[. ]+$/g, '').trim().replace(/^\.+/, '_');
  return !segment || /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(segment) || segment.toLowerCase() === 'node_modules' ? 'Research' : segment;
}

export function researchReviewMarkdown(review: ResearchReview, documentId: string): string {
  return [
    `${markerPrefix}${JSON.stringify({ editionId: review.editionId, arxivId: review.arxivId, documentId })} -->`,
    `# ${plain(review.title)}`, '', '## Rates & Execution review', '',
    formatPDFPageLink({ documentId, page: 1, title: 'Read PDF' }), '',
    `- Edition: ${plain(review.date)} (${plain(review.kind)})`,
    `- Published rating: ${review.rating === null ? 'Unrated' : `${review.rating}/${review.ratingScale}`}`,
    `- Authors: ${review.authors.map(plain).join(', ')}`,
    `- Topics: ${review.topics.map(plain).join(', ')}`,
    `- arXiv ID: ${plain(review.arxivId)}`,
    `- [Published review](${researchReviewURL(review.editionId)})`,
    `- [arXiv paper](https://arxiv.org/abs/${review.arxivId})`, '',
    review.reviewScope === 'edition' ? '## Full edition review' : review.reviewScope === 'summary' ? '## Published summary' : '## Review comment', '',
    review.reviewText || review.summary || 'No review comment was published for this paper.', '',
  ].join('\n');
}

function identity(content: string): { editionId: string; arxivId: string; documentId: string } | null {
  const first = content.replace(/^\ufeff/, '').split(/\r?\n/, 1)[0];
  if (!first.startsWith(markerPrefix) || !first.endsWith(' -->')) return null;
  try {
    const value: unknown = JSON.parse(first.slice(markerPrefix.length, -4));
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const record = value as Record<string, unknown>;
    return typeof record.editionId === 'string' && typeof record.arxivId === 'string' && typeof record.documentId === 'string'
      ? record as { editionId: string; arxivId: string; documentId: string } : null;
  } catch { return null; }
}

/** Serialized separately so repeat imports cannot publish two review notes. */
export class ResearchImporter {
  private queue: Promise<unknown> = Promise.resolve();
  constructor(
    private readonly client: Pick<ResearchClient, 'review' | 'downloadPDF'>,
    private readonly library: Pick<PDFLibraryService, 'importArxiv'>,
    private readonly currentWorkspace: () => Promise<WorkspaceStore>,
  ) {}

  import(request: unknown): Promise<ResearchImportResult> {
    const result = this.queue.then(() => this.perform(request));
    this.queue = result.catch(() => undefined);
    return result;
  }

  private async perform(value: unknown): Promise<ResearchImportResult> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Choose a published paper to import.');
    const request = value as ResearchImportRequest;
    if (Object.keys(value).some(key => !['editionId', 'arxivId', 'notebookPath', 'grouping'].includes(key))
      || typeof request.notebookPath !== 'string' || !['topic', 'month', 'flat'].includes(request.grouping)) throw new Error('Choose a valid review destination.');
    const notebook = await this.currentWorkspace();
    const checkNotebook = async () => {
      if (request.notebookPath !== notebook.root || await this.currentWorkspace() !== notebook) throw new Error('The notebook changed. Reopen Rates & Execution before importing.');
    };
    await checkNotebook();
    const review = await this.client.review({ editionId: request.editionId, arxivId: request.arxivId });
    // Reject an oversized review before saving any PDF. The eventual UUID has
    // the same length as this placeholder, so its note has the same byte count.
    const template = researchReviewMarkdown(review, '00000000-0000-4000-8000-000000000000');
    if (Buffer.byteLength(template, 'utf8') > MAX_NOTE_BYTES) throw new Error('This published review is too large for a Prism note. Open the published review to read it.');
    await checkNotebook();
    const saved = await this.library.importArxiv({ arxivId: review.arxivId, title: review.title, tags: review.topics }, () => this.client.downloadPDF(review.arxivId));
    const warnings = saved.warning ? [saved.warning] : [];
    const result = { document: saved.document, duplicatePDF: saved.duplicate };
    try {
      await checkNotebook();
      const snapshot = await notebook.load();
      const matching = snapshot.notes.filter(note => {
        const source = identity(note.content);
        return source?.editionId === review.editionId && source.arxivId === review.arxivId;
      });
      const existing = matching.find(note => identity(note.content)?.documentId === saved.document.id);
      if (existing) return { ...result, note: existing, duplicateNote: true, warning: warnings.join(' ') || undefined };
      if (matching.length) warnings.push('An earlier review links to a different managed PDF. It was preserved; the new review links to this copy.');
      const group = request.grouping === 'topic' ? researchFolderSegment(review.topics[0] || 'Uncategorized')
        : request.grouping === 'month' ? review.date.slice(0, 7) : '';
      const folder = ['Research', 'Rates & Execution', group].filter(Boolean).join('/');
      const basename = `arxiv-${review.arxivId.replace(/\//g, '-')}-${review.editionId}`;
      const content = researchReviewMarkdown(review, saved.document.id);
      const occupied = new Set(snapshot.notes.map(note => note.path.toLowerCase()));
      for (let suffix = 0; suffix < 1000; suffix++) {
        const notePath = `${folder}/${basename}${suffix ? ` (${suffix + 1})` : ''}.md`;
        if (occupied.has(notePath.toLowerCase())) continue;
        await checkNotebook();
        try {
          const note = await notebook.create(notePath, content);
          return { ...result, note, duplicateNote: false, warning: warnings.join(' ') || undefined };
        } catch (error) {
          // A file created after the scan is also preserved. Other failures are
          // reported as partial imports, without deleting the saved PDF.
          if (!reason(error).includes('A note already exists at that path.')) throw error;
        }
      }
      throw new Error('Too many review filenames already exist in this folder.');
    } catch (error) {
      warnings.push(`The PDF is saved, but its review could not be saved: ${reason(error)} Retry Import PDF + review to add it.`);
      return { ...result, note: null, duplicateNote: false, warning: warnings.join(' ') };
    }
  }
}
