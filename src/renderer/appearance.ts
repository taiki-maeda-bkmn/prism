import type { CSSProperties } from 'react';

export type Mode = 'source' | 'split' | 'preview';
export type ThemeId = 'prism' | 'paper' | 'scifi';
export interface Colors { accent: string; background: string; text: string; }
export interface Preferences {
  mode: Mode; transparent: boolean; opacity: number; textScale: number;
  theme: ThemeId; colors: Colors; themeColors: Partial<Record<ThemeId, Colors>>;
}

export const defaultColors: Colors = { accent: '#3e6242', background: '#faf9f5', text: '#344640' };
export const themes: Record<ThemeId, { name: string; description: string; colors: Colors }> = {
  prism: { name: 'Prism', description: 'Calm and familiar', colors: defaultColors },
  paper: { name: 'Paper', description: 'Warm ink and serif type', colors: { accent: '#8a5438', background: '#fbf5e8', text: '#40362a' } },
  scifi: { name: 'Sci-fi', description: 'Cool light and clean lines', colors: { accent: '#57d9cf', background: '#0f1825', text: '#d9e7f5' } },
};
export const themeIds: ThemeId[] = ['prism', 'paper', 'scifi'];
export const textSize = { min: 100, max: 150, step: 5, default: 120 } as const;
const defaults: Preferences = { mode: 'split', transparent: false, opacity: 82, textScale: textSize.default, theme: 'prism', colors: defaultColors, themeColors: {} };

export function normalizeColor(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const color = value.trim().toLowerCase();
  if (/^#[0-9a-f]{6}$/.test(color)) return color;
  if (/^#[0-9a-f]{3}$/.test(color)) return '#' + [...color.slice(1)].map(character => character.repeat(2)).join('');
  return undefined;
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function readColors(value: unknown, fallback: Colors): Colors {
  const colors = record(value);
  return {
    accent: normalizeColor(colors.accent) ?? fallback.accent,
    background: normalizeColor(colors.background) ?? fallback.background,
    text: normalizeColor(colors.text) ?? fallback.text,
  };
}

export function parsePreferences(serialized: string | null): Preferences {
  let value: Record<string, unknown>;
  try { value = record(JSON.parse(serialized || '{}')); } catch { value = {}; }
  const theme: ThemeId = value.theme === 'paper' || value.theme === 'scifi' ? value.theme : 'prism';
  const savedColors = record(value.themeColors);
  const themeColors: Preferences['themeColors'] = {};
  for (const id of themeIds) {
    if (Object.hasOwn(savedColors, id)) themeColors[id] = readColors(savedColors[id], themes[id].colors);
  }
  return {
    mode: value.mode === 'source' || value.mode === 'split' || value.mode === 'preview' ? value.mode : defaults.mode,
    transparent: value.transparent === true,
    opacity: typeof value.opacity === 'number' && Number.isFinite(value.opacity) ? Math.min(100, Math.max(25, value.opacity)) : defaults.opacity,
    textScale: typeof value.textScale === 'number' && Number.isFinite(value.textScale)
      ? Math.min(textSize.max, Math.max(textSize.min, Math.round(value.textScale / textSize.step) * textSize.step)) : textSize.default,
    theme, themeColors,
    colors: readColors(value.colors, themeColors[theme] ?? themes[theme].colors),
  };
}

export function selectTheme(preferences: Preferences, theme: ThemeId): Preferences {
  if (theme === preferences.theme) return preferences;
  return {
    ...preferences, theme,
    colors: { ...(preferences.themeColors[theme] ?? themes[theme].colors) },
    // The active palette remains in colors for compatibility with earlier
    // preferences; remember it here when leaving that theme.
    themeColors: { ...preferences.themeColors, [preferences.theme]: { ...preferences.colors } },
  };
}

type RGB = [number, number, number];
function rgb(hex: string): RGB {
  return [1, 3, 5].map(start => parseInt(hex.slice(start, start + 2), 16)) as RGB;
}
function mix(first: RGB, second: RGB, amount: number): RGB {
  return first.map((channel, index) => Math.round(channel * (1 - amount) + second[index] * amount)) as RGB;
}
function contrastText(color: RGB): string {
  const [r, g, b] = color.map(channel => {
    const value = channel / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  const luminance = r * 0.2126 + g * 0.7152 + b * 0.0722;
  return (luminance + 0.05) / 0.05 >= 1.05 / (luminance + 0.05) ? '#000000' : '#ffffff';
}

export function appearanceStyle(preferences: Preferences): CSSProperties {
  const { accent, background, text } = preferences.colors;
  const accentRGB = rgb(accent);
  const backgroundRGB = rgb(background);
  const sidebar = preferences.theme === 'paper' ? mix(backgroundRGB, accentRGB, 0.08)
    : preferences.theme === 'scifi' ? mix(backgroundRGB, [0, 0, 0], 0.25)
      : mix(accentRGB, [0, 0, 0], 0.55);
  const titlebar = preferences.theme === 'paper' ? mix(backgroundRGB, accentRGB, 0.12) : mix(sidebar, [0, 0, 0], 0.15);
  const sidebarAccent = contrastText(sidebar) === '#000000' ? mix(accentRGB, rgb(text), 0.35) : mix(accentRGB, [255, 255, 255], 0.6);
  return {
    colorScheme: contrastText(backgroundRGB) === '#ffffff' ? 'dark' : 'light',
    '--surface-alpha': preferences.transparent ? preferences.opacity / 100 : 1,
    '--text-scale': preferences.textScale / 100,
    '--accent': accent, '--accent-contrast': contrastText(accentRGB),
    '--text': text, '--background': background,
    '--background-rgb': backgroundRGB.join(', '),
    '--panel-rgb': mix(backgroundRGB, accentRGB, 0.035).join(', '),
    '--sidebar-rgb': sidebar.join(', '), '--sidebar-text': contrastText(sidebar),
    '--titlebar-rgb': titlebar.join(', '),
    '--sidebar-accent': `rgb(${sidebarAccent.join(', ')})`,
  } as CSSProperties;
}
