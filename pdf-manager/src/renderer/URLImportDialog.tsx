import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { BookOpen, Check, Download, LoaderCircle, X } from 'lucide-react';
import type { PDFDocument, PDFURLImportState } from '../shared/types';

interface URLImportDialogProps {
  active: boolean;
  onClose: () => void;
  onComplete: (document: PDFDocument) => void;
  onRefresh: () => void;
  onOpenPDF: (id: string) => void;
}

const busy = (state: PDFURLImportState | null) => state?.phase === 'downloading' || state?.phase === 'saving';
const errorMessage = (error: unknown) => error instanceof Error
  ? error.message.replace(/^Error invoking remote method '[^']+': Error: /, '')
  : 'The download status could not be checked. Please try again.';
const bytesLabel = (bytes: number) => bytes < 1024 ? `${bytes} B`
  : bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KB`
  : `${(bytes / (1024 * 1024)).toFixed(1)} MB`;

/** Downloads run in the main process; this dialog only observes and controls them. */
export function URLImportDialog({ active, onClose, onComplete, onRefresh, onOpenPDF }: URLImportDialogProps) {
  const dialog = useRef<HTMLDialogElement>(null);
  const urlInput = useRef<HTMLInputElement>(null);
  const mounted = useRef(false);
  const generation = useRef(0);
  const currentJob = useRef<PDFURLImportState | null>(null);
  const completed = useRef<string | null>(null);
  const closeAfterCancellation = useRef(false);
  const callbacks = useRef({ onClose, onComplete, onRefresh, onOpenPDF });
  callbacks.current = { onClose, onComplete, onRefresh, onOpenPDF };
  const [url, setURL] = useState('');
  const [job, setJob] = useState<PDFURLImportState | null>(null);
  const [initializing, setInitializing] = useState(true);
  const [pending, setPending] = useState<'start' | 'cancel' | null>(null);
  const [requestError, setRequestError] = useState('');
  const [statusError, setStatusError] = useState('');
  const [statusRetry, setStatusRetry] = useState(0);
  const [closing, setClosing] = useState(false);

  const accept = useCallback((state: PDFURLImportState) => {
    currentJob.current = state;
    setJob(state);
    setStatusError('');
  }, []);

  useEffect(() => {
    if (active) {
      if (!dialog.current?.open) dialog.current?.showModal();
    } else dialog.current?.close();
  }, [active]);

  useEffect(() => {
    mounted.current = true;
    const request = ++generation.current;
    setInitializing(true);
    void window.prismPdf.getURLImport().then(state => {
      if (!mounted.current || request !== generation.current) return;
      // An active download survives a renderer reload. A dismissed terminal
      // result belongs to the previous visit, so reopening starts a fresh form.
      if (state && busy(state)) accept(state);
      else if (state?.phase === 'complete' && state.document) {
        completed.current = state.id;
        // The PDF may have been edited or removed since this job completed.
        // Read the current catalogue instead of reinserting the old snapshot.
        callbacks.current.onRefresh();
      }
      setStatusError('');
    }).catch(error => {
      if (mounted.current && request === generation.current) setStatusError(errorMessage(error));
    }).finally(() => {
      if (mounted.current && request === generation.current) setInitializing(false);
    });
    return () => { mounted.current = false; ++generation.current; };
  }, [accept]);

  useEffect(() => {
    if (active && !initializing && !busy(job) && document.activeElement === dialog.current) urlInput.current?.focus();
  }, [active, initializing, job?.phase]);

  useEffect(() => {
    if (!busy(job) || pending) return;
    const id = job!.id;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      const request = generation.current;
      try {
        const state = await window.prismPdf.getURLImport();
        if (disposed || !mounted.current || request !== generation.current || currentJob.current?.id !== id) return;
        if (!state || state.id !== id) {
          accept({ ...currentJob.current, phase: 'error', error: 'The download is no longer available. Please try again.' });
          return;
        }
        accept(state);
        if (!busy(state)) return;
      } catch (error) {
        if (disposed || !mounted.current || request !== generation.current) return;
        setStatusError(errorMessage(error));
      }
      if (!disposed) timer = setTimeout(() => void poll(), 200);
    };
    timer = setTimeout(() => void poll(), 200);
    return () => { disposed = true; clearTimeout(timer); };
  }, [job?.id, job?.phase, pending, statusRetry, accept]);

  useEffect(() => {
    if (job?.phase === 'complete' && job.document && completed.current !== job.id) {
      completed.current = job.id;
      callbacks.current.onComplete(job.document);
    }
    if (job && !busy(job) && closeAfterCancellation.current) {
      closeAfterCancellation.current = false;
      callbacks.current.onClose();
    }
  }, [job]);

  const start = async (event: FormEvent) => {
    event.preventDefault();
    if (initializing || pending || busy(currentJob.current) || (statusError && !currentJob.current)) return;
    setRequestError('');
    try {
      const parsed = new URL(url.trim());
      if (parsed.protocol !== 'https:' || parsed.username || parsed.password) throw new Error();
    } catch {
      setRequestError('Enter a public HTTPS PDF link without a username or password.');
      return;
    }
    const request = ++generation.current;
    setPending('start');
    setStatusError('');
    currentJob.current = null;
    setJob(null);
    try {
      const state = await window.prismPdf.startURLImport(url.trim());
      if (mounted.current && request === generation.current) accept(state);
    } catch (error) {
      if (mounted.current && request === generation.current) {
        setRequestError(errorMessage(error));
        // A rejected start can mean another surviving job is still active.
        // Recover its handle so Close can cancel it rather than orphaning it.
        try {
          const state = await window.prismPdf.getURLImport();
          if (mounted.current && request === generation.current && state && busy(state)) {
            setURL('');
            setRequestError('');
            accept(state);
          }
        } catch (statusFailure) {
          if (mounted.current && request === generation.current) setStatusError(errorMessage(statusFailure));
        }
      }
    } finally {
      if (mounted.current && request === generation.current) setPending(null);
    }
  };

  const cancel = async (close: boolean) => {
    const state = currentJob.current;
    if (!state || state.phase !== 'downloading' || pending) return;
    ++generation.current;
    closeAfterCancellation.current = close;
    setClosing(close);
    setPending('cancel');
    setRequestError('');
    try {
      const cancelled = await window.prismPdf.cancelURLImport(state.id);
      if (mounted.current && currentJob.current?.id === state.id) accept(cancelled);
    } catch (error) {
      if (mounted.current) {
        closeAfterCancellation.current = false;
        setClosing(false);
        setRequestError(errorMessage(error));
      }
    } finally {
      if (mounted.current) setPending(null);
    }
  };

  const close = () => {
    if (initializing || pending || currentJob.current?.phase === 'saving') return;
    if (currentJob.current?.phase === 'downloading') void cancel(true);
    else callbacks.current.onClose();
  };

  const retryStatus = async () => {
    if (busy(currentJob.current)) { setStatusRetry(value => value + 1); return; }
    setInitializing(true);
    setStatusError('');
    try {
      const state = await window.prismPdf.getURLImport();
      if (mounted.current && state && busy(state)) accept(state);
      else if (mounted.current && state?.phase === 'complete' && state.document) {
        completed.current = state.id;
        callbacks.current.onRefresh();
      }
    } catch (error) {
      if (mounted.current) setStatusError(errorMessage(error));
    } finally {
      if (mounted.current) setInitializing(false);
    }
  };

  const downloading = job?.phase === 'downloading';
  const saving = job?.phase === 'saving';
  const complete = job?.phase === 'complete' && !!job.document;
  const disabled = initializing || !!pending || busy(job) || closing;
  const total = job?.totalBytes && job.totalBytes > 0 ? job.totalBytes : null;
  const percentage = total && job ? Math.min(100, Math.floor(job.receivedBytes / total * 100)) : null;

  return <dialog ref={dialog} className="modal pdf-url-import" aria-label="Import from URL"
    onCancel={event => { event.preventDefault(); close(); }}>
    <header><h2>Import from URL</h2><button className="icon-button" aria-label="Close URL import" disabled={initializing || !!pending || saving || closing} onClick={close}><X size={18} /></button></header>
    <p className="modal-description">Paste a public HTTPS link that downloads a PDF. Pages requiring sign-in cannot be imported. The saved copy stays in your library.</p>
    <form onSubmit={event => void start(event)} noValidate>
      <label className="field-label">PDF URL<input ref={urlInput} aria-label="PDF URL" type="url" autoFocus={active} placeholder="https://example.org/paper.pdf" value={url} disabled={disabled} maxLength={8192} spellCheck={false} autoComplete="off" onChange={event => { setURL(event.target.value); setRequestError(''); }} /></label>
      {initializing && <p className="pdf-url-status" role="status"><LoaderCircle size={17} className="spin" />Checking for an active download…</p>}
      {(downloading || saving) && <div className="pdf-url-progress">
        <p className="pdf-url-status" role="status"><LoaderCircle size={17} className="spin" />{saving ? 'Saving PDF to your library…' : pending === 'cancel' ? 'Cancelling download…' : 'Downloading PDF…'}</p>
        <progress aria-label="Download progress" max={100} value={saving ? 100 : percentage ?? undefined} />
        <p className="pdf-url-transfer">{percentage !== null && <span>{percentage}% · </span>}{bytesLabel(job.receivedBytes)}{total ? ` of ${bytesLabel(total)}` : ' downloaded'}</p>
        {saving && <p className="pdf-url-help">Saving cannot be cancelled. This usually takes a moment.</p>}
        {closing && <p className="pdf-url-help">This dialog will close when the download has stopped.</p>}
      </div>}
      {complete && <div className="pdf-url-result" role="status"><Check size={20} /><div><strong>{job.duplicate ? 'Already in your library' : 'PDF added to your library'}</strong><p>{job.document!.title}</p>{job.duplicate && <p className="pdf-url-help">Your existing title, tags, and reading position were kept.</p>}</div></div>}
      {job?.phase === 'cancelled' && <p className="pdf-url-status" role="status">Download cancelled. You can try another link.</p>}
      {job?.phase === 'error' && <p className="form-error" role="alert">{job.error || 'The PDF could not be imported. Check the link and try again.'}</p>}
      {requestError && <p className="form-error" role="alert">{requestError}</p>}
      {statusError && <div className="pdf-url-status-error"><p className="form-error" role="alert">{statusError}</p><button type="button" className="secondary-button" disabled={initializing || !!pending} onClick={() => void retryStatus()}>Check download status</button></div>}
      <div className="modal-actions">
        {downloading && <button type="button" className="secondary-button" disabled={!!pending || closing} onClick={() => void cancel(false)}>Cancel download</button>}
        {complete ? <>
          <button type="button" className="secondary-button" onClick={() => {
            currentJob.current = null; setJob(null); setURL(''); setRequestError('');
            requestAnimationFrame(() => urlInput.current?.focus());
          }}>Import another URL</button>
          <button type="button" className="primary-button" onClick={() => callbacks.current.onOpenPDF(job.document!.id)}><BookOpen size={17} />Open PDF</button>
        </> : <button type="submit" className="primary-button" disabled={disabled || !url.trim() || (!!statusError && !job)}>
          {pending === 'start' ? <LoaderCircle size={17} className="spin" /> : <Download size={17} />}
          {pending === 'start' ? 'Starting download…' : 'Download PDF'}
        </button>}
      </div>
    </form>
  </dialog>;
}
