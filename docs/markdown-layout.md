# Markdown layout

Choose **Layout** in the note toolbar, then **More writing space** to reclaim the space above your Markdown. This hides the large document heading, editor hint bars, routine save banners, and topic editing controls, and reduces toolbar spacing. Open tabs and group navigation remain visible.

You can also adjust each option independently:

- **Document heading:** show the large title, word count, reading time, and mode buttons. When hidden, a compact Source/Split/Live/Read selector appears beside Layout. The file name stays in the toolbar and tab.
- **Editor labels and hints:** show the labels above the editor and preview. When hidden, the toolbar keeps a Snippets button.
- **Save notifications:** show routine saved confirmations. Errors, notebook warnings, and other guidance remain visible. The status bar continues to show saved or unsaved state.
- **Topic tools:** show New topic, Move tab to, and the selected topic's rename/remove controls while Notes is visible, including Read & write. Tabs and the compact group selector remain accessible. PDF-only mode retains its topic tools.
- **Compact spacing:** reduce spacing around the toolbar, title, and hint bars without shrinking note text.

Changes apply immediately and are remembered on this device. **Reset layout** restores the original options. Layout and Save stay accessible even when the heading is hidden. Ctrl+1/2/3/4 still choose Source/Split/Read/Live.

Layout preferences are independent of themes, transparency, notebook selection, and PDF layout. Changing them does not save a note or replace the editor or PDF reader. Drafts, undo history, selections, and reading positions remain in the existing sessions; a scroll position near the document end may clamp to the new viewport size.

## Implementation and acceptance

The versioned `prism.markdown-layout` preference stores only booleans. Invalid fields fall back to defaults, and damaged or future versions restore all controls. CSS hides the existing heading/label wrappers without remounting the editor. Save confirmations carry a separate routine-notice classification so warnings cannot be suppressed by the save preference.

Validation covers preference recovery, Japanese BOM/CRLF editing and exact saves, retained editor state, layout restoration, mode recovery, narrow panes at enlarged text sizes, and the shared PDF workflow. Tests use disposable notebooks, profiles, and libraries.

Further changes such as freely dragging toolbar components or resizing the heading itself are outside this increment.
