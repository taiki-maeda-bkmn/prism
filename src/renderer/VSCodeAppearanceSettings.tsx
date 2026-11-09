import { useEffect, useRef, useState } from 'react';
import type { VSCodeAppearanceImport } from '../shared/vscodeAppearance';
import type { Colors } from './appearance';
import './vscode-appearance.css';

export function VSCodeAppearanceSettings({ colors, themeName, onApply }: {
  colors: Colors; themeName: string; onApply: (colors: Colors) => void;
}) {
  const [preview, setPreview] = useState<VSCodeAppearanceImport | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const request = useRef(0);
  useEffect(() => () => { request.current++; }, []);

  const load = async (source: 'installed' | 'file') => {
    const id = ++request.current;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const result = await window.prism.importVSCodeAppearance(source);
      if (id === request.current && result) setPreview(result);
    } catch (cause) {
      if (id === request.current) {
        setPreview(null);
        setError(cause instanceof Error ? cause.message : 'The VS Code theme could not be read.');
      }
    } finally { if (id === request.current) setBusy(false); }
  };
  const proposed = preview ? { ...colors, ...preview.colors } : colors;
  return <fieldset className="vscode-appearance-setting" aria-busy={busy}>
    <legend>Import from VS Code</legend>
    <p className="field-help">Bring in page, text, and accent colors from your default VS Code profile or a theme JSON/JSONC file.</p>
    <div className="vscode-import-actions">
      <button type="button" className="subtle-button" disabled={busy} onClick={() => void load('installed')}>Load from VS Code</button>
      <button type="button" className="subtle-button" disabled={busy} onClick={() => void load('file')}>Choose theme file…</button>
    </div>
    {busy && <p className="field-help" role="status">Reading theme…</p>}
    {error && <p className="inline-error" role="alert">{error}</p>}
    {notice && <p className="field-help" role="status">{notice}</p>}
    {preview && <div className="vscode-import-preview" role="region" aria-label="VS Code theme preview">
      <strong>{preview.name}</strong>
      <p className="field-help vscode-import-source">{preview.source}</p>
      <div className="vscode-import-sample" style={{ background: proposed.background, color: proposed.text, borderColor: proposed.accent }}>
        <strong style={{ color: proposed.accent }}>A place for your ideas</strong>
        <span>Prism · 日本語のノート</span>
      </div>
      <dl>{([['background', 'Page background'], ['text', 'Text'], ['accent', 'Accent']] as const).map(([key, label]) =>
        <div key={key}><dt>{label}</dt><dd>{proposed[key]}{preview.colors[key] === undefined ? ' (unchanged)' : ''}</dd></div>,
      )}</dl>
      <p className="field-help">Applies to the {themeName} theme. Fonts, syntax highlighting, and transparency use your Prism settings.</p>
      {preview.warnings.length > 0 && <ul className="field-help">{preview.warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul>}
      <div className="vscode-import-actions">
        <button type="button" className="primary-button" disabled={busy} onClick={() => {
          onApply(proposed);
          setNotice(`Imported ${preview.name} colors into ${themeName}.`);
          setPreview(null);
        }}>Apply imported colors</button>
        <button type="button" className="subtle-button" disabled={busy} onClick={() => setPreview(null)}>Cancel import</button>
      </div>
    </div>}
  </fieldset>;
}
