import { baseArxivId, normalizeArxivId } from '../shared/arxiv';
import type { ArxivImportResult } from '../shared/arxivSearch';
import type { ArxivClient } from './arxiv-client';
import type { ResearchClient } from './research-client';
import type { PDFLibraryService } from '../../pdf-manager/src/main/library-service';

/** Only a paper ID crosses IPC; import metadata comes from arXiv in main. */
export class ArxivImporter {
  constructor(
    private readonly client: Pick<ArxivClient, 'resolve'>,
    private readonly downloader: Pick<ResearchClient, 'downloadPDF'>,
    private readonly library: Pick<PDFLibraryService, 'importArxiv'>,
  ) {}

  async import(value: unknown): Promise<ArxivImportResult> {
    const id = normalizeArxivId(value);
    if (!id || id !== value) throw new Error('Choose a valid arXiv paper to import.');
    const paper = await this.client.resolve(id);
    if (normalizeArxivId(paper.arxivId) !== paper.arxivId || baseArxivId(paper.arxivId) !== baseArxivId(id)
      || (/v[0-9]+$/.test(id) && paper.arxivId !== id)) throw new Error('arXiv returned a different paper or version. Search again before importing.');
    return this.library.importArxiv({ arxivId: paper.arxivId, title: paper.title, tags: paper.categories },
      () => this.downloader.downloadPDF(paper.arxivId));
  }
}
