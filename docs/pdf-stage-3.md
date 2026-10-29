# PDF integration — stage 3 increments

Stages 1 and 2 provide the shared library, side-by-side reading/writing, and stable page links. Stage 3 connects those references back to notes and then to the graph. Deliver the increments separately; follow the [integration plan](pdf-integration.md). AI/API integration remains excluded.

- [x] PDF backlinks in the reader.
- [ ] Referenced PDFs in the full graph.
- [ ] Compact graph and combined connection workflow checks.

## 1. Linked notes in the PDF reader

Add a collapsible **Linked notes** panel to the integrated reader. Show each referencing note's title, relative path, and unique cited pages. The current notebook, including unsaved drafts, supplies these references; switching or refreshing notebooks must replace the list without resetting the reader.

Use the versioned managed document ID, never display-title matching. Parse actual Markdown links, including reference-style links, lists, quotes, and tables. Ignore code/math examples, images, raw HTML, unused definitions, malformed addresses, and unsupported link versions. Keep the existing note graph and note backlinks unchanged.

Opening a note selects Notes without saving, changing its editor mode, or closing the PDF. **Read & write** keeps both panes visible. Cited-page buttons open the exact page; loading/password states disable those buttons while note navigation remains available. A page beyond the loaded PDF's page count stays visible as unavailable rather than opening a different page. References to removed documents keep their original identity in Markdown; re-importing does not silently retarget them.

Keep the panel collapsed initially and cap its expanded height, with independent scrolling, so page turning and the PDF viewport remain usable. Preserve text size, themes, transparency, keyboard operation, zoom, and the unlocked reader session. The standalone reader has no notebook and omits the panel.

Acceptance: verify draft insertion/edit/undo, grouped pages, duplicate titles and renamed PDFs, exact save/restart, missing/re-imported IDs, password and invalid-page states, notebook refresh/change with dirty protection, and 420-pixel panes at 150% text size. Use temporary notebooks and libraries.

Implemented with **Linked notes** above the PDF viewport. The list is computed from the current notebook and drafts after the first PDF visit; unchanged notes reuse parsed references. Opening a backlink resolves focus after the note's editor mounts, retains Read mode, and returns from Graph view without saving. Cited-page navigation retains zoom and the reader session. No catalogue migration or library scan is needed.

Nine unit cases verify Markdown/reference/table parsing, exact character-reference decoding matching Read/Live anchors, exclusions, stable identities, deduplicated pages, draft changes, cache invalidation, notebook replacement, and unchanged note graph behavior. Four native journeys verify draft insertion/undo/redo/save/restart, grouped Japanese references, Source/Read/Graph navigation, duplicate-title rename/removal/re-import, refresh and notebook isolation, locked/out-of-range pages, and all themes at 420 pixels and 150% text with transparency. All 79 regular main desktop journeys pass together (two opt-in host skips), along with six standalone journeys. Main type/unit/build checks pass (261 unit passes, five platform skips); PDF type/unit/build checks pass (55 unit tests).

## 2. Referenced PDFs in the full graph

Define graph nodes with explicit note/PDF identity namespaces. Include PDFs referenced by the current notebook; opening a large library must not add every PDF to the graph. Provide a visible filter for PDF connections and preserve the existing note-only view, layout, dragging, zoom, and keyboard interaction.

Use distinct PDF styling and note-to-PDF edges. A PDF node opens its managed document, while page-specific navigation remains available through the reader's cited-page list. Represent unresolved managed IDs as missing references with a clear recovery action; never resolve by a duplicate title or silently replace an ID after re-import. Library loading/ownership errors must not block the note graph.

Before implementation, specify how catalogue titles enter the graph without loading the reader unnecessarily, how missing-document labels are derived, and which page opens when a node has several citations. Verify title changes, duplicates, missing IDs, filters, notebook isolation, and existing note graph positions.

## 3. Compact connections and complete workflow

Add PDF connections to the compact graph only after the full graph behavior is established. Define a small neighbor limit and an overflow affordance; keep nearby note connections readable in the inspector.

Verify an offline note → PDF → linked note → graph journey with drafts, undo, page destinations, restart, and notebook replacement. Update the reading guide and stage status once the complete connection workflow passes. Text selection, annotations, OCR, and sibling-project features remain separate requirements.
