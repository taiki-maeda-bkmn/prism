# Live Markdown editing

The brief asks for a mode where typing `# Title` formats the heading in the editing surface. Implement this incrementally, keeping Markdown files, reliable saving, snippets, and true window transparency.

## Stage 1: editable formatted text (implemented)

- Add **Live** beside Source, Split, and Read. Remember the selected mode. Keep existing shortcuts; Ctrl/⌘+4 opens Live.
- Use the existing CodeMirror document and undo history. Render formatting with decorations rather than converting edited HTML back into Markdown.
- Style headings, bold, italic, strikethrough, inline code, and block quotes as the user types. Hide their formatting markers on inactive lines; reveal markers on every line touched by the cursor or a selection.
- Keep the structural syntax of unsupported constructs, including links, lists, tasks, fenced code, tables, and raw HTML, as editable Markdown. Inline formatting inside list items still receives the supported text treatment.
- Preserve selection and undo when switching modes, including Read. Maintain snippets, search, theme colors, text size, and background transparency.
- Navigate the Live outline to Markdown headings in the editor, including headings outside the current viewport. Raw HTML headings remain available in the reading outline.
- Verify literal Markdown saves, LF/CRLF/BOM preservation, mouse caret placement, selection of literal Markdown, composition-event handling, large notes, and startup preferences. Native IME candidate-window behavior still needs manual platform testing.

## Stage 2: richer blocks and links

Add task controls, readable list markers, and link labels with an explicit navigation gesture. Retain reliable access to their Markdown source. Define behavior for selection, keyboard navigation, nested formatting, and incomplete syntax before hiding additional markers.

## Stage 3: tables and code blocks

Add table and code-block editing treatments only after defining lossless source mapping, keyboard navigation, paste behavior, undo boundaries, and fallback behavior for malformed content. Images, embedded notes, and arbitrary HTML rendering remain outside the current editor scope.

Each stage gets its own branch and review. Stage 1 is the first usable increment, not full rich-text editing of every Markdown construct. Rearranging graph nodes by dragging is a separate requirement.
