import { markdownLanguage } from '@codemirror/lang-markdown';
import type { Links } from 'marked';
import { type MathRange, scanMarkdownMath } from './math';
import { getMarkdownReferences } from './markdown';

export interface TableCellRange { from: number; to: number }
export interface TableRowRange { from: number; to: number; cells: TableCellRange[] }
export interface MarkdownTableRange {
  from: number;
  to: number;
  raw: string;
  references: Links;
  /** Include reference changes in widget identity without retaining the full note. */
  referenceKey: string;
  rows: TableRowRange[];
}

function escapedAt(source: string, position: number): boolean {
  let backslashes = 0;
  while (position > 0 && source[--position] === '\\') backslashes++;
  return backslashes % 2 === 1;
}

/** GFM pipes delimit cells even inside code spans; escaped pipes remain literal. */
function rowCells(source: string, from: number, to: number, math: readonly MathRange[] = []): TableCellRange[] {
  let start = from;
  let end = to;
  while (start < end && /\s/.test(source[start])) start++;
  while (end > start && /\s/.test(source[end - 1])) end--;
  if (source[start] === '|') start++;
  if (end > start && source[end - 1] === '|' && !escapedAt(source, end - 1)) end--;
  const cells: TableCellRange[] = [];
  let slot = start;
  for (let position = start; position <= end; position++) {
    if (position !== end && (source[position] !== '|' || escapedAt(source, position)
      || math.some(range => position >= range.from && position < range.to))) continue;
    const text = source.slice(slot, position);
    const leading = /^\s*/.exec(text)![0].length;
    const trailing = /\s*$/.exec(text)![0].length;
    const cellFrom = leading === text.length ? Math.min(slot + 1, position) : slot + leading;
    cells.push({ from: cellFrom, to: Math.max(cellFrom, position - trailing) });
    slot = position + 1;
  }
  return cells;
}

let lastScan: { source: string; ranges: MarkdownTableRange[] } | undefined;

/** Scan CodeMirror's LF-normalized source. Container tables retain their source. */
export function scanMarkdownTables(source: string): MarkdownTableRange[] {
  if (lastScan?.source === source) return lastScan.ranges;
  const ranges: MarkdownTableRange[] = [];
  if (source.includes('|')) {
    // Treat a UTF-8 BOM as encoding metadata without shifting source positions.
    const offset = source.startsWith('\ufeff') ? 1 : 0;
    const math = scanMarkdownMath(source);
    // The reading renderer hides math before recognizing Markdown structure.
    // Mask it here too, preserving every UTF-16 offset and newline so headers
    // such as | $|x|$ | B | have the same columns and exact source positions.
    const structural: string[] = [];
    let position = 0;
    for (const range of math) {
      structural.push(source.slice(position, range.from), range.raw.replace(/[^\n]/g, 'x'));
      position = range.to;
    }
    structural.push(source.slice(position));
    const tree = markdownLanguage.parser.parse(structural.join('').slice(offset));
    tree.iterate({
      enter(reference) {
        const node = reference.node;
        if (node.name !== 'Table') return;
        if (node.parent?.name !== 'Document') return false;
        const from = node.from + offset;
        const to = node.to + offset;
        let low = 0;
        let high = math.length;
        while (low < high) {
          const middle = (low + high) >>> 1;
          if (math[middle].to <= from) low = middle + 1; else high = middle;
        }
        let end = low;
        while (end < math.length && math[end].from < to) end++;
        const tableMath = math.slice(low, end);
        // A table-looking fragment inside a multiline equation belongs to math.
        // Inline and single-cell display formulas are rendered by the table.
        if (tableMath.some(range => range.from < from || range.to > to || /[\r\n]/.test(range.raw))) return false;
        const rows: TableRowRange[] = [];
        let mathIndex = 0;
        for (let row = node.firstChild; row; row = row.nextSibling) {
          if (row.name !== 'TableHeader' && row.name !== 'TableRow') continue;
          const rowFrom = row.from + offset;
          const rowTo = row.to + offset;
          while (mathIndex < tableMath.length && tableMath[mathIndex].to <= rowFrom) mathIndex++;
          const mathStart = mathIndex;
          while (mathIndex < tableMath.length && tableMath[mathIndex].to <= rowTo) mathIndex++;
          rows.push({
            from: rowFrom, to: rowTo,
            // The shared renderer protects TeX before Markdown tokenization,
            // so pipes inside a formula must not shift subsequent cell targets.
            cells: rowCells(source, rowFrom, rowTo, tableMath.slice(mathStart, mathIndex)),
          });
        }
        const delimiter = node.getChild('TableDelimiter');
        if (!delimiter || rows[0]?.cells.length !== rowCells(source, delimiter.from + offset, delimiter.to + offset).length) return false;
        const raw = source.slice(from, to);
        ranges.push({ from, to, raw, references: {}, referenceKey: '', rows });
        return false;
      },
    });
    if (ranges.length) {
      // Marked owns reference syntax and precedence in Read/Split, including
      // definitions nested in containers and escapes the editor parser lacks.
      const references = getMarkdownReferences(source);
      const referenceKey = JSON.stringify(references);
      for (const table of ranges) Object.assign(table, { references, referenceKey });
    }
  }
  lastScan = { source, ranges };
  return ranges;
}

export function isWithinMarkdownTable(tables: readonly MarkdownTableRange[], from: number, to: number): boolean {
  let low = 0;
  let high = tables.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (tables[middle].from <= from) low = middle + 1; else high = middle;
  }
  const table = tables[low - 1];
  return Boolean(table && from >= table.from && to <= table.to);
}

/** Resolve from the current table, so widgets reused after edits never use stale offsets. */
export function tableCellPosition(table: MarkdownTableRange, rowIndex: number, columnIndex: number): number {
  const row = table.rows[rowIndex] ?? table.rows[0];
  return row?.cells[columnIndex]?.from ?? row?.to ?? table.from;
}
