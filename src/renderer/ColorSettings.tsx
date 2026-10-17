import { useId, useState } from 'react';
import { normalizeColor, type Colors } from './appearance';

function ColorField({ label, value, onChange }: { label: string; value: string; onChange: (color: string) => void }) {
  const id = useId();
  const [draft, setDraft] = useState(value);
  const invalid = normalizeColor(draft) === undefined;
  return <div className="color-setting">
    <label htmlFor={`${id}-picker`}>{label}</label>
    <div className="color-inputs">
      <input id={`${id}-picker`} type="color" aria-label={`${label} color`} value={value} onChange={event => {
        setDraft(event.target.value);
        onChange(event.target.value);
      }} />
      <input type="text" aria-label={`${label} hex`} aria-invalid={invalid} aria-describedby={invalid ? `${id}-error` : undefined}
        value={draft} maxLength={7} spellCheck={false} autoComplete="off" onChange={event => {
          setDraft(event.target.value);
          const color = normalizeColor(event.target.value);
          if (color) onChange(color);
        }} onBlur={() => {
          // Keep invalid feedback in place during a click on Done or Reset.
          // Removing its row on blur can move that button before mouseup.
          if (normalizeColor(draft)) setDraft(value);
        }} />
    </div>
    {invalid && <p id={`${id}-error`} className="color-error field-help">Use a hex color such as #3e6242 or #abc.</p>}
  </div>;
}

export function ColorSettings({ colors, defaultColors, onChange }: { colors: Colors; defaultColors: Colors; onChange: (colors: Colors) => void }) {
  const [reset, setReset] = useState(0);
  return <fieldset className="color-settings">
    <legend>Colors</legend>
    <div className="color-settings-heading"><p>Choose a color or enter its hex code.</p><button type="button" className="subtle-button" onClick={() => {
      onChange({ ...defaultColors });
      setReset(previous => previous + 1);
    }}>Reset colors</button></div>
    <div key={reset}>
      <ColorField label="Accent" value={colors.accent} onChange={accent => onChange({ ...colors, accent })} />
      <ColorField label="Page background" value={colors.background} onChange={background => onChange({ ...colors, background })} />
      <ColorField label="Text" value={colors.text} onChange={text => onChange({ ...colors, text })} />
    </div>
  </fieldset>;
}
