# Live Markdown editing

The brief asks for a mode where typing `# Title` formats the heading in the editing surface. Implement this incrementally, keeping Markdown files, reliable saving, snippets, and true window transparency.

## Stage 1: editable formatted text (implemented)

- Add **Live** beside Source, Split, and Read. Remember the selected mode. Keep existing shortcuts; Ctrl/⌘+4 opens Live.
- Use the existing CodeMirror document and undo history. Render formatting with decorations rather than converting edited HTML back into Markdown.
- Style headings, bold, italic, strikethrough, inline code, and block quotes as the user types. Hide their formatting markers on inactive lines; reveal markers on every line touched by the cursor or a selection.
- Initially keep unsupported block syntax as editable Markdown, then add the code/checklist, link, list, and table follow-ups below. Raw HTML retains its source syntax. Inline formatting inside list items receives the supported text treatment.
- Preserve selection and undo when switching modes, including Read. Maintain snippets, search, theme colors, text size, and background transparency.
- Navigate the Live outline to Markdown headings in the editor, including headings outside the current viewport. Raw HTML headings remain available in the reading outline.
- Verify literal Markdown saves, LF/CRLF/BOM preservation, mouse caret placement, selection of literal Markdown, composition-event handling, large notes, and startup preferences. Native IME candidate-window behavior still needs manual platform testing.

## Follow-up: code blocks and checklists (implemented)

- Render fenced and indented code in editable monospace panels. Highlight recognized languages locally; unknown language names remain plain code. A fence becomes a language label when inactive, and its exact Markdown reappears when editing or selecting the boundary. Preserve blank lines and unfinished fences without interpreting their contents as prose or tasks.
- Render parsed task markers as native checkboxes. Click or focus and press Space to change only the marker’s middle character. Keep the source visible on active/selected lines, preserve focus, and make each toggle an independent undo step.
- Keep snippets, source/reading mode switches, selections and copying, IME guards, custom palettes, text size, transparency, and LF/CRLF/BOM saves working. Never execute code.
- Verify Java highlighting, direct code editing, fence access, actual mouse/keyboard checkbox behavior, nested tasks, exact source saves/copying, undo, read-only guards, and code/task snippets.

## Follow-up: links (implemented)

- Render single-line Markdown links, reference links, autolinks, and wiki aliases with the existing sanitized reading renderer. Preserve inline formatting in labels and document-global reference definitions. Unresolved references remain literal source.
- Ctrl+left-click opens the destination through Prism's existing note or external-link routing. Command+click also works. Same-note and other-note fragments navigate to Markdown headings at all six levels, including duplicate heading IDs. Links in rendered tables use the same gesture.
- Ordinary clicks reveal the source. Caret and selection lines retain every character and remain Ctrl-clickable. Multiline links preserve line breaks and use clickable source text. Rendered link labels support keyboard focus and Enter.
- Keep code, images, escaped examples, and equations out of link handling. Respect IME composition and current source offsets after edits. The document, newline convention, drafts, and undo history remain unchanged by rendering or navigation.

## Stage 2: list presentation (implemented)

- Render parsed `-`, `+`, and `*` list markers as bullets on inactive lines, with distinct bullets for nesting. Number ordered lists from their first source number and advance once per item, matching the reading view even when every later source marker is `1.`. Each nested list and delimiter change starts its own sequence.
- Replace only the marker. Preserve source indentation, spaces, tabs, continuation lines, and the existing wrapping layout. Task items retain their interactive checkboxes without an additional bullet. Formatting, links, and inline math in list text keep their existing behavior.
- Click a bullet or number to edit its exact Markdown. Moving the caret or a selection onto a line also exposes the source. Arrow navigation, Enter continuation, selection/copy, snippets, and undo use the existing editor document. Empty markers stay literal until text is present on the marker line.
- Leave code, HTML, equations, escaped examples, and table-owned source protected. Defer presentation changes during IME composition and resolve the current source offset when a marker is clicked.
- Verify numbering, nesting, task/link interaction, source reveal, selection/copy, undo across mode changes, wrapped Japanese text at larger sizes, and exact BOM/CRLF saves. Hanging-indent reflow and structural list editing controls are separate enhancements.

## Stage 3: tables (first increment implemented)

Top-level GFM tables render when the selection is outside them. Clicking a cell reveals the complete source with the caret at that cell; **Edit table** offers keyboard access. Edits, paste, selection, copying, and undo use the existing Markdown document. See [table editing](live-tables.md) for source mapping, malformed content, and the remaining work on nested tables and direct cell editing. Images, embedded notes, and arbitrary HTML editing remain outside the current editor scope.

Each stage gets its own branch and review. Stage 1 is the first usable increment, not full rich-text editing of every Markdown construct. Rearranging graph nodes by dragging is a separate requirement.
