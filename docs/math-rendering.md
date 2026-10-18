# Math rendering

Add equation rendering as a focused follow-up to Live Markdown editing. Keep the Markdown document authoritative and preserve the existing editor history, code blocks, checklists, themes, and transparent window.

## Shared equation rendering

- Recognize inline `$…$` and display `$$…$$` formulas, including multiline display equations. Support the LaTeX delimiters `\(…\)` and `\[…\]` consistently where practical.
- Render with locally bundled KaTeX and fonts in Split, Read, and Live modes. Keep code examples, escaped delimiters, and ordinary currency literal.
- Bound rendering work, disable commands that load resources or inject HTML, and keep raw Markdown HTML sanitization intact. Invalid equations retain their source and a useful error rather than breaking the note.

## Editable Live formulas

- Show a typeset formula when it is inactive. Reveal its exact source when editing or selecting it, and provide a keyboard-accessible way to edit the rendered formula.
- Keep edits, copying, undo, mode switches, and BOM/line-ending preservation lossless. Avoid disturbing IME composition.

## Verification and delivery

- Cover delimiter parsing, malformed expressions, literal code/currency, unsafe commands, and graph/outline behavior with focused tests.
- Exercise local font loading, formula editing and recovery, mode changes, undo, exact saves, appearance, and transparency in the desktop app.
- Build the updated desktop app, commit and push the requirement branch, request Copilot review, and wait for CI and Codex review on the final PR commit. Leave the PR open.

Document-level LaTeX projects, package loading, and PDF compilation are separate future work.
