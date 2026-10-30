# Read a PDF and write a linked note

Open **Prism** from its desktop shortcut. This workflow uses the main app's **Notes** and **PDFs** workspaces; the standalone **Prism PDF** launcher shares the same library and must be closed before Prism opens it.

## Start a reading session

1. In **Notes**, open your notebook and select or create a note. Put the cursor where you want to add a reference.
2. Choose **Read & write** in the title bar. **Show notes** opens note navigation; **Library** opens PDF filters and tags when its pane is narrow.
3. Open a PDF from your library, or use **Import PDFs**. Imported originals stay untouched. Password-protected PDFs ask for a password for the current reading session.
4. Read and write in either pane. Drag the divider to change their widths. The note keeps its Source, Split, Live, or Read mode; the note's own Split preview stacks vertically when space is limited.
5. On the page you want to cite, choose **Insert page link**. The link replaces the current note selection, or inserts at the cursor. One undo removes the insertion. Read mode changes to Source so you can see the change.
6. Focus **Notes** and press **Ctrl+S** (**⌘S** on Mac), or click the note's **Save** button. Inserting a link does not save it automatically.

Click a reference in Read or Split preview to open its page. In Live, use **Ctrl+click** or **⌘+click**; an ordinary click edits its Markdown. In Source, switch to Split, Live, or Read to follow the link. A linked PDF opens beside the note if **Read & write** is active; otherwise Prism switches to PDFs. Returning to Notes retains the draft and selection.

## Import a published Rates & Execution review

1. Open the notebook where you want to keep research notes. In **PDFs**, return to the library and choose **Rates & Execution**.
2. Search by title, author, arXiv ID, or topic. Use **Topic**, **Edition type**, and **Minimum rating** to narrow the published catalogue. Ratings are compared on a ten-point scale. Each paper appears once with its latest matching edition; **Review edition** selects another matching edition.
3. Read the published commentary. Some publications provide a **Full edition review** covering several papers; Prism labels it accordingly. **Published source** and **arXiv paper** open the original pages in your browser.
4. Check the destination notebook and choose **Group review notes**. Then select **Import PDF + review** and keep the dialog open until it finishes.
5. Choose **Open review** to edit the saved Markdown, or **Open PDF** to read the managed document. The review includes its published rating, authors, topics, source links, and a **Read PDF** link to page 1. That link connects the note and PDF in the graph and the reader's **Linked notes** panel.

| Group review notes | Destination within the current notebook |
| --- | --- |
| Topic | `Research/Rates & Execution/<first published topic>/` (or `Uncategorized`) |
| Month | `Research/Rates & Execution/YYYY-MM/`, using the edition date |
| No subfolders | `Research/Rates & Execution/` |

The PDF goes into the existing managed library; published topics become its tags. Importing the same arXiv paper again reuses its saved PDF and preserves your title, existing tags, favorite, and reading position. If another edition refers to a different arXiv version, Prism reports that it reused the saved version instead of replacing its contents. An identical local PDF can also be reused by its file content.

Repeating the same paper and edition preserves its existing review, including your edits, even when you choose another grouping. Each imported note has a hidden source marker on its first line; keep that marker so later imports can recognize it. A different review edition can create a separate note. Existing files at the intended destination are preserved, with a numbered filename used for the new review. Importing does not save or discard the draft you were already editing.

If the PDF is saved but the review cannot be written, the result explains the failure and still offers **Open PDF**. Resolve the notebook error and choose **Retry import** to add the review using the saved PDF. Catalogue or review loading failures have their own retry buttons; **Refresh catalogue** checks for newly published entries.

Browsing published research and downloading PDFs require an internet connection. Saved PDFs and review notes work offline through the normal library and notebook. This browser searches the Rates & Execution catalogue; use **Search arXiv** to look beyond it. It reads existing published commentary and needs no AI service or API key. Research import is available in the main Prism app, where a notebook is open.

## Search arXiv and import a PDF

1. In the main app's **PDFs** library, choose **Search arXiv**. Opening the dialog does not start a search.
2. Set **Search in** to **All fields**, **Title**, or **Author**, then enter a short phrase. Choose a **Category**, or leave **All categories** selected to search across arXiv. The category menu offers selected finance, economics, mathematics, statistics, and computing categories; you can also leave the phrase blank and browse one of these categories.
3. Choose **Relevance**, **Newest submission**, or **Recently updated** under **Sort by**, then press **Search**. Searches use your text as a literal phrase; arXiv query operators are not supported. After changing any criteria, press **Search** again to apply them.
4. Select a paper to read its abstract, authors, submission/update dates, and categories. Large author lists can be expanded. **arXiv paper** opens the original page in your browser. **Previous results** and **Next results** browse 20 papers at a time, up to the first 2,000 results; narrow your search to find more.
5. Choose **Import PDF**, wait for it to finish, and select **Open PDF**. The paper is saved in your existing library with its arXiv categories as tags.

To find a specific paper, choose **arXiv ID** under **Search in** and enter its bare ID, such as `2601.00001v2`, or paste an official arXiv abstract/PDF URL. Category and sort controls are inactive for an ID lookup.

Repeat imports reuse the saved paper while preserving your title, existing tags, favorite, and reading position. A request for another version reports that the existing version was retained. Direct import creates no review note: open or create your own note, choose **Read & write**, and use **Insert page link** to cite a page. Your current draft remains available; save note edits explicitly.

Search and downloads need an internet connection; saved PDFs remain readable offline. **Retry search** repeats a failed search, and **Import PDF** can retry a failed import. Batch importing remains deferred. No account or API key is required.

## Turn pages from the reading area

Use the **Previous / Next** buttons below the page; they stay visible while a zoomed page scrolls. With the mouse over the PDF, scroll normally through the page. Once you reach the bottom, pause briefly and scroll down again to turn forward. At the top, pause and scroll up to turn backward, landing at the preceding page's bottom. Each wheel or trackpad gesture turns at most one page; momentum from scrolling down a page cannot skip ahead.

Click the PDF page to focus its keyboard controls. **Left / Right** and **Page Up / Page Down** turn pages directly; **Home / End** jump to the first/last page. **Space** scrolls down about one screen, then turns forward on the next press at the bottom. **Shift+Space** does the same backward. Search, page-number, password fields, and the note editor keep their usual typing behavior. Scrolling over the PDF while a note is focused does not move the typing cursor out of the note.

## Find notes that cite a PDF

Open **Linked notes** above the PDF page to see references from the current notebook, including unsaved edits. Each note appears once, with its relative path and cited pages. Click the note to open it; **Read & write** keeps the PDF beside it. Click a page button to read that citation. Neither action saves the note or changes its editor mode.

The list updates as you insert, edit, or undo Markdown references, and when you refresh or change notebooks. Code/math examples, images, raw HTML, and unused reference definitions do not count. Duplicate PDF titles stay separate because references use document IDs. Removing and re-importing a PDF creates a new ID, so existing notes keep pointing to the original document.

Cited pages become available after the PDF loads or is unlocked. Out-of-range pages remain marked **unavailable**; open the note and correct the reference. The panel scrolls independently and can be collapsed to leave more reading space. This notebook feature is available in the main Prism app.

## Explore PDF connections in the graph

Choose **Graph view** in Notes. With **Show PDFs** checked, document-shaped nodes connect PDFs to the notes citing them, including unsaved references. Only PDFs cited by this notebook appear. Drag a PDF node or move it with the arrow keys, just like a note; filtering PDFs off and on retains manual positions.

Click a PDF node, or press Enter/Space while it is focused, to open its lowest cited page across the notebook. Use **Linked notes** in the reader for other cited pages and to return to a note. Hovering a node shows the full document ID and cited pages; duplicate titles remain separate documents.

The graph loads library titles without opening PDF pages. This uses the same library ownership as the reader, so close the standalone Prism PDF app first if it owns the library. **Refresh PDF titles** retries an error. Notes remain navigable during a library failure; references show shortened IDs until titles are available. A successful load marks absent IDs **Missing PDF**. Open those nodes for the usual missing-reference recovery options. Re-importing a PDF creates a different identity and does not repair an old reference automatically.

The inspector's compact **Connections** graph shows the current note and up to four nearby notes or cited PDFs. When both types are present, each gets up to two places; spare places show other connections. **+N more connections** opens the full graph with PDFs visible. The compact preview stays independent of the full graph's filter and manual arrangement.

A compact PDF node opens the lowest page cited by the current note, including unsaved references. **Load PDF titles** fills in document names without opening the reader; until then, references show shortened IDs. Already loaded titles are reused. Merely opening a note does not open or take ownership of the PDF library. **Refresh PDF titles** retries a failure, and PDF nodes remain usable while titles are unavailable.

Draft text survives navigating to other notes or the full graph. Undo history stays available while visiting PDFs and returning to the same mounted note; switching notes or entering the full graph currently starts a fresh editor history. Save explicitly to keep edits after restarting Prism.

## Focus and window controls

Click inside a pane to send its shortcuts there. The title-bar **Notes** and **PDFs** buttons also select a pane and return focus to it; they can be reached with Tab and activated with Enter or Space.

| Focus | Shortcut | Action |
| --- | --- | --- |
| Notes | Ctrl/⌘+S | Save the current note |
| Notes | Ctrl/⌘+Shift+S | Save all changed notes |
| Notes | Ctrl/⌘+P | Find a note |
| Notes | Ctrl/⌘+O | Open a notebook |
| PDFs | Ctrl/⌘+O | Import PDFs |
| PDFs | Ctrl/⌘+K | Search library metadata |
| PDF page viewport | Left/Right or Page Up/Page Down | Turn pages |
| PDF page viewport | Space / Shift+Space | Scroll a screen down/up; turn at the corresponding edge |
| PDF page viewport | Home / End | First / last page |
| Pane divider | Left/Right, with Shift for larger steps | Resize panes |
| Pane divider | Home or double-click | Reset equal widths |

Use the title-bar maximize button to fill the desktop work area while retaining the taskbar. Restore returns to the previous window bounds. Minimize retains the reading and editing session. Narrow windows temporarily show the focused workspace; widen the window to restore both panes. **Read & write** stays selected during this fallback, and can be turned off to keep one workspace.

## Save and return later

Within an open session, switching between **Notes** and **PDFs**, or toggling **Read & write**, retains drafts, editor history, PDF page, zoom, rotation, and the current reader's unlocked session. Save notes before quitting; closing, refreshing a notebook, or opening a different notebook asks about unsaved changes.

After a restart, Prism starts with Notes only. Choose **Read & write** again to use the saved divider proportions, then open your PDF from the library to resume its last successfully rendered page. Following a note's page link instead opens the page recorded in that link. PDF zoom, rotation, and passwords are session-only; unsaved drafts and undo history do not survive quitting.

PDF reading, Japanese fonts, Markdown preview, and page links use bundled local resources and work offline. No account or API key is needed.

## Recover a reading session

| Problem | What to do |
| --- | --- |
| Note changed in another app | A save conflict retains your draft and leaves the newer disk file untouched. Copy your draft somewhere safe before using Refresh and discarding it to load the external version. Cancel leaves the draft open. |
| Library already open elsewhere | Close its owning Prism/Prism PDF instance, then choose **Try again**. Keep the note open while resolving the library issue. |
| PDF file missing or unreadable | Use the reader's retry when the same managed file is available again, or return to the library. Your note stays open. Restore library backups with both apps closed. |
| PDF absent from the catalogue | Browse the library and insert a replacement link, or close Prism and restore the original library backup. Re-importing a removed PDF creates a new identity. |
| Link has an invalid page or unsupported format | Choose a valid page and insert a replacement reference. The original note text remains available to edit. |

Back up both your notebook and the entire managed PDF library with both Prism launchers closed. Renaming a PDF keeps links working, but copying the notebook alone does not include its PDFs. See [page-link identity and recovery](pdf-page-links.md) and [library locations](../pdf-manager/README.md#your-library).

Linux desktop tests cover the app's native window and editing flows. Windows/macOS compositor checks still need physical testing; the previously documented WSLg repeated-maximize clipping issue remains open. See [desktop behavior and limits](../README.md#desktop-behavior-and-limits).
