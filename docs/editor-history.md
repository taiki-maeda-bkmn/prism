# Per-note editor sessions

## Scope

Prism retains a note's text undo/redo history, selection, and editor scroll position when switching to another note or the full graph, then returning. Ordinary saves and cancelled refresh/open dialogs keep that session. Source, Split, Live, and Read continue to use the current editor behavior. History is local to the current application session; closing Prism does not persist it.

Accepted refreshes, discarded drafts followed by reload, and notebook replacement clear every retained editor session, including redo-only histories and notes with identical paths and contents in another notebook. A content mismatch also starts a fresh history. Draft text remains owned by the notebook UI independently of retained editor history.

## Implementation

The notebook UI owns an inactive-editor cache. Each accepted refresh or notebook replacement advances its generation, preventing a retired editor's cleanup from returning stale history to the new session. Restoration consumes a snapshot and reconstructs editor extensions with current links, snippets, appearance, and event handlers. Exact content validation, including the newline convention, rejects a stale snapshot.

The cache retains at most **20 inactive notes**, with an **8 MiB total serialized payload budget** and a **2 MiB per-note limit**. Payload accounting uses UTF-16 string size and includes note paths. The cache evicts the least recently used snapshots or skips oversized ones. Eviction removes history, never drafts. An incremental serialization budget stops oversized histories before constructing the complete JSON string, including histories containing large deleted text behind a small current draft.

Serialization occurs only during navigation/unmount. Ordinary scrolling tracks a small CodeMirror position anchor, mapped through edits, without serializing the document. Hidden Read/PDF views retain their last visible anchor. Cleanup uses the tracked anchor because parent layout changes can clamp the outgoing editor's scroll position before unmount. Explicit heading navigation takes precedence over restored positioning.

## Boundaries

The cache stores Markdown text history and selection rather than retaining editor views or DOM nodes. Transient completion popups, snippet placeholder sessions, search UI, and folding effects are not part of the restored session. Older or oversized inactive histories may be evicted; active editing and unsaved draft text are unaffected.

## Verification

Build and typecheck pass. The main unit suite has **369 passes and five platform skips**, including nine new editor-session cases. These cover independent note histories and selections, saved and redo-only states, accepted reset boundaries, stale cleanup, exact content/BOM/newline validation, a draft with no line breaks, LRU and aggregate-budget eviction, and oversized document/history/escape rejection. The extended Linux desktop scroll check also passes note, graph, and hidden Read-mode round trips.

All **15 native Windows desktop journeys pass** against staged release `20261106T121423214Z-cd4f8683`: seven editor-history journeys, four notebook lifecycle checks, and four side-by-side checks. Disposable Windows profiles verify independent histories, exact Japanese BOM/CRLF saves, graph navigation, reset/cancel behavior, restart boundaries, current Live/theme/snippet/link behavior, and long-note selection/scroll through Read → graph → Read → Source. Windows redo checks use Ctrl+Y. The suite completed in 42.8 seconds; elapsed test time is not an application performance measurement.

The native launcher harness also passes actual Windows mouse delivery, Japanese text save/readback preserving BOM/CRLF, dirty-close cancellation, repeated minimize/relaunch with retained drafts and renderer identity, clean process-tree exit, reopen, and the hidden PowerShell wrapper. The Japanese check uses editor input events rather than physical Microsoft IME composition. All fixture data is disposable and successful fixtures are removed.

The verified staged release was activated through the existing native Windows workflow. Desktop and Start Menu shortcuts were backed up and updated; opening the desktop shortcut produced a responsive native Prism window. No production session was running before activation, and application data remained in its existing Windows folders. GitHub CI was not checked; the PR is left unmerged for review.

### Synthetic capture and restore cost

A pure CodeMirror state benchmark on Linux with Node 22.23.2 used generated Japanese/math text, 100 independent edits, and 20 undo operations. Twenty runs measured capture and restoration with current extensions; no user notebook, DOM, Electron window, or application data was opened.

| Workload | Retained payload | Capture median / p95 | Restore median / p95 |
| --- | ---: | ---: | ---: |
| 28.9 KB note with small edits | 65.7 KB | 0.24 / 0.49 ms | 0.95 / 1.66 ms |
| 137 KB note replaced 100 times | Rejected; 0 bytes | 11.52 / 13.22 ms | Not restored |

The replacement workload would serialize about 21.8 MB of UTF-16 JSON without the budget guard; baseline stringification took a median 40.24 ms. These timings measure state handling only. They do not establish native frame rates or measure the full Markdown rendering pipeline, React navigation, OS input, or compositor presentation. The desktop diagnostic separately records navigation durations and renderer tasks above 50 ms without a timing-based pass/fail threshold.
