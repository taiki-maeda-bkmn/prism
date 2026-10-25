# PDF integration — stage 1 increments

Stage 1 of [PDF integration](pdf-integration.md) brings the existing Prism PDF library and reader into Prism. Deliver each increment on its own branch and leave its PR unmerged. Run local checks and request review; do not check GitHub CI.

- [x] Shared library foundation in the standalone app.
- [x] Notes and PDFs in one window.
- [x] Integrated compatibility checks and launch transition.

## 1. Shared library foundation

Scope: make the standalone PDF app use the storage and desktop boundaries that the integrated workspace will reuse.

- Resolve the existing PDF profile from the current OS account's `appData/prism-pdf`, independently of the Markdown profile. Preserve the development-only `PRISM_PDF_USER_DATA` override. Never search for or combine another Windows/WSL profile or the sibling project's catalogue.
- Put lazy loading, retry, exclusive ownership, and shutdown in `PDFLibraryService`. Keep `LibraryStore` private to that service in desktop code. Acquire ownership before reading the catalogue; reject new calls during shutdown and finish accepted operations before release.
- Reuse the validated PDF IPC handlers in either application shell. Keep window controls, sender validation, and the Electron lifecycle with the host application.
- Use a permanent `.prism-library-lock.sqlite` sidecar solely for ownership. A retained SQLite exclusive transaction supplies an OS-managed lock; process termination releases it. Do not delete the sidecar to recover from a crash. Do not open/read it through ordinary filesystem handles inside a process that holds the lock, because closing such a handle can release POSIX advisory locks.
- Keep `catalog.json`, document IDs, metadata, managed copies, import deduplication, and removal semantics intact. The sidecar is not a catalogue migration. Continue existing external-change and atomic-publication checks.
- Show a recoverable library-in-use error with the existing **Try again** action. Failed or damaged catalogue opens release ownership. A normal quit drains filesystem work before releasing it.

Ownership is cooperative and uses the local filesystem's SQLite file locks: both updated entry points must use the service. Older app builds and direct low-level `LibraryStore` consumers do not acquire this lock; close older builds before sharing a library. As with the existing storage layer, directory and pathname checks do not provide protection against hostile concurrent replacement by another process.

Acceptance: real competing-process denial; retry after orderly close and abrupt process death; same-process contention; close during a pending write; failed-open cleanup; unchanged legacy catalogue and PDF bytes; the actual desktop's in-use error, retry, reader flow, and normal-quit handoff.

## 2. Notes and PDFs in one window

Implemented with retained workspace panels, a lazy PDF renderer, shared appearance and native controls, and the common PDF service. The Notes panel stays mounted to preserve CodeMirror state; the reader stays mounted after its first visit. Keyboard shortcuts are limited to the visible workspace, while draft protection remains global.

- Register the shared library service and validated bridge under Prism's existing lifecycle. Defer opening the library until PDFs is visited. The standalone launcher continues to use the same service and profile.
- Add Notes/PDFs navigation. Keep the CodeMirror instance, drafts, selection, editor mode, and undo history alive across switches. Preserve save/discard/cancel protection while PDFs is active.
- Extract the existing PDF workspace from its standalone shell and scope its styles. Reuse Prism's title bar, appearance, text sizing, and transparency; keep document pages opaque.
- Bundle PDF.js resources offline and load the reader when needed. Extend the precise local-resource allowlist and CSP for these assets.
- Preserve reader page/password session and library filters across workspace switches. Scope shortcuts and focus to the visible workspace.

Acceptance: import/read offline in Prism, return to an unsaved note with its selection and undo intact, return to the same PDF page, and verify independent focus/shortcuts, appearance, closing, and competing-launcher recovery.

## 3. Compatibility and launch transition

- Exercise copied existing libraries, duplicates, metadata, removal, missing/corrupt files, password-protected PDFs, restart, and remembered positions in the integrated app.
- Verify notebook replacement and refresh while a reader is open, including all save/discard/cancel paths.
- Verify native minimize/maximize/restore, transparency, and keyboard access in both workspaces.
- Update desktop launch instructions after the integrated route passes the stage 1 acceptance list. Retain the standalone launcher during the transition.

Implemented with three compatibility journeys in `tests/e2e/pdf-compatibility.spec.ts`, four notebook lifecycle journeys in `tests/e2e/pdf-notebook-lifecycle.spec.ts`, and native window/keyboard coverage in `tests/e2e/pdf-workspace.spec.ts`. These use synthetic existing-format catalogs, real PDF.js rendering, and disposable profiles. They check byte-for-byte catalog preservation on open and duplicate import, document identities and PDF hashes, tags/favorites/titles, normal-quit restart, fresh password prompts, retained pages, missing-copy retry, damaged documents, and removal without deleting either PDF copy. Notebook tests cover Cancel, Save, and Discard with an unlocked reader retained, plus undo isolation after refresh or switching notebooks.

The combined app's primary installer is `npm run install:desktop`; `install:markdown` remains a compatible alias and existing shortcut paths stay valid. Use **Prism → PDFs** for the existing library. The standalone launcher and the sibling project remain available. No automatic Windows/WSL library merging or user-data migration is part of installation.

Native minimize/maximize/restore checks require a conventional window manager (Xvfb/Openbox on WSL). WSLg's X11 manager does not expose the hidden state to Electron, so the generic controls journey skips on its host display; the existing opt-in host suite checks Windows surface behavior. Physical Windows/macOS compositor checks and the known WSLg repeated-maximize clipping issue remain outside this increment.

AI assistance, OpenAI calls, API-key controls, and AI dependencies are excluded from this and later planned increments.

Side-by-side notes, PDF page links, graphs, annotations, full-text search, and features from the separate `pdfmanager` repository remain later stages.
