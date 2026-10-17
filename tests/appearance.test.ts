import assert from 'node:assert/strict';
import test from 'node:test';
import { appearanceStyle, defaultColors, normalizeColor, parsePreferences } from '../src/renderer/appearance';

test('existing preferences acquire colors without losing editor mode or transparency', () => {
  const preferences = parsePreferences(JSON.stringify({ mode: 'preview', transparent: true, opacity: 35 }));
  assert.deepEqual(preferences, { mode: 'preview', transparent: true, opacity: 35, colors: defaultColors });
});

test('damaged saved preferences recover independently while retaining valid values', () => {
  for (const serialized of ['null', '[]', 'true', '"text"', '{broken', null]) {
    assert.deepEqual(parsePreferences(serialized), parsePreferences(null));
  }
  const preferences = parsePreferences(JSON.stringify({
    mode: 'source', transparent: true, opacity: 120,
    colors: { accent: '#AbC', background: 'url(file:///bad)', text: '#EeEefF' },
  }));
  assert.deepEqual(preferences, {
    mode: 'source', transparent: true, opacity: 100,
    colors: { accent: '#aabbcc', background: defaultColors.background, text: '#eeeeff' },
  });
  assert.deepEqual(parsePreferences('{"colors":null}').colors, defaultColors);
});

test('color fields accept hex colors but reject incomplete values and CSS expressions', () => {
  assert.equal(normalizeColor(' #aB9 '), '#aabb99');
  assert.equal(normalizeColor('#0011FF'), '#0011ff');
  for (const invalid of ['', '#', '#12', '#1234', '#12345g', '#12345678', 'red', 'rgb(0,0,0)', 'var(--text)', 'url(test)', null, 123]) {
    assert.equal(normalizeColor(invalid), undefined);
  }
});

test('color changes retain surface alpha and contrasting labels for very light or dark accents', () => {
  const preferences = parsePreferences(JSON.stringify({ transparent: true, opacity: 35, colors: { accent: '#ffffff', background: '#141820' } }));
  const style = appearanceStyle(preferences) as Record<string, unknown>;
  assert.equal(style['--surface-alpha'], 0.35);
  assert.equal(style['--background-rgb'], '20, 24, 32');
  assert.equal(style['--accent-contrast'], '#000000');
  const dark = appearanceStyle({ ...preferences, transparent: false, colors: { ...preferences.colors, accent: '#000000' } }) as Record<string, unknown>;
  assert.equal(dark['--surface-alpha'], 1);
  assert.equal(dark['--accent-contrast'], '#ffffff');
});
