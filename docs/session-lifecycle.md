# Desktop session startup and shutdown

Closing the last Prism or Prism PDF window ends its session on every platform. Unsaved Markdown still requires Save, Discard, or Cancel; Cancel keeps the session and downloads running. A stalled research download must not leave an invisible app holding its single-instance or PDF library ownership.

## Findings and implementation

1. Research imports joined the main operation queue, but shutdown canceled only direct URL imports. A stalled arXiv download could therefore keep a windowless main process alive until its network timeout. Research and arXiv clients now permanently cancel their requests, response reads, and rate-limit waits when shutdown is accepted. Queued requests reject without starting a new download.
2. The renderer blocked close intents during imports. Close now remains available; the unsaved-note dialog appears above the existing research browser. Cancel explicitly clears the main process's pending close state, preserving the import and draft. Save remains unavailable until the current operation settles.
3. A dirty renderer that crashed could never answer its own close prompt. The main process now uses a native **Keep open / Close Prism** prompt when Electron reports an unresponsive or crashed renderer. Closing there explicitly discards unsaved changes; it does not claim to save a crashed editor's memory.
4. Accepted note and PDF writes finish before library ownership is released. Electron then performs its normal quit and storage flush, with a two-second exit fallback after that safe point. Closing the last window also quits on macOS. No timeout interrupts the file-operation queue, and lock files are never deleted to bypass another owner.
5. A second launch shows and focuses the existing window, including a hidden window. Startup and activation share one pending window-creation operation. Both apps explicitly show the loaded window, avoiding the standalone PDF shell's dependency on `ready-to-show`, which can stall for an unmapped transparent Wayland surface. An accepted shutdown cannot show the window again after loading finishes.
6. The desktop launcher waits for a per-launch readiness marker. If its new child never reports a loaded, shown window within 30 seconds, it terminates that failed startup and escalates after two seconds if necessary. Readiness cancels the deadline and escalation; an opened editing session has no startup timeout. The launcher tracks actual process exit, releases inherited stdout handles, and scopes termination to its own child/process group. On POSIX, it also immediately stops surviving members of that dedicated group after the browser exits; it never searches for other Prism processes by name or retains a delayed kill against an exited PID.

These paths address live background processes, which are often described as “zombies.” A true OS zombie is an already-exited process awaiting its parent's reaping; sending it another signal does not remove it. The launcher reaps its direct child. This change cannot guarantee a bounded exit while the OS or a filesystem write is wedged.

## Verification plan

- Typecheck and build both apps, and run their unit suites. Network regressions cover stalled transports/body reads, queued requests, cancellation during pacing, and rejection after close. Launcher regressions cover readiness, startup timeout, exit versus retained pipes, and repeated signal forwarding.
- Run native desktop journeys with disposable notebooks, empty PDF catalogues, and mocked research transport: hidden-window relaunch, process exit and immediate profile reuse, standalone visibility, dirty Cancel, crashed-renderer confirmation, and closing during a stalled download. Verify exact saved bytes and library ownership after exit.
- Recheck existing research, URL-import Save/Discard/Cancel, native placement, and standalone ownership workflows. Exercise the actual desktop wrapper and confirm it exits with its child.
- Do not test against user libraries or terminate an existing editing session. Do not check GitHub CI; request Copilot review and check Codex review on the final commit before completing the task.

## Verification results

- Both builds and typechecks pass. The main unit suite has 358 passes and five platform skips; the PDF suite has 107 passes. Fourteen new unit cases cover network cancellation and launcher supervision.
- Five new desktop journeys pass, including the actual desktop wrapper's readiness marker, title-bar close, wrapper exit, library-lock release, and immediate profile reuse. The other journeys cover hidden-window relaunch, standalone repeated close/reopen, dirty Cancel and crashed-renderer confirmation, and a stalled research import canceled by explicit Discard.
- Sixteen existing main journeys pass across arXiv, Rates & Execution, URL imports (including Save/Cancel during a download), and window placement. Three standalone journeys pass for folders/restart, ownership/retry/normal quit, and URL import. All 24 journeys use temporary data.
- A real, detached Node child that deliberately ignores SIGTERM is terminated and reaped by the supervisor's escalation path, using shortened test deadlines. The regular shortcut test uses the production deadline.
- Native tests ran on isolated Xvfb/Openbox because this execution session had no connected WSLg display socket. Windows/macOS and the physical Wayland compositor were not reverified. GitHub CI was not checked.
