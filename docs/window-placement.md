# Remembering Prism's window

Prism remembers its normal size and maximized state across launches. On native Windows, macOS, and X11, it also restores its previous position and fits saved bounds to a connected screen. On native Wayland, including WSLg, the compositor chooses the position. Closing while minimized reopens a visible window.

## Implementation

1. Save the normal window bounds and maximized state in the Notes profile's `window-placement.json`. Validate saved values, fit the restored rectangle to a connected display's work area, debounce changes, and flush an accepted close. A cancelled unsaved-note prompt keeps the same window and session.
2. Keep native maximize, minimize, transparency, and the WSLg repaint recovery. The standalone PDF launcher keeps its separate window behavior.
3. Leave WSLg position control to Wayland. The Windows host-position helper has been removed because it could separate the displayed window from its input coordinates. Existing `window-placement-wslg.json` files are ignored and left untouched. The ordinary placement record still supplies normal size and maximized state.
4. Treat missing, damaged, or unwritable preference files as recoverable. Notebook and PDF data remain independent of these preferences.

## WSLg input regression

The removed helper used Windows `SetWindowPos` to restore the host window. That moved the visible window without updating WSLg's compositor coordinates. Microsoft documents this source of misaligned mouse input in [WSLg issue #324](https://github.com/microsoft/wslg/issues/324).

A real Windows mouse check reproduced the failure: a fresh window received the expected pointer event, while reopening with a different saved host position produced no renderer pointer event at the displayed control. The host window was visible, enabled, and foreground in both cases. Removing host-only movement addresses that mismatch; restoring a host rectangle alone is insufficient evidence that input works.

The earlier position test checked Windows rectangles and used Playwright to click inside Chromium. It did not exercise the Windows-to-WSLg mouse route and therefore missed this regression. Its coordinate results are historical geometry evidence, not proof that the previous restoration was usable.

## Checks

- Unit checks for validated geometry, display changes, minimized/maximized transitions, debouncing, and final writes.
- Native Electron restart journeys for moved/resized windows, maximized and minimized restarts, cancelled draft closure, and damaged/offscreen preferences under Xvfb/Openbox.
- An opt-in WSLg input journey sends real Windows mouse input to a uniquely titled test window before and after reopening with legacy host-position preferences. It checks delivery to the displayed control rather than relying on a Playwright click. All profiles and notebooks are disposable.

Verified locally: typecheck/build and 343 unit tests pass (five platform skips),
along with 16 desktop regressions for window persistence, native controls,
dirty-close decisions, PDF workspaces, and URL imports. The real Windows-pointer
journey passes fresh launch, reopening with legacy host-position preferences,
actual Notes/PDFs button clicks, and minimize/host restore. The same pointer test
failed on the previous build after position restoration, despite its visible,
enabled window. Legacy host-position JSON remains unchanged. No user notebook
or PDF library is used by these tests, and GitHub CI was not checked.

The existing repeated-maximize host pixel tests previously exposed a separate painting/clipping issue, also reproduced on unchanged baseline `b2b43cf`. Removing the placement helper does not establish that this separate issue is fixed. Physical native Windows/macOS checks remain separate from the Linux and WSLg results.

## Follow-up: exact position on WSLg

Exact position restoration remains deferred. [Electron documents Wayland's limits on programmatic positioning](https://www.electronjs.org/docs/latest/api/browser-window#platform-notices). WSLg's current [shell protocol](https://github.com/microsoft/weston-mirror/blob/working/protocol/weston-rdprail-shell.xml) has no positioning request, and its [experimental local-move support](https://github.com/microsoft/weston-mirror/blob/working/rdprail-shell/shell.c#L779-L785) is disabled by default and marked incomplete.

1. Identify supported compositor-aware placement or session restoration available to Electron and the installed WSLg backend. Do not use host-only movement or production cursor/keyboard automation.
2. Define coordinate/display handling and a fallback that keeps input usable when restoration is unsupported. Preserve existing preferences until a compatible migration is available.
3. Require real Windows-pointer delivery checks after reopening, maximize/restore, minimize/restore, and monitor changes, alongside geometry, transparency, and draft-retention checks. Re-enable exact restoration only when both placement and input pass.
