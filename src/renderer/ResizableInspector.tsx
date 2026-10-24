import { useLayoutEffect, useRef, useState, type KeyboardEvent, type PointerEvent, type ReactNode } from 'react';
import { inspectorSize } from './appearance';

const minimumEditorWidth = 480;

export function ResizableInspector({ width, onWidthChange, children }: {
  width: number; onWidthChange: (width: number) => void; children: ReactNode;
}) {
  const panel = useRef<HTMLDivElement>(null);
  const divider = useRef<HTMLDivElement>(null);
  const drag = useRef<{ pointer: number; x: number; width: number; savedWidth: number } | null>(null);
  const [maximum, setMaximum] = useState<number>(inspectorSize.max);
  const [resizing, setResizing] = useState(false);
  const displayedWidth = Math.min(width, maximum);

  function finishDrag(event?: { pointerId: number }) {
    if (event && event.pointerId !== drag.current?.pointer) return;
    const pointer = drag.current?.pointer;
    drag.current = null;
    setResizing(false);
    if (pointer !== undefined && divider.current?.hasPointerCapture(pointer)) divider.current.releasePointerCapture(pointer);
  }

  useLayoutEffect(() => {
    const element = panel.current;
    const container = element?.parentElement;
    if (!element || !container) return;
    const sidebar = container.querySelector<HTMLElement>(':scope > .sidebar');
    const measure = () => {
      const available = container.clientWidth - (sidebar?.getBoundingClientRect().width ?? 0);
      setMaximum(Math.max(inspectorSize.min, Math.min(inspectorSize.max, Math.floor(available - minimumEditorWidth))));
      // A responsive hide must not leave an invisible separator holding a drag.
      if (!element.getClientRects().length) finishDrag();
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(container);
    if (sidebar) observer.observe(sidebar);
    const blur = () => finishDrag();
    window.addEventListener('blur', blur);
    return () => {
      observer.disconnect();
      window.removeEventListener('blur', blur);
    };
  }, []);

  function changeWidth(next: number) {
    onWidthChange(Math.max(inspectorSize.min, Math.min(maximum, Math.round(next))));
  }

  function beginDrag(event: PointerEvent<HTMLDivElement>) {
    if (event.button !== 0 || !event.isPrimary || drag.current) return;
    event.preventDefault();
    event.currentTarget.focus({ preventScroll: true });
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { pointer: event.pointerId, x: event.clientX, width: displayedWidth, savedWidth: width };
    setResizing(true);
  }

  function moveDrag(event: PointerEvent<HTMLDivElement>) {
    const start = drag.current;
    if (!start || start.pointer !== event.pointerId) return;
    changeWidth(start.width + start.x - event.clientX);
  }

  function keyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    if (event.key === 'Escape' && drag.current) {
      event.preventDefault();
      onWidthChange(drag.current.savedWidth);
      finishDrag();
    } else if (!drag.current && ['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) {
      event.preventDefault();
      if (event.key === 'Home') onWidthChange(inspectorSize.default);
      else if (event.key === 'End') changeWidth(maximum);
      else changeWidth(displayedWidth + (event.key === 'ArrowLeft' ? 1 : -1) * (event.shiftKey ? 40 : 10));
    }
  }

  return <div ref={panel} className="inspector-panel" style={{ width: displayedWidth }} data-resizing={resizing}>
    <div ref={divider} className="inspector-divider" role="separator" tabIndex={0}
      aria-label="Resize note inspector" aria-orientation="vertical" aria-controls="note-inspector"
      aria-valuemin={inspectorSize.min} aria-valuemax={maximum} aria-valuenow={displayedWidth} aria-valuetext={`${displayedWidth} pixels wide`}
      title="Drag to resize. Left/Right arrows adjust width; Home or double-click resets."
      onPointerDown={beginDrag} onPointerMove={moveDrag}
      onPointerUp={finishDrag} onPointerCancel={finishDrag} onLostPointerCapture={finishDrag}
      onKeyDown={keyDown} onDoubleClick={() => { finishDrag(); onWidthChange(inspectorSize.default); }} />
    <aside id="note-inspector" className="inspector" aria-label="In this note">{children}</aside>
  </div>;
}
