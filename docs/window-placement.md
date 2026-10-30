# Remembering Prism's window

Prism should reopen where it was last used, with the same normal size and maximized state. Closing while minimized should reopen a visible window. Removing a monitor or reducing its resolution must leave the title bar reachable.

## Implementation

1. Save the normal window bounds and maximized state in the Notes profile's `window-placement.json`. Validate saved values, fit the restored rectangle to a connected display's work area, debounce changes, and flush an accepted close. A cancelled unsaved-note prompt keeps the same window and session.
2. Keep native maximize, minimize, transparency, and the WSLg repaint recovery. The standalone PDF launcher keeps its separate window behavior.
3. On WSLg's native Wayland backend, use a Windows helper to remember the physical desktop position in `window-placement-wslg.json`. [Wayland does not expose global window coordinates to Electron](https://www.electronjs.org/docs/latest/api/browser-window#wingetbounds). The helper binds once to a unique startup title, retains an identity check for that window, restores its position without raising it, and observes its normal bounds. It also corrects WSLg's original-position reset after restoring a maximized/minimized window. Active dragging or a new position from a keyboard/window-manager move cancels that correction. It exits when Prism closes. The main-process placement record supplies the normal size and maximized state.
4. Treat missing, damaged, or unwritable preference files and an unavailable host helper as recoverable. Notebook and PDF data remain independent of these preferences.

## Checks

- Unit checks for validated geometry, display changes, minimized/maximized transitions, debouncing, final writes, and host-helper lifecycle.
- Native Electron restart journeys for moved/resized windows, maximized and minimized restarts, cancelled draft closure, and damaged/offscreen preferences under Xvfb/Openbox.
- An opt-in WSLg journey moves its own uniquely titled window through Windows, restarts Prism, and checks actual Windows coordinates through normal, maximized, and minimized sessions. It also verifies that a new nonmodal move immediately after restore is retained across restart. All profiles and notebooks are disposable.

Verified locally: main typecheck/build and 355 unit tests pass (five platform skips); all 98 regular desktop journeys pass (three opt-in host skips). The new Windows-host position/restart/move sequence passes. The existing host minimize/focus/pixel journey passed an earlier run but hit the known maximize-paint issue on the final run. Both old host pixel journeys also fail on unchanged baseline `b2b43cf`, including the same overlay-alignment assertion. That pre-existing WSLg painting/clipping limitation remains outside this change; see the [desktop guide](../README.md#development-and-checks).

The WSLg bridge requires Windows PowerShell and WSL interoperability. On other native Wayland compositors, placement remains compositor-controlled; normal size and maximized-state persistence still apply. Physical Windows/macOS checks remain separate from the Linux and WSLg results.
