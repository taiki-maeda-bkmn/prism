# Import VS Code colors

Open **Appearance → Import from VS Code** in Prism. Choose either:

- **Load from VS Code** to read the configured color theme in the standard VS
  Code default profile on this operating system, including matching user color
  customizations and locally installed theme files.
- **Choose theme file…** to open a VS Code color-theme `.json` or `.jsonc` file.
  For an exact export of a running VS Code profile, open its Command Palette,
  run **Developer: Generate Color Theme From Current Settings**, and save the
  generated document as a JSON file. See [VS Code's theme guide](https://code.visualstudio.com/docs/configure/themes).

Review the sample and color values, then choose **Apply imported colors**. Until
then, the import does not change your appearance. Cancel the preview or file
picker to keep your existing colors. **Reset colors** restores the current
Prism theme's defaults.

The import changes the current Prism theme's palette and is remembered when
switching themes or restarting. It also colors the integrated PDF workspace.
Prism's fonts, text size, syntax highlighting, layout, window transparency, and
PDF page opacity remain separate settings. Standalone Prism PDF does not use
the Markdown app's palette.

## Color mapping

| Prism color | VS Code color, in priority order |
| --- | --- |
| Page background | `editor.background` |
| Text | `editor.foreground`, `foreground` |
| Accent | `textLink.foreground`, `button.background`, `focusBorder`, `activityBarBadge.background` |

Missing colors keep their current Prism values and appear as **unchanged** in
the preview. Unsupported values are reported. Hex colors with three, four, six,
or eight digits are accepted; an alpha channel is removed with a notice because
Prism controls transparency separately. Icons and TextMate/semantic token themes
are not imported. Color identifiers follow [VS Code's theme color reference](https://code.visualstudio.com/api/references/theme-color).
When a supported color is explicitly set to `default`, export the active theme
from VS Code first: that value depends on VS Code's own color registry. Null and
non-string overrides retain inherited colors, following [VS Code's theme loader](https://github.com/microsoft/vscode/blob/main/src/vs/workbench/services/themes/common/colorThemeData.ts).

## Local discovery and file handling

Automatic discovery reads the standard Windows or Linux **default profile**,
not workspace settings, named profiles, Insiders, remote hosts, or the running
window's cached theme. If the configured theme is missing, matches multiple
installed versions, or cannot be resolved, Prism reports that instead of
guessing. Export the active theme in VS Code and
use **Choose theme file…** for those cases, portable installations, or themes
installed in custom locations.

Themes are read as data. Imports do not install or execute extensions, use the
network, write VS Code settings, or save any notes. Only the mapped palette,
theme name, source description, and notices are returned to the renderer.
Parsing uses Microsoft's [JSONC parser](https://github.com/microsoft/node-jsonc-parser)
and accepts comments, trailing commas, and UTF-8 BOMs while rejecting malformed
or oversized documents. Files are limited to 2 MiB each. Inheritance is limited
to eight theme files and must stay inside the selected file's directory, or the
discovered extension's directory. Cycles and escaping includes are rejected.

Further appearance work can add separately configurable editor fonts, richer
interface colors, and syntax-token mapping. Those require preference migration
and editor/PDF readability checks beyond this palette import.
