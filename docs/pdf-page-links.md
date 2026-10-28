# PDF page links — version 1

This increment connects an ordinary Markdown note to a page in Prism's managed PDF library. It does not add PDF graph nodes or change storage.

## Stored format

```markdown
[研究メモ — p. 2](prism-pdf://v1/documents/12345678-1234-4234-8234-123456789abc?page=2)
```

The `v1` authority identifies the format version. The path contains the catalogue document's UUID, and `page` is a positive, one-based safe integer, written in decimal without leading zeroes. Accept only this structure: no credentials, port, fragment, extra parameters, encoded paths, or filesystem paths. ASCII letter case is accepted throughout the URI; generated links and parsed UUIDs are lowercase. Validate the destination against the actual loaded PDF's page count, including after a password is entered. Unsupported versions and malformed destinations report an error in Prism and never go to an external application.

The label is a snapshot of the current document title and page number, escaped as plain Markdown text. It is informational; resolution always uses the ID. Renamed documents and duplicate titles therefore remain unambiguous. Existing notes' labels are not automatically rewritten on rename.

## Writing and following

- The integrated reader offers **Insert page link** after a page has rendered successfully. It inserts at the current note selection (replacing selected text), using the retained editor, in one isolated undo step. No save occurs. If the note is in Read mode, insertion switches to Source so the change is visible. Without an active note, insertion is disabled.
- Following a link from Read/Split preview, or Ctrl/Command-click in Live (including tables), opens that PDF/page in the PDF workspace. An existing side-by-side layout stays open; a single workspace switches to PDFs. The note draft, cursor/selection, mode, and undo history remain intact. Return to Notes at any time.
- Repeated navigation to the current document retains its unlocked session, zoom, and rotation. A newer request wins over an older request still loading. Navigating back to the library cancels pending navigation.
- A valid page is checked against the actual PDF, not stale catalogue metadata. An out-of-range page is reported explicitly and the reader remains usable at its existing or restored valid page. The user can choose a valid page and insert a replacement link.
- A missing document reports that it is absent from this library. The user can browse/import PDFs, or close Prism, restore the correct library backup, and follow the link after reopening. Library load failures retain the request for retry. A removed entry is not silently matched by title or filename.

## Identity, portability, and recovery

Duplicate import of a document still in the catalogue retains its existing ID. Removing an entry retains the stored file but removes its identity from the catalogue. Re-import after removal creates a new ID; old links remain missing and must be replaced, or the original catalogue and managed files restored together. Prism does not rewrite links during import.

A notebook can be opened in any Markdown editor. The label and URI remain ordinary Markdown, but this URI opens only inside Prism; this increment registers no operating-system protocol handler. Other Markdown apps will generally not follow it. Copying the notebook alone does not copy its PDFs.

Back up both the notebook folder and the entire managed PDF library (catalogue and `documents/` directory), with Prism and standalone Prism PDF closed for a consistent copy. Preserve IDs when restoring. The library belongs to the current operating-system profile; a Windows profile and a Linux/WSL profile may have different catalogues. A missing/new library does not locate PDFs from another profile automatically.

## Validation

Use disposable notebooks and libraries. Cover strict parsing and Markdown label escaping; Source/Live/Read insertion, isolated undo, Japanese BOM/CRLF saves, save/restart/follow, duplicate and renamed titles, same-document navigation and passwords, missing/removed/re-imported IDs, malformed/unsupported/out-of-range pages, loading races, and existing note/external-link behavior. Combined workflow validation is now complete in [stage 2](pdf-stage-2.md); PDF graph work remains a later increment. Do not add AI/API integration or check GitHub CI.

Implemented coverage is in `tests/pdf-links.test.ts` (five cases) and `tests/e2e/pdf-page-links.spec.ts` (four native journeys). The full main desktop suite passes with 68 regular journeys and two opt-in host skips; page-link tests verify actual PDF canvas output, exact saved bytes, retained editor/reader identities, and no external navigation or remote requests. Platform compositor limits from stage 1 still apply.
