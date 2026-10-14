# Prism implementation plan

## First working desktop release

Build the brief in `AGENTS.md` as a local desktop application. Notes remain ordinary Markdown files in a folder chosen by the user. Electron supplies the native transparent window, and React with CodeMirror supplies the editing interface.

- [ ] Desktop foundation: isolated renderer, narrow filesystem bridge, native folder picker, window controls, and a starter notebook.
- [ ] Note workspace: folder navigation, search, create, explicit save, refresh, conflict detection, and protection for unsaved edits when closing or switching folders.
- [ ] Markdown: source, split preview, and reading modes; syntax highlighting; safe rendering; wiki links and Markdown file links.
- [ ] Connected notes: clickable graph, backlinks, and navigation between notes.
- [ ] Appearance: true background transparency with adjustable opacity, legible text, and persistent preferences.
- [ ] Delivery: filesystem/link tests, desktop interaction checks, documentation, CI, and a pull request with Copilot review requested.

## Scope and follow-up

This release prioritizes editing, reading, and navigating local notes. Sync services, plugins, rich-text editing, attachment management, automatic link updates on rename, and signed installers are later requirements. The repository will include commands for building and running the desktop app.

Transparent windows depend on the host compositor. The implementation uses a transparent native window and translucent background colors, without blurring the windows behind it. Electron documents limitations around native resizing and maximization, so the app will offer controlled window sizing and document platform verification.

## Workflow

Implementation branch: `feat/prism-desktop`. Commit and push changes automatically, request Copilot review, address actionable review feedback, and leave the pull request open. Do not merge automatically.
