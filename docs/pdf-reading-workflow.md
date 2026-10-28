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
| Pane divider | Left/Right, with Shift for larger steps | Resize panes |
| Pane divider | Home or double-click | Reset equal widths |

Use the title-bar maximize button to fill the desktop work area while retaining the taskbar. Restore returns to the previous window bounds. Minimize retains the reading and editing session. Narrow windows temporarily show the focused workspace; widen the window to restore both panes. **Read & write** stays selected during this fallback, and can be turned off to keep one workspace.

## Save and return later

Within an open session, switching workspaces and layouts retains drafts, editor history, PDF page, zoom, rotation, and the current reader's unlocked session. Save notes before quitting; closing, refreshing a notebook, or opening a different notebook asks about unsaved changes.

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
