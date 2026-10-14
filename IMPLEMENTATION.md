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

This release prioritizes editing, reading, and navigating local notes. Sync services, plugins, rich-text editing, attachment management, automatic link updates on rename, and signed installers are later requirements. The repository will include commands for building and running the desktop app.

Transparent windows depend on the host compositor. The implementation uses a transparent native window and translucent background colors, without blurring the windows behind it. Electron documents limitations around native resizing and maximization, so the app will offer controlled window sizing and document platform verification.

## Workflow

Implementation branch: `feat/prism-desktop`. Commit and push changes automatically, request Copilot review, address actionable review feedback, and leave the pull request open. Do not merge automatically.

Before reporting the work complete, check CI and the Codex review against the current PR commit. Wait for the review summary to show that commit as completed, address any new findings, and check for unresolved threads. A new push requires checking the new commit again; resolved comments on an earlier commit do not complete this check.

## Verification

- 67 Markdown, filesystem, external-link, and resource-access tests pass locally, including extensionless links, heading fragments, literal percent filenames, note creation without hard links, rejection of replaced notebook folders, staged starter publication, and recovery from interrupted saves and competing writes.
- Five native Electron scenarios cover editor modes, preview, disk saves, draft retention, close cancellation, refresh/discard, invalid and duplicate names, graph navigation, backlinks, persisted appearance, startup retry, percent-containing filenames, scrolling to linked headings, and external web/email links.
- Native window capture confirms alpha 255 when opaque and approximately 89 at 35% background opacity.
- A normal launch with the sandbox enabled succeeds in the local Linux/WSLg environment. Windows/macOS compositor behavior still needs physical desktop testing.
- Linux and Windows build/unit checks and a Linux desktop journey run in GitHub Actions. Current results and review activity are on [PR #2](https://github.com/beautysamurai/prism/pull/2).

The save-publication change and its recovery guarantees are broken down in [save recovery](docs/save-recovery.md). Retained recovery copies are not automatically pruned.
