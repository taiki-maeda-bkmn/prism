# Markdown folders

## First increment: browse and create

Notes use real directories inside the current notebook. In the Notes sidebar,
choose **Folder** to show **All notes**, only files in **Notebook root**, or a
folder and its subfolders. Search applies within that selection. All notes keeps
the existing expandable tree; empty folders are also shown. The selected folder
is remembered separately for each notebook. Opening a link to a note outside the
selected folder returns the filter to All notes.

Use **New folder** beside YOUR NOTES, choose its parent, and enter a name. A path
such as `Research/Reading` creates nested folders. Prism selects the new folder
after creation. Folders are ordinary directories, visible in Windows Explorer or
other file managers, and are discovered again on refresh or restart.

**New note** and Ctrl+N offer a **Note folder** selector. It starts at the current
folder filter, or Notebook root when viewing All notes. A nested note name is
relative to that destination: `Drafts/Idea` inside `Research` creates
`Research/Drafts/Idea.md`. Existing files are never overwritten.

Changing a folder filter or creating a folder keeps the current editor, drafts,
undo history, PDF reader, and note save baselines. It does not refresh the whole
notebook or silently save notes. Save normally with Ctrl+S. Refresh still uses
the existing Save/Discard/Cancel flow. The graph and backlinks continue to use
the whole notebook regardless of the sidebar filter.

Folder paths use the notebook's existing portable naming rules. Hidden,
reserved, unsupported, and symbolic-link directories are excluded. Inventory
uses the existing bounded scan; folder creation supports up to 32 nested levels.

## Next increment: move and rename notes

Moving existing Markdown files needs more than a folder assignment: relative
links, incoming references, and editor identities depend on their paths. This
increment is separate from browsing and creation.

1. Define one-note move/rename with a destination picker and a preview of affected
   links. Resolve wiki links, Markdown links, reference links, and relative assets
   against the original paths; preserve PDF page identifiers.
2. Publish without overwriting a competing destination. Preserve bytes, BOM,
   line endings, permissions, and external-edit conflict detection. Record enough
   recovery information to recover an interrupted move or multi-note link update.
3. Carry open drafts, selections, undo history, graph positions, and backlinks to
   the new identity. If link updates touch unsaved notes, make the save/discard
   decision explicit and keep cancellation lossless.
4. Verify disk state and recovery after interruption, duplicate destinations,
   concurrent external changes, native Windows moves, and restart.

## Later: manage whole folders

Folder rename/move, drag-and-drop organization, and deletion follow the one-note
move foundation. Empty-folder removal can be offered independently; nonempty
folder operations need impact previews and recovery for all contained notes and
links. Until then, use a file manager for existing-file reorganization and refresh
Prism after saving, taking care to update path-based links.

The previously documented concurrent-directory-replacement limitation in
[filesystem races](filesystem-races.md) remains; this increment uses the existing
root identity, ancestor checks, and serialized workspace operations.
