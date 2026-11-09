import { constants } from 'node:fs';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { getNodeValue, parseTree, type ParseError } from 'jsonc-parser';
import type { VSCodeAppearanceImport } from '../shared/vscodeAppearance';

const MAX_JSON_BYTES = 2 * 1024 * 1024;
const MAX_THEME_FILES = 8;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function parseVSCodeJSON(text: string): Record<string, unknown> {
  if (Buffer.byteLength(text, 'utf8') > MAX_JSON_BYTES) throw new Error('VS Code appearance files must be 2 MB or smaller.');
  const errors: ParseError[] = [];
  let value: unknown;
  try {
    const tree = parseTree(text.replace(/^\ufeff/, ''), errors, { allowTrailingComma: true, disallowComments: false });
    // getNodeValue uses null-prototype records, so a JSON __proto__ key cannot
    // manufacture inherited theme/settings fields.
    value = tree && getNodeValue(tree);
  }
  catch { throw new Error('The VS Code appearance file contains invalid or overly complex JSON.'); }
  // The parser deliberately returns partial values on malformed input. Never
  // preview or apply those partial settings as a successful import.
  if (errors.length || !isRecord(value)) throw new Error('The VS Code appearance file must contain a valid JSON object. Comments and trailing commas are allowed.');
  return value;
}

export async function readVSCodeJSON(filePath: string): Promise<Record<string, unknown>> {
  // O_NONBLOCK prevents a substituted FIFO from hanging the main process on
  // platforms that support it. stat on the open handle rejects every non-file.
  const handle = await fs.open(filePath, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0));
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw new Error('Choose a regular VS Code JSON file.');
    if (info.size > MAX_JSON_BYTES) throw new Error('VS Code appearance files must be 2 MB or smaller.');
    const buffer = Buffer.alloc(Math.min(info.size + 1, MAX_JSON_BYTES + 1));
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
      if (!bytesRead) break;
      length += bytesRead;
    }
    // Detect growth after stat rather than accepting a truncated JSON prefix.
    if (length > info.size) throw new Error('The VS Code appearance file changed while it was being read. Try importing it again.');
    let text: string;
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, length)); }
    catch { throw new Error('The VS Code appearance file must use UTF-8 text.'); }
    return parseVSCodeJSON(text);
  } finally { await handle.close(); }
}

function within(root: string, file: string): boolean {
  const relative = path.relative(root, file);
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

interface VSCodeTheme {
  name: string;
  type?: string;
  colors: Record<string, unknown>;
}

export async function readVSCodeTheme(filePath: string, options: { root?: string } = {}): Promise<VSCodeTheme> {
  const root = await fs.realpath(options.root ?? path.dirname(path.resolve(filePath)));
  if (!(await fs.stat(root)).isDirectory()) throw new Error('The VS Code theme folder is unavailable.');
  const active = new Set<string>();
  const read = async (candidate: string, depth: number): Promise<VSCodeTheme> => {
    if (depth >= MAX_THEME_FILES) throw new Error(`VS Code theme inheritance is limited to ${MAX_THEME_FILES} files.`);
    const canonical = await fs.realpath(candidate);
    if (!within(root, canonical)) throw new Error('VS Code theme includes must stay inside the selected theme folder.');
    if (active.has(canonical)) throw new Error('The VS Code theme contains a circular include.');
    active.add(canonical);
    try {
      const theme = await readVSCodeJSON(canonical);
      let parent: VSCodeTheme | undefined;
      if (theme.include !== undefined) {
        if (typeof theme.include !== 'string' || !theme.include || theme.include.length > 1024
          || /[\\:\u0000-\u001f]/.test(theme.include) || path.posix.isAbsolute(theme.include)) {
          throw new Error('VS Code theme includes must use a relative local JSON path.');
        }
        const included = path.resolve(path.dirname(canonical), theme.include);
        if (!within(root, included)) throw new Error('VS Code theme includes must stay inside the selected theme folder.');
        parent = await read(included, depth + 1);
      }
      if (theme.colors !== undefined && !isRecord(theme.colors)) throw new Error('The VS Code theme colors must be a JSON object.');
      const colors = { ...parent?.colors };
      for (const [key, value] of Object.entries(theme.colors ?? {})) {
        // VS Code ignores non-string theme colors, including null. Keep a
        // default marker so the mapper can ask for a resolved exported theme.
        if (typeof value === 'string') colors[key] = value;
      }
      return {
        name: typeof theme.name === 'string' && theme.name.trim() ? theme.name.trim().slice(0, 256) : path.basename(canonical).replace(/\.jsonc?$/i, ''),
        type: typeof theme.type === 'string' ? theme.type.slice(0, 32) : parent?.type,
        colors,
      };
    } finally { active.delete(canonical); }
  };
  return read(path.resolve(filePath), 0);
}

function hexColor(value: unknown): { color: string; translucent: boolean } | undefined {
  if (typeof value !== 'string') return undefined;
  const hex = value.trim().toLowerCase();
  if (!/^#(?:[\da-f]{3}|[\da-f]{4}|[\da-f]{6}|[\da-f]{8})$/.test(hex)) return undefined;
  const expanded = hex.length <= 5 ? '#' + [...hex.slice(1)].map(character => character.repeat(2)).join('') : hex;
  return { color: expanded.slice(0, 7), translucent: expanded.length === 9 && expanded.slice(7) !== 'ff' };
}

export function mapVSCodeColors(input: Record<string, unknown>): Pick<VSCodeAppearanceImport, 'colors' | 'warnings'> {
  const colors: VSCodeAppearanceImport['colors'] = {};
  const warnings: string[] = [];
  const choices = {
    background: ['editor.background'],
    text: ['editor.foreground', 'foreground'],
    accent: ['textLink.foreground', 'button.background', 'focusBorder', 'activityBarBadge.background'],
  } as const;
  if (Object.values(choices).flat().some(key => Object.hasOwn(input, key) && input[key] === 'default')) {
    throw new Error('This VS Code theme uses registry-default colors that cannot be resolved from its files. In VS Code, run “Developer: Generate Color Theme From Current Settings”, save it as JSON, and choose that file.');
  }
  for (const target of ['background', 'text', 'accent'] as const) {
    for (const source of choices[target]) {
      if (!Object.hasOwn(input, source) || input[source] === null) continue;
      const parsed = hexColor(input[source]);
      if (!parsed) { warnings.push(`Ignored an unsupported ${source} color.`); continue; }
      colors[target] = parsed.color;
      if (parsed.translucent) warnings.push(`${source} uses transparency; its RGB color will be imported. Use Prism's opacity controls for transparency.`);
      break;
    }
  }
  return { colors, warnings };
}
