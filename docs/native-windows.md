# Native Windows desktop installation

Prism can run directly on Windows while its source repository stays in WSL. The native application has its own Windows Electron runtime and launch supervision, so opening the desktop shortcut does not depend on WSLg or a global Node installation. This avoids WSLg sessions in which the renderer remains alive after Windows has lost its host window.

## Stage a release

Build the current source first, then stage into a dedicated Windows folder. Use the actual Windows user path; the staging command requires an explicit destination and will reject a nonempty folder that is not marked as a Prism installation.

```sh
npm run build
npm run stage:windows -- --destination /mnt/c/Users/YOUR_USER/AppData/Local/PrismNative
```

The command downloads the exact Electron version pinned in `package.json` from the official Electron GitHub release and checks its SHA256 against that release's `SHASUMS256.txt`. An existing official archive can be supplied with `--archive`; its checksum is still verified against the official manifest. The default architecture is `x64`; use `--architecture arm64` for Windows on ARM.

The command copies the built app and supervised launcher into a new `releases/<release-id>` folder and prints its Windows paths. It does not open Prism, install shortcuts, or move notebooks/PDFs. Incomplete releases never become selectable. Existing releases remain available for rollback.

## Verify before activation

Run the staged `scripts/native-windows-launch.ps1` using Windows PowerShell with an isolated notebook and profile. The launcher preserves `PRISM_USER_DATA`, `PRISM_PDF_USER_DATA`, and `PRISM_WORKSPACE` environment overrides for this purpose. Check startup, normal close and reopen, Japanese input, Markdown save/readback, PDF reading, and transparent-window controls on the native desktop.

Each launch writes separate stdout/stderr logs under the installation's `logs` folder. The launcher uses Electron's bundled Node runtime to supervise its GUI child, ends when that child exits, and shows a Windows error dialog if startup or the session fails. No command window is needed once the shortcut is installed.

## Preserve the existing data

Native Windows defaults to `%APPDATA%\Prism` for the notebook profile and `%APPDATA%\prism-pdf` for the PDF catalogue. These differ from the existing Ubuntu profiles. A successful native launch alone does not migrate any data.

Before switching, close the existing editing session normally and preserve the authoritative notebook, recovery files, and entire PDF library. Copy into new Windows folders, verify the files, and point the native profile at that notebook. Preserve PDF catalogue IDs and the library's folder layout so tags and linked notes still resolve. Keep the Ubuntu originals as a rollback copy. Do not overwrite an older Windows notebook merely because its name matches, and do not share a live library between the two processes.

Opening Ubuntu notebooks through `\\wsl.localhost\...` is not the native migration path: readable files do not guarantee that Windows metadata-preserving save operations or SQLite library ownership work over that filesystem. Normal Windows folders should be used for the active native notebook/library after verified copying.

## Activate or roll back

After the native release and data have been verified, run its installation's `activate.ps1` from Windows PowerShell, passing the release ID printed by staging:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$env:LOCALAPPDATA\PrismNative\activate.ps1" -ReleaseId RELEASE_ID
```

Activation updates the desktop and Start Menu **Prism** shortcuts to the selected native release. It only replaces shortcuts marked as managed Prism launchers, backs them up under `shortcut-backups`, creates both replacement shortcuts before promoting either, and restores the previous shortcuts if promotion fails. The `active.json` selection is replaced atomically. Activation does not launch the app or change its data.

Future source updates use the same build, stage, verify, and activate sequence. Selecting an earlier staged release rolls back the app version. Restoring old WSLg shortcuts also requires the corresponding Ubuntu storage; if that storage has been retired, restore it into separate folders from its backup before using a legacy launcher. Do not run both app versions against the same active notebook or PDF library.

## Retiring the old WSL storage

Once the native app and migrated data have been verified, old WSL storage can be retired at the user's request. Recheck for newer WSL work and running legacy processes first. Back up the complete old profiles and notebook, including historical PDF backups, starter notes, settings, and recovery files that are outside the active library migration. Verify every archived file before deleting the original directories. Back up and remove obsolete managed launchers so they cannot accidentally create fresh, empty WSL profiles.

The local WSL copies were retired on 6 November 2026 after explicit user approval. The two old application profiles (`~/.config/Prism` and `~/.config/prism-pdf`) and the migrated notebook (`~/practice/problem_solving`) contained 293 files, totaling about 210 MiB. All matched a verified Windows backup before removal. The Windows desktop and Start Menu **Prism PDF** shortcuts and both Linux Prism application entries were also backed up and removed; the native **Prism** shortcuts and source repository were retained.

The archive, per-file hashes, original paths, and retirement record are under `%LOCALAPPDATA%\PrismNative\backups\wsl-storage-20261106-193024`. The active Windows notebook and all 69 PDFs remain in their native storage. Restore archived files into a separate folder when recovering old material, so newer native work is preserved. Source changes still need the native build, stage, verify, and activate workflow above; this storage cleanup does not require an application release.

## Validation

Run `node --test tests/native-windows-install.test.mjs` for destination and checksum rejection coverage. Run the native regression harness with **Windows Node** and an absolute staged release path:

```powershell
node scripts/test-native-windows.mjs --release C:\Users\YOUR_USER\AppData\Local\PrismNative\releases\RELEASE_ID
```

The harness also works with a script path in the source repository's WSL UNC location. It creates disposable Windows notebooks and profiles, checks a native HWND and actual Windows mouse delivery, saves Japanese text while preserving BOM/CRLF, cancels dirty close, restores drafts through repeated minimize/relaunch cycles, saves on close, and reopens. It also runs the hidden PowerShell launcher without debugger flags and verifies that the launcher and all recorded session processes exit. Evidence is retained; successful fixtures are removed. The Japanese check uses editor input events, not physical Microsoft IME composition.

### Verified rollout, 6 November 2026

The original WSLg session had a responsive renderer with no dirty notes but no Windows host window. Repeated launch and both immediate and delayed hide/show failed to restore that session. A normal close and fresh process restored access. Native Windows deployment removes the WSLg display connection from subsequent desktop launches; the Linux window recovery code is unchanged.

On Windows x64 with Electron 44.7.2, the regression harness passed, including real mouse delivery, retained drafts, native save/readback, and process cleanup. The build/typecheck and 360 existing unit tests passed (five platform skips), as did the three installer checks. The actual managed desktop and Start Menu shortcuts were backed up, replaced, and opened successfully. Migration verified 34 notebook/recovery files and 78 PDF library files by SHA256, preserved all 69 document IDs and metadata, and verified a rendered PDF plus a native save in the new notebook. Original notebook hashes remained unchanged. Ubuntu originals were retained until the subsequent verified retirement described above; Windows archive and shortcut backups remain available.

The observed WSLg failure is bypassed by the native launcher. This is not a guarantee against every Windows, driver, or Electron failure; startup failures produce a Windows error dialog and a per-launch log. GitHub CI was not checked.
