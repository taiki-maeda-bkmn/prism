import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent } from 'react';
import { notesPaneWidth, parseNotesSide, parseWorkspaceRatio, workspaceSplit } from './workspaceLayout';

const preferenceKey = 'prism.workspace-split';
const sidePreferenceKey = 'prism.workspace-notes-side';

function readRatio() {
  try { return parseWorkspaceRatio(localStorage.getItem(preferenceKey)); }
  catch { return workspaceSplit.defaultRatio; }
}

function readNotesSide() {
  try { return parseNotesSide(localStorage.getItem(sidePreferenceKey)); }
  catch { return 'left' as const; }
}

export function useWorkspaceSplit() {
  const area = useRef<HTMLDivElement>(null);
  const divider = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [requested, setRequested] = useState(false);
  const [ratio, setRatio] = useState(readRatio);
  const [notesSide, setNotesSide] = useState(readNotesSide);
  const [resizing, setResizing] = useState(false);
  const drag = useRef<{ pointer: number; x: number; width: number; ratio: number } | null>(null);
  const swapScroll = useRef<{ element: Element; top: number; left: number }[]>([]);
  const available = width >= workspaceSplit.minimumWidth;
  const visible = requested && available;
  const displayedWidth = notesPaneWidth(width, ratio);
  const direction = notesSide === 'left' ? 1 : -1;
  const availableWidth = Math.max(0, width - workspaceSplit.divider);
  const leftWidth = notesSide === 'left' ? displayedWidth : availableWidth - displayedWidth;
  const notesPercent = Math.round(displayedWidth / Math.max(1, availableWidth) * 100);

  const finishDrag = useCallback((cancel: boolean, event?: { pointerId: number }) => {
    const start = drag.current;
    if (!start || (event && event.pointerId !== start.pointer)) return;
    drag.current = null;
    if (cancel) setRatio(start.ratio);
    setResizing(false);
    if (divider.current?.hasPointerCapture(start.pointer)) divider.current.releasePointerCapture(start.pointer);
  }, []);

  useLayoutEffect(() => {
    const element = area.current;
    if (!element) return;
    const measure = () => setWidth(element.clientWidth);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    const blur = () => finishDrag(true);
    window.addEventListener('blur', blur);
    return () => { observer.disconnect(); window.removeEventListener('blur', blur); };
  }, [finishDrag]);

  useLayoutEffect(() => { if (!visible) finishDrag(true); }, [visible, finishDrag]);
  useLayoutEffect(() => {
    // Moving keyed DOM nodes can reset descendant scrolling even though their
    // editor/reader instances survive. Restore it before the new order paints.
    for (const { element, top, left } of swapScroll.current) {
      if (element.isConnected) { element.scrollTop = top; element.scrollLeft = left; }
    }
    swapScroll.current = [];
  }, [notesSide]);
  useEffect(() => {
    if (resizing) return;
    try { localStorage.setItem(preferenceKey, JSON.stringify(ratio)); }
    catch { /* Layout remains usable if optional preference storage is unavailable. */ }
  }, [ratio, resizing]);
  useEffect(() => {
    try { localStorage.setItem(sidePreferenceKey, JSON.stringify(notesSide)); }
    catch { /* The order remains usable for this session. */ }
  }, [notesSide]);

  const swapSides = () => {
    finishDrag(true);
    swapScroll.current = [...(area.current?.querySelectorAll('*') ?? [])]
      .filter(element => element.scrollTop || element.scrollLeft)
      .map(element => ({ element, top: element.scrollTop, left: element.scrollLeft }));
    setNotesSide(previous => previous === 'left' ? 'right' : 'left');
  };

  function changeWidth(next: number) {
    const bounded = notesPaneWidth(width, next / Math.max(1, width - workspaceSplit.divider));
    setRatio(Math.max(0.2, Math.min(0.8, bounded / Math.max(1, width - workspaceSplit.divider))));
  }

  function pointerDown(event: PointerEvent<HTMLDivElement>) {
    if (!visible || event.button !== 0 || !event.isPrimary || drag.current) return;
    event.preventDefault();
    event.currentTarget.focus({ preventScroll: true });
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { pointer: event.pointerId, x: event.clientX, width: displayedWidth, ratio };
    setResizing(true);
  }

  function pointerMove(event: PointerEvent<HTMLDivElement>) {
    const start = drag.current;
    if (start && start.pointer === event.pointerId) changeWidth(start.width + direction * (event.clientX - start.x));
  }

  function keyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    if (event.key === 'Escape' && drag.current) {
      event.preventDefault();
      finishDrag(true);
    } else if (!drag.current && ['ArrowLeft', 'ArrowRight', 'Home'].includes(event.key)) {
      event.preventDefault();
      if (event.key === 'Home') setRatio(workspaceSplit.defaultRatio);
      else changeWidth(displayedWidth + direction * (event.key === 'ArrowLeft' ? -1 : 1) * (event.shiftKey ? 40 : 10));
    }
  }

  return {
    area, requested, setRequested, available, visible, resizing, notesSide, swapSides,
    style: { '--notes-pane-width': `${displayedWidth}px` } as CSSProperties,
    dividerProps: {
      ref: divider,
      'aria-valuemin': notesPaneWidth(width, 0.2),
      'aria-valuemax': notesPaneWidth(width, 0.8),
      'aria-valuenow': leftWidth,
      'aria-valuetext': notesSide === 'left' ? `Notes left ${notesPercent}%, PDFs right ${100 - notesPercent}%`
        : `PDFs left ${100 - notesPercent}%, Notes right ${notesPercent}%`,
      onPointerDown: pointerDown,
      onPointerMove: pointerMove,
      onPointerUp: (event: PointerEvent<HTMLDivElement>) => finishDrag(false, event),
      onPointerCancel: (event: PointerEvent<HTMLDivElement>) => finishDrag(true, event),
      onLostPointerCapture: (event: PointerEvent<HTMLDivElement>) => finishDrag(true, event),
      onKeyDown: keyDown,
      onDoubleClick: () => { finishDrag(false); setRatio(workspaceSplit.defaultRatio); },
    },
  };
}
