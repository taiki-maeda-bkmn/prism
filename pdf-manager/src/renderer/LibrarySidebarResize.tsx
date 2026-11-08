import { useLayoutEffect, useRef, useState, type KeyboardEvent, type PointerEvent, type RefObject } from 'react';
import { librarySidebarSize } from './pdfLayout';
import './sidebar-resize.css';

export { librarySidebarSize } from './pdfLayout';

const minimumContentWidth = 480;
const separatorWidth = 6;

/** Keeps the existing sidebar a direct child so drawer and drop behavior survive. */
export function useLibrarySidebarResize({ width, onWidthChange, enabled, workspaceRef }: {
  width: number;
  onWidthChange: (width: number) => void;
  enabled: boolean;
  workspaceRef: RefObject<HTMLDivElement | null>;
}) {
  const divider = useRef<HTMLDivElement>(null);
  const drag = useRef<{ pointer: number; x: number; width: number; preview: number } | null>(null);
  const [maximum, setMaximum] = useState<number>(librarySidebarSize.max);
  const [preview, setPreview] = useState<number | null>(null);
  const clamp = (next: number) => Math.max(librarySidebarSize.min, Math.min(maximum, Math.round(next)));
  const displayedWidth = clamp(preview ?? width);

  function finishDrag(commit = false, event?: { pointerId: number }) {
    const start = drag.current;
    if (!start || (event && event.pointerId !== start.pointer)) return;
    drag.current = null;
    setPreview(null);
    if (divider.current?.hasPointerCapture(start.pointer)) divider.current.releasePointerCapture(start.pointer);
    // A simple click on a temporarily clamped sidebar must not change its preference.
    if (commit && enabled && clamp(start.preview) !== start.width) onWidthChange(clamp(start.preview));
  }

  useLayoutEffect(() => {
    if (!enabled) finishDrag();
    const element = workspaceRef.current;
    if (!element) return;
    const measure = () => {
      const available = element.getBoundingClientRect().width;
      if (available <= 0) { finishDrag(); return; }
      setMaximum(Math.max(librarySidebarSize.min, Math.min(librarySidebarSize.max, Math.floor(available - minimumContentWidth - separatorWidth))));
      if (divider.current && !divider.current.getClientRects().length) finishDrag();
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    const blur = () => finishDrag();
    window.addEventListener('blur', blur);
    return () => {
      observer.disconnect();
      window.removeEventListener('blur', blur);
      const pointer = drag.current?.pointer;
      drag.current = null;
      if (pointer !== undefined && divider.current?.hasPointerCapture(pointer)) divider.current.releasePointerCapture(pointer);
      // Release only: effect cleanup can run while the component is unmounting.
    };
  }, [enabled, workspaceRef]);

  // Losing availability while dragging rolls back the local preview as well.
  useLayoutEffect(() => { if (!enabled) setPreview(null); }, [enabled]);

  function beginDrag(event: PointerEvent<HTMLDivElement>) {
    if (!enabled || event.button !== 0 || !event.isPrimary || drag.current) return;
    event.preventDefault();
    event.currentTarget.focus({ preventScroll: true });
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { pointer: event.pointerId, x: event.clientX, width: displayedWidth, preview: displayedWidth };
    setPreview(displayedWidth);
  }

  function moveDrag(event: PointerEvent<HTMLDivElement>) {
    const start = drag.current;
    if (!start || start.pointer !== event.pointerId) return;
    start.preview = clamp(start.width + event.clientX - start.x);
    setPreview(start.preview);
  }

  function keyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.altKey || event.ctrlKey || event.metaKey || event.nativeEvent.isComposing) return;
    if (event.key === 'Escape' && drag.current) {
      event.preventDefault();
      event.stopPropagation();
      finishDrag();
    } else if (!drag.current && ['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) {
      event.preventDefault();
      event.stopPropagation();
      if (event.key === 'Home') onWidthChange(librarySidebarSize.default);
      else if (event.key === 'End') onWidthChange(maximum);
      else onWidthChange(clamp(displayedWidth + (event.key === 'ArrowRight' ? 1 : -1) * (event.shiftKey ? 40 : 10)));
    }
  }

  const separator = enabled ? <div ref={divider} className="pdf-sidebar-divider" role="separator" tabIndex={0}
    data-resizing={preview !== null} aria-label="Resize PDF library sidebar" aria-orientation="vertical"
    aria-controls="pdf-library-navigation" aria-valuemin={librarySidebarSize.min} aria-valuemax={maximum}
    aria-valuenow={displayedWidth} aria-valuetext={`${displayedWidth} pixels wide`}
    title="Drag to resize. Left/Right arrows adjust width; Home or double-click resets."
    onPointerDown={beginDrag} onPointerMove={moveDrag} onPointerUp={event => finishDrag(true, event)}
    onPointerCancel={event => finishDrag(false, event)} onLostPointerCapture={event => finishDrag(false, event)}
    onKeyDown={keyDown} onDoubleClick={() => { finishDrag(); onWidthChange(librarySidebarSize.default); }} /> : null;
  return { width: displayedWidth, separator };
}
