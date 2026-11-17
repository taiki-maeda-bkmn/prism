# PDF text, links, and search

This increment adds three related reading features to the shared PDF reader used by Prism and Prism PDF.

1. Render a selectable text layer aligned with the PDF canvas. Support ordinary selection and Ctrl+C copying without a permanent text-tools row.
2. Add safe links from PDF annotations. Web/email links open only after activation through the main-process URL validator. Internal destinations navigate within the current document. PDF scripts, forms, file launches, and unsupported actions remain inactive.
3. Search text throughout the open PDF, with next/previous matches, page navigation, visible highlights, and Ctrl+F scoped to the focused PDF pane. Search runs progressively and can be cancelled; it does not rasterize pages or block note editing.

Text comes from the PDF's embedded text. Image-only scans need OCR, which is outside this increment. A document's font mapping and text ordering determine extraction quality.

## Use the reader

- Drag across text, then press **Ctrl+C**. With the page focused, **Ctrl+A** selects that page's text. Selecting and copying text does not add a toolbar or change the reading area's height.
- Click an embedded web/email link to open the default application, or an internal link to jump to its page. Links can also receive keyboard focus and activate with Enter.
- Find stays hidden until you press **Ctrl+F** while the PDF pane is active. There is no permanent Find button. Search ignores case and matches across text items and line breaks. Use **Enter / Shift+Enter**, **F3 / Shift+F3**, or the match arrows to move through results. Escape closes Find from its input or navigation buttons and returns focus to the page.
- **Ctrl+F** still opens Find when the page toolbar is hidden; **Ctrl+C** copies selected text without showing a toolbar. Switching to another tab retains the query and selected result; hidden readers pause any unfinished search.

Search keeps at most 1,000 matches and reads up to 20,000 pages, 32 million document characters, and one million characters per page. A notice identifies limited results or pages that could not be searched. No PDF text is sent to a server, and these interactions do not modify the PDF file.

## Acceptance

- Selection, copy, and links align at different zoom levels, rotations, and pane widths.
- Search matches can span PDF text items and line breaks, and support Japanese text when the PDF supplies Unicode mappings.
- Page changes, retries, tab switches, and newer queries cannot publish stale layers or matches.
- Hidden reader controls do not make Find or Copy inaccessible.
- Existing page navigation, transparency, reader sessions, and Markdown drafts/undo remain intact.
- PDF bytes and catalogue identity are unchanged.
- Tests use generated PDFs, disposable notebooks/profiles, and intercepted external-link calls.

The previously diagnosed Windows Smart App Control block is a separate installation issue. This feature does not alter security settings or supply a trusted signature.

## Verification

The Copy-toolbar removal passes both builds/typechecks and all four targeted integrated/standalone desktop journeys. Tests verify actual selection/clipboard copying, no permanent or selection-triggered toolbar, unchanged reading-area geometry, search-field copying, and image-only guidance inside Find. The ordinary-reader screenshot was inspected.

The Ctrl+F-only visibility follow-up passes both builds/typechecks and the four targeted integrated/standalone desktop journeys. The checks cover no permanent Find button, hidden initial and locked states, Escape from match controls, closed F3 behavior, and retained query/results on reopening.

Both application builds and typechecks pass, with 438 main unit passes (five platform skips) and 148 PDF unit passes. Twenty-four new unit cases cover search normalization/offsets/bounds/cancellation, link validation, and retained search sessions through React StrictMode.

Thirteen targeted Linux/WSLg desktop journeys pass: three new integrated journeys, one new standalone journey, and nine rendering/navigation/split-pane regressions. These check actual mouse selection and clipboard results, external-link dispatch, internal page jumps, cross-page and multiline search, tab retention, Japanese draft/undo preservation, encrypted and image-only files, rotation/zoom, and controls at 420px with 150% text. The compact rotated-page screenshot was inspected. All data is disposable, external links are intercepted, and clipboard contents are restored.

Native Windows startup verification remains pending resolution of its existing application-control block. Rebuilt packages and managed shortcuts can still be updated without changing security settings. GitHub CI was not checked.
