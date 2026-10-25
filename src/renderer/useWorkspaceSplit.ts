import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent } from 'react';
import { notesPaneWidth, parseWorkspaceRatio, workspaceSplit } from './workspaceLayout';

const preferenceKey = 'prism.workspace-split';

function readRatio() {
  try { return parseWorkspaceRatio(localStorage.getItem(preferenceKey)); }
  catch { return workspaceSplit.defaultRatio; }
}

export function useWorkspaceSplit() {
  const area = useRef<HTMLDivElement>(null);
  const divider = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [requested, setRequested] = useState(false);
  const [ratio, setRatio] = useState(readRatio);
  const [resizing, setResizing] = useState(false);
  const drag = useRef<{ pointer: number; x: number; width: number; ratio: number } | null>(null);
  const available = width >= workspaceSplit.minimumWidth;
  const visible = requested && available;
  const displayedWidth = notesPaneWidth(width, ratio);

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
  useEffect(() => {
    if (resizing) return;
    try { localStorage.setItem(preferenceKey, JSON.stringify(ratio)); }
    catch { /* Layout remains usable if optional preference storage is unavailable. */ }
  }, [ratio, resizing]);

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
    if (start && start.pointer === event.pointerId) changeWidth(start.width + event.clientX - start.x);
  }

  function keyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    if (event.key === 'Escape' && drag.current) {
      event.preventDefault();
      finishDrag(true);
    } else if (!drag.current && ['ArrowLeft', 'ArrowRight', 'Home'].includes(event.key)) {
      event.preventDefault();
      if (event.key === 'Home') setRatio(workspaceSplit.defaultRatio);
      else changeWidth(displayedWidth + (event.key === 'ArrowLeft' ? -1 : 1) * (event.shiftKey ? 40 : 10));
    }
  }

  return {
    area, requested, setRequested, available, visible, resizing,
    style: { '--notes-pane-width': `${displayedWidth}px` } as CSSProperties,
    dividerProps: {
      ref: divider,
      'aria-valuemin': notesPaneWidth(width, 0.2),
      'aria-valuemax': notesPaneWidth(width, 0.8),
      'aria-valuenow': displayedWidth,
      'aria-valuetext': `Notes ${Math.round(displayedWidth / Math.max(1, width - workspaceSplit.divider) * 100)}%, PDFs ${Math.round((1 - displayedWidth / Math.max(1, width - workspaceSplit.divider)) * 100)}%`,
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
