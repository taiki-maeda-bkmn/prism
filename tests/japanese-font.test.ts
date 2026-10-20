import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { japaneseFontCSS } from '../scripts/japanese-font.mjs';

interface Face {
  body: string;
  url: string;
  ranges: [number, number][];
}

function faces(css: string): Face[] {
  return Array.from(css.matchAll(/@font-face\s*\{([^}]+)\}/g), match => {
    const body = match[1];
    const url = /src:\s*url\(([^)]+)\)/.exec(body)?.[1];
    const ranges = /unicode-range:\s*([^;]+);/.exec(body)?.[1];
    assert.ok(url && ranges, 'Every generated face needs its original file and explicit coverage.');
    return {
      body, url,
      ranges: ranges.split(',').map(part => {
        const [first, last = first] = part.trim().replace(/^U\+/i, '').split('-');
        return [Number.parseInt(first, 16), Number.parseInt(last, 16)];
      }),
    };
  });
}

function includes(fonts: readonly Face[], codePoint: number): boolean {
  return fonts.some(face => face.ranges.some(([first, last]) => first <= codePoint && codePoint <= last));
}

// Use the installed, pinned package: a handcrafted fixture could miss the
// upstream numbered subsets that contain both Japanese glyphs and ASCII.
const upstream = await readFile('node_modules/@fontsource-variable/noto-sans-jp/index.css', 'utf8');
const generated = japaneseFontCSS(upstream);
const originalFaces = faces(upstream);
const generatedFaces = faces(generated);

test('keeps kana, kanji, punctuation, and rare Japanese name characters from the bundled font', () => {
  for (const character of Array.from('あいうえおカタカナ日本語漢字髙﨑𠮷。、　゙゚ｶﾞＡ１')) {
    const codePoint = character.codePointAt(0)!;
    assert.ok(includes(originalFaces, codePoint), `The pinned font must contain ${character}.`);
    assert.ok(includes(generatedFaces, codePoint), `The generated font must still contain ${character}.`);
  }
});

test('excludes ASCII and Latin even from mixed Japanese subsets so source code stays monospaced', () => {
  const mixed = originalFaces.filter(face => includes([face], '日'.codePointAt(0)!) && includes([face], 'A'.codePointAt(0)!));
  assert.ok(mixed.length, 'The upstream fixture should include the mixed-subset case.');
  for (let codePoint = 0; codePoint <= 0x024f; codePoint++) {
    assert.equal(includes(generatedFaces, codePoint), false, `Latin U+${codePoint.toString(16)} must use the existing font stack.`);
  }
  for (const character of '“”‘’–—…€') assert.equal(includes(generatedFaces, character.codePointAt(0)!), false);
});

test('reuses each original font asset and its variable weights without changing other face descriptors', () => {
  const originals = new Map(originalFaces.map(face => [face.url, face]));
  assert.ok(generatedFaces.length > 100, 'Japanese coverage must not be reduced to only the common subsets.');
  for (const face of generatedFaces) {
    const original = originals.get(face.url);
    assert.ok(original, `The font URL must remain an existing upstream asset: ${face.url}`);
    assert.doesNotMatch(face.url, /noto-sans-jp-(?:latin|latin-ext|cyrillic|vietnamese)-/);
    assert.match(face.body, /font-family:\s*'Noto Sans JP CJK';/);
    assert.match(face.body, /font-weight:\s*100 900;/);
    const descriptors = (body: string) => body.replace(/font-family:[^;]+;|unicode-range:[^;]+;/g, '');
    assert.equal(descriptors(face.body), descriptors(original.body));
    for (const [first, last] of face.ranges) {
      assert.ok(original.ranges.some(([low, high]) => low <= first && last <= high), 'Generated coverage cannot claim glyphs outside its source subset.');
    }
  }
});

test('fails the build when upstream CSS has no Japanese coverage or unsupported range syntax', () => {
  assert.throws(() => japaneseFontCSS(''), /No Japanese font subsets/);
  assert.throws(() => japaneseFontCSS('body { font-family: sans-serif; }'), /No Japanese font subsets/);
  assert.throws(() => japaneseFontCSS("@font-face { font-family: 'Changed upstream family'; unicode-range: U+65E5; }"), /Unexpected Japanese font family/);
  assert.throws(() => japaneseFontCSS("@font-face { font-family: 'Noto Sans JP Variable'; }"), /missing its Unicode range/);
  assert.throws(() => japaneseFontCSS("@font-face { font-family: 'Noto Sans JP Variable'; unicode-range: U+30??; }"), /Unsupported Japanese font range/);
  assert.throws(() => japaneseFontCSS("@font-face { font-family: 'Noto Sans JP Variable'; unicode-range: U+20-7E; }"), /No Japanese font subsets/);
});
