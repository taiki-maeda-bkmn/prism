# PDF integration — stage 2 increments

Stage 1 provides one Prism window with Notes and PDFs. Stage 2 makes reading and writing possible at the same time. Follow [the integration plan](pdf-integration.md); deliver each increment on its own branch and PR. Keep AI assistance and OpenAI API integration out of scope.

- [x] Side-by-side layout and focus.
- [ ] Stable PDF page links.
- [ ] Combined linking workflow checks.

## 1. Side-by-side reading and writing

- Add an explicit action to show the current note and PDF workspace together, with a resizable divider and independent scrolling.
- Retain the existing editor and reader instances. Entering or leaving the layout must preserve unsaved text, cursor/selection, undo, editor mode, PDF page, zoom, and the in-memory password session.
- Preserve Source, Split, Live, and Read for the note. Keep PDF imports and library navigation available without replacing the note pane.
- Route workspace shortcuts according to the focused pane; retain global close protection. Make pane focus and divider resizing work from the keyboard.
- Clamp pane widths to keep controls usable. At narrow window sizes, offer the existing single-workspace layout without discarding either session.
- Reuse the current themes, text sizing, true transparency, and opaque document pages.

Acceptance: type and undo while the PDF remains visible, independently scroll and turn pages, resize with mouse and keyboard, switch layouts and note modes, and save/reopen the note. Verify Japanese text, locked PDFs, narrow windows, and unsaved-close protection. Use temporary data.

Implemented with **Read & write** in the native title bar. Notes and PDFs stay mounted while their visibility and widths change. Clicking or focusing a pane selects its shortcuts; the title-bar workspace buttons return focus to that pane. The split opens with note navigation collapsed and without the inspector; **Show notes** and the compact PDF **Library** menu keep navigation available. Source, Split, Live, and Read all remain available, with the note's own Split preview stacked vertically in a narrow pane.

The divider supports pointer dragging, Left/Right arrows (10 pixels, or 40 with Shift), Home/double-click reset, and Escape/pointer cancellation. A bounded ratio is saved separately from note preferences. Panes keep at least 420 pixels; below 960 pixels of available workspace width the app temporarily shows the active pane, then restores the requested split when widened. Restart starts with Notes only and retains the divider ratio for the next split session. Closing still protects unsaved notes, and passwords remain session-only.

Four native journeys in `tests/e2e/pdf-side-by-side.spec.ts` cover exact Japanese BOM/CRLF saves, selection and undo, retained reader/password/page/zoom, independent scrolling, focus-scoped shortcuts and navigation, divider input/cancellation/restart, responsive fallback, 420-pixel panes at 150% text size, themes/transparency, and native close/save/reopen. Both note and PDF surfaces remain usable while a document awaits a password. Native screenshots show the actual combined app.

## 2. Stable PDF page links

Before changing link handling, document a versioned format using the managed document ID and page number. Define title changes, removal/re-import, invalid pages, missing libraries, opening Markdown outside Prism, and backing up the library alongside a notebook. Do not resolve documents by display title.

Then add an action to insert the current PDF page link at the note's cursor, with ordinary Markdown source, one undo step, and no implicit save. Following the link opens the document/page while retaining the note draft and selection.

Acceptance: insert/follow/save/reopen round trips, renamed and duplicate titles, Japanese filenames, missing documents, invalid destinations, and recovery without losing the note.

## 3. Combined workflow checks

Verify a complete offline read/write/link/save/restart journey, independent keyboard focus, native window changes, remembered reading positions, and existing notebook/library error handling. Update desktop guidance for the combined layout.

PDF backlinks and graph nodes are stage 3. Text selection, full-document search, annotations, OCR, separate reader windows, and sibling-project imports remain separate requirements.
