# Live tables

## Render and edit Markdown (implemented)

- Render complete top-level GFM tables in Live mode, including header-only tables, alignment, empty cells, escaped pipes, inline formatting, Japanese text, and equations. Use the existing sanitized Markdown renderer with the note's reference definitions.
- Keep the Markdown document as the only source of truth. Rendering does not normalize whitespace, escape sequences, line endings, or a UTF-8 BOM.
- Click a displayed cell to reveal the entire table with the caret at that cell's source. A cell's text formatting markers remain available. Empty cells place the caret inside the surrounding spaces; missing cells on short rows place it at the row end.
- Focus **Edit table** and press Enter or Space to reveal the header. Arrow keys, search, or a selection touching any table line also reveal its complete source. Move the caret outside the table to render it again.
- Typing, paste, copy, and undo use ordinary CodeMirror behavior. Rendering and source reveal add no undo steps. `/table` snippet fields remain editable until the caret leaves the table.
- Keep formula decorations out of table-owned source, preventing overlapping replacements. The table renderer typesets cell equations once.
- Defer decoration changes during IME composition and refresh after composition ends.
- Let wide tables scroll horizontally without widening the editor. Inherit theme colors, Japanese fonts, text scaling, and window transparency.
- Treat displayed links as labels in this editing surface: clicking opens the cell source. Read and Split retain normal link navigation. Images display their alternative text.

Incomplete tables remain editable Markdown. Tables nested inside quotes or lists also retain source in this increment, preserving their container markers. Table-like text inside code, HTML blocks, or multiline equations is not converted.

## Later increments

1. Render nested tables while preserving quote/list prefixes and their source positions.
2. Define direct cell editing: keyboard navigation, row/column insertion, escaped pipes, multiline paste, selection/copy behavior, and independent undo steps. Implement only after those behaviors can round-trip the original Markdown.

Graph dragging is a separate requirement and branch.
