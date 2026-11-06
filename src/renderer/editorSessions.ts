import { historyField } from '@codemirror/commands';
import type { EditorState, StateEffect } from '@codemirror/state';

export const editorHistoryFields = { history: historyField };
export const EDITOR_SESSION_LIMITS = { entries: 20, bytes: 8 * 1024 * 1024, entryBytes: 2 * 1024 * 1024 } as const;

export interface EditorSnapshot {
  json: Record<string, unknown>;
  lineEnding: string;
  // CodeMirror's public scrollSnapshot effect contains a document position and
  // offsets, not an EditorView, DOM node, or callback to a retired editor.
  scrollTo?: StateEffect<unknown>;
}

interface Entry {
  json: string;
  lineEnding: string;
  scrollTo?: StateEffect<unknown>;
  bytes: number;
}

/** Stop before stringifying an oversized history, including a single huge string. */
function serializeWithinBudget(value: unknown, maximumBytes: number): string | undefined {
  let remaining = Math.floor(maximumBytes / 2);
  const exhausted = {};
  try {
    const result = JSON.stringify(value, (key, item: unknown) => {
      // Conservatively account for object keys, delimiters, and primitive
      // values. Retained payload size is also checked exactly below.
      remaining -= key.length + 4;
      if (typeof item === 'string') {
        remaining -= item.length;
        if (remaining < 0) throw exhausted;
        for (let index = 0; index < item.length; index++) {
          const code = item.charCodeAt(index);
          if (code === 34 || code === 92 || code === 8 || code === 9 || code === 10 || code === 12 || code === 13) remaining--;
          else if (code < 32) remaining -= 5;
          else if (code >= 0xd800 && code <= 0xdbff) {
            const next = item.charCodeAt(index + 1);
            if (next >= 0xdc00 && next <= 0xdfff) index++;
            else remaining -= 5;
          } else if (code >= 0xdc00 && code <= 0xdfff) remaining -= 5;
          if (remaining < 0) throw exhausted;
        }
      } else if (typeof item === 'number') remaining -= 24;
      else if (typeof item === 'boolean' || item === null) remaining -= 5;
      if (remaining < 0) throw exhausted;
      return item;
    });
    return result && result.length * 2 <= maximumBytes ? result : undefined;
  } catch (error) {
    if (error === exhausted) return undefined;
    throw error;
  }
}

/** Inactive-note history only. Draft text stays authoritative in App. */
export class EditorSessions {
  private entries = new Map<string, Entry>();
  private currentGeneration = 0;
  private retained = 0;

  constructor(private readonly limits: { entries: number; bytes: number; entryBytes: number } = EDITOR_SESSION_LIMITS) {}

  get generation(): number { return this.currentGeneration; }
  get size(): number { return this.entries.size; }
  get retainedBytes(): number { return this.retained; }

  clear(): void {
    this.currentGeneration++;
    this.entries.clear();
    this.retained = 0;
  }

  private remove(path: string): Entry | undefined {
    const entry = this.entries.get(path);
    if (entry) { this.entries.delete(path); this.retained -= entry.bytes; }
    return entry;
  }

  capture(path: string, generation: number, state: EditorState, lineEnding: string, scrollTo?: StateEffect<unknown>): boolean {
    // An old editor can unmount after acceptWorkspace has cleared the cache.
    if (generation !== this.currentGeneration) return false;
    this.remove(path);
    const maximum = Math.min(this.limits.entryBytes, this.limits.bytes) - path.length * 2;
    if (this.limits.entries < 1 || maximum <= 0 || state.doc.length * 2 > maximum) return false;
    let json: string | undefined;
    try { json = serializeWithinBudget(state.toJSON(editorHistoryFields), maximum); }
    catch { return false; } // Optional history must never prevent navigation.
    if (!json) return false;
    const bytes = json.length * 2 + path.length * 2;
    while (this.entries.size >= this.limits.entries || this.retained + bytes > this.limits.bytes) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) return false;
      this.remove(oldest);
    }
    this.entries.set(path, { json, lineEnding, scrollTo, bytes });
    this.retained += bytes;
    return true;
  }

  restore(path: string, generation: number, content: string): EditorSnapshot | undefined {
    if (generation !== this.currentGeneration) return undefined;
    // Consume the snapshot while its note is active. Returning to another note
    // captures it again as the most recently visited inactive editor.
    const entry = this.remove(path);
    if (!entry) return undefined;
    try {
      const json = JSON.parse(entry.json) as Record<string, unknown>;
      if (typeof json.doc !== 'string' || !['\n', '\r\n', '\r'].includes(entry.lineEnding)
        || json.doc.replace(/\n/g, entry.lineEnding) !== content) return undefined;
      return { json, lineEnding: entry.lineEnding, scrollTo: entry.scrollTo };
    } catch { return undefined; }
  }
}
