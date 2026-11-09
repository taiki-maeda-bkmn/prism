import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { discoverVSCodeAppearance, type VSCodeDiscoveryOptions } from '../src/main/vscode-discovery';

const basic = { 'editor.background': '#123456', 'editor.foreground': '#eeeeee', 'textLink.foreground': '#abcdef' };
async function fixture(t: TestContext, platform: 'linux' | 'win32' = 'linux') {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'prism-vscode-discovery-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const home = path.join(root, 'Home');
  const appData = path.join(root, 'AppData');
  const settingsPath = path.join(appData, 'Code', 'User', 'settings.json');
  const extensions = path.join(home, '.vscode', 'extensions');
  const install = path.join(root, 'Microsoft VS Code');
  await fs.mkdir(path.dirname(settingsPath), { recursive: true });
  await fs.mkdir(extensions, { recursive: true });
  const options: VSCodeDiscoveryOptions = { home, appData, platform, installationRoots: [install], env: {} };
  const settings = (value: unknown) => fs.writeFile(settingsPath, JSON.stringify(value));
  const theme = async (directory: string, name = 'Ocean', colors = basic) => {
    await fs.mkdir(path.join(directory, 'themes'), { recursive: true });
    await fs.writeFile(path.join(directory, 'package.json'), JSON.stringify({ contributes: { themes: [{ label: name, path: 'themes/theme.json' }] } }));
    await fs.writeFile(path.join(directory, 'themes', 'theme.json'), JSON.stringify({ colors }));
  };
  return { root, options, settingsPath, extensions, install, settings, theme };
}

test('discovers a Windows versioned built-in theme by ID and translated label, merging scoped customizations', async t => {
  const f = await fixture(t, 'win32');
  const extension = path.join(f.install, 'aabbccddeeff', 'resources', 'app', 'extensions', 'theme-defaults');
  await f.theme(extension);
  await fs.writeFile(path.join(extension, 'package.json'), JSON.stringify({ contributes: { themes: [{ id: 'Ocean ID', label: '%oceanName%', path: './themes/theme.json' }] } }));
  await fs.writeFile(path.join(extension, 'package.nls.json'), JSON.stringify({ oceanName: 'Ocean theme' }));
  await fs.writeFile(path.join(extension, 'base.json'), JSON.stringify({ colors: basic }));
  await fs.writeFile(path.join(extension, 'themes', 'theme.json'), '{ "include": "../base.json", "colors": {"editor.foreground": "#fff"}, }');
  await f.settings({ 'workbench.colorTheme': 'Ocean ID', 'workbench.colorCustomizations': {
    'editor.background': '#222222', '[Other][Ocean ID]': { 'textLink.foreground': '#f00' }, '[Ocean*]': { 'editor.foreground': '#0f0' },
    '[Ocean theme]': { 'editor.background': '#ff00ff' }, '[Oc*ID]': { 'textLink.foreground': '#00f' },
  }, 'unrelated.privateSetting': 'Do not return this' });
  const imported = await discoverVSCodeAppearance(f.options);
  assert.equal(imported.name, 'Ocean theme');
  assert.equal(imported.source, f.settingsPath);
  assert.deepEqual(imported.colors, { background: '#222222', text: '#00ff00', accent: '#ff0000' });
  assert.equal(JSON.stringify(imported).includes('Do not return this'), false);
  await f.settings({ 'workbench.colorTheme': 'Ocean theme' });
  await assert.rejects(discoverVSCodeAppearance(f.options), /not found/);
  await fs.writeFile(path.join(extension, 'package.json'), JSON.stringify({ contributes: { themes: [{ label: '%oceanName%', path: './themes/theme.json' }] } }));
  assert.deepEqual((await discoverVSCodeAppearance(f.options)).colors, { background: '#123456', text: '#ffffff', accent: '#abcdef' });
});

test('multiple installed extension versions require an exported theme instead of guessing the active copy', async t => {
  const f = await fixture(t);
  await f.theme(path.join(f.extensions, 'publisher.ocean-1.9.0'), 'Ocean', { ...basic, 'editor.background': '#000000' });
  await f.theme(path.join(f.extensions, 'publisher.ocean-1.10.0'));
  await f.settings({ 'workbench.colorTheme': 'Ocean' });
  await assert.rejects(discoverVSCodeAppearance(f.options), /matches multiple installed theme files.*Generate Color Theme/);
});

test('multiple versioned Windows installations are ambiguous even when their theme colors match', async t => {
  const f = await fixture(t, 'win32');
  for (const version of ['aabbccddeeff', '112233445566']) {
    await f.theme(path.join(f.install, version, 'resources', 'app', 'extensions', 'theme-defaults'));
  }
  await f.settings({ 'workbench.colorTheme': 'Ocean' });
  await assert.rejects(discoverVSCodeAppearance(f.options), /matches multiple installed theme files.*Generate Color Theme/);
});

test('duplicate discovery roots referring to the same canonical theme remain unambiguous', async t => {
  const f = await fixture(t);
  await f.theme(path.join(f.extensions, 'publisher.ocean-1.0.0'));
  await f.settings({ 'workbench.colorTheme': 'Ocean' });
  const alias = path.join(f.root, 'Extension alias');
  await fs.symlink(f.extensions, alias, 'junction');
  const imported = await discoverVSCodeAppearance({ ...f.options, extensionRoots: [f.extensions, alias] });
  assert.deepEqual(imported.colors, { background: '#123456', text: '#eeeeee', accent: '#abcdef' });
});

test('null or non-string customizations leave supported global color overrides intact', async t => {
  const f = await fixture(t);
  await f.theme(path.join(f.extensions, 'publisher.ocean-1.0.0'));
  await f.settings({ 'workbench.colorTheme': 'Ocean', 'workbench.colorCustomizations': {
    'editor.background': '#222222', 'editor.foreground': '#777777',
    '[Ocean]': { 'editor.background': 42, 'editor.foreground': null },
  } });
  assert.deepEqual((await discoverVSCodeAppearance(f.options)).colors, { background: '#222222', text: '#777777', accent: '#abcdef' });
});

test('runtime registry defaults require an exported theme rather than substituting the extension palette', async t => {
  const f = await fixture(t);
  await f.theme(path.join(f.extensions, 'publisher.ocean-1.0.0'));
  await f.settings({ 'workbench.colorTheme': 'Ocean', 'workbench.colorCustomizations': { '[Ocean]': { 'editor.background': 'default' } } });
  await assert.rejects(discoverVSCodeAppearance(f.options), /default.*Generate Color Theme|Generate Color Theme.*default/);
});

test('OS appearance selects configured preferred themes only when automatic matching is enabled', async t => {
  const f = await fixture(t);
  for (const name of ['Ocean', 'Day', 'Night', 'Contrast', 'Light contrast']) await f.theme(path.join(f.extensions, name), name);
  const settings = { 'workbench.colorTheme': 'Ocean', 'window.autoDetectColorScheme': true,
    'workbench.preferredDarkColorTheme': 'Night', 'workbench.preferredLightColorTheme': 'Day',
    'workbench.preferredHighContrastColorTheme': 'Contrast', 'workbench.preferredHighContrastLightColorTheme': 'Light contrast' };
  await f.settings(settings);
  assert.equal((await discoverVSCodeAppearance({ ...f.options, dark: true })).name, 'Night');
  assert.equal((await discoverVSCodeAppearance({ ...f.options, dark: false })).name, 'Day');
  assert.equal((await discoverVSCodeAppearance({ ...f.options, dark: true, highContrast: true })).name, 'Contrast');
  assert.equal((await discoverVSCodeAppearance({ ...f.options, dark: false, highContrast: true })).name, 'Light contrast');
  await f.settings({ ...settings, 'window.autoDetectColorScheme': false, 'window.autoDetectHighContrast': false });
  assert.equal((await discoverVSCodeAppearance({ ...f.options, dark: true, highContrast: true })).name, 'Ocean');
});

test('missing and unresolvable configured themes fail with export guidance rather than guessing', async t => {
  const f = await fixture(t);
  await f.theme(path.join(f.extensions, 'publisher.ocean-1.0.0'));
  await assert.rejects(discoverVSCodeAppearance(f.options), /settings file was not found.*Generate Color Theme/);
  await f.settings({});
  await assert.rejects(discoverVSCodeAppearance(f.options), /cannot be determined reliably.*Generate Color Theme/);
  await f.settings({ 'workbench.colorTheme': 'Missing theme' });
  await assert.rejects(discoverVSCodeAppearance(f.options), /Missing theme.*not found.*Generate Color Theme/);
  await f.settings({ 'workbench.colorTheme': 'Ocean', 'window.autoDetectColorScheme': true });
  await assert.rejects(discoverVSCodeAppearance({ ...f.options, dark: true }), /preferredDarkColorTheme.*cannot be determined reliably/);
});

test('default-profile import excludes workspace and named-profile overrides', async t => {
  const f = await fixture(t);
  await f.theme(path.join(f.extensions, 'publisher.ocean-1.0.0'));
  await f.settings({ 'workbench.colorTheme': 'Ocean' });
  const otherProfile = path.join(path.dirname(f.settingsPath), 'profiles', 'private-profile');
  await fs.mkdir(otherProfile, { recursive: true });
  await fs.writeFile(path.join(otherProfile, 'settings.json'), '{"workbench.colorTheme":"Missing private profile"}');
  await fs.mkdir(path.join(f.options.home, '.vscode'), { recursive: true });
  await fs.writeFile(path.join(f.options.home, '.vscode', 'settings.json'), '{"workbench.colorTheme":"Missing workspace"}');
  assert.equal((await discoverVSCodeAppearance(f.options)).name, 'Ocean');
});

test('extension theme paths and symlinked theme files cannot leave the extension', async t => {
  const f = await fixture(t);
  const extension = path.join(f.extensions, 'publisher.ocean-1.0.0');
  await f.theme(extension);
  await f.settings({ 'workbench.colorTheme': 'Ocean' });
  const outside = path.join(f.root, 'outside.json');
  await fs.writeFile(outside, JSON.stringify({ colors: basic }));
  for (const relative of ['../../../outside.json', '/outside.json', 'C:\\outside.json', 'https://example.com/theme.json']) {
    await fs.writeFile(path.join(extension, 'package.json'), JSON.stringify({ contributes: { themes: [{ label: 'Ocean', path: relative }] } }));
    await assert.rejects(discoverVSCodeAppearance(f.options), /unsupported file path|leaves its extension folder/);
  }
  if (process.platform === 'win32') return; // Creating file symlinks may require Developer Mode.
  await f.theme(extension);
  await fs.unlink(path.join(extension, 'themes', 'theme.json'));
  await fs.symlink(outside, path.join(extension, 'themes', 'theme.json'));
  await assert.rejects(discoverVSCodeAppearance(f.options), /stay inside the selected theme folder/);
});

test('invalid settings are rejected while unrelated damaged manifests do not mask a valid theme', async t => {
  const f = await fixture(t);
  const extension = path.join(f.extensions, 'publisher.ocean-1.0.0');
  await f.theme(extension);
  await fs.mkdir(path.join(f.extensions, 'zzz-broken'));
  await fs.writeFile(path.join(f.extensions, 'zzz-broken', 'package.json'), '{invalid');
  await fs.writeFile(f.settingsPath, '{"workbench.colorTheme":"Ocean", invalid');
  await assert.rejects(discoverVSCodeAppearance(f.options), /valid JSON object/);
  await fs.writeFile(f.settingsPath, '\ufeff{ // comment\n "workbench.colorTheme": "Ocean",\n }');
  assert.equal((await discoverVSCodeAppearance(f.options)).name, 'Ocean');
});

test('oversized manifest scans and non-JSON configured themes fail with actionable guidance', async t => {
  const f = await fixture(t);
  const extension = path.join(f.extensions, 'publisher.ocean-1.0.0');
  await f.theme(extension);
  await f.settings({ 'workbench.colorTheme': 'Ocean' });
  await fs.writeFile(path.join(extension, 'package.json'), JSON.stringify({ contributes: { themes: [{ label: 'Ocean', path: 'theme.tmTheme' }] } }));
  await assert.rejects(discoverVSCodeAppearance(f.options), /does not use a JSON.*Generate Color Theme/);
  await fs.writeFile(path.join(extension, 'package.json'), Buffer.alloc(16 * 1024 * 1024 + 1, 32));
  await assert.rejects(discoverVSCodeAppearance(f.options), /scan exceeds its size limit.*Generate Color Theme/);
});
