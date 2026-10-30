# Research connections

Core note/PDF integration is complete. Connect the existing Rates & Execution public archive first, then add direct arXiv discovery. These are separate increments; keep the sibling repositories and their data independent. Prism does not call OpenAI or run the page's research pipeline.

- [x] Rates & Execution browsing and single-paper PDF/review import.
- [ ] Batch imports and additional organization options, if needed after using the first increment.
- [ ] Direct arXiv search, categories, result details, and selected-paper import.

## 1. Published reviews in Prism

Open **Rates & Execution** from the integrated PDF library. Load the published catalogue only on request. Search titles, authors, and arXiv IDs; filter by topic, edition type, and rating. Show the latest matching edition per paper and allow choosing earlier reviews. Retain original ratings and distinguish a paper review from a full-edition review when the source cannot be attributed unambiguously.

**Import PDF + review** adds one selected paper to Prism's managed library and a Markdown review to the current notebook. PDF topics become tags within the existing tag limits. Review notes contain all topics, authors, original rating, source links, and a stable managed-PDF page link, making them usable in both graphs and the reader's Linked notes panel. The destination is `Research/Rates & Execution`, optionally grouped by the first topic or edition month. The UI identifies the current notebook before importing.

An optional validated arXiv ID on a PDF preserves source identity across restarts. Repeated imports reuse a verified existing copy by base arXiv ID before downloading; hash duplicates also reuse their existing managed document. Preserve custom titles, existing tags, favorites, and reading positions. If another version is already stored, explain that its bytes are retained. Both launchers accept old catalogues and the new optional field; no eager migration occurs.

Review identity is recorded in a leading Markdown comment. A repeat import for the same edition, paper, and managed PDF reuses the existing review without overwriting edits. Unrelated filename collisions get a new name. If a PDF was removed and re-imported, keep the old review unchanged and create a new review linked to the new managed ID. If saving the review fails after the PDF is saved, report partial success and allow retry without downloading again. Existing note drafts are retained; importing never refreshes or replaces renderer drafts.

Only the Electron main process fetches data. Derive catalogue/archive/PDF URLs from fixed hosts and validated identifiers, bound response sizes and timeouts, serialize downloads, and validate redirect destinations and PDF headers. Keep renderer resource restrictions unchanged. Validate the notebook identity and serialize import with notebook operations; shutdown drains accepted work before releasing the library.

Use deterministic network fixtures for parser, download, storage, and native UI checks. Cover duplicate/edited reviews, catalogue compatibility, source preservation, topic limits, partial failures/retry, stale selections, notebook protection, local page links/graphs, offline reopening, and appearance/keyboard behavior. A small read-only live catalogue check can validate the published schema; do not import into the user's real library for tests.

### Verification

Parser/download checks cover both archive scopes, malformed/ambiguous data, original rating scales, cache refresh, bounded responses, timeout handling, PDF identity/redirect validation, and request pacing. Library tests cover legacy catalogues, verified source/hash reuse, preserved metadata, tag limits, publication failures, and shutdown. Import tests use real temporary notebooks and libraries to verify edited/renamed review reuse, grouping, collision races, partial retries, removed PDFs, notebook replacement, and stale-save conflicts. Passive previews retain text and math while removing media and navigation before entering the active document.

Two native journeys verify a tagged PDF and linked review through draft undo, compact graph and reader backlinks, edited review/title/tag preservation and restart; catalogue/review retry, edition/topic/rating filters, explicit source navigation, no renderer network requests, and a pending import at 720 pixels with 150% text and transparency. Desktop screenshots also verify the wide two-column layout. Main typecheck/build and 311 unit tests pass (five platform skips), with all 88 regular desktop journeys passing together (two opt-in Windows host skips). Standalone PDF typecheck/build, 66 unit tests, and all six desktop journeys pass. Tests use isolated profiles and temporary libraries; GitHub CI is not checked.

A read-only check against the published site successfully parsed 205 paper appearances and retrieved a paper-specific daily review. It downloaded no PDFs and changed no user files. Runtime catalogue changes and arXiv availability remain external dependencies.

The paper list now fills the review column's height instead of stopping at 700 pixels. A populated-catalogue desktop regression checks aligned column bottoms, independent scrolling, no-results visibility, and reachable import/close controls in tall, normal, short, and narrow windows at 150% text. The narrow layout retains its compact list height. Typecheck/build and all three research desktop journeys pass for this layout follow-up.

## 2. Batch and organization follow-ups

Add selected-paper queues with per-item progress/retry only after single-paper behavior is established. Consider custom destination folders, richer date filters, and import-history affordances separately; do not silently move existing PDFs or notes.

## 3. Direct arXiv discovery

Reuse the validated downloader and managed-source identity. Add title/author/ID search, concrete categories, result paging, metadata/abstract details, and explicit import. Respect arXiv request pacing and avoid duplicate downloads. No AI recommendations, API-key controls, or model service dependencies.

Use a branch and PR per increment, run local checks, request Copilot review, verify the final-commit Codex review, and leave PRs unmerged. Do not check GitHub CI.
