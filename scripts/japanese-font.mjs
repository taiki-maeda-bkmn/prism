// Use the bundled font first for CJK glyphs only. Some Linux/Chromium font
// fallbacks otherwise stop at missing-glyph boxes in short text and SVG labels.
// Restricting coverage keeps Latin text in each theme's existing serif/sans/mono
// fonts. The upstream WOFF2 files and their weight ranges stay unchanged.
const cjkRanges = [
  [0x2e80, 0x9fff], [0xf900, 0xfaff], [0xfe30, 0xfe6f], [0xff00, 0xffef],
  [0x1aff0, 0x1afff], [0x1b000, 0x1b16f], [0x1f200, 0x1f2ff],
  [0x20000, 0x323af],
];

export function japaneseFontCSS(source) {
  const faces = [];
  for (const match of source.matchAll(/@font-face\s*\{([^}]+)\}/g)) {
    const body = match[1];
    const family = /font-family:\s*'Noto Sans JP Variable'/;
    if (!family.test(body)) throw new Error('Unexpected Japanese font family.');
    const declaration = /unicode-range:\s*([^;]+);/.exec(body);
    if (!declaration) throw new Error('Japanese font subset is missing its Unicode range.');
    const ranges = [];
    for (const part of declaration[1].split(',')) {
      const range = /^\s*U\+([0-9a-f]+)(?:-([0-9a-f]+))?\s*$/i.exec(part);
      if (!range) throw new Error(`Unsupported Japanese font range: ${part}`);
      const first = parseInt(range[1], 16);
      const last = parseInt(range[2] ?? range[1], 16);
      for (const [low, high] of cjkRanges) {
        const from = Math.max(first, low);
        const to = Math.min(last, high);
        if (from <= to) ranges.push(`U+${from.toString(16)}${from === to ? '' : `-${to.toString(16)}`}`);
      }
    }
    if (ranges.length) faces.push(`@font-face {${body
      .replace(family, "font-family: 'Noto Sans JP CJK'")
      .replace(declaration[0], `unicode-range: ${ranges.join(',')};`)}}`);
  }
  if (!faces.length) throw new Error('No Japanese font subsets were found.');
  return faces.join('\n');
}
