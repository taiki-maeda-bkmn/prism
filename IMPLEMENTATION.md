# Prism implementation plan

## First working desktop release

Build the brief in `AGENTS.md` as a local desktop application. Notes remain ordinary Markdown files in a folder chosen by the user. Electron supplies the native transparent window, and React with CodeMirror supplies the editing interface.

- [x] Desktop foundation: isolated renderer, narrow filesystem bridge, native folder picker, window controls, and a starter notebook.
- [x] Note workspace: folder navigation, search, create, explicit save, refresh, conflict detection, and protection for unsaved edits when closing or switching folders.
- [x] Markdown: source, split preview, and reading modes; syntax highlighting; safe rendering; wiki links and Markdown file links.
- [x] Connected notes: clickable graph, backlinks, and navigation between notes.
- [x] Appearance: true background transparency with adjustable opacity, legible text, and persistent preferences.
- [x] Delivery: filesystem/link tests, desktop interaction checks, documentation, CI, and a pull request with Copilot review requested.

## Scope and follow-up

The new requirements in `AGENTS.md` are being implemented one at a time:

- [x] Color customization: accent, page background, and text controls, saved locally, with reset and support for the existing transparent window.
- [x] Theme customization: Prism, Paper, and Sci-fi styles with coordinated palettes, typography, and controls; custom colors are remembered per theme.
- [x] Built-in snippets with Tab completion: headings, tasks, quotes, code blocks, tables, links, and wiki links, with editable fields and an in-app guide.
- [ ] Switchable direct editing in the rendered Markdown view: [stage 1](docs/live-editing.md) adds Live editing for headings and text formatting; the follow-up adds editable highlighted code blocks and interactive task checkboxes. Tables, list markers, and links remain separate stages.
- [x] [Math rendering](docs/math-rendering.md): offline inline and display equations in Split, Read, and Live, with source editing, invalid-formula recovery, and unchanged Markdown saves.
- [ ] Rearrange the graph by dragging individual vertices.

Text size now defaults to 120% and remains adjustable in Appearance. Built-in slash snippets now support Tab completion in Source, Split, and Live modes. User-defined templates and richer Live blocks remain separate follow-ups.

An open P2 review finding concerns concurrent replacement of nested directories between validation and filesystem access. A portable fix requires directory-handle operations across the filesystem layer. Per the brief's instruction to break down large next actions, [filesystem races](docs/filesystem-races.md) records the implementation stages and acceptance tests. This finding remains unresolved; passing current CI does not cover this race.

This release prioritizes editing, reading, and navigating local notes. Sync services, plugins, rich-text editing, attachment management, automatic link updates on rename, and signed installers are later requirements. The repository will include commands for building and running the desktop app.

Transparent windows depend on the host compositor. The implementation uses a transparent native window and translucent background colors, without blurring the windows behind it. The title bar uses native maximize/restore so the window manager reserves the taskbar area and restores the previous bounds. Linux/macOS allow native resizing; Windows retains fixed normal bounds. Compositor behavior still needs physical platform verification.

The WSLg launcher selects native Wayland before Electron initializes when the local Wayland socket is available. This avoids Xwayland's displaced content in maximized borderless windows. Explicit backend choices and remote or isolated X displays are preserved. Showing the loaded page explicitly also avoids an initially hidden transparent Wayland window. A WSLg Wayland resize schedules a full repaint so repeated maximization cannot retain the previous smaller surface. A dedicated opt-in test checks actual Windows host pixels and monitor work-area bounds through maximize, restore, and repeated maximization; Electron bounds alone did not reveal the original offset.

## Workflow

Implementation branch: `feat/prism-desktop`. Commit and push changes automatically, request Copilot review, address actionable review feedback, and leave the pull request open. Do not merge automatically.

Before reporting the work complete, check CI and the Codex review against the current PR commit. Wait for the review summary to show that commit as completed, address any new findings, and check for unresolved threads. A new push requires checking the new commit again; resolved comments on an earlier commit do not complete this check.

## Verification

- 160 launch, appearance, snippet, Live editing, math, Markdown, filesystem, metadata, external-link, and resource-access tests are defined (155 pass locally; five cases require Windows or macOS), including available Wayland sockets and explicit backend overrides, safe snippet contexts, IME composition guards and placeholder navigation, legacy color/theme/text-size preference migration, saved palettes across theme switches, malformed-value recovery, hex validation, UTF-8 BOM preservation, extensionless links, heading fragments, literal percent filenames, note creation without hard links, rejection of replaced notebook folders, starter publication that preserves competing folders, recovery from interrupted saves and competing writes, and preservation of native permissions and extended attributes.
- Twenty-four native Electron scenarios cover editor modes, preview, LF/CRLF preservation without phantom edits, disk saves, partial-publication recovery and manual repair, draft retention, undo isolation after discard and notebook changes, close cancellation, refresh/discard, invalid and duplicate names, graph navigation, backlinks, persisted appearance, startup retry, starter creation without symlinks and persistence across restarts, percent-containing filenames, scrolling to linked headings, external web/email links, custom colors with restart, reset, invalid saved values, retained undo history, native transparency, theme selection with saved palettes and keyboard navigation, live text sizing with accurate caret placement and restart persistence, and snippet expansion with field navigation, undo, prefix filtering, Escape dismissal, ordinary Tab/Enter behavior, and CRLF/BOM saves. Live editing adds formatted typing, editing rendered text by mouse, selection and composition-event checks, cursor/undo preservation through every mode, exact Markdown saves, snippets, mode persistence, and large-note outline navigation. Native maximize/restore is verified without fullscreen, with preserved window bounds, visible controls, synchronized state after reload, and transparency. Code/checklist journeys cover actual Java highlighting, direct code edits, mouse and Space toggles, undo isolation, exact copy/save, editable fences, incomplete code blocks, and code/task snippets with BOM/CRLF preservation. Math journeys cover inline and multiline equations in Split, Read, and Live, locally loaded fonts, direct formula editing, invalid-formula recovery, quoted equations, undo, exact BOM/CRLF saves, and appearance changes. The additional opt-in Windows host test checks real compositor pixels and work-area bounds.
- Native window capture confirms alpha 255 when opaque and approximately 89 at 35% background opacity.
- A normal launch with the sandbox enabled succeeds in the local Linux/WSLg environment. Windows/macOS compositor behavior still needs physical desktop testing.
- Linux, Windows, and macOS build/unit checks and a Linux desktop journey run in GitHub Actions. Current results and review activity are on [PR #2](https://github.com/beautysamurai/prism/pull/2).

The save-publication change and its recovery guarantees are broken down in [save recovery](docs/save-recovery.md). Retained recovery copies are not automatically pruned.
