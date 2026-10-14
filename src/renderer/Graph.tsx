import { memo, useEffect, useId, useMemo, useRef, useState, type PointerEvent } from 'react';
import type { Note } from '../shared/types';
import { getNoteLinks, getTitle, resolveLink } from './markdown';
import './graph.css';

interface GraphProps {
  notes: Note[];
  activePath: string;
  onOpen: (path: string) => void;
  compact?: boolean;
}

interface Point { x: number; y: number }
interface Edge { source: string; target: string }

function createLayout(notes: Note[], edges: Edge[], width: number, height: number): Map<string, Point> {
  const count = notes.length;
  const degree = new Map<string, number>();
  for (const edge of edges) {
    degree.set(edge.source, (degree.get(edge.source) ?? 0) + 1);
    degree.set(edge.target, (degree.get(edge.target) ?? 0) + 1);
  }
  const ordered = [...notes].sort((a, b) => (degree.get(b.path) ?? 0) - (degree.get(a.path) ?? 0) || a.path.localeCompare(b.path));
  const points = ordered.map((note, index) => {
    const angle = index * 2.399963229728653;
    const radius = index ? Math.sqrt(index / Math.max(count, 1)) * height * 0.37 : 0;
    return { path: note.path, x: Math.cos(angle) * radius, y: Math.sin(angle) * radius, vx: 0, vy: 0 };
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

export const Graph = memo(function Graph({ notes, activePath, onOpen, compact = false }: GraphProps) {
  const width = compact ? 300 : 960;
  const height = compact ? 220 : 620;
  const patternId = useId().replace(/:/g, '');
  const svg = useRef<SVGSVGElement>(null);
  const drag = useRef<{ x: number; y: number; pan: Point } | null>(null);
  const [pan, setPan] = useState<Point>({ x: 0, y: 0 });
  const [zoom, setZoom] = useState(1);
  const [hovered, setHovered] = useState<string | null>(null);
  useEffect(() => {
    const canvas = svg.current;
    if (!canvas || compact) return;
    const wheel = (event: WheelEvent) => {
      event.preventDefault();
      setZoom(current => Math.max(0.4, Math.min(2.5, current - Math.sign(event.deltaY) * 0.1)));
    };
    canvas.addEventListener('wheel', wheel, { passive: false });
    return () => canvas.removeEventListener('wheel', wheel);
  }, [compact, notes.length]);
  const allEdges = useMemo(() => {
    const unique = new Map<string, Edge>();
    for (const note of notes) {
      for (const target of getNoteLinks(note)) {
        const resolved = resolveLink(target, note.path, notes);
        if (!resolved || resolved.path === note.path) continue;
        const pair = [note.path, resolved.path].sort();
        unique.set(JSON.stringify(pair), { source: pair[0], target: pair[1] });
      }
    }
    return [...unique.values()];
  }, [notes]);
  const graphNotes = useMemo(() => {
    if (!compact) return notes;
    const connected = new Set([activePath]);
    for (const edge of allEdges) {
      if (edge.source === activePath || edge.target === activePath) {
        connected.add(edge.source); connected.add(edge.target);
      }
    }
    return notes.filter(note => connected.has(note.path));
  }, [notes, allEdges, activePath, compact]);
  const edges = useMemo(() => {
    if (!compact) return allEdges;
    const visible = new Set(graphNotes.map(note => note.path));
    return allEdges.filter(edge => visible.has(edge.source) && visible.has(edge.target));
  }, [allEdges, graphNotes, compact]);
  const topology = useMemo(() => JSON.stringify([graphNotes.map(note => note.path), edges]), [graphNotes, edges]);
  // Text-only edits keep the existing layout; only changes to nodes/edges move it.
  const positions = useMemo(() => createLayout(graphNotes, edges, width, height), [topology, width, height]);
  const focused = hovered ?? activePath;
  const neighbors = new Set(edges.filter(edge => edge.source === focused || edge.target === focused).flatMap(edge => [edge.source, edge.target]));

  function pointerDown(event: PointerEvent<SVGSVGElement>) {
    if (compact || event.button !== 0 || (event.target as Element).closest('[data-graph-node]')) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { x: event.clientX, y: event.clientY, pan };
  }

  function pointerMove(event: PointerEvent<SVGSVGElement>) {
    if (!drag.current || !svg.current) return;
    const bounds = svg.current.getBoundingClientRect();
    const ratio = Math.min(bounds.width / width, bounds.height / height) || 1;
    setPan({ x: drag.current.pan.x + (event.clientX - drag.current.x) / ratio, y: drag.current.pan.y + (event.clientY - drag.current.y) / ratio });
  }

  const adjustZoom = (delta: number) => setZoom(current => Math.max(0.4, Math.min(2.5, current + delta)));

  return <div className={`graph-view${compact ? ' graph-compact' : ''}`}>
    {!compact && <div className="graph-caption"><span className="graph-caption-dot" /><span>{notes.length} notes<span className="graph-caption-separator">·</span>{edges.length} connections</span></div>}
    {notes.length === 0 ? <div className="graph-empty">Your ideas will connect here.<span>Create a note and link it with [[another note]].</span></div> : <svg
      ref={svg}
      className="graph-canvas"
      viewBox={`0 0 ${width} ${height}`}
      role="group"
      aria-label={compact ? 'Local note graph' : 'Note graph. Select a note to open it. Drag the background to pan.'}
      onPointerDown={pointerDown}
      onPointerMove={pointerMove}
      onPointerUp={() => { drag.current = null; }}
      onPointerCancel={() => { drag.current = null; }}
    >
      <defs><pattern id={patternId} width="25" height="25" patternUnits="userSpaceOnUse"><circle cx="1" cy="1" r="0.8" fill="currentColor" /></pattern></defs>
      {!compact && <rect width={width} height={height} fill={`url(#${patternId})`} className="graph-grid" />}
      <g transform={`translate(${width / 2 + pan.x} ${height / 2 + pan.y}) scale(${zoom})`}>
        {edges.map(edge => {
          const source = positions.get(edge.source)!; const target = positions.get(edge.target)!;
          const highlighted = edge.source === focused || edge.target === focused;
          return <line key={`${edge.source}:${edge.target}`} x1={source.x} y1={source.y} x2={target.x} y2={target.y} className={`graph-edge${highlighted ? ' graph-edge-highlight' : ''}`} />;
        })}
        {graphNotes.map(note => {
          const point = positions.get(note.path)!;
          const active = note.path === activePath;
          const title = getTitle(note);
          const maxLabel = compact ? 17 : 30;
          return <g key={note.path}
            data-graph-node="true"
            className={`graph-node${active ? ' graph-node-active' : ''}${neighbors.has(note.path) ? ' graph-node-connected' : ''}`}
            transform={`translate(${point.x} ${point.y})`}
            tabIndex={0} role="button" aria-label={`Open ${title}`} aria-pressed={active}
            onClick={() => onOpen(note.path)}
            onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onOpen(note.path); } }}
            onMouseEnter={() => setHovered(note.path)} onMouseLeave={() => setHovered(null)}
            onFocus={() => setHovered(note.path)} onBlur={() => setHovered(null)}
          >
            <title>{note.path}</title>
            <circle className="graph-node-hit" r={compact ? 13 : 22} />
            <circle className="graph-node-halo" r={compact ? 12 : 21} />
            <circle className="graph-node-dot" r={compact ? (active ? 5.5 : 3.5) : (active ? 10 : 6)} />
            {(!compact || active || neighbors.has(note.path)) && <text className="graph-node-label" y={compact ? 19 : 30} textAnchor="middle">{title.length > maxLabel ? `${title.slice(0, maxLabel - 1)}…` : title}</text>}
          </g>;
        })}
      </g>
    </svg>}
    {!compact && <><div className="graph-hint">Connected thoughts, a little clearer.</div><div className="graph-controls" aria-label="Graph zoom controls">
      <button type="button" onClick={() => adjustZoom(-0.2)} disabled={zoom <= 0.4} aria-label="Zoom out" title="Zoom out">−</button>
      <button type="button" onClick={() => { setZoom(1); setPan({ x: 0, y: 0 }); }} aria-label="Reset graph view" title="Reset view" className="graph-reset">{Math.round(zoom * 100)}%</button>
      <button type="button" onClick={() => adjustZoom(0.2)} disabled={zoom >= 2.5} aria-label="Zoom in" title="Zoom in">+</button>
    </div></>}
  </div>;
});

export default Graph;
