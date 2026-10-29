import type { PDFDocument } from '../../pdf-manager/src/shared/types';
import type { Note } from './types';

export interface ResearchIdentity { editionId: string; arxivId: string }
export interface ResearchPaper extends ResearchIdentity {
  baseId: string;
  title: string;
  authors: string[];
  topics: string[];
  date: string;
  kind: string;
  rating: number | null;
  ratingScale: number | null;
  score: number | null;
  rank: number | null;
  summary: string;
}
export interface ResearchCatalog { papers: ResearchPaper[]; sourceUrl: string }
export interface ResearchReview extends ResearchPaper {
  reviewText: string;
  reviewScope: 'paper' | 'edition' | 'summary';
  sourceUrl: string;
}
export type ResearchGrouping = 'topic' | 'month' | 'flat';
export interface ResearchImportRequest extends ResearchIdentity { notebookPath: string; grouping: ResearchGrouping }
export interface ResearchImportResult {
  document: PDFDocument;
  note: Note | null;
  duplicatePDF: boolean;
  duplicateNote: boolean;
  warning?: string;
}
export interface PrismResearchAPI {
  catalogue(refresh?: boolean): Promise<ResearchCatalog>;
  review(identity: ResearchIdentity): Promise<ResearchReview>;
  importPaper(request: ResearchImportRequest): Promise<ResearchImportResult>;
}
declare global { interface Window { prismResearch: PrismResearchAPI } }
