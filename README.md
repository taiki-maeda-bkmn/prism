# Prism

A local Markdown notebook and PDF library with live preview, connected notes, and a transparent desktop window. Built with Electron, React, TypeScript, and CodeMirror.

Prism includes **Notes** and **PDFs** workspaces in the same window. Use the buttons in the title bar to switch between them, or choose **Read & write** to keep a note and PDF visible together.

Follow the [reading and writing guide](docs/pdf-reading-workflow.md) to import a PDF, add page references to a note, save, and resume later. It also covers keyboard focus and recovery when a note or PDF cannot be opened or saved.

The **[Prism PDF](pdf-manager/README.md)** standalone launcher remains available with `npm run start:pdf`. Both launchers use the same existing PDF library for your OS account; close the app that owns it before opening it in the other launcher. See the [integration plan](docs/pdf-integration.md) for progress.

![Prism showing source editing, live preview, and connected notes](docs/prism-desktop.png)

[See the graph view](docs/prism-graph.png).

## Run

Install Node.js **22.22.2 or later** (Node 24 recommended), then:

```sh
npm ci
npm start
```

Prism opens a starter notebook with four connected notes. Use **Open notebook** to choose your own folder. Existing files are never seeded or overwritten. The chosen folder and appearance preferences are remembered when you reopen the app.

On Linux and macOS, the starter folder is a symbolic link to a complete notebook in an adjacent `.prism-notebook-…` folder. If the filesystem cannot create links, Prism opens and remembers that complete notebook directly. When backing it up, copy the actual note files, not just a link. The **Open notebook** button's tooltip shows the resolved folder path. Windows uses an ordinary starter folder.

This is a desktop application; opening the HTML file in a browser does not provide notebook access.

### Open from your desktop

On Linux or Windows with WSLg, install the launcher once after installing dependencies:

```sh
npm run install:desktop
```

On Windows, double-click **Prism** on your desktop or search for **Prism** in the Start menu. On Linux, choose **Prism** from your applications menu. The green prism icon opens Prism with Notes and PDFs; **Prism PDF** still opens the standalone reader. Launching needs no terminal and does not rebuild the app.

Keep this repository in place: the shortcuts use its installed Electron and built app. Run `npm run install:desktop` again after moving the repository or updating the app. The previous `npm run install:markdown` command remains an alias for the same launcher. Your notebook and preferences remain in their existing locations. To remove the launchers, delete the Windows shortcuts and the Linux `io.github.beautysamurai.Prism.desktop` file from `${XDG_DATA_HOME:-~/.local/share}/applications`.

### Moving from Prism PDF

Use **Prism → PDFs** as the main entry point. Close the standalone **Prism PDF** app before opening its library in Prism; if the library is busy, close its owner and choose **Try again**. No re-import or catalog migration is needed: both launchers use the same OS account's `prism-pdf/library` directory, preserving tags, favorites, titles, document IDs, and reading positions. Back up that entire directory with both apps closed. A Windows library and a Linux/WSL library are separate; Prism does not combine them automatically.

The separate sibling `pdfmanager` project remains independent. Its documents need an explicit import into Prism; selecting its manifest as Prism's catalog is unsupported. The standalone Prism PDF launcher remains available during the transition.

Prism stores notes and PDFs locally. Rates & Execution and arXiv discovery retrieve published research online. AI assistance and OpenAI API integration are out of scope; no API key is required.

## Write, read, connect

- **PDF page links:** open a note and PDF, then click **Insert page link** in the reader. The current page becomes an ordinary Markdown link at your note selection; undo removes it in one step and saving remains explicit. Read mode switches to Source for insertion. Click the link in Read/Split, or Ctrl/Command-click in Live, to open that PDF page. Renaming a PDF keeps the link working. Links depend on its managed ID: back up the PDF library alongside the notebook, and replace links after removing and re-importing a PDF. See the [format and recovery guide](docs/pdf-page-links.md).
- **Notes and PDFs:** import, organize, and read PDFs without opening a second app. Switching workspaces keeps the note's draft, cursor, selection, mode, and undo history, as well as the reader's current page and password session. Library filters stay in place when returning from a document. PDFs use the same Appearance settings; document pages stay opaque. PDF resources load locally on your first visit.
- **Rates & Execution:** choose **Rates & Execution** in the PDF library to search published papers, filter topics and ratings, and select a review edition. **Import PDF + review** saves the PDF with topic tags and a linked Markdown review under `Research/Rates & Execution` in the current notebook, grouped by topic or month if desired. Open either item from the result. Repeat imports preserve existing PDFs and edited reviews. Discovery and downloads need an internet connection; saved PDFs and notes remain usable offline. See the [research import guide](docs/pdf-reading-workflow.md#import-a-published-rates--execution-review).
- **Search arXiv:** search directly from the PDF library by title, author, all fields, or arXiv ID; filter by category and sort the results. Read an abstract, then **Import PDF** and **Open PDF**. Categories become tags, existing copies are reused, and saved PDFs work offline. Direct import saves only the PDF; use **Read & write** and **Insert page link** to connect your own notes. See [arXiv search and import](docs/pdf-reading-workflow.md#search-arxiv-and-import-a-pdf).
- **Import from URL:** paste a public HTTPS PDF download link into the PDF library in either launcher. Follow progress, cancel a download, and open the saved copy offline. Identical PDFs reuse their existing titles, tags, and reading positions. See [website PDF import](docs/pdf-reading-workflow.md#import-a-pdf-from-a-website).
- **PDF folders:** create folders in the library sidebar, then drag a PDF from the grid or list onto a folder. Drop onto **Unfiled** to remove its assignment, or use **Details → Folder** with the keyboard. Folder changes preserve tags, reading positions, and note links. See [organizing PDFs](docs/pdf-reading-workflow.md#organize-pdfs-in-folders).
- **PDF tag suggestions:** in document details, focus **Tags** to see matching tags from your library. Click a suggestion or use Up/Down and Enter. Suggestions complete the tag at your cursor; you can also type new tags separated by commas. Choose **Save changes** to keep them.
- **PDF page turning:** Previous/Next buttons stay below the page while you scroll. Mouse-wheel and trackpad scrolling stay on the current page, including at its top and bottom. Click the page to use Left/Right or Page Up/Page Down. Space scrolls a screen, then turns at the bottom; Shift+Space goes backward. Home/End jump to the first/last page.
- **PDF linked notes:** expand **Linked notes** above a PDF page to find notes in the current notebook that cite it, including unsaved edits. Open a note or jump to a cited page. Note paths distinguish duplicate titles; PDF references retain their document IDs through title changes.
- **PDF graph connections:** the full graph shows document-shaped PDF nodes for citations in the current notebook. **Show PDFs** toggles them; clicking one opens its lowest cited page. Duplicate titles keep separate identities, and **Missing PDF** nodes lead to recovery options. **Refresh PDF titles** retries a library error.
- **Nearby connections:** the compact inspector graph shows up to four neighboring notes and PDFs, with a **+N more connections** action for the full graph. Compact PDFs open a page cited by the current note. **Load PDF titles** retrieves names without opening the reader; opening a note alone leaves the PDF library unopened. Draft edits and undo update the connections immediately.
- **Read & write:** show your note and PDF beside each other, with independent scrolling. Click a pane to direct its shortcuts there, or use the **Notes** and **PDFs** buttons to focus it. Drag the divider to resize; focus it and use Left/Right arrows (Shift for larger steps), Home or double-click to reset, and Escape to cancel a drag. **Swap sides** switches PDF and Markdown between left and right while keeping their widths and current content. Pane order and proportions are remembered. **Show notes** opens note navigation; **Library navigation** opens PDF tags and filters in a narrow pane. Turning **Read & write** off shows the focused workspace. A narrow window temporarily shows one workspace and restores both when widened. Prism starts in the single-workspace layout; saved notes and reading positions remain available when reopened.
- **Source, Split, Live, and Read:** choose Markdown source, side-by-side preview, direct formatted editing, or a reading view. Mode changes retain your cursor and undo history.
- **Room to write:** Live and Read use the available pane width in every theme, with modest side padding that adapts to the window size.
- **Arrange your graph:** drag note or PDF nodes to reshape the full graph, or focus a node and use the arrow keys (hold Shift for larger steps). Click or press Enter/Space to open it. Manual positions stay in place while filtering, navigating, editing, and refreshing the current notebook; they reset when you switch notebooks or restart Prism. **Reset layout** restores the automatic arrangement; the percentage button resets only pan and zoom.
- **Live editing:** type `# Title` to format a heading immediately. Headings, emphasis, strikethrough, inline code, and quotes show their formatting in the editor. Markdown markers appear on the line you edit or select. The outline takes you directly to editable headings. Code blocks have editable panels with language highlighting. Task lists have checkboxes you can click or focus and toggle with Space; their changes support undo and save as `[ ]` or `[x]`. HTML keeps its source syntax; see the [staged plan](docs/live-editing.md).
- **Live lists:** bullets show their nesting, and ordered lists display consecutive numbers from the first item. Click a bullet or number to edit its original Markdown, or move the cursor onto the line. Source indentation, repeated `1.` markers, copying, undo, and existing line endings are preserved.
- **Live links:** Markdown and wiki links display their labels. Hold **Ctrl** and left-click to open a linked note, heading, web page, or email address (**⌘+click** also works on Mac). This works in tables and while editing link source. An ordinary click reveals the Markdown for editing. Multiline links keep their source layout and remain clickable.
- **Live tables:** Markdown tables render with column alignment, formatted text, and equations, including inside quotes and lists. Click a cell or activate **Edit table** to reveal the exact Markdown, with its quote/list prefixes preserved; move the caret outside the table to render it again. Opening list markers can also be clicked or focused and activated with Enter or Space. Wide tables scroll horizontally; see [table editing](docs/live-tables.md).
- **Japanese text:** a bundled Noto Sans JP font keeps Japanese readable offline in the editor, preview, note names, and graph labels, including systems without Japanese fonts installed. The font and its Open Font License are included in the build.
- **Math equations:** write `$x^2$` inline or put `\frac{a}{b}` between `$$` delimiters for a display equation. `\(…\)` and `\[…\]` also work. Split, Read, and Live render equations offline using bundled KaTeX and fonts. In Live, click an equation or move the cursor onto its line to edit the original LaTeX; move away to render it again. Code examples and escaped dollar signs stay literal. Invalid formulas retain their source, with an error available on hover. See the [supported KaTeX commands](https://katex.org/docs/supported.html); complete LaTeX documents and package loading are outside this feature.
- **Tab snippets:** type `/` at the start of a line or within prose in Source, Split, or Live mode to see templates, choose with the arrow keys, and press **Tab**. Full shortcuts such as `/task` also expand with Tab. Use Tab and Shift+Tab to move through fields, or Esc to leave a snippet. Open **Snippets** above the editor to add, edit, or delete your own templates and see the built-in guide. Custom snippets are saved locally for all your notebooks.
- **Ordinary files:** search notes by name or content, create notes in nested folders, and save directly to Markdown files. Nothing is sent to a server.
- **Connected notes:** use `[[Note name]]`, `[[Note name|label]]`, `[label](folder/note.md)`, or extensionless `[label](folder/note)`. The graph and backlinks update as you write. Links such as `[[Note#Heading]]` and `[label](note.md#heading)` also scroll to the destination heading.
- **A clear workspace:** navigate the outline, hide sidebars with Focus mode, or explore the graph with pan and zoom.
- **Room for your outline:** drag the left edge of the right sidebar to resize Outline, Connections, and Backlinks. Focus the divider and use Left/Right arrows (Shift for larger steps), or double-click it or press Home to reset. The width is remembered across restarts and adapts to smaller windows while preserving room for writing.
- **True transparency:** enable **Appearance → Transparent window** and adjust background opacity. Text remains opaque; no blur is applied to the windows behind Prism.
- **Your themes:** choose **Prism**, **Paper**, or **Sci-fi** in **Appearance**. Paper pairs warm colors with serif reading text; Sci-fi uses a dark palette, monospace headings, and angular controls. The selected theme is remembered when Prism reopens. Switching themes preserves your drafts, editor mode, and transparency settings.
- **Readable text:** text opens at a larger **120%** size. Use **Appearance → Text size** to adjust notes, navigation, and settings from **100% to 150%**. The size is remembered across restarts and themes; **Reset text size** returns to 120%.
- **Your colors:** change the accent, page background, and text colors with a picker or hex code. Colors update immediately across the source editor, preview, and graph. Each theme remembers its custom palette, including when you switch away and return. **Reset colors** restores the selected theme’s default palette while keeping the other themes’ colors and your editor mode and transparency settings.

Saving is explicit. Unsaved drafts survive switching between notes within the current session. Closing Prism, refreshing the notebook, or opening another folder asks you to save or discard those drafts. Drafts are kept in memory until saved, so save before terminating the process or shutting down the computer.

Closing the last window ends the app session, cancels research downloads, finishes accepted file writes, and releases the PDF library. **Cancel** keeps Prism open. If the editor crashes, a native prompt lets you keep waiting or close and discard unsaved changes. Launching Prism again brings an existing hidden window forward. See [startup and shutdown](docs/session-lifecycle.md).

In **PDFs**, **Ctrl+O / ⌘O** imports documents and **Ctrl+K / ⌘K** focuses library search. In **Notes**, **Ctrl+O / ⌘O** opens a notebook. In **Read & write**, these shortcuts follow the pane you last focused; **Ctrl+S / ⌘S** saves while Notes is focused. Closing from either workspace still asks about unsaved notes. PDFs remain in the existing managed library, separate from your Markdown notebook; see [library storage and backup](pdf-manager/README.md#your-library). Switching workspaces neither saves nor discards a draft, and PDF passwords are never persisted. All four note modes remain available; the note's own Split preview stacks vertically when its pane is narrow.

Built-in snippets insert ordinary Markdown:

| Shortcut | Inserts |
| --- | --- |
| `/h1`, `/h2` | A heading and space to continue writing |
| `/task` | An unchecked task |
| `/quote` | A block quote |
| `/code` | A fenced code block with language and code fields |
| `/table` | A two-column table with editable headers and values |
| `/link` | A link with label and URL fields |
| `/wiki` | A `[[Note name]]` connection |

Shortcuts work within ordinary prose after whitespace, punctuation, or Japanese text, as well as at the start of a line. Block snippets add line breaks as needed to keep their Markdown separate from surrounding text; `/link` and `/wiki` insert directly at the cursor. Inside table cells or inline formatting, use cursor insertion to preserve the surrounding structure. Snippets stay inactive inside code, HTML tags or blocks, existing links, and URLs. Escape dismisses a suggestion without expanding it; Tab outside an active snippet or matching shortcut keeps normal keyboard focus navigation.

For a custom template, choose **Snippets → Add snippet**, enter a name and unique shortcut such as `/meeting`, and write your Markdown. Use `${1:Topic}`, `${2:Action}`, and `${0}` for editable fields and the final cursor position. Escape braces as `\{` and `\}` when you need them literally. New custom snippets insert directly at the cursor, including multiline templates. Enable **Insert as a separate block** to add line breaks around the template when expanding within ordinary prose. Previously saved block templates retain this setting and can also expand within prose. Shortcuts start with a lowercase letter after `/` and accept lowercase letters, digits, hyphens, and underscores (up to 32 characters). Save up to 100 custom templates of 20,000 characters each. Editing the catalog takes effect immediately and preserves the open note's draft and undo history.

Within LaTeX equations, custom snippets insert directly at the cursor, including templates previously saved as separate blocks. Backslashes and brackets are recognized as LaTeX: a shortcut such as `/widehat` can expand in `\mathbb{E}[(/widehat)]` without spaces. This also works while writing an unfinished `$$`, `$`, `\(`, or `\[` equation. Existing Markdown links and code examples keep their usual snippet restrictions.

Prism checks for external changes before saving and keeps your draft if it detects a conflict. Each save captures the previous file before publishing the draft, and refuses to replace a new destination created during publication. Copy your draft before refreshing to load the external version. Use **Refresh notebook** to see files added or changed outside Prism.

Saves retain recovery files beside the note in a hidden `.prism-recovery/save-…` directory: `original.md`, `draft.md`, and a manifest. A `complete` marker identifies a settled save. On loading a notebook, Prism can restore a missing note from an unfinished save; it never replaces an existing destination or restores deliberately deleted notes from completed saves. If an existing file cannot be verified as a complete known version, Prism leaves every copy untouched, withholds that note from the list, and shows a recovery warning with the copies' location. See [manual recovery](docs/save-recovery.md#manual-recovery) before choosing which version to keep. Recovery copies are not automatically pruned in this release.

Saves preserve supported file metadata, including extended attributes and access controls. This uses GNU `/bin/cp` on Linux, the native copy API through system `/usr/bin/osascript` on macOS, and Windows PowerShell for Windows permissions. If those helpers are unavailable or permissions cannot be preserved, Prism reports a save error and retains recovery copies. See [save recovery](docs/save-recovery.md) for platform details.

| Action | Windows / Linux | macOS |
| --- | --- | --- |
| Save current note | Ctrl+S | ⌘S |
| Save all changed notes | Ctrl+Shift+S | ⌘Shift+S |
| New note | Ctrl+N | ⌘N |
| Open notebook | Ctrl+O | ⌘O |
| Find a note | Ctrl+P | ⌘P |
| Source / Split / Read | Ctrl+1 / 2 / 3 | ⌘1 / 2 / 3 |
| Live editing | Ctrl+4 | ⌘4 |
| Toggle graph | Ctrl+Shift+G | ⌘Shift+G |
| Find text in the editor | Ctrl+F | ⌘F |

## Desktop behavior and limits

Prism creates a native transparent window and uses alpha backgrounds. Actual composition depends on the operating system and desktop compositor. Use **Maximize window** in the title bar to maximize within the desktop work area, keeping the taskbar and window controls available. The same button becomes **Restore window** and returns to the previous size and position. This uses the operating system’s maximized state, not fullscreen. Linux and macOS also allow normal window resizing. Windows keeps the normal window size fixed to retain transparent-window behavior. The initial size fits the current screen. Opening DevTools can disable native transparency. See [Electron's transparent-window documentation](https://www.electronjs.org/docs/latest/tutorial/custom-window-styles#transparent-windows).

On Windows with WSLg, the desktop shortcut and `npm start` automatically use native Wayland when its socket is available. This avoids [WSLg's displaced content in maximized borderless X11 windows](https://github.com/microsoft/wslg/issues/1015). Remote X displays and isolated test displays retain their existing backend. An explicit backend flag is respected, for example `npm start -- --ozone-platform=x11`.

Prism remembers its normal size and maximized state when reopened. Native Windows, macOS, and X11 also restore the previous position and fit saved bounds to a connected screen after monitor changes. Native Wayland desktops, including WSLg, choose the window's position themselves. The former WSLg host-position helper was removed because moving only the visible Windows window could prevent clicks from reaching the displayed controls. Its old preference file is left untouched. Closing while minimized still reopens a visible window. See [window placement](docs/window-placement.md) for the fix and the deferred WSLg position-restoration plan.

The first release supports UTF-8 `.md` and `.markdown` files (new files use `.md`). An existing UTF-8 byte-order mark is preserved on save and excluded from the editor text. Existing newline styles are preserved; editing a file with mixed line endings normalizes it to its first newline style. Each note can be up to 2 MB; a notebook can load up to 2,000 notes and 64 MB of text. Hidden folders, `node_modules`, symbolic links, and unsupported filenames are skipped, with scan warnings shown in the app. Preview HTML is sanitized; scripts, forms, external image loading, and arbitrary local file access are blocked. Task-list checkboxes in Read and Split previews are read-only. Use the Live editor’s checkboxes or edit the Markdown source to change them. Code blocks are displayed and edited; code is never executed.

Attachments, embedded notes, file renaming/deletion, synchronization, plugins, and signed installers are outside this first release. The desktop launchers use the source checkout; they are not standalone installers. Windows and macOS compositor behavior needs testing on those desktops; automated Linux desktop tests verify the app's native window and editing flows.

## Development and checks

```sh
npm run check       # TypeScript, Markdown/filesystem tests, production build
npm run test:e2e    # Playwright against the actual Electron app
```

Linux CI runs `scripts/test-desktop-with-wm.sh` inside Xvfb with Openbox, so native maximize and restore are tested with a real window manager. The test suite uses temporary notebooks and user profiles, and captures a desktop screenshot in `test-results/`. Electron's sandbox is disabled only for automated test launches; normal `npm start` keeps it enabled.

For PDF performance measurements, see the [investigation and follow-up plan](docs/pdf-performance.md). `node scripts/profile-pdf.mjs --output=/tmp/prism-pdf-profile` profiles a built app with generated PDFs and disposable profiles, recording redraw counts, frame gaps, GPU status, and a renderer CPU profile.

On an interactive WSLg desktop, `PRISM_TEST_WSLG_HOST=1 npx playwright test tests/e2e/host-window.spec.ts` also checks the actual Windows host surface. It focuses its own temporary window, verifies four opaque test pixels through maximize/restore, and checks the host monitor's work area. These tests catch displaced or frozen content that Electron's internal bounds and screenshots can miss. They also check repeated minimize/restore cycles, newly painted host pixels, and preserved drafts; ordinary CI skips these host-specific checks. On native Wayland under WSLg, returning focus clears a stale minimized state so the editor can resume painting without reloading your notes. The separate repeated-maximize geometry test still exposes an intermittent clipped surface on the current WSLg host, also reproduced before this recovery change; that resize issue remains open.

`PRISM_TEST_WSLG_HOST=1 npx playwright test tests/e2e/host-window-input.spec.ts` checks real Windows mouse delivery to its uniquely titled temporary Prism window after reopening with legacy host-position preferences. This test moves the pointer and clicks only its own verified test window; it uses disposable profiles and restores the pointer when it has not subsequently moved. Playwright clicks alone bypass this input route and did not catch the earlier WSLg position-restoration regression.

The isolated renderer talks to a narrow preload bridge. The main process validates sender frames and notebook paths, serializes writes, detects external changes, and preserves displaced versions during save publication. Concurrent replacement of a nested folder can still redirect a path-based filesystem operation; this known P2 remains open, with its implementation and tests broken down in [filesystem races](docs/filesystem-races.md).

See [IMPLEMENTATION.md](IMPLEMENTATION.md) for scope and progress, [save recovery](docs/save-recovery.md) for the publication and recovery design, and [AGENTS.md](AGENTS.md) for the project brief and branch/review workflow. Pull requests remain open for review and are not merged automatically.
