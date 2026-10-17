import type { CSSProperties } from 'react';

export type Mode = 'source' | 'split' | 'preview';
export interface Colors { accent: string; background: string; text: string; }
export interface Preferences { mode: Mode; transparent: boolean; opacity: number; colors: Colors; }

export const defaultColors: Colors = { accent: '#3e6242', background: '#faf9f5', text: '#344640' };
const defaults: Preferences = { mode: 'split', transparent: false, opacity: 82, colors: defaultColors };

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

export function parsePreferences(serialized: string | null): Preferences {
  let value: Record<string, unknown>;
  try { value = record(JSON.parse(serialized || '{}')); } catch { value = {}; }
  const colors = record(value.colors);
  return {
    mode: value.mode === 'source' || value.mode === 'split' || value.mode === 'preview' ? value.mode : defaults.mode,
    transparent: value.transparent === true,
    opacity: typeof value.opacity === 'number' && Number.isFinite(value.opacity) ? Math.min(100, Math.max(25, value.opacity)) : defaults.opacity,
    colors: {
      accent: normalizeColor(colors.accent) ?? defaultColors.accent,
      background: normalizeColor(colors.background) ?? defaultColors.background,
      text: normalizeColor(colors.text) ?? defaultColors.text,
    },
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
  const sidebar = mix(accentRGB, [0, 0, 0], 0.55);
  return {
    '--surface-alpha': preferences.transparent ? preferences.opacity / 100 : 1,
    '--accent': accent, '--accent-contrast': contrastText(accentRGB),
    '--text': text, '--background': background,
    '--background-rgb': backgroundRGB.join(', '),
    '--panel-rgb': mix(backgroundRGB, accentRGB, 0.035).join(', '),
    '--sidebar-rgb': sidebar.join(', '), '--sidebar-text': contrastText(sidebar),
    '--titlebar-rgb': mix(sidebar, [0, 0, 0], 0.15).join(', '),
    '--sidebar-accent': `rgb(${mix(accentRGB, [255, 255, 255], 0.6).join(', ')})`,
  } as CSSProperties;
}
