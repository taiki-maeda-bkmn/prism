# PDF library folders

## Increment 1: organize existing PDFs

Add a Folders section to the shared PDF sidebar, with **New folder**, folder
counts, and **Unfiled**. A PDF belongs to at most one folder and can retain any
of its existing tags. All documents, Favorites, Recently opened, and tag views
continue to work across folders.

Drag an existing PDF from the grid or list onto a sidebar folder to move it;
drop onto **Unfiled** to remove its folder assignment. The document details
dialog provides a keyboard-accessible Folder selector for the same action.
Create, rename, and remove folders in the app. Removing a folder moves its PDFs
to Unfiled and preserves the documents.

These are library folders. PDF bytes remain at their stable managed paths, so
document IDs, note links, tags, favorites, and reading positions survive moves.
This increment uses one level of folders and moves one PDF per drag. Folder
names support Japanese, are limited to 80 characters, and are unique within
the library. Nested folders and batch movement remain separate increments.

## Storage and compatibility

- Existing version 1 catalogues open unchanged, with their PDFs in Unfiled.
- The first folder creation publishes a version 2 catalogue atomically. It adds
  folder records and optional document folder IDs. Subsequent imports and edits
  retain this version and the folder assignments.
- Both Prism and Prism PDF are updated together. Older builds reject version 2
  rather than discarding folder metadata. Back up the complete library before
  opening it with a different build; ordinary load does not migrate the data.
- Folder changes use the existing library ownership, serialized writes, and
  publication recovery. An invalid or externally changed catalogue is reported
  without overwriting it. No application user data is used in automated tests.

## Increment 2: import by dropping files

Prism supports dropping PDF files from Windows Explorer or another file manager onto
the library or a chosen folder. The library area uses the currently selected
folder; other views import into Unfiled. A sidebar folder or Unfiled is an
explicit destination. **Import PDFs** and Ctrl/⌘+O use the selected folder too.

- Copy ordinary PDF files into managed storage and leave originals unchanged.
  Accept up to 100 files per import, with the existing 100 MiB per-file limit.
  Show added, duplicate, and failed-file results; valid files in a mixed batch
  can still be imported.
- Identify duplicates by content. Keep an existing copy's folder, title, tags,
  favorite, reading position, and ID. Dropping the same file into another folder
  does not move it; moving its existing library card remains a separate action.
- Assign a new PDF's destination during its initial catalogue publication.
  Reject an unavailable folder before copying anything. Keep the current
  ownership, serialized writes, and publication-recovery behavior.
- Resolve disk-backed files in the shared Electron preload using
  `webUtils.getPathForFile`. Do not accept text/URL drops as filesystem paths or
  read PDF bytes in the renderer. Native Windows receives Windows paths directly;
  Linux receives paths supplied by its file manager. Do not guess translations
  between Windows and WSL. A gesture without accessible disk-backed files reports
  an error and can be retried with **Import PDFs**.
- Highlight the destination with a copy cue, expose folders from compact Library
  navigation, clear cancelled drags, and retain existing internal drag moves.
  Guard imports while another file import, loading, or a modal is active. Drops
  onto the reader itself do not import files. A visible library pane in
  **Read & write** accepts file drops while the adjacent note retains keyboard
  focus, selection, undo, and save shortcuts; hidden or busy panes reject them.

Both integrated and standalone hosts share the change. No AI API is involved;
GitHub CI remains unchecked.

## Verification

### File imports

Both builds and typechecks pass, with 369 main unit tests passing (five platform
skips) and 116 PDF unit tests passing. Nine new cases verify initial folder
publication, duplicate and source preservation, partial results, unavailable
folder rejection and queue order, publication retry, invalid/sparse path batches,
native File resolution, and import completion before library shutdown.

Thirteen integrated native Windows journeys pass together: five new file-drop
journeys, four existing folder journeys, and four side-by-side reading journeys.
The standalone folder journey also passes with dropped files and restart. These
checks use disk-backed Chromium drag events through the actual preload and IPC
boundary, rather than mocking the import bridge. They cover Japanese filenames,
mixed valid/invalid files, unchanged duplicates/originals, current-folder picker
imports, Markdown drafts/undo and exact saves, reader retention, restart,
rejected synthetic/text/reader/modal drops, cancelled drags, busy-import guards,
newer navigation during import, and drops beside a focused note while retaining
its selection, undo, and save shortcuts. The compact folder highlight was visually
checked at 420 pixels wide and 150% text size. Physical Explorer mouse gestures
are not automated by these tests. All profiles, notebooks, and source PDFs are
disposable fixtures; tests do not modify the user's library.

Drag fixtures use continued hovering and check the acceptance cue before release,
following [Playwright's drag guidance](https://playwright.dev/docs/input#drag-and-drop).
Save polls tolerate only transient `ENOENT` during publication, while retaining
exact BOM/CRLF byte assertions and failing if publication never completes.

The native launcher regression also passes real Windows mouse delivery,
Japanese BOM/CRLF save/readback, dirty-close cancellation, repeated relaunch with
retained drafts, complete process exit, and reopen. The verified native release
`20261106T130357944Z-22234e93` was activated through the existing desktop and Start
Menu shortcuts and opened successfully. Shortcut backups and the previous
release remain available; existing Windows notebooks and PDFs remain in place.

### Existing folder organization

Both builds and typechecks pass, along with 343 main unit tests (five platform
skips) and 117 PDF unit tests. Fourteen new storage cases cover migration,
validation, duplicate preservation, atomic folder removal, failed publication,
external edits, restart, and orderly shutdown. Five snapshot cases cover late
responses alongside newer metadata, reading, import, and removal changes.

Thirty integrated desktop journeys pass, including four folder journeys:
grid/list drag moves, Escape cancellation, rejection of unrelated/spoofed drops,
failed-write retry, keyboard alternatives, duplicate names, safe removal,
restart, existing page links, unchanged PDF bytes, retained note drafts/undo,
and 420-pixel layouts at 150% in all three themes. Compact folder dialogs restore
focus to Library. Regression coverage also includes legacy libraries, page links,
side-by-side reading, URL/research imports, and native window controls.

All eight standalone desktop journeys also pass, including folder assignment,
Unfiled, metadata/byte preservation, and reading-position persistence across
restart. All checks use disposable profiles, notebooks, and real PDF fixtures.
No user library is migrated by testing.
