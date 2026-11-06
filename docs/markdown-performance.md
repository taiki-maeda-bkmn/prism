# Markdown editing performance

Measured on 2026-11-06 with Electron 44.7.2 / Chromium 152.0.7977.149,
native WSLg Wayland, a 1440×1000 viewport, and device pixel ratio 1.

## Confirmed redundant work

Every edited note previously passed through the full reading renderer even in
Source and Live, where its HTML was never displayed. This parsed and sanitized
the document and compiled every body equation with KaTeX. React's deferred value
postponed this work but could not interrupt the synchronous conversion once it
started. Live's own unchanged equation widgets were already reused.

Source and Live now request navigation metadata instead. Both retain the same
heading IDs, labels, and indices. Live includes only editable Markdown headings;
Source keeps raw HTML headings and renders formulas within headings to preserve
their existing labels, including invalid formulas. Body equations are compiled
only for the visible Live widgets or the full Split/Read preview.

## Measurements

The disposable fixture contains Japanese prose, links, 50 inline formulas, and
50 display equations: 22,171 UTF-8 bytes and 553 lines. The paced phase inserts
the same 40-character sentence with a requested 25 ms delay between characters.

| Paced typing | Before | After |
| --- | ---: | ---: |
| Source: discarded preview formula HTML assignments | 4,100 | 0 |
| Live: discarded preview formula HTML assignments | 4,100 | 0 |
| Source: phase wall time | 1,974 ms | 1,512 ms |
| Live: phase wall time | 1,805 ms | 1,658 ms |

These are paired synthetic runs, not guaranteed latency improvements. Phase
wall time includes automation and a 150 ms settling interval. Renderer
keydown-to-animation-frame p95 did not show a consistent improvement: paced
Source was 13.2 → 16.5 ms and Live 20.5 → 21.2 ms. Burst typing, cursor movement,
and scrolling were similar between these runs. Neither run reported a renderer
long task over 50 ms. The deterministic improvement is removal of unnecessary
formula conversions and their temporary DOM allocations.

The probe counts successful KaTeX HTML assignments on detached preview
placeholders, separately from legitimate Live widgets. It does not count failed
formula attempts or claim to measure Windows compositor presentation. This
fixture does not open the PDF workspace or reproduce every real notebook.

## Reproduce

```sh
npm run build
node scripts/profile-markdown.mjs --output=/tmp/prism-markdown-profile
```

The opt-in script generates its own notebook and profiles, verifies exact saved
text, records `summary.json`, `renderer.cpuprofile`, and `electron-stderr.log`,
then removes its temporary data. It never opens the user's notebook. Compare
the same fixture, display backend, viewport, and build settings. CPU sampling
and automation affect timings.

## Verification and remaining work

The unit regressions compare metadata with full rendering, including math,
duplicate IDs, Unicode, nested headings, references, unsafe HTML, and invalid
formulas. They count KaTeX calls to ensure body math is not compiled for metadata.
Native regressions count discarded previews while typing, use visible Split
rendering as a positive control, and verify Japanese edits, outline navigation,
mode changes, undo, and exact BOM/CRLF saves. The Source regression failed on the
old build with 96 discarded formula conversions.

The final build and typecheck pass, with 360 unit tests passing and five
platform-specific skips. Twelve native desktop journeys pass across the new
performance regression, math, links, tables, and caret alignment. GitHub CI was
not checked, per the requested workflow.

This increment does not change the Live parser, graph/backlink updates, or
graphics backend. Further work should profile those costs in a representative
larger notebook and beside an active PDF before selecting another optimization.
Source still parses/sanitizes its document for raw HTML heading compatibility;
Live still parses the document to collect trusted headings.
