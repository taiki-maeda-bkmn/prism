# PDF integration into Prism

Status: stage 1 and stage 2's side-by-side layout are implemented. The next increment defines stable PDF page links and connects them to note insertion/navigation. See [stage 2 progress](pdf-stage-2.md) and [stage 1 evidence and platform limits](pdf-stage-1.md).

## Product direction

Make Prism one desktop application with **Notes** and **PDFs** workspaces. Keep the Markdown editor, PDF reader, and PDF library as separate internal modules. The intended workflow is to read a document, write notes beside it, and connect those notes to particular pages and other ideas.

Use the existing **Prism PDF** implementation in this repository's `pdf-manager/` directory as the foundation. The sibling checkout at `../pdfmanager` (`/home/kabes/repository/pdfmanager` in the current environment) is a separate project with a broader research workflow. Keep it available during the transition; consider its features individually in later stages. Integrating Prism PDF does not merge that repository or import its catalogue.

Prism should remain useful as a focused Markdown writer. Load the PDF renderer and its document resources when needed, and keep PDF-specific controls in the PDF workspace. A separate reader window can be considered later for multiple monitors.

AI assistance and OpenAI API integration are out of scope, per the user's direction. Do not add model calls, API-key settings, or AI service dependencies. Continue with local reading, writing, and organization features.

## Existing foundation

| Component | Current behavior | Integration approach |
| --- | --- | --- |
| [Markdown workspace](../src/renderer/App.tsx) | Ordinary Markdown files, explicit saves, Live editing, graph, themes, transparency | Preserve the editor, draft lifecycle, and notebook model |
| [PDF library](../pdf-manager/src/main/library.ts) | Managed PDF copies, document IDs, duplicate detection, tags, favorites, reading positions | Reuse the storage service and preserve existing data |
| [PDF reader](../pdf-manager/src/renderer/PdfReader.tsx) | Offline PDF.js rendering, page navigation, zoom, rotation, passwords, thumbnails | Adapt it as a module inside Prism |
| [PDF desktop bridge](../pdf-manager/src/main/preload.ts) | Narrow document operations through `window.prismPdf` | Register the required operations under Prism's application lifecycle |
| [PDF build](../scripts/build-pdf.mjs) | Bundled worker, character maps, fonts, and WebAssembly assets | Include these resources in the integrated build |

Both Prism applications already share the repository's Electron, React, TypeScript, and PDF.js dependencies. They currently have separate entry points, windows, settings, launchers, and application-data directories. Integration requires consolidating those boundaries; importing both Electron entry points into one process is not the design.

The current PDF reader renders pages to canvas. Text selection, annotations, OCR, and full-document text search are not existing capabilities. Library search currently covers metadata. These remain separate reader enhancements.

## Stage 1 — Open the existing PDF library and reader inside Prism

Goal: launch Prism once and switch between writing notes and managing or reading PDFs.

### User-facing behavior

- Add clear **Notes** and **PDFs** navigation within Prism's existing window.
- Reuse the PDF library's grid/list views, metadata search, recent documents, tags, favorites, import, and removal behavior.
- Open a PDF inside Prism with its current reader controls and remembered reading position. Returning to the library retains its filter and selection context.
- Switching workspaces preserves the active note, unsaved text, editor mode, cursor, selection, and undo history. Visiting PDFs does not save or discard a note. Existing save/discard/cancel protection still applies when closing Prism or replacing a notebook.
- Preserve the current PDF document and page when switching to Notes and back. Passwords remain in memory for the reading session only.
- Use Prism's title bar, native maximize/restore behavior, themes, text sizing, and Appearance settings. Keep true window transparency; PDF pages remain opaque.
- Scope shortcuts to the active workspace. In particular, Ctrl/Command+O opens a notebook in Notes and imports PDFs in PDFs. Inactive editor shortcuts must not consume reader input; global close and draft protection still work.

### Implementation boundaries

- Keep one Electron application lifecycle and window controller, with separate Markdown and PDF services behind validated preload operations.
- Extract reusable library and reader views from the standalone PDF shell. Scope their CSS so generic selectors such as `.sidebar`, `.app-shell`, and `:root` do not override Prism's interface.
- Place editor state outside workspace switching or retain the editor instance so switching cannot silently clear CodeMirror history. Preserve Prism's existing protection against carrying undo history into another notebook.
- Bundle and load PDF.js resources offline. Reconcile the resource allowlist and content security policy for the required local worker/assets without opening general network or filesystem access.
- Keep both existing test suites and add focused desktop coverage for the integrated workspace lifecycle.

### Data compatibility and transition

- Keep Markdown in the user's selected notebook. Keep PDFs in the existing Prism PDF managed library directory for this stage; do not relocate files, rewrite catalogues, or change document IDs merely to combine the interface.
- Preserve managed PDF bytes, tags, favorites, titles, reading positions, and duplicate-detection behavior. Imported source files remain untouched. Removal keeps its current semantics: remove the catalogue entry while retaining the managed file.
- Preserve the entire existing PDF library as the backup unit. A missing library may be initialized normally; a damaged catalogue must report an error without overwriting recoverable data.
- Resolve the existing library for the current operating-system profile explicitly. Windows and Linux/WSL profiles may contain different libraries; do not silently choose between or combine them.
- Establish one writer per library before allowing the integrated and standalone Prism PDF launchers to share it. Route launches to the owning app or use a shared library lock that both entry points honor. A second process must not write a stale catalogue. Test conflict handling and lock recovery.
- Keep the standalone Prism PDF entry point during the transition until the integrated route passes its acceptance checks. Update launch instructions deliberately afterward. The separate sibling `pdfmanager` project and its data remain independently usable.

### Acceptance checks

- [x] A fresh Prism profile can import and read a PDF offline, then return to the same Markdown draft and undo history.
- [x] A disposable copy of an existing Prism PDF library opens with matching document IDs, tags, favorites, stored positions, and file hashes. Opening it alone performs no migration.
- [x] Imports, duplicate handling, metadata updates, removal, restart, passwords, and damaged-PDF handling retain existing behavior.
- [x] The reader resumes at the expected page after switching workspaces and restarting; passwords are not persisted.
- [x] Close, notebook replacement, and refresh preserve existing save/discard/cancel behavior. Close protection works while PDFs is active; notebook actions are accessed from Notes while the reader session remains mounted.
- [x] Theme, text-size, transparency, keyboard focus, minimize, maximize, and restore are covered in both workspaces. Native window-state checks use a conventional window manager; WSLg and physical-platform limits remain documented below.
- [x] Missing/corrupt library data and competing app instances produce recoverable behavior without discarding files, catalogue changes, or note drafts.
- [x] Build/type checks, filesystem/library tests, and the affected native desktop journeys pass with temporary profiles and libraries.

Native tests verify Linux desktop behavior. Windows/macOS compositor behavior still needs physical testing; the previously documented intermittent WSLg repeated-maximize clipping issue remains open. The generic minimize-state journey runs under Xvfb/Openbox on WSL because WSLg's X11 manager does not report the hidden state; its Windows host behavior has separate opt-in checks. Stage 1 does not claim to resolve that host limitation.

Stage 1 ends with these workspace and compatibility checks. Side-by-side editing, PDF page links, graph changes, and features from the sibling project belong to later stages.

## Stage 2 — Read and write side by side

Goal: work on a Markdown note while a PDF remains visible.

Follow the smaller [stage 2 increments](pdf-stage-2.md). The **Read & write** layout is implemented; a documented page-link format and navigation come next, followed by combined linking workflow checks.

- Add a resizable PDF/Markdown split with independent scrolling and predictable keyboard focus. Preserve the existing Markdown Source, Split, Live, and Read modes.
- Add an action to insert a link to the current PDF page into the active note.
- Before implementing links, define a versioned link format using stable document identity and a page destination. Document how it behaves when a title changes, a document is removed or re-imported, and a note is opened outside Prism. Notebook backup/export must explain its dependency on the managed PDF library.
- Follow a page link by opening the correct PDF and page without losing the note's draft, selection, or undo history. Missing documents and invalid pages should offer a useful recovery path.
- Verify page-link round trips, Japanese filenames, renamed titles, missing documents, keyboard operation, and a complete read/write/save/reopen journey.

## Stage 3 — Connect PDFs to notes and the graph

Goal: make PDF references part of Prism's connected-notes workflow.

- Extend link resolution with distinct note and PDF identities; use stage 2's document links rather than guessing from display titles.
- Show backlinks from a PDF to notes that reference it, including page destinations where available.
- Add visually distinguishable PDF nodes and note-to-PDF edges, while preserving existing note links and graph dragging.
- Define graph filtering and missing-document behavior before exposing a large library in the graph. Keep the compact local graph readable.
- Verify duplicate titles, removed PDFs, notebook switching, page destinations, existing note links, and graph navigation.

## Later increments — Selective research and reader features

Evaluate these separately after the core reading/writing workflow works:

- Text selection/copy, document text search, and annotations.
- Optional separate reader windows for multiple monitors.
- Useful capabilities from the sibling `pdfmanager` project, such as arXiv import or companion research notes. Each needs its own scope, data compatibility review, and acceptance checks. AI/API features are excluded.
- Jupyter integration, OCR, sync, and a unified file-storage migration only as explicit future requirements.

Do not copy the sibling project's full application shell or catalogue into Prism as part of the first increment. Its feature set and data model need independent decisions.

## Delivery workflow

Use a separate branch and PR for each increment. Keep this plan and [the implementation checklist](../IMPLEMENTATION.md) current as work is completed. Commit and push automatically, request Copilot review, address actionable findings, run appropriate local checks, and verify the Codex review on the final commit. Per the user's instruction, do not check or wait for GitHub CI. Leave PRs unmerged for user review.

The first stage is split into shared library ownership, workspace integration, and compatibility/launch checks in [the stage 1 breakdown](pdf-stage-1.md).
