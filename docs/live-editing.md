# Live Markdown editing

The brief asks for a mode where typing `# Title` formats the heading in the editing surface. Implement this incrementally, keeping Markdown files, reliable saving, snippets, and true window transparency.

## Stage 1: editable formatted text (implemented)

- Add **Live** beside Source, Split, and Read. Remember the selected mode. Keep existing shortcuts; Ctrl/⌘+4 opens Live.
- Use the existing CodeMirror document and undo history. Render formatting with decorations rather than converting edited HTML back into Markdown.
- Style headings, bold, italic, strikethrough, inline code, and block quotes as the user types. Hide their formatting markers on inactive lines; reveal markers on every line touched by the cursor or a selection.
- Initially keep unsupported block syntax as editable Markdown, then add the code/checklist and table follow-ups below. Links, ordinary list markers, and raw HTML retain their source syntax. Inline formatting inside list items receives the supported text treatment.
- Preserve selection and undo when switching modes, including Read. Maintain snippets, search, theme colors, text size, and background transparency.
- Navigate the Live outline to Markdown headings in the editor, including headings outside the current viewport. Raw HTML headings remain available in the reading outline.
- Verify literal Markdown saves, LF/CRLF/BOM preservation, mouse caret placement, selection of literal Markdown, composition-event handling, large notes, and startup preferences. Native IME candidate-window behavior still needs manual platform testing.

## Follow-up: code blocks and checklists (implemented)

- Render fenced and indented code in editable monospace panels. Highlight recognized languages locally; unknown language names remain plain code. A fence becomes a language label when inactive, and its exact Markdown reappears when editing or selecting the boundary. Preserve blank lines and unfinished fences without interpreting their contents as prose or tasks.
- Render parsed task markers as native checkboxes. Click or focus and press Space to change only the marker’s middle character. Keep the source visible on active/selected lines, preserve focus, and make each toggle an independent undo step.
- Keep snippets, source/reading mode switches, selections and copying, IME guards, custom palettes, text size, transparency, and LF/CRLF/BOM saves working. Never execute code.
- Verify Java highlighting, direct code editing, fence access, actual mouse/keyboard checkbox behavior, nested tasks, exact source saves/copying, undo, read-only guards, and code/task snippets.

## Stage 2: list presentation and links

Add readable list markers and link labels with an explicit navigation gesture. Retain reliable access to their Markdown source. Define behavior for selection, keyboard navigation, nested formatting, and incomplete syntax before hiding additional markers.

## Stage 3: tables (first increment implemented)

Top-level GFM tables render when the selection is outside them. Clicking a cell reveals the complete source with the caret at that cell; **Edit table** offers keyboard access. Edits, paste, selection, copying, and undo use the existing Markdown document. See [table editing](live-tables.md) for source mapping, malformed content, and the remaining work on nested tables and direct cell editing. Images, embedded notes, and arbitrary HTML editing remain outside the current editor scope.

Each stage gets its own branch and review. Stage 1 is the first usable increment, not full rich-text editing of every Markdown construct. Rearranging graph nodes by dragging is a separate requirement.
