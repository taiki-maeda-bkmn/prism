# Live tables

## Render and edit Markdown (implemented)

- Render complete GFM tables in Live mode, at the top level and inside quotes or lists, including header-only tables, alignment, empty cells, escaped pipes, inline formatting, Japanese text, and equations. Use the existing sanitized Markdown renderer with the note's reference definitions.
- Keep the Markdown document as the only source of truth. Rendering does not normalize whitespace, escape sequences, line endings, or a UTF-8 BOM.
- Click a displayed cell to reveal the entire table with the caret at that cell's source. A cell's text formatting markers remain available. Empty cells place the caret inside the surrounding spaces; missing cells on short rows place it at the row end.
- Focus **Edit table** and press Enter or Space to reveal the header. Arrow keys, search, or a selection touching any table line also reveal its complete source. Move the caret outside the table to render it again.
- Typing, paste, copy, and undo use ordinary CodeMirror behavior. Rendering and source reveal add no undo steps. `/table` snippet fields remain editable until the caret leaves the table.
- Keep formula decorations out of table-owned source, preventing overlapping replacements. The table renderer typesets cell equations once.
- Defer decoration changes during IME composition and refresh after composition ends.
- Let wide tables scroll horizontally without widening the editor. Inherit theme colors, Japanese fonts, text scaling, and window transparency.
- Ctrl+left-click displayed links to open them (Command+click also works). Ordinary clicks open the cell source. Read and Split retain normal link navigation. Images display their alternative text.

Incomplete tables remain editable Markdown. Table-like text inside code, HTML blocks, or multiline equations is not converted. Formulas spanning physical table rows also retain source; supported cell formulas fit on one line.

## Nested tables (implemented)

- Render tables inside blockquotes, bullet lists, numbered lists, and combinations of those containers. Preserve the order of quote borders and list indentation. A table may share its first line with a list marker or follow earlier text in the list item.
- Retain exact quote prefixes, indentation, list markers, and original cell offsets in the document. Only the rendered copy removes container prefixes. Clicking a cell reveals the complete table source with its prefixes intact; selecting any prefix or delimiter also reveals it.
- When a list item begins with a table, show its bullet or computed list number alongside the header. Click that marker, or focus it and press Enter or Space, to edit the original marker. Earlier numbered items affect the displayed number even when they are outside the table.
- Keep table styling within the measured widget, so text below it retains correct caret placement. Ancestor quote decorations must not independently style or hide the table's source. Math in cells is rendered once, and Ctrl-click links retain their existing behavior.
- Preserve neighboring quote/list paragraphs and independently reveal multiple tables in one container. Reused widgets resolve current cell positions after preceding edits and reject stale container or reference metadata.
- Require explicit quote prefixes on every row. Ambiguous lazy quote continuations or inconsistent physical row boundaries retain their source instead of concealing unrelated text.

## Later increments

1. Define direct cell editing: keyboard navigation, row/column insertion, escaped pipes, multiline paste, selection/copy behavior, and independent undo steps. Implement only after those behaviors can round-trip the original Markdown.

Graph dragging is a separate requirement and branch.
