import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, ArrowRight, ArrowUpRight, Download, FileText, LoaderCircle, Search, X } from 'lucide-react';
import { normalizeArxivId } from '../shared/arxiv';
import { ARXIV_CATEGORIES, ARXIV_MAX_START, ARXIV_PAGE_SIZE, type ArxivImportResult, type ArxivSearchField, type ArxivSearchRequest, type ArxivSearchResult, type ArxivSort } from '../shared/arxivSearch';
import { renderMarkdownDocument } from './markdown';
import './research.css';
import './arxiv.css';

interface Props {
  onClose: () => void;
  onImport: (arxivId: string) => Promise<ArxivImportResult>;
  onOpenPDF: (id: string) => void;
}
interface SearchPage { request: ArxivSearchRequest; result: ArxivSearchResult }

const failureMessage = (error: unknown) => error instanceof Error
  ? error.message.replace(/^Error invoking remote method '[^']+': Error: /, '')
  : 'The request could not be completed. Please try again.';
const criteriaKey = ({ query, field, category, sort }: ArxivSearchRequest) => JSON.stringify([query.trim(), field, category, sort]);
const authorPreview = (authors: string[], limit: number) => `${authors.slice(0, limit).join(', ')}${authors.length > limit ? ` · +${authors.length - limit} more` : ''}`;

export function ArxivBrowser({ onClose, onImport, onOpenPDF }: Props) {
  const dialog = useRef<HTMLDialogElement>(null);
  const resultsList = useRef<HTMLElement>(null);
  const mounted = useRef(false);
  const searchRequest = useRef(0);
  const selectionGeneration = useRef(0);
  const sourceRequest = useRef(0);
  const searchingNow = useRef(false);
  const importingNow = useRef(false);
  const [query, setQuery] = useState('');
  const [field, setField] = useState<ArxivSearchField>('all');
  const [category, setCategory] = useState('');
  const [sort, setSort] = useState<ArxivSort>('relevance');
  const [page, setPage] = useState<SearchPage | null>(null);
  const [lastAttempt, setLastAttempt] = useState<ArxivSearchRequest | null>(null);
  const [selectedId, setSelectedId] = useState('');
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState('');
  const [importing, setImporting] = useState(false);
  const [importError, setImportError] = useState('');
  const [importResult, setImportResult] = useState<ArxivImportResult | null>(null);
  const [sourceError, setSourceError] = useState('');

  useEffect(() => {
    mounted.current = true;
    dialog.current?.showModal();
    return () => {
      mounted.current = false;
      searchRequest.current++;
      selectionGeneration.current++;
    };
  }, []);

  const formRequest: ArxivSearchRequest = { query: query.trim(), field, category: field === 'id' ? '' : category, sort: field === 'id' ? 'relevance' : sort, start: 0 };
  const previousRequest = page?.request ?? lastAttempt;
  const changedCriteria = !!previousRequest && criteriaKey(formRequest) !== criteriaKey(previousRequest);
  const busy = searching || importing;
  const selected = page?.result.papers.find(paper => paper.arxivId === selectedId) ?? page?.result.papers[0];
  const abstract = useMemo(() => selected ? renderMarkdownDocument(selected.summary, undefined, { passive: true }).html : '', [selected]);
  const pageLimit = !!page && page.result.nextStart === null && page.result.start >= ARXIV_MAX_START
    && page.result.totalResults > ARXIV_MAX_START + ARXIV_PAGE_SIZE;

  const clearSelectionStatus = () => {
    selectionGeneration.current++;
    setImportResult(null);
    setImportError('');
    setSourceError('');
  };
  const search = async (request: ArxivSearchRequest) => {
    if (searchingNow.current || importingNow.current) return;
    if (!request.query && (!request.category || request.field === 'id')) {
      setSearchError(request.field === 'id' ? 'Enter an arXiv ID or an arxiv.org paper link.' : 'Enter search terms or choose a category.');
      return;
    }
    const generation = ++searchRequest.current;
    searchingNow.current = true;
    setSearching(true);
    setSearchError('');
    setLastAttempt(request);
    setPage(null);
    setSelectedId('');
    clearSelectionStatus();
    try {
      const result = await window.prismArxiv.search(request);
      if (!mounted.current || generation !== searchRequest.current) return;
      setPage({ request, result });
      setSelectedId(result.papers[0]?.arxivId ?? '');
    } catch (error) {
      if (mounted.current && generation === searchRequest.current) setSearchError(failureMessage(error));
    } finally {
      if (generation === searchRequest.current) {
        searchingNow.current = false;
        if (mounted.current) setSearching(false);
      }
    }
  };
  const changePage = (start: number) => {
    if (!page || changedCriteria || start < 0 || start > ARXIV_MAX_START) return;
    void search({ ...page.request, start });
  };
  const selectPaper = (id: string) => {
    if (searchingNow.current || importingNow.current || selected?.arxivId === id) return;
    setSelectedId(id);
    clearSelectionStatus();
  };
  const close = () => {
    if (importingNow.current) return;
    mounted.current = false;
    searchRequest.current++;
    selectionGeneration.current++;
    onClose();
  };
  const openSource = async () => {
    if (!selected || searchingNow.current || importingNow.current) return;
    const id = normalizeArxivId(selected.arxivId);
    if (!id) { setSourceError('This paper has an invalid arXiv ID.'); return; }
    const generation = selectionGeneration.current;
    const request = ++sourceRequest.current;
    setSourceError('');
    try { await window.prism.openExternal(`https://arxiv.org/abs/${id}`); }
    catch (error) {
      if (mounted.current && generation === selectionGeneration.current && request === sourceRequest.current) setSourceError(failureMessage(error));
    }
  };
  const importSelected = async () => {
    if (!selected || searchingNow.current || importingNow.current) return;
    const id = normalizeArxivId(selected.arxivId);
    if (!id) { setImportError('This paper has an invalid arXiv ID.'); return; }
    const generation = selectionGeneration.current;
    importingNow.current = true;
    setImporting(true);
    setImportError('');
    setImportResult(null);
    try {
      const result = await onImport(id);
      if (mounted.current && generation === selectionGeneration.current) setImportResult(result);
    } catch (error) {
      if (mounted.current && generation === selectionGeneration.current) setImportError(failureMessage(error));
    } finally {
      importingNow.current = false;
      if (mounted.current) setImporting(false);
    }
  };

  useEffect(() => { if (resultsList.current) resultsList.current.scrollTop = 0; }, [page]);

  return <dialog ref={dialog} className="modal research-browser arxiv-browser" aria-label="Search arXiv"
    onCancel={event => { event.preventDefault(); close(); }}>
    <div className="modal-heading research-heading"><div><p className="eyebrow">FIND A PAPER</p><h2>Search arXiv</h2></div>
      <button type="button" className="icon-button" aria-label="Close arXiv browser" disabled={importing} onClick={close}><X size={19} /></button></div>
    <p className="research-introduction">Find a paper and save its PDF to your library. Imported papers remain available offline.</p>
    <form onSubmit={event => { event.preventDefault(); void search(formRequest); }}>
      <div className="research-search-row"><label className="research-search"><span>Search terms</span>
        <input type="search" className="text-input" aria-label="Search terms" autoFocus value={query} disabled={busy}
          placeholder={field === 'id' ? 'arXiv ID or arxiv.org paper link' : 'Title, author, or keywords'} onChange={event => setQuery(event.target.value)} /></label>
        <button type="submit" className="primary-button" disabled={busy}>{searching ? <LoaderCircle size={16} className="spin" /> : <Search size={16} />}Search</button></div>
      <div className="research-filters arxiv-filters">
        <label>Search in<select aria-label="Search in" value={field} disabled={busy} onChange={event => setField(event.target.value as ArxivSearchField)}>
          <option value="all">All fields</option><option value="title">Title</option><option value="author">Author</option><option value="id">arXiv ID</option>
        </select></label>
        <label>Category<select aria-label="Category" value={category} disabled={busy || field === 'id'} onChange={event => setCategory(event.target.value)}>
          <option value="">All categories</option>{ARXIV_CATEGORIES.map(item => <option key={item.id} value={item.id}>{item.id} · {item.label}</option>)}
        </select></label>
        <label>Sort by<select aria-label="Sort by" value={sort} disabled={busy || field === 'id'} onChange={event => setSort(event.target.value as ArxivSort)}>
          <option value="relevance">Relevance</option><option value="newest">Newest submission</option><option value="updated">Recently updated</option>
        </select></label>
      </div>
    </form>
    {!page && !searching && !searchError && <p className="research-empty arxiv-start">Enter search terms, choose a category, or look up an arXiv ID, then select Search.</p>}
    {changedCriteria && <p className="research-status" role="status">Search again to apply your changes.</p>}
    {searching && <p className="research-status" role="status"><LoaderCircle size={16} className="spin" />Searching arXiv…</p>}
    {searchError && <div className="research-error" role="alert"><p>{searchError}</p>
      {lastAttempt && !changedCriteria && <button type="button" className="subtle-button" disabled={busy} onClick={() => void search(lastAttempt)}>Retry search</button>}
    </div>}
    {page && <><div className="arxiv-results-toolbar">
      <p className="research-result-count" role="status">{page.result.papers.length
        ? `Papers ${page.result.start + 1}–${page.result.start + page.result.papers.length} of ${page.result.totalResults.toLocaleString()}`
        : 'No papers found'}</p>
      <nav className="arxiv-pagination" aria-label="Search result pages">
        <button type="button" className="subtle-button" disabled={busy || changedCriteria || page.result.start === 0} onClick={() => changePage(Math.max(0, page.result.start - ARXIV_PAGE_SIZE))}><ArrowLeft size={15} />Previous results</button>
        <button type="button" className="subtle-button" disabled={busy || changedCriteria || page.result.nextStart === null} onClick={() => { if (page.result.nextStart !== null) changePage(page.result.nextStart); }}>Next results<ArrowRight size={15} /></button>
      </nav>
    </div>
      {pageLimit && <p className="field-help" role="status">The first {(ARXIV_MAX_START + ARXIV_PAGE_SIZE).toLocaleString()} results are available here. Narrow your search to find more.</p>}
      {!page.result.papers.length ? <p className="research-empty">Try different search terms or another category.</p> : <div className="research-browser-content">
        <section ref={resultsList} className="research-results arxiv-results" aria-label="Search results">
          <div className="research-paper-list">{page.result.papers.map(paper => <button key={paper.arxivId} type="button" className="research-paper"
            aria-label={`View paper ${paper.title} (${paper.arxivId})`} aria-pressed={selected?.arxivId === paper.arxivId} disabled={busy} onClick={() => selectPaper(paper.arxivId)}>
            <strong>{paper.title}</strong><span>{authorPreview(paper.authors, 3)}</span><span className="research-paper-meta">Submitted {paper.published.slice(0, 10)} · {paper.primaryCategory}</span><code>{paper.arxivId}</code>
          </button>)}</div>
        </section>
        <section className="research-detail arxiv-detail" aria-label="Paper details">
          {selected && <><div className="research-detail-heading"><h3>{selected.title}</h3><p>{authorPreview(selected.authors, 8)}</p></div>
            {selected.authors.length > 8 && <details className="arxiv-authors" key={selected.arxivId}><summary>All {selected.authors.length.toLocaleString()} authors</summary><p>{selected.authors.join(', ')}</p></details>}
            <dl className="arxiv-paper-metadata"><dt>arXiv ID</dt><dd>{selected.arxivId}</dd>
              <dt>Submitted</dt><dd><time dateTime={selected.published}>{selected.published.slice(0, 10)}</time></dd>
              <dt>Updated</dt><dd><time dateTime={selected.updated}>{selected.updated.slice(0, 10)}</time></dd>
              <dt>Primary category</dt><dd>{selected.primaryCategory}</dd><dt>Categories</dt><dd>{selected.categories.join(' · ')}</dd></dl>
            <h4 className="arxiv-abstract-heading">Abstract</h4>
            <div className="markdown-body research-review arxiv-abstract" onClick={event => event.preventDefault()} dangerouslySetInnerHTML={{ __html: abstract }} />
            <div className="research-source-actions"><button type="button" className="text-button" disabled={busy} onClick={() => void openSource()}>arXiv paper<ArrowUpRight size={14} /></button></div>
            {sourceError && <p className="research-error" role="alert">{sourceError}</p>}
            <div className="research-import"><p>Save this PDF to your library with its arXiv categories as tags. Existing PDFs and your metadata are preserved.</p>
              <button type="button" className="primary-button" disabled={busy} onClick={() => void importSelected()}>{importing ? <LoaderCircle size={17} className="spin" /> : <Download size={17} />}{importing ? 'Importing PDF…' : 'Import PDF'}</button>
              {importing && <p role="status">Downloading and saving. Keep this window open until the import finishes.</p>}
              {importError && <p className="research-error" role="alert">{importError}</p>}
              {importResult && <div className="research-import-result" role={importResult.warning ? 'alert' : 'status'}>
                <p>{importResult.duplicate ? 'Existing PDF reused.' : 'PDF imported.'} <strong>{importResult.document.title}</strong></p>
                {importResult.warning && <p>{importResult.warning}</p>}
                <button type="button" className="subtle-button" onClick={() => onOpenPDF(importResult.document.id)}><FileText size={15} />Open PDF</button>
              </div>}
            </div>
          </>}
        </section>
      </div>}
    </>}
  </dialog>;
}
