import { memo, useEffect, useId, useMemo, useRef, useState, type PointerEvent } from 'react';
import type { Note } from '../shared/types';
import type { PDFGraphCatalog } from '../shared/pdfGraph';
import type { PDFNoteBacklink, PDFPageTarget } from '../shared/pdfLinks';
import { buildGraphModel, noteGraphId, type GraphEdge, type GraphNode } from './graphModel';
import './graph.css';

interface GraphProps {
  notes: Note[];
  activePath: string;
  onOpen: (path: string) => void;
  compact?: boolean;
  manualPositions?: ReadonlyMap<string, GraphPoint>;
  onMoveNode?: (path: string, point: GraphPoint) => void;
  onResetLayout?: () => void;
  pdfBacklinks?: ReadonlyMap<string, readonly PDFNoteBacklink[]>;
  pdfCatalog?: PDFGraphCatalog;
  showPDFs?: boolean;
  onOpenPDF?: (target: PDFPageTarget) => void;
}

export interface GraphPoint { x: number; y: number }
type Point = GraphPoint;
interface Gesture {
  pointerId: number;
  node?: string;
  clientStart: Point;
  canvasStart: Point;
  initial: Point;
  zoom: number;
  moved: boolean;
  target: SVGElement;
}

function createLayout(nodes: GraphNode[], edges: GraphEdge[], width: number, height: number): Map<string, Point> {
  const count = nodes.length;
  const degree = new Map<string, number>();
  for (const edge of edges) {
    degree.set(edge.source, (degree.get(edge.source) ?? 0) + 1);
    degree.set(edge.target, (degree.get(edge.target) ?? 0) + 1);
  }
  const ordered = [...nodes].sort((a, b) => (degree.get(b.id) ?? 0) - (degree.get(a.id) ?? 0) || a.id.localeCompare(b.id));
  const points = ordered.map((node, index) => {
    const angle = index * 2.399963229728653;
    const radius = index ? Math.sqrt(index / Math.max(count, 1)) * height * 0.37 : 0;
    return { path: node.id, x: Math.cos(angle) * radius, y: Math.sin(angle) * radius, vx: 0, vy: 0 };
  });
  const indexes = new Map(points.map((point, index) => [point.path, index]));
  const springs = edges.map(edge => [indexes.get(edge.source)!, indexes.get(edge.target)!]);
  const scale = height / 620;
  const idealLength = Math.max(80, Math.min(175, height / Math.sqrt(Math.max(count, 3)))) * (height < 300 ? 0.7 : 1);
  // A bounded deterministic simulation avoids animation churn while typing.
  const iterations = count > 150 ? 50 : 180;
  for (let iteration = 0; iteration < iterations; iteration++) {
    for (let i = 0; i < count; i++) {
      const a = points[i];
      a.vx -= a.x * 0.0025;
      a.vy -= a.y * 0.0025;
      const sampleStep = Math.max(1, Math.floor(count / 180));
      for (let j = i + 1; j < count; j += sampleStep) {
        const b = points[j];
        const dx = a.x - b.x || 0.1;
        const dy = a.y - b.y || 0.1;
        const squared = Math.max(dx * dx + dy * dy, 60 * scale);
        const force = 1150 * scale * scale * sampleStep / squared;
        a.vx += dx * force; a.vy += dy * force;
        b.vx -= dx * force; b.vy -= dy * force;
      }
    }
    for (const [source, target] of springs) {
      const a = points[source]; const b = points[target];
      const dx = b.x - a.x; const dy = b.y - a.y;
      const length = Math.sqrt(dx * dx + dy * dy) || 1;
      const force = (length - idealLength) * 0.014 / length;
      a.vx += dx * force; a.vy += dy * force;
      b.vx -= dx * force; b.vy -= dy * force;
    }
    const cooling = 1 - iteration / (iterations + 1);
    for (const point of points) {
      point.vx *= 0.65; point.vy *= 0.65;
      point.x = Math.max(-width * 0.38, Math.min(width * 0.38, point.x + point.vx * cooling));
      point.y = Math.max(-height * 0.36, Math.min(height * 0.36, point.y + point.vy * cooling));
    }
  }
  return new Map(points.map(point => [point.path, { x: point.x, y: point.y }]));
}

export const Graph = memo(function Graph({ notes, activePath, onOpen, compact = false, manualPositions, onMoveNode, onResetLayout, pdfBacklinks, pdfCatalog, showPDFs = false, onOpenPDF }: GraphProps) {
  const width = compact ? 300 : 960;
  const height = compact ? 220 : 620;
  const patternId = useId().replace(/:/g, '');
  const svg = useRef<SVGSVGElement>(null);
  const drag = useRef<Gesture | null>(null);
  const suppressClick = useRef(false);
  const [draggedNode, setDraggedNode] = useState<string | null>(null);
  const [pan, setPan] = useState<Point>({ x: 0, y: 0 });
  const [zoom, setZoom] = useState(1);
  const [hovered, setHovered] = useState<string | null>(null);
  useEffect(() => {
    const canvas = svg.current;
    if (!canvas || compact) return;
    const wheel = (event: WheelEvent) => {
      event.preventDefault();
      if (drag.current) return;
      setZoom(current => Math.max(0.4, Math.min(2.5, current - Math.sign(event.deltaY) * 0.1)));
    };
    canvas.addEventListener('wheel', wheel, { passive: false });
    return () => canvas.removeEventListener('wheel', wheel);
  }, [compact, notes.length]);
  useEffect(() => {
    const cancel = () => finishGesture();
    window.addEventListener('blur', cancel);
    return () => window.removeEventListener('blur', cancel);
  }, []);
  const model = useMemo(() => buildGraphModel(notes, pdfBacklinks, pdfCatalog, !compact && showPDFs), [notes, pdfBacklinks, pdfCatalog, compact, showPDFs]);
  const activeId = noteGraphId(activePath);
  const graphNodes = useMemo(() => {
    if (!compact) return model.nodes;
    const connected = new Set([activeId]);
    for (const edge of model.edges) {
      if (edge.source === activeId || edge.target === activeId) {
        connected.add(edge.source); connected.add(edge.target);
      }
    }
    return model.nodes.filter(node => connected.has(node.id));
  }, [model, activeId, compact]);
  const edges = useMemo(() => {
    if (!compact) return model.edges;
    const visible = new Set(graphNodes.map(node => node.id));
    return model.edges.filter(edge => visible.has(edge.source) && visible.has(edge.target));
  }, [model, graphNodes, compact]);
  const topology = useMemo(() => JSON.stringify([graphNodes.map(node => node.id), edges]), [graphNodes, edges]);
  // Text-only edits keep the existing layout; only changes to nodes/edges move it.
  const layout = useMemo(() => createLayout(graphNodes, edges, width, height), [topology, width, height]);
  useEffect(() => {
    // Filtering/removing a node must not leave pointer capture or a stale drag
    // attached to its old DOM. Metadata label changes keep the gesture intact.
    if (drag.current) finishGesture();
    setHovered(current => current && graphNodes.some(node => node.id === current) ? current : null);
  }, [topology, compact]);
  const positions = useMemo(() => {
    if (compact || !manualPositions?.size) return layout;
    return new Map([...layout].map(([path, point]) => [path, manualPositions.get(path) ?? point]));
  }, [layout, compact, manualPositions]);
  const focused = hovered ?? activeId;
  const neighbors = new Set(edges.filter(edge => edge.source === focused || edge.target === focused).flatMap(edge => [edge.source, edge.target]));
  const pdfCount = graphNodes.filter(node => node.kind === 'pdf').length;

  function openNode(node: GraphNode) {
    if (node.kind === 'note') onOpen(node.path);
    else onOpenPDF?.({ documentId: node.documentId, page: node.page });
  }

  function canvasPoint(event: PointerEvent<SVGElement>): Point | null {
    const matrix = svg.current?.getScreenCTM();
    if (!matrix) return null;
    // The inverse includes viewBox scaling and letterboxing on wide windows.
    return new DOMPoint(event.clientX, event.clientY).matrixTransform(matrix.inverse());
  }

  function pointerDown(event: PointerEvent<SVGElement>, node?: string) {
    if (compact || event.button !== 0 || !event.isPrimary || drag.current) return;
    const start = canvasPoint(event);
    if (!start) return;
    event.preventDefault();
    event.stopPropagation();
    suppressClick.current = false;
    // Capture on the node itself so a click still targets that note.
    event.currentTarget.setPointerCapture(event.pointerId);
    if (node) event.currentTarget.focus();
    drag.current = {
      pointerId: event.pointerId, node, clientStart: { x: event.clientX, y: event.clientY },
      canvasStart: start, initial: node ? positions.get(node)! : pan,
      zoom, moved: false, target: event.currentTarget,
    };
  }

  function pointerMove(event: PointerEvent<SVGSVGElement>) {
    const gesture = drag.current;
    if (!gesture || gesture.pointerId !== event.pointerId) return;
    if (!gesture.moved && Math.hypot(event.clientX - gesture.clientStart.x, event.clientY - gesture.clientStart.y) < 4) return;
    const point = canvasPoint(event);
    if (!point) return;
    gesture.moved = true;
    const scale = gesture.node ? gesture.zoom : 1;
    const next = {
      x: gesture.initial.x + (point.x - gesture.canvasStart.x) / scale,
      y: gesture.initial.y + (point.y - gesture.canvasStart.y) / scale,
    };
    if (gesture.node) {
      setDraggedNode(gesture.node);
      onMoveNode?.(gesture.node, next);
    } else setPan(next);
  }

  function finishGesture(event?: PointerEvent<SVGSVGElement>) {
    const gesture = drag.current;
    if (!gesture || (event && gesture.pointerId !== event.pointerId)) return;
    if (gesture.node) suppressClick.current = gesture.moved || event?.type !== 'pointerup';
    drag.current = null;
    setDraggedNode(null);
    if (gesture.target.hasPointerCapture(gesture.pointerId)) gesture.target.releasePointerCapture(gesture.pointerId);
  }

  const adjustZoom = (delta: number) => setZoom(current => Math.max(0.4, Math.min(2.5, current + delta)));

  return <div className={`graph-view${compact ? ' graph-compact' : ''}`}>
    {!compact && <div className="graph-caption"><span className="graph-caption-dot" /><span>{notes.length} notes{pdfCount > 0 && <><span className="graph-caption-separator">·</span>{pdfCount} PDFs</>}<span className="graph-caption-separator">·</span>{edges.length} connections</span></div>}
    {notes.length === 0 ? <div className="graph-empty">Your ideas will connect here.<span>Create a note and link it with [[another note]].</span></div> : <svg
      ref={svg}
      className="graph-canvas"
      viewBox={`0 0 ${width} ${height}`}
      role="group"
      aria-label={compact ? 'Local note graph' : pdfCount ? 'Note and PDF graph. Select a node to open it. Drag the background to pan.' : 'Note graph. Select a note to open it. Drag the background to pan.'}
      onPointerDown={event => pointerDown(event)}
      onPointerMove={pointerMove}
      onPointerUp={finishGesture}
      onPointerCancel={finishGesture}
      onLostPointerCapture={finishGesture}
    >
      <defs><pattern id={patternId} width="25" height="25" patternUnits="userSpaceOnUse"><circle cx="1" cy="1" r="0.8" fill="currentColor" /></pattern></defs>
      {!compact && <rect width={width} height={height} fill={`url(#${patternId})`} className="graph-grid" />}
      <g transform={`translate(${width / 2 + pan.x} ${height / 2 + pan.y}) scale(${zoom})`}>
        {edges.map(edge => {
          const source = positions.get(edge.source)!; const target = positions.get(edge.target)!;
          const highlighted = edge.source === focused || edge.target === focused;
          return <line key={JSON.stringify([edge.source, edge.target])} data-source={edge.source} data-target={edge.target} x1={source.x} y1={source.y} x2={target.x} y2={target.y} className={`graph-edge${edge.kind === 'pdf' ? ' graph-edge-pdf' : ''}${highlighted ? ' graph-edge-highlight' : ''}`} />;
        })}
        {graphNodes.map(node => {
          const point = positions.get(node.id)!;
          const active = node.id === activeId;
          const title = node.title;
          const isPDF = node.kind === 'pdf';
          const accessibleLabel = node.kind === 'note' ? `Open ${title}`
            : node.availability === 'missing' ? `Open missing PDF ${node.documentId}`
              : `Open PDF ${node.availability === 'available' ? title : node.documentId}`;
          const maxLabel = compact ? 12 : 28;
          // Keep the larger labels inside the canvas at its default zoom. Edge
          // nodes point their labels inward; the accessible name stays complete.
          const labelAnchor = point.x < -width * 0.18 ? 'start' : point.x > width * 0.18 ? 'end' : 'middle';
          return <g key={node.id}
            data-graph-node="true"
            data-graph-id={node.id} data-node-kind={node.kind} data-pdf-id={node.kind === 'pdf' ? node.documentId : undefined}
            className={`graph-node${isPDF ? ` graph-node-pdf graph-node-pdf-${node.availability}` : ''}${active ? ' graph-node-active' : ''}${neighbors.has(node.id) ? ' graph-node-connected' : ''}${draggedNode === node.id ? ' graph-node-dragging' : ''}`}
            transform={`translate(${point.x} ${point.y})`}
            tabIndex={0} role="button" aria-label={accessibleLabel} aria-pressed={active}
            aria-description={compact ? undefined : `Drag or use arrow keys to move. Hold Shift for larger steps. Enter or Space ${node.kind === 'pdf' ? `opens cited page ${node.page}${node.availability === 'missing' ? ' with recovery options' : ''}` : 'opens the note'}.`}
            onPointerDown={event => pointerDown(event, node.id)}
            onClick={event => {
              if (drag.current) return;
              if (event.detail !== 0 && suppressClick.current) { suppressClick.current = false; return; }
              openNode(node);
            }}
            onKeyDown={event => {
              if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); if (!drag.current) openNode(node); }
              if (compact || drag.current || event.ctrlKey || event.metaKey || event.altKey) return;
              const step = (event.shiftKey ? 40 : 10) / zoom;
              const delta: Record<string, Point> = { ArrowLeft: { x: -step, y: 0 }, ArrowRight: { x: step, y: 0 }, ArrowUp: { x: 0, y: -step }, ArrowDown: { x: 0, y: step } };
              if (delta[event.key]) {
                event.preventDefault();
                onMoveNode?.(node.id, { x: point.x + delta[event.key].x, y: point.y + delta[event.key].y });
              }
            }}
            onMouseEnter={() => setHovered(node.id)} onMouseLeave={() => setHovered(null)}
            onFocus={() => setHovered(node.id)} onBlur={() => setHovered(null)}
          >
            <title>{node.kind === 'note' ? node.path : `${node.title}\n${node.documentId}\nCited pages: ${node.pages.join(', ')}\nOpens page ${node.page}${node.availability === 'missing' ? '\nMissing from this library; open for recovery options.' : ''}`}</title>
            <circle className="graph-node-hit" r={compact ? 13 : 22} />
            <circle className="graph-node-halo" r={compact ? 12 : 21} />
            {isPDF ? <><path className="graph-node-document" d="M-11-16H3L11-8V16H-11Z M3-16V-8H11" /><text className="graph-node-pdf-badge" y="7" textAnchor="middle" aria-hidden="true">PDF</text></>
              : <circle className="graph-node-dot" r={compact ? (active ? 5.5 : 3.5) : (active ? 10 : 6)} />}
            {(!compact || active || neighbors.has(node.id)) && <text className="graph-node-label" y={compact ? 24 : 34} textAnchor={labelAnchor}>{title.length > maxLabel ? `${title.slice(0, maxLabel - 1)}…` : title}</text>}
          </g>;
        })}
      </g>
    </svg>}
    {!compact && <><div className="graph-hint">Drag {pdfCount ? 'nodes' : 'notes'} to arrange.</div><div className="graph-controls" aria-label="Graph zoom controls">
      <button type="button" onClick={() => { onResetLayout?.(); setZoom(1); setPan({ x: 0, y: 0 }); }} aria-label="Reset graph layout" title="Restore the automatic layout" className="graph-reset">Reset layout</button>
      <button type="button" onClick={() => adjustZoom(-0.2)} disabled={zoom <= 0.4} aria-label="Zoom out" title="Zoom out">−</button>
      <button type="button" onClick={() => { setZoom(1); setPan({ x: 0, y: 0 }); }} aria-label="Reset graph view" title="Reset view" className="graph-reset">{Math.round(zoom * 100)}%</button>
      <button type="button" onClick={() => adjustZoom(0.2)} disabled={zoom >= 2.5} aria-label="Zoom in" title="Zoom in">+</button>
    </div></>}
  </div>;
});

export default Graph;
