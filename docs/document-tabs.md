# Document tabs and topics

Open notes from the notebook or PDFs from the library to add them to the shared
tab area. Opening the same document again selects its existing tab. Markdown and
PDF icons distinguish the two kinds; a dot marks a note with unsaved edits.

Click a tab to return to it. **Ctrl+Tab** and **Ctrl+Shift+Tab** cycle through open
documents across all topics, revealing the selected document's group. **Ctrl+W** closes the focused document tab.
Closing an edited note offers **Save & close**, **Discard & close**, and **Cancel**.
A failed save leaves the tab and draft open. Other drafts are unaffected. Closing
a tab does not delete its file, and closing the final tab keeps Prism open.

In **Read & write**, selecting a Markdown tab changes the note pane; selecting a
PDF changes the reader pane. The other pane stays in place. Back to library and
the Notes/PDFs buttons remain available for browsing and opening more documents.

## Topic groups

Use **New topic** to create a group such as Research or Trading. Topics can mix
Markdown notes and PDFs. Select a tab, then use **Move tab to** to assign it to a
topic or return it to Ungrouped. Newly opened notes and PDFs always start in
**Ungrouped**. Opening an already open document keeps its existing assignment.

Choose a group in the existing controls row to show only its document tabs.
Changing the visible group leaves the current document and its draft in place;
select a document tab to switch documents. When group choices overflow, small
left/right arrows scroll them horizontally within the same controls row.
New topics start empty; use **Move tab to** to assign the current document.

Rename or remove the selected topic using its pencil or × control. Removing a
topic moves its tabs to Ungrouped and preserves all documents. Topic groups are independent of
notebook directories and PDF library folders/tags; they never move files.

The selected group's tab rows wrap automatically. With many rows, the tab area scrolls vertically and
leaves room for the document panes. Left/Right and Home/End move keyboard focus
between visible tabs; Enter or Space selects one. Topic controls and close
buttons are also keyboard accessible. Within the group selector, Left/Right and
Home/End move focus without changing groups; Enter or Space shows that group.
Hiding **Topic tools** in Markdown Layout keeps group navigation available.

## Persistence and resource limits

Open tabs, topic names, assignments, the visible group, and the selected tab are
remembered separately for each notebook on this device. Refresh removes tabs for
notes no longer in the notebook; a successful PDF catalogue load removes tabs for
removed PDFs. A failed library load leaves their metadata available for retry.
When changing notebooks, open PDF tabs remain available because the library is
shared. They enter Ungrouped unless already assigned in the destination notebook;
the current reader stays in place. Notebook notes and topic names remain separate.

Tab metadata does not store document contents or passwords. Existing explicit
save, save-conflict detection, and application-close prompts protect note drafts.
Switching notes uses the existing [bounded editor-history cache](editor-history.md);
drafts remain independent of history eviction. Reading-view scroll positions are
retained during the session. Accepted notebook refresh resets note history and
reading positions as before.

At most three PDF readers remain loaded. Other open PDF tabs retain lightweight
page, zoom, rotation, and scroll information until revisited. Evicted encrypted
readers require their password again. Closing a PDF tab releases its reader and
temporary view snapshot. Across application restarts, PDF page numbers remain
saved in the library; zoom, rotation, scroll, and passwords start fresh.

The metadata limit is 256 open tabs and 32 topics per notebook. Reaching a limit
reports how to make room; existing tabs and drafts are kept. Tabs are part of the
combined Prism application. The separate legacy PDF launcher retains its
single-reader workflow.

## Delivery increments

1. Shared mixed-document tabs, safe closing, topic groups, wrapping rows, keyboard
   navigation, and per-notebook metadata.
2. Retained PDF readers with bounded memory and independent reading coordinates.
3. Local model/build checks and disposable desktop journeys for drafts,
   mixed groups, restart, narrow layouts, and save conflicts; review and native
   release activation.
4. Explicit grouping and a compact group selector: new files start Ungrouped,
   one group's tabs appear at a time, and existing assignments survive upgrades.

Drag reordering, detachable windows, and synchronizing tab groups between devices
are separate follow-ups.

## Validation

Both application builds and typechecks pass, with 433 Markdown/shared unit passes
(five platform skips) and 124 PDF unit passes. Fourteen new model cases cover tab
metadata, groups, limits, notebook transitions, and bounded PDF reader retention.
Twenty-six integrated native Windows journeys pass, including six new tab
scenarios; the final compact group layout passes all six again. Five standalone
PDF journeys confirm existing reading, password, damaged-file, scanned-page, and
window behavior. Tests use disposable notebooks, libraries, and profiles.

The native checks preserve two independent note drafts and undo stacks, verify
exact BOM/CRLF saves and failed-save recovery, restore topic metadata after a
restart, exercise wrapping at 420 pixels and 150% text, and retain reader state
through switching, eviction, and delayed imports. They also check Read-view scroll
through graph navigation and hiding Notes. GitHub CI was not checked.

The compact group-selector follow-up passes both builds and typechecks, with
441 main unit passes (five platform skips). All 17 targeted Linux/WSLg desktop
journeys pass across tabs, Markdown layout, side-by-side reading, and PDF text
interactions. Coverage includes new PDFs opening Ungrouped from a selected topic,
reopening assigned PDFs, independent viewed-group persistence, hidden topic tools,
unchanged drafts/undo and reader sessions, and mouse/keyboard group navigation.
At 420 pixels and 150% text, ten group choices keep the same header height while
the selected group's twelve document tabs wrap. Screenshots were visually checked.
The redo tests use an uppercase `Shift+Z` key event so Linux receives the intended
shortcut. All fixtures are disposable; no GitHub CI was checked. Windows package
verification checks staged build hashes and launcher targets separately from
native launch, which remains unverified under the existing Smart App Control policy.
