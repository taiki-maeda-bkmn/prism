import type { CSSProperties } from 'react';
import { themeIds, themes, type Colors, type ThemeId } from './appearance';

export function ThemeSettings({ theme, palettes, onChange }: { theme: ThemeId; palettes: Partial<Record<ThemeId, Colors>>; onChange: (theme: ThemeId) => void }) {
  return <fieldset className="theme-settings">
    <legend>Theme</legend>
    <div className="theme-options">
      {themeIds.map(id => {
        const option = themes[id];
        const palette = palettes[id] ?? option.colors;
        const sample = {
          '--sample-accent': palette.accent,
          '--sample-background': palette.background,
          '--sample-text': palette.text,
        } as CSSProperties;
        return <label key={id} className="theme-option" data-theme-choice={id} style={sample}>
          <input type="radio" name="theme" aria-label={`${option.name} theme`} checked={theme === id} onChange={() => onChange(id)} />
          <span className="theme-sample" aria-hidden="true"><span className="theme-sample-sidebar" /><span className="theme-sample-content"><strong>Aa</strong><span /><span /><span /></span></span>
          <span className="theme-option-name">{option.name}</span>
          <span className="theme-option-description">{option.description}</span>
        </label>;
      })}
    </div>
    <p className="field-help">Each theme remembers your custom colors.</p>
  </fieldset>;
}
