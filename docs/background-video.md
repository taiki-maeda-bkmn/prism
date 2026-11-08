# Video behind a transparent Prism window

On native Windows, Edge could pause a video when Prism covered its window even
though the video was still visible through Prism's background. The same native
window classification is used by Chromium-based browsers.

## Cause and fix

Prism previously made its surface transparent through Electron and CSS, but its
Windows window did not advertise translucency to other applications. Chromium's
[occlusion check](https://github.com/chromium/chromium/blob/main/ui/gfx/win/hwnd_util.cc)
therefore counted Prism as an opaque covering window. A raw-CDP test with native
Edge reproduced a transition to `document.visibilityState === 'hidden'`, paused
playback, and stopped video frames when transparent Prism covered the browser.

When **Transparent window** is enabled and **Background opacity** is below 100%,
Prism now uses Electron's native window opacity of `254 / 255` on Windows. This
sets the layered-window transparency indicator that the browser understands.
CSS still controls the chosen background opacity; the native adjustment changes
the whole surface by only one alpha level (about 0.4%). At 100%, or with
transparency off, native opacity returns to `1`.
New windows start with that native translucency indicator before they are shown,
so reopening with saved transparency does not briefly hide the background video
while the renderer loads its appearance settings.

Changing native alpha alone does not reliably refresh another application's
occlusion calculation. A short, hidden Windows helper sends
[`NotifyWinEvent(EVENT_OBJECT_STATECHANGE)`](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-notifywinevent)
for Prism's own window after the change. It validates the owning process, has a
bounded timeout, coalesces repeated notifications, and is stopped when the window
closes. It does not move the window, take away keyboard input, or make clicks pass
through. Both the integrated app and standalone PDF launcher use this behavior.
Linux behavior is unchanged.

## Verification

The native regression harness runs an isolated Edge profile and local generated
video behind Prism. It checks a fully covered opaque window as a positive
control, then tests transparency and the 100% boundary, native window controls,
and advancing video frames. It uses raw CDP for Edge: Playwright's browser focus
emulation otherwise hides this bug. Test windows and profiles are separate from
the user's browser and notebook.

```powershell
node scripts/test-background-video-windows.mjs --release C:\Users\YOUR_USER\AppData\Local\PrismNative\releases\RELEASE_ID --output C:\Temp\prism-background-video.json
```

Run with Windows Node on an unlocked desktop with Microsoft Edge installed.
Only fixture windows temporarily become topmost to make the coverage test
deterministic; normal Prism window ordering is unchanged.

On 2026-11-07, all 18 playback phases passed against native release
`20261106T145843695Z-0cf800d4`, including live settings changes, Japanese
BOM/CRLF saves, window controls, clean process exit, and reopening with saved
transparency without a hidden-video event. The native launcher regression also
passed with `PRISM_TEST_TRANSPARENT=1`, including actual Windows pointer delivery
and complete process cleanup. Standalone PDF opacity transitions and immediate
shutdown passed. Evidence is saved under `%LOCALAPPDATA%\PrismNative` as
`background-video-validation-final.json` and
`background-video-launcher-validation.json`.

This corrects false occlusion. It does not change a website's own playback rules,
browser settings, media keys, or protected-content handling. If a player has
already paused, resume it after reopening the updated Prism app.
