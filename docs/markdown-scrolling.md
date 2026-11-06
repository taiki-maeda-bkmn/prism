# Markdown scrolling investigation

The typing optimization did not resolve the reported scrolling lag. The earlier
profile covered only 2,160 pixels near the top of a note in a 1440×1000 window.
On 2026-11-06, full-note scrolling at the user's maximized display size reproduced
a much larger problem. This document records a diagnosis, not a completed fix.

## Reproduction and evidence

Electron 44.7.2 / Chromium 152.0.7977.149, native WSLg Wayland, DPR 1. The
maximized renderer was 3840×2088 on a 3840×2160 display. All comparisons used
the same synthetic Japanese/math/table note and disposable app profiles.

| Test | Renderer frame-gap p95 |
| --- | ---: |
| Maximized, transparent, Source, wheel down/up | 133–267 ms |
| Maximized, transparent, Live, wheel down/up | 133–183 ms |
| Maximized, transparent, Read, wheel down/up | 133–268 ms |
| Maximized, opaque, Live, wheel down/up | 400–431 ms |
| 1320×860, transparent, Live, wheel down/up | 20–21 ms |

These are separate runs on a changing desktop, not controlled estimates of the
cost of transparency. Opaque mode did not solve the large-window problem. The
app's native surface remains transparent in both appearance modes. A separate
maximized test driving scrolling through animation frames instead of injected
wheel events also reproduced long gaps (approximately 398–431 ms p95). Its
document stayed visible and focused throughout all phases.

In the first maximized Read traversal, renderer metrics recorded **no layouts**
and about **6.5 ms of script execution over a 4.57-second phase**, with no new
formula or table rendering. The smaller Live window created at least as many
widgets as the maximized one while scrolling much more smoothly. These results
point beyond Markdown parsing as the primary cause of this reproduced stall.
Animation-frame measurements do not directly measure Windows presentation.

## Current WSLg failure

The current compositor log contains:

```text
[11:38:18.437] rdp_allocate_shared_memory: Failed to open "/mnt/shared_memory/{...}" with error: Input/output error
[11:38:18.437] RDP backend: use_gfxredir = 0
```

A read-only check in the WSL system distribution also reports an I/O error when
accessing `/mnt/shared_memory`; the path remains mounted as `virtiofs`. The
[exact installed Weston implementation](https://raw.githubusercontent.com/microsoft/weston/2318fecaeac1f1a2d5a7a042c34d931c71dae04c/libweston/backend-rdp/rdprail.c)
disables graphics redirection when its startup shared-memory probe fails and
uses the ordinary RDP surface copy path. Electron also reports software GPU
compositing and rasterization. GPU status alone does not prove repeated crashes
or identify their cause.

This is a strong environmental lead, but a successful restart and repeat
measurement are required before attributing all lag to that failure. No graphics
flags, user preferences, system packages, or notebook files have been changed.

## Next steps

- [x] Reproduce whole-note scrolling, compare Source/Live/Read, and compare
  maximized, smaller, opaque, and translucent windows.
- [x] Verify the current graphics shared-memory failure without modifying it.
- [ ] With explicit approval, restart WSL, which closes all Ubuntu applications
  and terminals. Reopen Prism, then check that shared memory is accessible and
  the new compositor log enables graphics redirection.
- [ ] Repeat the same maximized profile and have the user check physical mouse
  or touchpad scrolling. Do not call recovery successful from socket readiness
  or app startup alone. If graphics redirection remains disabled, investigate
  host WSL/graphics components separately.
- [ ] If material editor lag remains after graphics recovery, measure caching
  of virtualized table/formula rendering and better block-height estimates.
  Full traversal confirmed repeated widget compilation and cold height changes;
  neither explains the equally slow Read view in this session.

Restoring Prism to a smaller window is a measured temporary workaround.

## Repeat the measurements

```sh
npm run build
node scripts/profile-markdown-scroll.mjs --maximize --transparent --output=/tmp/prism-scroll
node scripts/profile-markdown-scroll.mjs --mode=Live --cycles=1 --width=1320 --height=860 --transparent --output=/tmp/prism-scroll-small
```

Options include `--input=raf`, `--mode=Source,Live,Read`, `--cycles=1..5`, and
`--step=600`. Omitting `--transparent` tests opaque appearance. `--note=/path`
explicitly reads a selected note into a disposable copy; it never opens the
original notebook. The report includes dimensions but no copied note text.

The script verifies unchanged fixture bytes and clean editor state. It records
frame gaps, scroll-height corrections, widget HTML assignments, renderer timing,
GPU/display state, and a CPU profile, then closes only its own Electron session
and deletes its temporary notebook/profiles. CDP duration counters use seconds;
frame and phase timings use milliseconds. Probes and automation add overhead.
Chromium wheel injection does not test physical Windows input delivery.
