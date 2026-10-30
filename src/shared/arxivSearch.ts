import type { PDFDocument } from '../../pdf-manager/src/shared/types';

export const ARXIV_CATEGORIES = [
  { id: 'q-fin.TR', label: 'Trading and Market Microstructure' },
  { id: 'q-fin.PR', label: 'Pricing of Securities' },
  { id: 'q-fin.MF', label: 'Mathematical Finance' },
  { id: 'q-fin.PM', label: 'Portfolio Management' },
  { id: 'q-fin.RM', label: 'Risk Management' },
  { id: 'q-fin.ST', label: 'Statistical Finance' },
  { id: 'q-fin.CP', label: 'Computational Finance' },
  { id: 'q-fin.EC', label: 'Economics' },
  { id: 'q-fin.GN', label: 'General Finance' },
  { id: 'econ.EM', label: 'Econometrics' },
  { id: 'econ.TH', label: 'Theoretical Economics' },
  { id: 'cs.LG', label: 'Machine Learning' },
  { id: 'cs.AI', label: 'Artificial Intelligence' },
  { id: 'cs.GT', label: 'Computer Science and Game Theory' },
  { id: 'stat.ML', label: 'Machine Learning (Statistics)' },
  { id: 'stat.ME', label: 'Methodology (Statistics)' },
  { id: 'math.OC', label: 'Optimization and Control' },
  { id: 'math.PR', label: 'Probability' },
] as const;
export const ARXIV_PAGE_SIZE = 20;
export const ARXIV_MAX_START = 1980;
export type ArxivSearchField = 'all' | 'title' | 'author' | 'id';
export type ArxivSort = 'relevance' | 'newest' | 'updated';
export interface ArxivSearchRequest {
  query: string;
  field: ArxivSearchField;
  category: string;
  sort: ArxivSort;
  start: number;
}
export interface ArxivPaper {
  arxivId: string;
  baseId: string;
  title: string;
  authors: string[];
  summary: string;
  primaryCategory: string;
  categories: string[];
  published: string;
  updated: string;
}
export interface ArxivSearchResult {
  papers: ArxivPaper[];
  totalResults: number;
  start: number;
  nextStart: number | null;
}
export interface ArxivImportResult { document: PDFDocument; duplicate: boolean; warning?: string }
export interface PrismArxivAPI {
  search(request: ArxivSearchRequest): Promise<ArxivSearchResult>;
  importPaper(arxivId: string): Promise<ArxivImportResult>;
}
declare global { interface Window { prismArxiv: PrismArxivAPI } }
