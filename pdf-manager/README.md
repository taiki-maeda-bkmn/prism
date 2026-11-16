# Prism PDF

Supported platforms are **Windows and Linux**. macOS is no longer supported or included in GitHub Actions checks.

Use **Prism → PDFs** for the local PDF library and reader alongside your Markdown notes. Install the main **Prism** desktop shortcut with `npm run install:desktop`, or run `npm start`. Your existing Prism PDF library opens directly without re-importing or moving it.

In the combined app, choose **Read & write** to keep a note beside the library or reader. Resize the divider and scroll each pane independently. In a narrow PDF pane, **Library** opens tags and filters. Clicking a pane directs keyboard shortcuts to it, and switching layouts retains the current page, zoom, and password session.

With a note open, **Insert page link** inserts a reference to the reader's current page at the note selection without saving it. Follow it in Read/Split or Ctrl/Command-click in Live. Links retain the managed document ID across title changes; removing and re-importing creates a new ID. Back up the library with the notebook. See [page links and recovery](../docs/pdf-page-links.md).

The [reading and writing guide](../docs/pdf-reading-workflow.md) walks through a complete session, keyboard focus, saving, reopening at the remembered page, and recovery from notebook/library errors.

The main app's PDF library also has **Rates & Execution** for importing a published paper with topic tags and a linked review in the current notebook. Discovery and downloads need an internet connection; imported PDFs remain available in both launchers offline. The standalone launcher has no research-import entry because it has no notebook. See [research import](../docs/pdf-reading-workflow.md#import-a-published-rates--execution-review).

**Search arXiv** in the main app searches arXiv directly and imports one selected PDF with category tags. It shares source/version deduplication with Rates & Execution and preserves your library metadata. Use either launcher to read saved PDFs offline; the standalone launcher retains its local-file import controls. See [arXiv search](../docs/pdf-reading-workflow.md#search-arxiv-and-import-a-pdf).

In the main Prism reader, **Linked notes** lists the current notebook's references to the PDF, including unsaved changes. Open a note or jump to a cited page while keeping the reader session. This panel is omitted in the standalone launcher, which has no notebook.

The main Prism graph also connects cited PDFs to notes. **Show PDFs** toggles document nodes; activating one opens its lowest cited page. The compact note inspector shows up to four neighbors and opens the lowest page cited by that note. Its **Load PDF titles** action explicitly loads names; merely opening a note leaves library ownership untouched. Loading graph titles acquires the same library ownership as the reader while leaving PDF rendering unloaded until needed. See [graph navigation and recovery](../docs/pdf-reading-workflow.md#explore-pdf-connections-in-the-graph).

Prism PDF remains the standalone launcher during the transition. Launch it with `npm run start:pdf`; close the owning app before opening the library in the other launcher. See the [transition and backup guidance](../README.md#moving-from-prism-pdf). AI assistance and OpenAI API integration are outside Prism's scope.

![Prism PDF library with a real document thumbnail, tags, and favorites](docs/library.png)

[See the PDF reader](docs/reader.png). Screenshots show the actual Electron app with a test document.

## Open from your desktop

On Linux or Windows through WSL, run `npm run install:pdf` once from the repository root after installing dependencies. This builds the app and adds **Prism PDF** to your applications menu. On WSL it also creates **Prism PDF** shortcuts on your Windows desktop and in the Windows Start menu, including redirected OneDrive desktops.

Double-click the desktop shortcut or search for **Prism PDF** in Start. The shortcut opens the built app directly without a terminal or rebuilding it. Opening it again brings the existing window forward. You can pin the Start menu shortcut for easier access.

The launcher uses this checkout and its installed Electron runtime, so keep the repository in place. After moving the repository, rerun `npm run install:pdf`; after updating the code, rebuild with `npm run build:pdf`. Installation preserves your PDF library. To remove the launchers, delete the Windows shortcuts and the `io.github.beautysamurai.PrismPDF.desktop` file under `${XDG_DATA_HOME:-~/.local/share}/applications`.

## Run locally

Use Node.js 22.22.2 or newer. From the repository root:

```sh
npm ci
npm run start:pdf
```

The app opens a native Electron window. Import PDFs using the system file picker, organize them with tags and favorites, and search their titles, filenames, and tags. Switch between grid and list views, or pick up a document from Recently opened. The built-in PDF.js reader provides page navigation, zoom, rotation, password entry, and a remembered reading position. You can open a managed document in your system PDF app or reveal its file in the file manager.

In document details, focus **Tags** for suggestions from the whole library. Type to filter, then click a tag or use Up/Down and Enter. You can still enter new tags separated by commas. Escape closes suggestions; **Save changes** stores your edits.

**Import from URL** adds a public HTTPS PDF link directly to the library in either launcher. Paste a website's PDF download link, choose **Download PDF**, and then **Open PDF**. The dialog shows progress and supports cancellation while downloading. The same 100 MiB limit and content deduplication apply. Login pages and ordinary webpages are unsupported; download those PDFs in your browser and use **Import PDFs**. See the [website import guide](../docs/pdf-reading-workflow.md#import-a-pdf-from-a-website).

Use **New folder** in the library sidebar to organize existing PDFs. Drag a document from the grid or list onto a folder, or choose a **Folder** in its details and save. **Unfiled** contains documents without a folder; **All documents**, tags, Favorites, and Recently opened span the whole library. Folder management supports rename and removal; removing a folder returns its PDFs to Unfiled. These library folders keep managed files and document links at their existing paths.

Drag PDF files from Windows Explorer or your file manager onto the library or a sidebar folder to import copies. The library area and **Import PDFs** use the selected folder, otherwise Unfiled. Originals stay untouched. Duplicate files keep their existing library folder and metadata; the result reports imported files, duplicates, and errors separately. Use **Import from URL** for website links.

Select PDF text by dragging, then press **Ctrl+C** or choose **Copy selected text**. Embedded web/email links open in your default app; internal links jump to the destination page. Use **Find in PDF** or **Ctrl+F** to search the whole open document, then **Enter / Shift+Enter** or the match arrows to navigate. Search and copy use embedded text; image-only scans require OCR first. See [PDF text, links, and search](../docs/pdf-text-interactions.md).

Use **Ctrl+O** to import and **Ctrl+K** to search. **Previous / Next** buttons stay below the page while you scroll. Mouse-wheel and trackpad scrolling stay within the current page, including at its top and bottom, and never turn pages.

Click the PDF page to use **Left / Right**, **Page Up / Page Down**, or **Home / End** for the first/last page. **Space** scrolls down a screen and turns at the bottom; **Shift+Space** scrolls up and turns at the top. These shortcuts stay inside the page viewport so typing in notes, search, page-number, and password fields is unaffected.

## Your library

Imported PDFs are copied into Prism PDF's application-data directory, separate from Prism's Markdown notes. Each import is limited to 100 MiB, with up to 100 files per import and 2,000 documents in the library. Identical files are detected by content and imported once. The original selected file is not edited or deleted. The library keeps its own metadata and copies so it remains available when the source file moves. Back up the app's entire `library` directory to retain your documents and organization.

The default library locations are `%APPDATA%/prism-pdf/library` on Windows and `$XDG_CONFIG_HOME/prism-pdf/library` (normally `~/.config/prism-pdf/library`) on Linux. **Show library copy** opens its location in the system file manager.

Only one updated Prism app can own a library at a time. If another app has it open, close that app and choose **Try again**. Ownership is released automatically after a crash; keep the hidden `.prism-library-lock.sqlite` file in place. Close older app builds before sharing their library with an updated build.

Research imports add an optional `arxivId` to their catalogue entries; existing entries without it remain supported. Existing version 1 catalogues open unchanged. Creating the first library folder atomically upgrades the catalogue to version 2, adding folder records and optional document folder IDs while retaining existing PDFs and metadata. Update both launchers together: older builds reject version 2 rather than dropping organization data. Back up the complete library for use with another build. See [folder storage and compatibility](../docs/pdf-folders.md#storage-and-compatibility).

**Remove** removes the catalog entry and its tags, favorite, and reading position. Both the original and the managed PDF remain on disk. Removed copies can be imported again from `library/documents`; this release does not automatically reclaim their disk space. The displayed storage total counts cataloged PDFs only. A damaged catalog is reported without overwriting it; restore its backup before continuing.

Failed imports clean up copies that can still be verified as belonging to the failed operation. If a file was replaced, edited, or its ownership is uncertain, it is kept and its recovery path is shown in the error.

PDF rendering uses bundled workers, fonts, character maps, and WebAssembly resources. It does not require a remote PDF service. Search covers library metadata; it does not OCR scanned pages or index the full PDF text.

Enable **Appearance → Transparent window** and adjust background opacity to see the desktop through the interface. Document pages remain opaque. Transparency depends on the operating system compositor. As with Prism's Markdown window, Electron's transparent-window limits mean this app uses its own **Expand / restore** control rather than native resizing.

This first version is a document manager and reader. Pages render to canvas; text selection, PDF editing, merging, annotations, OCR, cloud sync, and signed installers are not included. Passwords are used only for the current reading session and are not saved. The app validates PDF headers on import and reports damaged documents when previewing them. As with other filesystem applications, its checks are not a security boundary against another process concurrently replacing its application-data directories.

## Development

Run these commands from the repository root:

```sh
npm run check:pdf     # TypeScript, library tests, and desktop build
npm run test:pdf:e2e  # Actual Electron desktop journeys; needs a display
```

On Linux without a display, run the desktop suite with `xvfb-run --auto-servernum npm run test:pdf:e2e`. The desktop suite uses temporary profiles; it does not alter your normal library.

Source code is in `pdf-manager/src/`; generated output is in `pdf-manager/dist/`. Dependencies and their pinned versions are managed by the repository-root package manifest and lockfile.

The [integration plan](../docs/pdf-stage-1.md) uses a shared `PDFLibraryService`, profile resolver, and reusable IPC handlers in both launchers. Prism's Notes/PDFs navigation keeps note drafts and reader sessions intact, with shared appearance settings. The library uses bundled Node SQLite only as an ownership lock; library metadata remains in the JSON catalogue alongside the managed PDF files.
