# Markdown scrolling investigation

The typing optimization did not resolve the reported scrolling lag. The earlier
profile covered only 2,160 pixels near the top of a note in a 1440×1000 window.
On 2026-11-06, full-note scrolling at the user's maximized display size reproduced
a much larger problem. An approved WSL restart restored graphics redirection
and substantially improved the same maximized test. Physical scrolling
confirmation and long-term recurrence remain unverified.

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

## WSLg failure before recovery

The compositor log before restarting contained:

```text
[11:38:18.437] rdp_allocate_shared_memory: Failed to open "/mnt/shared_memory/{...}" with error: Input/output error
[11:38:18.437] RDP backend: use_gfxredir = 0
```

A directory metadata check in the WSL system distribution also returned an I/O
error for `/mnt/shared_memory`, which was mounted as `virtiofs`. That check alone
is not a reliable transport health test: it still returns an error after the
successful recovery described below. The concrete pre-restart failure was the
compositor's attempt to allocate a shared-memory file. The
[exact installed Weston implementation](https://raw.githubusercontent.com/microsoft/weston/2318fecaeac1f1a2d5a7a042c34d931c71dae04c/libweston/backend-rdp/rdprail.c)
disables graphics redirection when its startup shared-memory probe fails and
uses the ordinary RDP surface copy path. Electron also reports software GPU
compositing and rasterization. GPU status alone does not prove repeated crashes
or identify their cause.

## Approved recovery and repeat measurements

The user approved restarting WSL. On 2026-11-06 at 13:39 JST, the host-side
recovery helper stopped WSL, started Ubuntu-24.04, waited for its Wayland socket,
and reopened Prism through the existing desktop shortcut. The new compositor
log reports `use_gfxredir = 1` and successful client capability negotiation
(`0x2000`), without shared-memory allocation errors. The installed implementation
enables redirection after an allocation, mapping, and write/read probe succeeds.

The same synthetic fixture, maximized 3840×2088 viewport, DPR, translucent
appearance, wheel input, and two down/up cycles were repeated:

| Mode | Before: p95 frame-gap range | After: p95 frame-gap range |
| --- | ---: | ---: |
| Source | 133–267 ms | 22–26 ms |
| Live | 133–183 ms | 23–28 ms |
| Read | 133–268 ms | 22–26 ms |

The recovered run reported no errors and preserved exact fixture contents. Its
maximum individual frame gap was 33.3 ms. Electron still reported the same
software GPU feature status, so the recovered WSLg presentation path—not a newly
enabled Electron GPU feature—is the observed graphics change. No application
code, graphics flags, preferences, packages, or notebook files changed during
recovery. The reopened user app was left running; the profiler closed only its
own disposable app.

This verifies recovery of the reproduced stall in automated scrolling. It does
not establish what originally triggered the allocation failure, prevent a future
recurrence, or substitute for the user's physical mouse/touchpad confirmation.
The helper's transport-check log entry was blank because its directory `stat`
check gated the subsequent log read. Recovery was verified independently using
the new compositor log and scrolling measurements, not that helper entry.

## Next steps

- [x] Reproduce whole-note scrolling, compare Source/Live/Read, and compare
  maximized, smaller, opaque, and translucent windows.
- [x] Verify the compositor's shared-memory allocation failure and disabled
  redirection without modifying the graphics configuration.
- [x] With explicit approval, restart WSL and reopen Prism. Verify redirection
  and client negotiation in the new compositor log.
- [x] Repeat the same maximized profile; verify improved frame timing, clean
  renderer state, and unchanged fixture contents.
- [ ] Have the user confirm physical mouse or touchpad scrolling. If the stall
  recurs, capture new allocation errors/redirection state and investigate host
  WSL/graphics components. Directory `stat` errors alone do not establish a
  recurrence.
- [ ] If material editor lag remains after graphics recovery, measure caching
  of virtualized table/formula rendering and better block-height estimates.
  Full traversal confirmed repeated widget compilation and cold height changes;
  neither explains the equally slow Read view in this session.

Restoring Prism to a smaller window was a measured temporary workaround while
redirection was disabled.

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

The selected `Profile.md` must be loaded and active before and after each
traversal. A note skipped by the app (for example, exceeding its 2 MB limit)
fails the run instead of silently profiling the small related note. Both an
ordinary fixture run and an oversized-copy rejection were checked after adding
this guard; the rejected run recorded no profiling phases.
