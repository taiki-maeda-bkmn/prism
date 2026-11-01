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

Support dropping PDF files from Windows Explorer or another file manager onto
the library or a chosen folder. Define copy/duplicate behavior, path handling
across Windows and WSL, and import results before implementation. This increment
will use the existing managed import flow and preserve originals.

## Verification

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
