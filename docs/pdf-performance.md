# PDF rendering investigation

Measured on 2026-11-01 with Electron 44.7.2 / Chromium 152.0.7977.149,
native WSLg Wayland, a 1440×1000 viewport, and device pixel ratio 1.

## Findings

**Redundant resizing work was confirmed and fixed.** The reader previously
started a complete page render on every viewport-width change, including fixed
numeric zoom where the page's scale did not change. A 12-step divider drag
published 12 replacement pages. The fixed version leaves numeric-zoom pages
alone and waits 120 ms for fit-width resizing to settle, retaining the previous
surface until its replacement is ready. Initial sizing remains immediate.

| Synthetic document / drag | Page paints before → after | HTML canvas pixels allocated before → after |
| --- | --- | --- |
| Dense vector, 150% zoom | 12 → 0 | 13,087,008 → 0 |
| Dense vector, fit width | 12 → 1 | 4,576,547 → 306,180 |
| Scanned images, 150% zoom | 12 → 0 | 48,960,000 → 0 |
| Scanned images, fit width | 12 → 1 | 4,717,160 → 316,065 |

Pixel counts are cumulative allocations during the drag, including PDF.js
intermediate HTML canvases; they are not peak resident memory measurements.
Replaced completed page canvases now release their backing buffers immediately.
Previously those buffers waited for garbage collection; this was not evidence
of a permanent memory leak. Height-only observer callbacks also no longer reset
the reader's wheel-navigation gate.

**Graphics acceleration is unavailable in this tested Electron/WSLg environment.**
Electron reports `disabled_software` for canvas, GPU compositing, and
rasterization. Direct minimal Electron windows reproduce this with opaque and
transparent Wayland windows and a transparent X11 window, without Playwright.
The Wayland result also reproduces with normal Electron sandboxing enabled.
This is broader than Prism's PDF code, transparency setting, or Wayland alone.
The exact graphics initialization/driver cause remains unresolved. No launcher,
host graphics, sandbox, or transparency settings were changed.

The GPU-info API reports “due to frequent crashes,” but that wording does not
prove a crash sequence: this Chromium version also uses it for a general
unavailable-GPU branch. The captured startup logs do not show an explicit crash
or relaunch. See the matching [Chromium GPU access implementation](https://raw.githubusercontent.com/chromium/chromium/152.0.7977.149/content/browser/gpu/gpu_data_manager_impl_private.cc)
and [Electron release](https://releases.electronjs.org/release/v44.7.2).

**Ordinary scrolling did not rasterize pages.** Both opaque and transparent
scrolling phases published zero new pages. Frame-gap p95 values varied around
16.8–24.5 ms across the runs, without a consistent transparency penalty. No
renderer long task above the browser's 50 ms threshold occurred in these sample
phases. These measurements do not reproduce or rule out stalls in a particular
real PDF, at higher display scale, or in the Windows compositor's presentation.

**Page turning and initial library loading still do work worth investigating.**
Revisiting a page paints a fresh canvas; there is no completed-page bitmap cache.
Synthetic page-turn interactions took roughly 70–240 ms, including automation
and readiness waits, rather than pure drawing time. The first thumbnail phase
started 10 PDF workers for the visible/nearby cards. Thumbnail jobs remain
eligible after a card has once been visible, even if the PDF workspace is later
hidden. PDF.js also performs canvas execution on the renderer main thread;
the CPU profile includes image scaling, drawing setup, text, and fills.

At the time of this investigation, wheel page turning required a deliberate
gesture: a 250 ms quiet gap, 350 ms inter-turn cooldown, and movement threshold.
That interaction policy could feel like a pause at a page edge without being a
rendering stall. A subsequent change removed wheel page turning at the user's
request; mouse-wheel and trackpad scrolling now stay within the current page.

## Reproduce the measurements

```sh
npm run build
node scripts/profile-pdf.mjs --output=/tmp/prism-pdf-profile
```

The opt-in harness uses 12 generated PDFs in disposable notebooks/profiles:
eight-page vector documents with 4,000 paths and 1,000 text draws per page,
six-page scans containing 3000×4000 grayscale images, and small text documents.
It never opens or modifies the user's library. It records `summary.json`,
`renderer.cpuprofile`, and `electron-stderr.log`, then removes its temporary data.
Run it on the same display backend and viewport when comparing versions.
Xvfb is useful for functional tests but is not a substitute for native graphics
measurements. CPU sampling covers the renderer main thread, not PDF workers;
canvas counters exclude OffscreenCanvas. Timing figures include automation waits.

## Follow-up increments

- [x] Eliminate fixed-zoom resize paints, settle fit-width resizing, and release
  superseded page buffers. Preserve quality, selection, scrolling, and page links.
- [ ] Diagnose graphics availability separately: compare the actual Mesa renderer
  with Electron initialization details and GPU process-exit events. Evaluate
  alternatives only with native input, transparency, maximize, and restore checks.
- [ ] Measure a bounded cache for recently rendered pages. Limit retained pixels
  and clear it on document/retry changes; keep latest-request and password behavior.
- [ ] Pause/reprioritize thumbnail jobs when cards or the PDF workspace are hidden,
  preserving managed-file verification and foreground reader responsiveness.
- [ ] Profile a representative large/math-heavy notebook while typing beside PDFs
  before changing Markdown/backlink recomputation. It is a separate potential cost,
  not a demonstrated explanation of idle PDF scrolling.

## Verification

Both builds/typechecks, 344 main unit tests (five platform skips), and 117 PDF
unit tests pass. Sixteen integrated and eight standalone desktop journeys cover
canvas work counts and identity, fit-width settling, scroll retention, buffer
release, latest-page/zoom/rotation races, large scans, page links, page navigation,
pane swapping, and the standalone reader. Pixel probes retry a canvas selection
if its old surface was released during replacement.
