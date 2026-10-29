import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowUpRight, BookOpen, Download, LoaderCircle, RefreshCw, X } from 'lucide-react';
import type { ResearchCatalog, ResearchGrouping, ResearchImportRequest, ResearchImportResult, ResearchPaper, ResearchReview } from '../shared/research';
import { renderMarkdownDocument } from './markdown';
import './research.css';

interface Props {
  notebookName: string;
  notebookPath: string;
  onClose: () => void;
  onImport: (request: ResearchImportRequest) => Promise<ResearchImportResult>;
  onOpenNote: (path: string) => void;
  onOpenPDF: (id: string) => void;
}

const identity = (paper: ResearchPaper) => `${paper.editionId}:${paper.arxivId}`;
const failureMessage = (error: unknown) => error instanceof Error
  ? error.message.replace(/^Error invoking remote method '[^']+': Error: /, '')
  : 'The request could not be completed. Please try again.';
const ratingLabel = (paper: ResearchPaper) => paper.rating === null ? 'Unrated' : `${paper.rating}/${paper.ratingScale}`;

/** Keep published text readable while all navigation remains an explicit source action. */
function reviewHTML(text: string): string {
  return renderMarkdownDocument(text, undefined, { passive: true }).html;
}

export function ResearchBrowser({ notebookName, notebookPath, onClose, onImport, onOpenNote, onOpenPDF }: Props) {
  const dialog = useRef<HTMLDialogElement>(null);
  const mounted = useRef(false);
  const catalogRequest = useRef(0);
  const reviewRequest = useRef(0);
  const importingNow = useRef(false);
  const [catalog, setCatalog] = useState<ResearchCatalog | null>(null);
  const [catalogLoading, setCatalogLoading] = useState(true);
  const [catalogError, setCatalogError] = useState('');
  const [query, setQuery] = useState('');
  const [topic, setTopic] = useState('');
  const [kind, setKind] = useState('');
  const [minimum, setMinimum] = useState('');
  const [visibleCount, setVisibleCount] = useState(100);
  const [selectedBase, setSelectedBase] = useState('');
  const [selectedEdition, setSelectedEdition] = useState('');
  const [loadedReview, setReview] = useState<ResearchReview | null>(null);
  const [reviewLoading, setReviewLoading] = useState(false);
  const [reviewError, setReviewError] = useState('');
  const [reviewAttempt, setReviewAttempt] = useState(0);
  const [grouping, setGrouping] = useState<ResearchGrouping>('topic');
  const [importing, setImporting] = useState(false);
  const [importError, setImportError] = useState('');
  const [result, setResult] = useState<ResearchImportResult | null>(null);
  const [sourceError, setSourceError] = useState('');

  const loadCatalog = useCallback(async (refresh: boolean) => {
    const request = ++catalogRequest.current;
    setCatalogLoading(true);
    setCatalogError('');
    try {
      const next = await window.prismResearch.catalogue(refresh);
      if (!mounted.current || request !== catalogRequest.current) return;
      setCatalog(next);
      setVisibleCount(100);
      // A refreshed edition should replace a previously cached review too.
      setReviewAttempt(previous => previous + 1);
    } catch (error) {
      if (mounted.current && request === catalogRequest.current) setCatalogError(failureMessage(error));
    } finally {
      if (mounted.current && request === catalogRequest.current) setCatalogLoading(false);
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    dialog.current?.showModal();
    void loadCatalog(false);
    return () => {
      mounted.current = false;
      catalogRequest.current++;
      reviewRequest.current++;
    };
  }, [loadCatalog]);

  const topics = useMemo(() => [...new Set(catalog?.papers.flatMap(paper => paper.topics) ?? [])].sort(), [catalog]);
  const kinds = useMemo(() => [...new Set(catalog?.papers.map(paper => paper.kind).filter(Boolean) ?? [])].sort(), [catalog]);
  const groups = useMemo(() => {
    const search = query.trim().toLocaleLowerCase();
    const grouped = new Map<string, ResearchPaper[]>();
    const matches = (catalog?.papers ?? []).filter(paper => (!topic || paper.topics.includes(topic))
      && (!kind || paper.kind === kind) && (!minimum || (paper.score !== null && paper.score >= Number(minimum)))
      && (!search || `${paper.title}\n${paper.authors.join(' ')}\n${paper.arxivId}\n${paper.topics.join(' ')}`.toLocaleLowerCase().includes(search)))
      .sort((a, b) => b.date.localeCompare(a.date) || b.editionId.localeCompare(a.editionId) || a.arxivId.localeCompare(b.arxivId));
    for (const paper of matches) {
      const editions = grouped.get(paper.baseId);
      if (editions) { if (!editions.some(previous => identity(previous) === identity(paper))) editions.push(paper); }
      else grouped.set(paper.baseId, [paper]);
    }
    return [...grouped.values()];
  }, [catalog, query, topic, kind, minimum]);
  const selectedGroup = groups.find(papers => papers[0].baseId === selectedBase) ?? groups[0];
  const selected = selectedGroup?.find(paper => identity(paper) === selectedEdition) ?? selectedGroup?.[0];
  const selectedKey = selected ? identity(selected) : '';
  const review = loadedReview && identity(loadedReview) === selectedKey ? loadedReview : null;

  useEffect(() => { setVisibleCount(100); }, [query, topic, kind, minimum]);
  useEffect(() => {
    const request = ++reviewRequest.current;
    setReview(null);
    setReviewError('');
    setImportError('');
    setResult(null);
    setSourceError('');
    setReviewLoading(!!selected);
    if (!selected) return;
    void window.prismResearch.review({ editionId: selected.editionId, arxivId: selected.arxivId }).then(next => {
      if (mounted.current && request === reviewRequest.current) setReview(next);
    }, error => {
      if (mounted.current && request === reviewRequest.current) setReviewError(failureMessage(error));
    }).finally(() => {
      if (mounted.current && request === reviewRequest.current) setReviewLoading(false);
    });
    return () => { reviewRequest.current++; };
    // The selected identity, rather than the catalogue object, owns each request.
  }, [selectedKey, reviewAttempt]);

  const html = useMemo(() => review ? reviewHTML(review.reviewText || review.summary) : '', [review]);
  const close = () => { if (!importingNow.current) onClose(); };
  const openSource = async (url: string) => {
    setSourceError('');
    try { await window.prism.openExternal(url); }
    catch (error) { if (mounted.current) setSourceError(failureMessage(error)); }
  };
  const importSelected = async () => {
    if (!review || importingNow.current || reviewLoading) return;
    importingNow.current = true;
    setImporting(true);
    setImportError('');
    setResult(null);
    try {
      const next = await onImport({ editionId: review.editionId, arxivId: review.arxivId, notebookPath, grouping });
      if (mounted.current) setResult(next);
    } catch (error) { if (mounted.current) setImportError(failureMessage(error)); }
    finally {
      importingNow.current = false;
      if (mounted.current) setImporting(false);
    }
  };

  return <dialog ref={dialog} className="modal research-browser" aria-label="Rates & Execution"
    onCancel={event => { event.preventDefault(); close(); }}>
    <div className="modal-heading research-heading"><div><p className="eyebrow">PUBLISHED RESEARCH</p><h2>Rates & Execution</h2></div>
      <button type="button" className="icon-button" aria-label="Close research browser" disabled={importing} onClick={close}><X size={19} /></button></div>
    <p className="research-introduction">Explore published reviews and keep a PDF with a linked review note in your notebook.</p>
    <div className="research-search-row"><label className="research-search"><span>Search published papers</span>
      <input type="search" className="text-input" aria-label="Search published papers" value={query} disabled={importing} placeholder="Title, author, arXiv ID, or topic" onChange={event => setQuery(event.target.value)} /></label>
      <button type="button" className="subtle-button" disabled={catalogLoading || importing} onClick={() => void loadCatalog(true)}><RefreshCw size={15} />Refresh catalogue</button></div>
    <div className="research-filters">
      <label>Topic<select aria-label="Topic" value={topic} disabled={importing} onChange={event => setTopic(event.target.value)}><option value="">All topics</option>{topics.map(value => <option key={value} value={value}>{value}</option>)}</select></label>
      <label>Edition type<select aria-label="Edition type" value={kind} disabled={importing} onChange={event => setKind(event.target.value)}><option value="">All editions</option>{kinds.map(value => <option key={value} value={value}>{value}</option>)}</select></label>
      <label>Minimum rating<select aria-label="Minimum rating" value={minimum} disabled={importing} onChange={event => setMinimum(event.target.value)}><option value="">Any rating</option>{[5, 6, 7, 8, 9].map(value => <option key={value} value={value}>{value}/10</option>)}</select></label>
    </div>
    {catalogLoading && <p className="research-status" role="status"><LoaderCircle size={16} className="spin" />Loading published papers…</p>}
    {catalogError && <div className="research-error" role="alert"><p>{catalogError}</p><button type="button" className="subtle-button" disabled={catalogLoading || importing} onClick={() => void loadCatalog(true)}>Retry catalogue</button></div>}
    {catalog && <div className="research-browser-content">
      <section className="research-results" aria-label="Published papers">
        <p className="research-result-count">{groups.length} {groups.length === 1 ? 'paper' : 'papers'}{groups.length > visibleCount ? ` · showing ${visibleCount}` : ''}</p>
        {!groups.length && <p className="research-empty">No papers match these filters.</p>}
        <div className="research-paper-list">{groups.slice(0, visibleCount).map(papers => {
          const paper = papers[0];
          return <button key={paper.baseId} type="button" className="research-paper" aria-pressed={selected?.baseId === paper.baseId}
            aria-label={`View review for ${paper.title} (${paper.baseId})`} disabled={importing}
            onClick={() => { setSelectedBase(paper.baseId); setSelectedEdition(identity(paper)); }}>
            <strong>{paper.title}</strong><span>{paper.authors.join(', ')}</span><span className="research-paper-meta">{paper.date} · {paper.kind} · {ratingLabel(paper)}</span>
            <span>{paper.topics.join(' · ')}</span><code>{paper.arxivId}</code>
          </button>;
        })}</div>
        {groups.length > visibleCount && <button type="button" className="subtle-button research-more" disabled={importing} onClick={() => setVisibleCount(previous => previous + 100)}>Show more papers</button>}
      </section>
      <section className="research-detail" aria-label="Published review" aria-busy={reviewLoading}>
        {selected && <><div className="research-detail-heading"><h3>{selected.title}</h3><p>{selected.authors.join(', ')}</p></div>
          <label className="research-edition">Review edition<select aria-label="Review edition" value={selectedKey} disabled={importing} onChange={event => { setSelectedBase(selected.baseId); setSelectedEdition(event.target.value); }}>
            {selectedGroup?.map(paper => <option key={identity(paper)} value={identity(paper)}>{paper.date} · {paper.kind} · {ratingLabel(paper)} · {paper.arxivId}</option>)}
          </select></label></>}
        {reviewLoading && <p className="research-status" role="status"><LoaderCircle size={16} className="spin" />Loading published review…</p>}
        {reviewError && <div className="research-error" role="alert"><p>{reviewError}</p><button type="button" className="subtle-button" onClick={() => setReviewAttempt(previous => previous + 1)}>Retry review</button></div>}
        {review && <><div className="research-review-meta"><span>Published rating: {ratingLabel(review)}</span><span>{review.topics.join(' · ')}</span></div>
          <p className="research-review-scope">{review.reviewScope === 'edition' ? 'Full edition review — the published edition covers several papers.' : review.reviewScope === 'summary' ? 'Published summary' : 'Published paper review'}</p>
          <div className="markdown-body research-review" onClick={event => event.preventDefault()} dangerouslySetInnerHTML={{ __html: html }} />
          <div className="research-source-actions"><button type="button" className="text-button" disabled={importing} onClick={() => void openSource(review.sourceUrl)}>Published source <ArrowUpRight size={14} /></button>
            <button type="button" className="text-button" disabled={importing} onClick={() => void openSource(`https://arxiv.org/abs/${review.arxivId}`)}>arXiv paper <ArrowUpRight size={14} /></button></div>
          {sourceError && <p className="research-error" role="alert">{sourceError}</p>}
          <div className="research-import"><p>Save the PDF to your library and its review to <strong>{notebookName}</strong>.</p>
            <label>Group review notes<select aria-label="Group review notes" value={grouping} disabled={importing} onChange={event => setGrouping(event.target.value as ResearchGrouping)}>
              <option value="topic">Topic</option><option value="month">Month</option><option value="flat">No subfolders</option>
            </select></label>
            <p className="field-help">Review notes go in Research/Rates &amp; Execution{grouping === 'topic' ? '/topic' : grouping === 'month' ? '/month' : ''}. Published topics become PDF tags. Existing PDFs and edited reviews are preserved.</p>
            <button type="button" className="primary-button" disabled={importing || !notebookPath || catalogLoading} onClick={() => void importSelected()}>
              {importing ? <LoaderCircle className="spin" size={17} /> : <Download size={17} />}{importing ? 'Importing PDF and review…' : result && !result.note ? 'Retry import' : 'Import PDF + review'}
            </button>
            {importing && <p role="status">Downloading and saving. Keep this window open until the import finishes.</p>}
            {importError && <p className="research-error" role="alert">{importError}</p>}
            {result && <div className="research-import-result" role={result.warning ? 'alert' : 'status'}>
              <p>{result.warning || `${result.duplicatePDF ? 'Existing PDF reused.' : 'PDF imported.'} ${result.duplicateNote ? 'Existing review preserved.' : 'Review note saved.'}`}</p>
              {result.note && <p className="research-note-path">{result.note.path}</p>}
              <div className="research-result-actions">{result.note && <button type="button" className="subtle-button" onClick={() => onOpenNote(result.note!.path)}><BookOpen size={15} />Open review</button>}
                <button type="button" className="subtle-button" onClick={() => onOpenPDF(result.document.id)}>Open PDF</button></div>
            </div>}
          </div></>}
      </section>
    </div>}
  </dialog>;
}
