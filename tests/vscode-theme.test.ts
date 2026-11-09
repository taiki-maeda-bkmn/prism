import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { mapVSCodeColors, parseVSCodeJSON, readVSCodeJSON, readVSCodeTheme } from '../src/main/vscode-theme';

async function fixture(t: TestContext) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'prism-vscode-theme-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const write = async (name: string, content: unknown) => {
    const file = path.join(root, name);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, typeof content === 'string' ? content : JSON.stringify(content));
    return file;
  };
  return { root, write };
}

test('reads JSONC comments, trailing commas and UTF-8 BOM without accepting partial or non-object input', () => {
  assert.equal(JSON.stringify(parseVSCodeJSON('\ufeff{ // Theme\n "colors": {"editor.background":"#123",},\n}')), '{"colors":{"editor.background":"#123"}}');
  for (const text of ['{ "colors": {},', '{ "colors": {"editor.foreground":"#abc"} bad }', '{} {}', '[]', 'null', '"theme"', '']) {
    assert.throws(() => parseVSCodeJSON(text), /valid JSON object/);
  }
  assert.equal(parseVSCodeJSON('{"name":"A // quoted /* name */"}').name, 'A // quoted /* name */');
  const malicious = parseVSCodeJSON('{"__proto__":{"include":"outside.json","colors":{"editor.background":"#fff"}}}');
  assert.equal(Object.getPrototypeOf(malicious), null);
  assert.equal(malicious.include, undefined);
  assert.equal(malicious.colors, undefined);
});

test('theme inheritance merges string colors with child precedence and ignores null or non-string overrides', async t => {
  const { write } = await fixture(t);
  await write('base.json', { name: 'Base', type: 'dark', colors: { 'editor.background': '#112233', 'editor.foreground': '#eee', 'textLink.foreground': '#aab' } });
  const theme = await write('研究.jsonc', '\ufeff{ /* Child */ "include":"./base.json", "name":"研究", "colors":{"editor.foreground":"#abcdef", "textLink.foreground":null,}, }');
  assert.deepEqual(await readVSCodeTheme(theme), { name: '研究', type: 'dark', colors: { 'editor.background': '#112233', 'editor.foreground': '#abcdef', 'textLink.foreground': '#aab' } });
  await write('研究.jsonc', { include: 'base.json', colors: { 'editor.background': 1, 'editor.foreground': {}, 'textLink.foreground': [] } });
  assert.deepEqual((await readVSCodeTheme(theme)).colors, { 'editor.background': '#112233', 'editor.foreground': '#eee', 'textLink.foreground': '#aab' });
});

test('supports relative parent includes only within the explicitly selected extension root', async t => {
  const { root, write } = await fixture(t);
  await write('base.json', { colors: { 'editor.background': '#123456' } });
  const theme = await write('themes/child.json', { include: '../base.json' });
  await assert.rejects(readVSCodeTheme(theme), /inside the selected theme folder/);
  assert.deepEqual((await readVSCodeTheme(theme, { root })).colors, { 'editor.background': '#123456' });
});

test('rejects circular, too deep, absolute, URL and escaping includes', async t => {
  const { root, write } = await fixture(t);
  const theme = await write('theme.json', { include: 'theme.json' });
  await assert.rejects(readVSCodeTheme(theme), /circular include/);
  for (const include of ['/outside.json', '../outside.json', 'https://example.test/theme.json', 'file:///outside.json', 'C:\\outside.json', '..\\outside.json', '', {}, ['base.json']]) {
    await write('theme.json', { include });
    await assert.rejects(readVSCodeTheme(theme), /relative local JSON path|inside the selected theme folder/);
  }
  for (let index = 0; index < 9; index++) await write(`depth-${index}.json`, index < 8 ? { include: `depth-${index + 1}.json` } : { colors: {} });
  await assert.rejects(readVSCodeTheme(path.join(root, 'depth-0.json')), /limited to 8 files/);
  assert.deepEqual((await readVSCodeTheme(path.join(root, 'depth-1.json'))).colors, {});
});

test('canonical includes cannot follow a symlink outside the theme root', async t => {
  const { root, write } = await fixture(t);
  const outside = await write('outside/other.json', { colors: { 'editor.background': '#000' } });
  const theme = await write('theme/entry.json', { include: 'linked/other.json' });
  await fs.symlink(path.dirname(outside), path.join(root, 'theme/linked'), 'junction');
  await assert.rejects(readVSCodeTheme(theme), /inside the selected theme folder/);
});

test('file reads reject oversized, non-file, malformed and invalid UTF-8 input', async t => {
  const { root, write } = await fixture(t);
  const big = await write('big.json', JSON.stringify({ name: 'x'.repeat(2 * 1024 * 1024) }));
  await assert.rejects(readVSCodeJSON(big), /2 MB or smaller/);
  assert.throws(() => parseVSCodeJSON(' '.repeat(2 * 1024 * 1024 + 1)), /2 MB or smaller/);
  await assert.rejects(readVSCodeJSON(root));
  const invalid = await write('invalid.json', '{ "colors": { "editor.background":"#abc" }, ??? }');
  await assert.rejects(readVSCodeJSON(invalid), /valid JSON object/);
  await fs.writeFile(invalid, Buffer.from([0x7b, 0xff, 0x7d]));
  await assert.rejects(readVSCodeJSON(invalid), /UTF-8/);
  const malformedColors = await write('bad-colors.json', { colors: ['#fff'] });
  await assert.rejects(readVSCodeTheme(malformedColors), /colors must be a JSON object/);
});

test('maps supported colors by precedence and normalizes short hex and alpha without passing other settings', () => {
  assert.deepEqual(mapVSCodeColors({
    'editor.background': '#123', 'editor.foreground': '#AbCdEf', foreground: '#111',
    'textLink.foreground': '#bcde', 'button.background': '#999999',
    'editor.fontSize': 42, 'window.opacity': 0.1, 'some.setting': 'private',
  }), {
    colors: { background: '#112233', text: '#abcdef', accent: '#bbccdd' },
    warnings: ["textLink.foreground uses transparency; its RGB color will be imported. Use Prism's opacity controls for transparency."],
  });
  assert.deepEqual(mapVSCodeColors({ 'editor.background': '#123456ff', 'editor.foreground': '#abcf' }), {
    colors: { background: '#123456', text: '#aabbcc' }, warnings: [],
  });
});

test('invalid CSS values and nulls cannot reach the palette and valid fallbacks still apply', () => {
  const mapped = mapVSCodeColors({
    'editor.background': 'url(https://example.test)', 'editor.foreground': null, foreground: '#fff',
    'textLink.foreground': 'rgb(0 0 0)', 'button.background': 123, focusBorder: '#ff004480',
  });
  assert.deepEqual(mapped.colors, { text: '#ffffff', accent: '#ff0044' });
  assert.equal(mapped.warnings.length, 4);
  assert.deepEqual(mapVSCodeColors({ 'editor.foreground': null, 'unrelated.setting': '#fff' }), { colors: {}, warnings: [] });
  assert.deepEqual(mapVSCodeColors(Object.create({ 'editor.background': '#fff' })), { colors: {}, warnings: [] });
});

test('registry-default theme colors request a resolved export instead of inventing inherited colors', async t => {
  const { write } = await fixture(t);
  await write('base.json', { colors: { 'editor.background': '#123456', 'editor.foreground': '#eee' } });
  const theme = await write('child.json', { include: 'base.json', colors: { 'editor.background': 'default' } });
  const loaded = await readVSCodeTheme(theme);
  assert.equal(loaded.colors['editor.background'], 'default');
  assert.throws(() => mapVSCodeColors(loaded.colors), /registry-default.*Generate Color Theme From Current Settings/);
  for (const key of ['editor.foreground', 'foreground', 'textLink.foreground', 'button.background', 'focusBorder', 'activityBarBadge.background']) {
    assert.throws(() => mapVSCodeColors({ 'editor.background': '#123', 'textLink.foreground': '#abc', [key]: 'default' }), /Generate Color Theme From Current Settings/);
  }
  assert.deepEqual(mapVSCodeColors({ 'unused.color': 'default', 'editor.background': '#fff' }).colors, { background: '#ffffff' });
});
