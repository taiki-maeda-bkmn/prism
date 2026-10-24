import { markdownLanguage } from '@codemirror/lang-markdown';
import type { SyntaxNode } from '@lezer/common';
import type { Links } from 'marked';
import { type MathRange, scanMarkdownMath } from './math';
import { getMarkdownReferences } from './markdown';

export interface TableCellRange { from: number; to: number }
export interface TableRowRange { from: number; to: number; cells: TableCellRange[] }
export type TableContainer = { kind: 'quote' } | {
  kind: 'list';
  /** Source columns between this item's marker and its content, including tabs. */
  indent: number;
  /** Present only when this table shares the list item's opening source line. */
  marker?: string;
  markerOffset?: number;
};
export interface MarkdownTableRange {
  from: number;
  to: number;
  raw: string;
  /** Standalone table Markdown with container prefixes removed, never saved. */
  markdown: string;
  containers: TableContainer[];
  references: Links;
  /** Include reference changes in widget identity without retaining the full note. */
  referenceKey: string;
  rows: TableRowRange[];
}

function lineStart(source: string, position: number, offset: number): number {
  return Math.max(offset, source.lastIndexOf('\n', position - 1) + 1);
}

function columns(source: string, from: number, to: number): number {
  let column = 0;
  for (let position = from; position < to; position++) {
    column = source[position] === '\t' ? column + 4 - column % 4 : column + 1;
  }
  return column;
}

function tableContainers(
  source: string, table: SyntaxNode, offset: number, from: number,
  orderedNumbers: Map<number, Map<number, number>>,
): { containers: TableContainer[]; openingMarks: { from: number; to: number }[] } | null {
  const ancestors: SyntaxNode[] = [];
  for (let ancestor = table.parent; ancestor?.name !== 'Document'; ancestor = ancestor?.parent ?? null) {
    if (!ancestor || !['Blockquote', 'ListItem', 'BulletList', 'OrderedList'].includes(ancestor.name)) return null;
    if (ancestor.name === 'Blockquote' || ancestor.name === 'ListItem') ancestors.push(ancestor);
  }
  const containers: TableContainer[] = [];
  const openingMarks: { from: number; to: number }[] = [];
  let listDepth = 0;
  for (const ancestor of ancestors.reverse()) {
    if (ancestor.name === 'Blockquote') { containers.push({ kind: 'quote' }); continue; }
    const mark = ancestor.getChild('ListMark');
    const list = ancestor.parent;
    if (!mark || !list || !['BulletList', 'OrderedList'].includes(list.name)) return null;
    const markerFrom = mark.from + offset;
    const markerTo = mark.to + offset;
    const markerLine = lineStart(source, markerFrom, offset);
    let contentFrom = markerTo;
    while (contentFrom < source.length && /[ \t]/.test(source[contentFrom])) contentFrom++;
    const gap = columns(source, markerLine, contentFrom) - columns(source, markerLine, markerTo);
    // Match Markdown's list base: five or more spaces begin indented code,
    // while a blank opener uses a single separating column regardless of padding.
    const indent = markerTo - markerFrom + (gap >= 5 || contentFrom === source.length || source[contentFrom] === '\n' ? 1 : Math.max(1, gap));
    let marker: string | undefined;
    if (markerLine === from) {
      if (list.name === 'OrderedList') {
        let numbers = orderedNumbers.get(list.from);
        if (!numbers) {
          numbers = new Map();
          let number: number | undefined;
          for (let item = list.firstChild; item; item = item.nextSibling) {
            if (item.name !== 'ListItem') continue;
            const itemMark = item.getChild('ListMark');
            if (!itemMark) continue;
            number ??= Number.parseInt(source.slice(itemMark.from + offset, itemMark.to + offset), 10);
            numbers.set(item.from, number++);
          }
          orderedNumbers.set(list.from, numbers);
        }
        marker = `${numbers.get(ancestor.from)}.`;
      } else marker = ['•', '◦', '▪'][listDepth % 3];
      openingMarks.push({ from: markerFrom, to: markerTo });
    }
    containers.push({ kind: 'list', indent, ...(marker ? { marker, markerOffset: markerFrom - from } : {}) });
    listDepth++;
  }
  return { containers, openingMarks };
}

/** Only structural prefixes may be hidden; missing quote markers stay literal. */
function validPrefix(
  source: string, from: number, to: number, quoteDepth: number,
  openingMarks: readonly { from: number; to: number }[] = [],
): boolean {
  let prefix = source.slice(from, to);
  for (const mark of openingMarks) {
    if (mark.from < from || mark.to > to) return false;
    const start = mark.from - from;
    prefix = prefix.slice(0, start) + ' '.repeat(mark.to - mark.from) + prefix.slice(mark.to - from);
  }
  return /^[ \t>]*$/.test(prefix) && (prefix.match(/>/g)?.length ?? 0) === quoteDepth;
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

/** Scan CodeMirror's LF-normalized source without rewriting container prefixes. */
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
    const orderedNumbers = new Map<number, Map<number, number>>();
    tree.iterate({
      enter(reference) {
        const node = reference.node;
        if (node.name !== 'Table') return;
        const contentFrom = node.from + offset;
        const physicalFrom = lineStart(source, contentFrom, offset);
        const context = tableContainers(source, node, offset, physicalFrom, orderedNumbers);
        if (!context) return false;
        const { containers, openingMarks } = context;
        // A block replacement owns all first-line container syntax. Plain
        // tables retain their existing source range for compatibility.
        const from = containers.length ? physicalFrom : contentFrom;
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
        const tableLines: string[] = [];
        const quoteDepth = containers.filter(container => container.kind === 'quote').length;
        let mathIndex = 0;
        let previousLineEnd: number | undefined;
        for (let row = node.firstChild; row; row = row.nextSibling) {
          if (!['TableHeader', 'TableDelimiter', 'TableRow'].includes(row.name)) continue;
          const rowFrom = row.from + offset;
          const rowTo = row.to + offset;
          const physicalStart = lineStart(source, rowFrom, offset);
          // Lezer accepts some lazy quote continuations that Read mode treats
          // as prose. Require explicit quote prefixes and contiguous row lines
          // so rendering cannot silently absorb unrelated container content.
          if (source.slice(rowFrom, rowTo).includes('\n')
            || (previousLineEnd !== undefined && physicalStart !== previousLineEnd + 1)
            || !validPrefix(source, physicalStart, rowFrom, quoteDepth, previousLineEnd === undefined ? openingMarks : [])) return false;
          previousLineEnd = rowTo;
          tableLines.push(source.slice(rowFrom, rowTo));
          if (row.name === 'TableDelimiter') continue;
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
        if (previousLineEnd !== to || !delimiter || rows[0]?.cells.length !== rowCells(source, delimiter.from + offset, delimiter.to + offset).length) return false;
        const raw = source.slice(from, to);
        ranges.push({ from, to, raw, markdown: tableLines.join('\n'), containers, references: {}, referenceKey: '', rows });
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
