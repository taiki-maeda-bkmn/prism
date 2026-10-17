import assert from 'node:assert/strict';
import test from 'node:test';
import { appearanceStyle, defaultColors, normalizeColor, parsePreferences, selectTheme, textSize, themes } from '../src/renderer/appearance';

test('existing preferences acquire colors without losing editor mode or transparency', () => {
  const preferences = parsePreferences(JSON.stringify({ mode: 'preview', transparent: true, opacity: 35 }));
  assert.deepEqual(preferences, { mode: 'preview', transparent: true, opacity: 35, textScale: 120, colors: defaultColors, theme: 'prism', themeColors: {} });
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
    mode: 'source', transparent: true, opacity: 100, textScale: 120,
    colors: { accent: '#aabbcc', background: defaultColors.background, text: '#eeeeff' },
    theme: 'prism', themeColors: {},
  });
  assert.deepEqual(parsePreferences('{"colors":null}').colors, defaultColors);
});

test('text size migrates legacy preferences and safely recovers invalid saved sizes', () => {
  assert.deepEqual(textSize, { min: 100, max: 150, step: 5, default: 120 });
  for (const textScale of [undefined, null, '140', true, [], {}, Infinity, -Infinity, NaN]) {
    assert.equal(parsePreferences(JSON.stringify({ textScale })).textScale, 120);
  }
  assert.equal(parsePreferences('{"textScale":1e309}').textScale, 120);
  for (const [textScale, expected] of [[75, 100], [100, 100], [122, 120], [123, 125], [147.8, 150], [150, 150], [500, 150]]) {
    const saved = parsePreferences(JSON.stringify({ textScale, theme: 'paper', mode: 'source', opacity: 35, transparent: true }));
    assert.equal(saved.textScale, expected);
    assert.equal(selectTheme(saved, 'scifi').textScale, expected);
    assert.equal(parsePreferences(JSON.stringify(saved)).textScale, expected);
    const style = appearanceStyle(saved) as Record<string, unknown>;
    assert.equal(style['--text-scale'], expected / 100);
    assert.equal(style['--surface-alpha'], 0.35);
    assert.equal(saved.mode, 'source');
  }
});

test('legacy custom colors stay with Prism when introducing themes', () => {
  const colors = { accent: '#aabbcc', background: '#112233', text: '#ddeeff' };
  const legacy = parsePreferences(JSON.stringify({ mode: 'source', transparent: true, opacity: 46, colors }));
  assert.equal(legacy.theme, 'prism');
  assert.deepEqual(legacy.colors, colors);
  const paper = selectTheme(legacy, 'paper');
  assert.deepEqual(paper.colors, themes.paper.colors);
  assert.deepEqual(selectTheme(paper, 'prism').colors, colors);
  assert.equal(paper.mode, 'source');
  assert.equal(paper.transparent, true);
  assert.equal(paper.opacity, 46);
});

test('invalid themes and saved palette fields recover independently', () => {
  for (const theme of ['unknown', 'toString', '__proto__', null, 0, {}]) {
    const invalidTheme = parsePreferences(JSON.stringify({ theme, colors: { accent: '#abc' } }));
    assert.equal(invalidTheme.theme, 'prism');
    assert.equal(invalidTheme.colors.accent, '#aabbcc');
  }
  const preferences = parsePreferences(JSON.stringify({
    theme: 'scifi',
    colors: { accent: '#ABC', background: 'url(file:///bad)', text: null },
    themeColors: {
      paper: { accent: '#123', background: '#12345', text: '#FfEeDd' },
      prism: { accent: 'red', background: '#010203' },
      unknown: { accent: '#ffffff', background: '#000000', text: '#ffffff' },
    },
  }));
  assert.equal(preferences.theme, 'scifi');
  assert.deepEqual(preferences.colors, { ...themes.scifi.colors, accent: '#aabbcc' });
  assert.deepEqual(preferences.themeColors, {
    paper: { accent: '#112233', background: themes.paper.colors.background, text: '#ffeedd' },
    prism: { ...themes.prism.colors, background: '#010203' },
  });
  for (const themeColors of [null, [], 'invalid']) {
    assert.deepEqual(parsePreferences(JSON.stringify({ theme: 'paper', themeColors })).themeColors, {});
  }
});

test('theme palettes survive switches and storage without changing other preferences', () => {
  const prismColors = { accent: '#7733aa', background: '#fffedd', text: '#332211' };
  const paperColors = { accent: '#bb6633', background: '#ffefdb', text: '#554433' };
  const prism = parsePreferences(JSON.stringify({ colors: prismColors, mode: 'preview', transparent: true, opacity: 35 }));
  assert.equal(selectTheme(prism, 'prism'), prism);
  const paper = { ...selectTheme(prism, 'paper'), colors: paperColors };
  const scifi = selectTheme(paper, 'scifi');
  assert.deepEqual(scifi.colors, themes.scifi.colors);
  const restored = parsePreferences(JSON.stringify(scifi));
  assert.deepEqual(restored, scifi);
  assert.deepEqual(selectTheme(restored, 'paper').colors, paperColors);
  assert.deepEqual(selectTheme(restored, 'prism').colors, prismColors);
  assert.equal(restored.mode, 'preview');
  assert.equal(restored.transparent, true);
  assert.equal(restored.opacity, 35);
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
