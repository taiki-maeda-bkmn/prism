import * as fs from 'node:fs/promises';
import type { Dir } from 'node:fs';
import path from 'node:path';
import type { VSCodeAppearanceImport } from '../shared/vscodeAppearance';
import { mapVSCodeColors, readVSCodeJSON, readVSCodeTheme } from './vscode-theme';

export interface VSCodeDiscoveryOptions {
  home: string;
  appData: string;
  platform: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  dark?: boolean;
  highContrast?: boolean;
  /** Explicit locations keep tests independent of the user's VS Code files. */
  settingsPath?: string;
  extensionRoots?: readonly string[];
  installationRoots?: readonly string[];
}

const guidance = 'Choose a theme JSON file instead. In VS Code, run “Developer: Generate Color Theme From Current Settings” and save the result.';
const MAX_DIRECTORIES = 512;
const MAX_MANIFEST_BYTES = 16 * 1024 * 1024;
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown): string | undefined => typeof value === 'string' && value.trim() && value.length <= 256 ? value.trim() : undefined;
const missing = (error: unknown) => ['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException)?.code ?? '');
function within(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

async function directories(root: string, maximum = MAX_DIRECTORIES): Promise<string[]> {
  let directory: Dir;
  try { directory = await fs.opendir(root); }
  catch (error) { if (missing(error)) return []; throw error; }
  const result: string[] = [];
  let entries = 0;
  for await (const entry of directory) {
    // Count files too: an arbitrarily large directory must not stall discovery.
    if (++entries > maximum * 4) throw new Error(`The VS Code installation contains too many entries to scan. ${guidance}`);
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    if (result.length >= maximum) throw new Error(`The VS Code installation contains too many folders to scan. ${guidance}`);
    result.push(path.join(root, entry.name));
  }
  return result.sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
}

function installationRoots(options: VSCodeDiscoveryOptions): readonly string[] {
  if (options.installationRoots) return options.installationRoots;
  const env = options.env ?? {};
  if (options.platform === 'win32') {
    return [
      path.join(env.LOCALAPPDATA || path.join(options.home, 'AppData', 'Local'), 'Programs', 'Microsoft VS Code'),
      path.join(env.ProgramFiles || 'C:\\Program Files', 'Microsoft VS Code'),
      path.join(env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Microsoft VS Code'),
    ];
  }
  return ['/usr/share/code', '/usr/lib/code', '/usr/lib64/code', '/opt/visual-studio-code', '/opt/vscode', '/snap/code/current/usr/share/code'];
}

async function extensionRoots(options: VSCodeDiscoveryOptions): Promise<string[]> {
  const roots = [...(options.extensionRoots ?? [path.join(options.home, '.vscode', 'extensions')])];
  const installs = installationRoots(options);
  if (roots.length > 8 || installs.length > 8) throw new Error('Too many VS Code installation locations were supplied.');
  for (const root of installs) {
    roots.push(path.join(root, 'resources', 'app', 'extensions'));
    if (options.platform !== 'win32') continue;
    // Current Windows installers keep the application below a commit-named
    // directory; older versions put resources directly below the install root.
    const versions = (await directories(root, 32)).filter(candidate => /^[a-f0-9]{8,64}$/i.test(path.basename(candidate)));
    const dated = await Promise.all(versions.map(async directory => ({ directory, modified: (await fs.stat(directory)).mtimeMs })));
    dated.sort((a, b) => b.modified - a.modified || b.directory.localeCompare(a.directory));
    for (const { directory } of dated) roots.push(path.join(directory, 'resources', 'app', 'extensions'));
  }
  return [...new Set(roots)];
}

function configuredTheme(settings: Record<string, unknown>, options: VSCodeDiscoveryOptions): string {
  let setting = 'workbench.colorTheme';
  if (options.highContrast && settings['window.autoDetectHighContrast'] !== false) {
    setting = options.dark === false ? 'workbench.preferredHighContrastLightColorTheme' : 'workbench.preferredHighContrastColorTheme';
  } else if (settings['window.autoDetectColorScheme'] === true) {
    setting = options.dark ? 'workbench.preferredDarkColorTheme' : 'workbench.preferredLightColorTheme';
  }
  const name = text(settings[setting]);
  if (!name) throw new Error(`The VS Code default profile does not specify ${setting}, so its active theme cannot be determined reliably. ${guidance}`);
  return name;
}

/** VS Code treats wildcards only at the beginning/end of a theme settings ID. */
function patternMatches(pattern: string, name: string): boolean {
  return pattern === name
    || (pattern.startsWith('*') && pattern.endsWith('*') && name.includes(pattern.slice(1, -1)))
    || (pattern.endsWith('*') && name.startsWith(pattern.slice(0, -1)))
    || (pattern.startsWith('*') && name.endsWith(pattern.slice(1)));
}

function mergeCustomColors(base: Record<string, unknown>, settings: Record<string, unknown>, settingsId: string): Record<string, unknown> {
  const custom = settings['workbench.colorCustomizations'];
  if (!record(custom)) return base;
  const result = { ...base };
  const apply = (values: Record<string, unknown>) => {
    for (const [key, value] of Object.entries(values)) {
      // VS Code ignores null/non-string overrides; they do not reset a global
      // customization. Preserve "default" so mapping can explain that it
      // requires VS Code's runtime registry, rather than guess a theme value.
      if (!key.startsWith('[') && typeof value === 'string') result[key] = value;
    }
  };
  apply(custom);
  for (const [selector, values] of Object.entries(custom)) {
    if (selector.length > 1024 || !selector.startsWith('[') || !record(values)) continue;
    const matches = [...selector.matchAll(/\[([^\]]+)\]/g)];
    if (matches.map(match => match[0]).join('') !== selector) continue;
    if (matches.some(match => patternMatches(match[1], settingsId))) apply(values);
  }
  return result;
}

/** Read only the stable VS Code default profile and installed theme JSON files. */
export async function discoverVSCodeAppearance(options: VSCodeDiscoveryOptions): Promise<VSCodeAppearanceImport> {
  if (options.platform !== 'win32' && options.platform !== 'linux') throw new Error(`Automatic VS Code import supports Windows and Linux. ${guidance}`);
  const settingsPath = options.settingsPath ?? path.join(options.appData, 'Code', 'User', 'settings.json');
  let settings: Record<string, unknown>;
  try { settings = await readVSCodeJSON(settingsPath); }
  catch (error) {
    if (missing(error)) throw new Error(`The VS Code default-profile settings file was not found. ${guidance}`);
    throw error;
  }
  const selected = configuredTheme(settings, options);
  let manifestBytes = 0;
  let manifests = 0;
  const candidates = new Map<string, { file: string; root: string; name: string; settingsId: string }>();
  const manifest = async (file: string, root: string) => {
    const canonical = await fs.realpath(file);
    if (!within(root, canonical)) throw new Error('The VS Code manifest leaves its extension folder.');
    const info = await fs.stat(canonical);
    manifestBytes += info.size;
    if (manifestBytes > MAX_MANIFEST_BYTES) throw new Error(`The VS Code theme scan exceeds its size limit. ${guidance}`);
    return readVSCodeJSON(canonical);
  };
  for (const root of await extensionRoots(options)) {
    for (const extension of await directories(root)) {
      if (++manifests > MAX_DIRECTORIES) throw new Error(`The VS Code theme scan exceeds ${MAX_DIRECTORIES} extensions. ${guidance}`);
      let packageRoot: string;
      let pkg: Record<string, unknown>;
      try {
        packageRoot = await fs.realpath(extension);
        pkg = await manifest(path.join(packageRoot, 'package.json'), packageRoot);
      } catch (error) {
        if (manifestBytes > MAX_MANIFEST_BYTES) throw error;
        continue;
      }
      const contributions = record(pkg.contributes) ? pkg.contributes.themes : undefined;
      if (!Array.isArray(contributions)) continue;
      if (contributions.length > 128) throw new Error(`The VS Code extension contributes too many themes. ${guidance}`);
      let translations: Record<string, unknown> | undefined;
      for (const contribution of contributions) {
        if (!record(contribution)) continue;
        const id = text(contribution.id);
        let label = text(contribution.label);
        if (label?.startsWith('%') && label.endsWith('%')) {
          if (!translations) {
            try { translations = await manifest(path.join(packageRoot, 'package.nls.json'), packageRoot); }
            catch (error) { if (manifestBytes > MAX_MANIFEST_BYTES) throw error; translations = {}; }
          }
          label = text(translations[label.slice(1, -1)]);
        }
        const settingsId = id ?? label;
        if (selected !== settingsId) continue;
        const relative = contribution.path;
        if (typeof relative !== 'string' || !relative || relative.length > 1024 || /[\\:\u0000-\u001f]/.test(relative) || path.posix.isAbsolute(relative)) {
          throw new Error(`The configured VS Code theme has an unsupported file path. ${guidance}`);
        }
        if (!/\.jsonc?$/i.test(relative)) throw new Error(`The configured VS Code theme does not use a JSON color-theme file. ${guidance}`);
        const target = path.resolve(packageRoot, relative);
        if (!within(packageRoot, target)) throw new Error(`The configured VS Code theme leaves its extension folder. ${guidance}`);
        const canonical = await fs.realpath(target);
        if (!within(packageRoot, canonical)) throw new Error('VS Code theme includes must stay inside the selected theme folder.');
        // A directory's version or modification time does not establish which
        // extension VS Code has active. Detect all matches before choosing,
        // while treating aliases of the same file as a single candidate.
        candidates.set(canonical, { file: canonical, root: packageRoot, name: label ?? settingsId, settingsId });
      }
    }
  }
  if (!candidates.size) throw new Error(`The configured VS Code theme “${selected}” was not found in the installed extensions. ${guidance}`);
  if (candidates.size > 1) throw new Error(`The configured VS Code theme “${selected}” matches multiple installed theme files. Prism cannot determine which copy VS Code uses. ${guidance}`);
  const candidate = candidates.values().next().value!;
  const theme = await readVSCodeTheme(candidate.file, { root: candidate.root });
  const mapped = mapVSCodeColors(mergeCustomColors(theme.colors, settings, candidate.settingsId));
  if (!Object.keys(mapped.colors).length) throw new Error(`The configured VS Code theme has no supported Prism colors. ${guidance}`);
  return { name: candidate.name, source: settingsPath, ...mapped };
}
