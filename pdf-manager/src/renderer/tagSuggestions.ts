export interface TagSegment { from: number; to: number }

/** Work on the whole comma-delimited tag containing the caret, not the full field. */
export function getTagSuggestions(value: string, selectionStart: number, selectionEnd: number, candidates: readonly string[]) {
  const start = Math.max(0, Math.min(value.length, selectionStart));
  const end = Math.max(start, Math.min(value.length, selectionEnd));
  const from = start === 0 ? 0 : value.lastIndexOf(',', start - 1) + 1;
  const comma = value.indexOf(',', start);
  const to = comma < 0 ? value.length : comma;
  const query = value.slice(from, to).trim().toLowerCase();
  const used = new Set(value.split(',').map(tag => tag.trim().toLowerCase()));
  const seen = new Set<string>();
  // A selection crossing commas is a normal text edit, never a tag replacement.
  const options = end > to ? [] : candidates.filter(candidate => {
    const key = candidate.toLowerCase();
    if (!candidate || candidate.includes(',') || seen.has(key)) return false;
    seen.add(key);
    return !used.has(key) && key.includes(query)
      && insertTagSuggestion(value, { from, to }, candidate) !== null;
  });
  return { from, to, options };
}

export function insertTagSuggestion(value: string, segment: TagSegment, tag: string): { value: string; caret: number } | null {
  const current = value.slice(segment.from, segment.to);
  const leading = current.match(/^\s*/)?.[0] ?? '';
  const trailing = current.trim() ? current.match(/\s*$/)?.[0] ?? '' : '';
  const prefix = value.slice(0, segment.from) + leading + tag;
  const next = segment.to === value.length ? prefix + ', ' : prefix + trailing + value.slice(segment.to);
  if (next.length > 800) return null;
  return { value: next, caret: segment.to === value.length ? next.length : prefix.length };
}
