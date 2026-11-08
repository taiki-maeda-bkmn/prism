import { useMemo, useState, type ReactNode } from 'react';
import { ChevronDown, ChevronRight, FileText, Folder } from 'lucide-react';
import type { Note } from '../shared/types';
import { matchesNoteFolder } from './noteFolders';

interface Branch {
  folders: Map<string, Branch>;
  notes: Map<string, Note>;
}
const branch = (): Branch => ({ folders: new Map(), notes: new Map() });

interface NoteTreeProps {
  notes: Note[];
  folders: readonly string[];
  activePath: string;
  drafts: Record<string, string>;
  query: string;
  onOpen: (path: string) => void;
  selectedFolder: string | null;
}

export function NoteTree({ notes, folders, activePath, drafts, query, onOpen, selectedFolder }: NoteTreeProps) {
  const [closed, setClosed] = useState<Set<string>>(new Set());
  const searching = !!query.trim();
  const prefix = selectedFolder ? `${selectedFolder}/` : '';
  const tree = useMemo(() => {
    const root = branch();
    const directory = (parts: string[]) => {
      let parent = root;
      for (const part of parts) {
        let child = parent.folders.get(part);
        if (!child) { child = branch(); parent.folders.set(part, child); }
        parent = child;
      }
      return parent;
    };
    if (!searching && selectedFolder !== '') {
      for (const folder of folders) {
        if (prefix && !folder.startsWith(prefix)) continue;
        const relative = folder.slice(prefix.length);
        if (relative) directory(relative.split('/'));
      }
    }
    for (const note of notes) {
      if (!matchesNoteFolder(note.path, selectedFolder)) continue;
      const parts = note.path.slice(prefix.length).split('/');
      const name = parts.pop()!;
      directory(parts).notes.set(name, note);
    }
    return root;
  }, [notes, folders, prefix, searching, selectedFolder]);

  const render = (node: Branch, pathPrefix: string, depth: number): ReactNode => {
    if (!node.folders.size && !node.notes.size) return <p className="note-folder-empty" style={{ paddingLeft: 15 + depth * 14 }}>{searching ? 'No notes match your search.' : 'Empty folder'}</p>;
    return <>
      {[...node.folders].sort(([a], [b]) => a.localeCompare(b)).map(([name, child]) => {
        const path = pathPrefix + name;
        const expanded = searching || !closed.has(path);
        return <div key={path}>
          <button className="folder-item" style={{ paddingLeft: 13 + depth * 14 }} title={path} onClick={() => setClosed(previous => {
            const next = new Set(previous);
            next.has(path) ? next.delete(path) : next.add(path);
            return next;
          })} aria-expanded={expanded}>
            {expanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}<Folder size={14} /><span>{name}</span>
          </button>
          {expanded && render(child, `${path}/`, depth + 1)}
        </div>;
      })}
      {[...node.notes].sort(([a], [b]) => a.localeCompare(b)).map(([name, note]) => <button key={note.path} className={`note-item ${activePath === note.path ? 'active' : ''}`} style={{ paddingLeft: 15 + depth * 14 }} onClick={() => onOpen(note.path)} title={note.path} aria-current={activePath === note.path ? 'page' : undefined}>
        <FileText size={15} /><span>{name.replace(/\.md$/i, '')}</span>{Object.hasOwn(drafts, note.path) && <span className="dirty-dot" aria-label="Unsaved changes" />}
      </button>)}
    </>;
  };
  return <nav className="note-tree" aria-label="Notes">{render(tree, prefix, 0)}</nav>;
}
