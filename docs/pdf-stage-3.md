# PDF integration — stage 3 increments

Stages 1 and 2 provide the shared library, side-by-side reading/writing, and stable page links. Stage 3 connects those references back to notes and then to the graph. Deliver the increments separately; follow the [integration plan](pdf-integration.md). AI/API integration remains excluded.

- [x] PDF backlinks in the reader.
- [x] Referenced PDFs in the full graph.
- [x] Compact graph and combined connection workflow checks.

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

Implementation decisions for this increment:

- Graph identities are `note:<relative path>` and `pdf:<managed document ID>`. Only citations in the current notebook and its drafts add PDF nodes or edges; catalogue-only PDFs stay out of the graph.
- **Show PDFs** defaults on for the full graph and can be turned off for a note-only view. Manual positions use these identities and survive filtering, title changes, and navigation within a notebook. Switching notebooks clears positions. The compact graph stays note-only for this increment.
- A graph with visible PDF citations loads catalogue metadata through the existing library service, acquiring the same library ownership as the reader. It does not mount the PDF workspace, read PDF bytes, or load PDF.js. Notes-only sessions and graphs without PDF citations leave the library unopened. Renames, removals, and imports from the PDF workspace publish current titles to the graph; **Refresh PDF titles** retries metadata loading. An older load cannot replace a newer published snapshot.
- Until metadata is available, a PDF is labelled with its shortened ID. A successful catalogue load marks absent IDs **Missing PDF**. Loading/ownership errors display a recoverable notice while note nodes remain usable; they do not declare references missing. Full IDs remain available in node descriptions to distinguish duplicate titles.
- Clicking or pressing Enter/Space on a PDF opens the lowest cited page across the current notebook. Other citations remain available in **Linked notes**. An unavailable document or invalid page uses the existing page-link recovery flow; re-import never retargets an old ID.

Implemented with document-shaped nodes, dashed citation edges, and distinct missing-document styling. Seven graph-model unit cases cover namespaced identities, duplicate titles, current-notebook citations, unique edges/pages, filtering, rename stability, unresolved metadata, and re-import behavior. Six catalogue-controller cases cover lazy loading, retry, superseded requests, metadata-only publications, unmount/remount, and stable React callbacks.

Four native desktop journeys verify metadata loading without the reader or PDF resources, unsaved Japanese references and exact BOM/CRLF saves, lowest-page navigation, pointer/keyboard movement with attached edges, pan/zoom/filter/reset retention, rename/removal/re-import recovery, library ownership retry, and notebook isolation. Controls also fit a 420-pixel Notes pane at 150% text with transparency. The compact graph remains note-only until the next increment. All 83 regular main desktop journeys pass together (two opt-in host skips), along with six standalone journeys. Main type/unit/build checks pass (274 unit passes, five platform skips); PDF type/unit/build checks pass (55 unit tests).

## 3. Compact connections and complete workflow

Add PDF connections to the compact graph only after the full graph behavior is established. Define a small neighbor limit and an overflow affordance; keep nearby note connections readable in the inspector.

Verify an offline note → PDF → linked note → graph journey with drafts, undo, page destinations, restart, and notebook replacement. Update the reading guide and stage status once the complete connection workflow passes. Text selection, annotations, OCR, and sibling-project features remain separate requirements.

Implementation decisions for this increment:

- The compact graph shows the current note and at most four direct neighbors. Reserve two places for notes and two for PDFs when both are present, then fill spare places from the remaining neighbors. Stable identities determine selection; title changes cannot reshuffle it. A **+N more connections** button opens the full graph with PDFs visible.
- Compact PDFs come only from the current note, including its draft. Opening one uses that note's lowest cited page; the full graph continues to use the lowest page cited anywhere in the notebook. Incoming and outgoing note connections remain available, and citations in neighboring notes do not add unrelated PDFs to the compact graph.
- **Load PDF titles** explicitly requests catalogue metadata without mounting the reader. Opening a note alone leaves library ownership untouched. Previously loaded titles from the reader or full graph are reused. **Refresh PDF titles** retries an error, and successful metadata is required before marking an ID missing.
- Full-graph filtering and manual positions remain independent of the compact preview. Both the overflow action and the existing expand actions reveal PDF connections in the full graph.

Implemented with distinct compact PDF nodes, bounded labels, a four-neighbor limit, keyboard-accessible overflow, and explicit title loading. Six additional model cases verify balanced selection/fill, unique overflow counts, active-note page scope, stable selection through title changes, draft/notebook replacement, and missing active notes or hidden PDFs.

Three native journeys verify an offline compact note → PDF → linked note → full graph → save/restart workflow, same-note PDF undo/redo, draft retention across note/graph navigation, current-note versus notebook page destinations, explicit metadata-only loading, ownership retry, missing references, and dirty notebook replacement. Appearance checks cover all themes at 150% text, transparency, default and expanded inspector widths, and actual label clicks at the 198-pixel minimum. At that stage, another note or the full graph recreated editor history. The subsequent [editor sessions increment](editor-history.md) adds bounded per-note history retention.

Main typecheck/build and 280 unit tests pass (five platform skips). All 86 regular main desktop journeys pass together (two opt-in host skips), including the existing full-graph, editor, reader, and notebook lifecycle checks. The standalone PDF code is unchanged in this increment.

Stage 3's connection workflow is complete. Text selection/copy, search, annotations, OCR, separate reader windows, and selected sibling-project features remain later requirements; AI/API integration remains excluded.
