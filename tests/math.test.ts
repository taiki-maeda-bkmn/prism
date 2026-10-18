import assert from 'node:assert/strict';
import { test } from 'node:test';
import { JSDOM } from 'jsdom';
import { MAX_MATH_LENGTH, matchMathAt, mathTextContent, renderMath, scanMarkdownMath } from '../src/renderer/math';

const tex = (source: string) => scanMarkdownMath(source).map(range => ({ tex: range.tex, display: range.display }));

test('math delimiters support inline, same-line display, multiline display, and explicit TeX delimiters', () => {
  assert.deepEqual(tex(String.raw`Inline $x^2$, $$y^2$$, \(a+b\), and \[c+d\].`), [
    { tex: 'x^2', display: false }, { tex: 'y^2', display: true },
    { tex: 'a+b', display: false }, { tex: 'c+d', display: true },
  ]);
  assert.deepEqual(tex('Before\n\n$$\n\\frac{a}{b}\n$$\n\nAfter'), [{ tex: '\n\\frac{a}{b}\n', display: true }]);
  assert.deepEqual(tex('\\[\r\n\\sum_{i=1}^n i\r\n\\]'), [{ tex: '\r\n\\sum_{i=1}^n i\r\n', display: true }]);
});

test('math offsets preserve exact source including BOM, CRLF, leading spaces and delimiters', () => {
  const source = '\uFEFF# Heading\r\n\r\n$$\r\n  x^2\r\n$$\r\n';
  const [range] = scanMarkdownMath(source);
  assert.equal(source.slice(range.from, range.to), range.raw);
  assert.equal(source.slice(range.contentFrom, range.contentTo), range.tex);
  assert.equal(range.raw, '$$\r\n  x^2\r\n$$');
  assert.equal(range.tex, '\r\n  x^2\r\n');
});

test('prices, escaped dollars, whitespace and unmatched inline delimiters stay ordinary text', () => {
  assert.deepEqual(tex(String.raw`Cost $5 and $10; then $x^2$. Escaped \$20 and \$30.`), [{ tex: 'x^2', display: false }]);
  for (const source of ['$ incomplete', '$x $', '$ x$', '$5$20', '$x\ny$', '$$', '$$$x$$$', '\\(x', '\\[x']) {
    assert.deepEqual(tex(source), [], source);
  }
  assert.equal(matchMathAt(String.raw`$\text{cost \$5}$`)?.tex, String.raw`\text{cost \$5}`);
  assert.deepEqual(tex(String.raw`\\(literal\\) and \(real\)`), [{ tex: 'real', display: false }]);
});

test('math scanner excludes code, raw HTML, note links, images, autolinks and wiki aliases', () => {
  const source = [
    '`$inline$`', '```tex\n$$fenced$$\n```', '    $$indented$$',
    '<div>$$html$$</div>', 'Inline <span>$raw$</span>',
    '[$label$](Note$x$.md) ![$image$](image.png) <https://example.com/$url$>',
    '[[Note$x$|$alias$]] ![[Image$y$]]', '$actual$',
  ].join('\n\n');
  assert.deepEqual(tex(source), [{ tex: 'actual', display: false }]);
});

test('math contents are not mistaken for Markdown emphasis, links or code', () => {
  assert.deepEqual(tex(String.raw`$x_1 + \text{[[Not a note]]}$`), [{ tex: String.raw`x_1 + \text{[[Not a note]]}`, display: false }]);
  assert.deepEqual(tex('- $x^2$\n\n> $y^2$\n\n# $z^2$'), [
    { tex: 'x^2', display: false }, { tex: 'y^2', display: false }, { tex: 'z^2', display: false },
  ]);
  assert.deepEqual(tex('$$\n```md\nx\n```\n$$'), []);
});

test('KaTeX renders fractions, roots, matrices and aligned equations with accessible MathML', () => {
  for (const source of [String.raw`\frac{a}{b}`, String.raw`\sqrt{x^2+y^2}`, String.raw`\begin{pmatrix}a&b\\c&d\end{pmatrix}`, String.raw`\begin{aligned}a&=b+c\\d&=e\end{aligned}`]) {
    const result = renderMath(source, true);
    assert.equal(result.ok, true, source);
    if (!result.ok) continue;
    const fragment = JSDOM.fragment(result.html);
    assert.ok(fragment.querySelector('.katex-display .katex-html'));
    assert.equal(fragment.querySelector('.katex-mathml annotation')?.textContent, source);
    assert.ok(fragment.querySelector('math'));
    assert.ok(fragment.querySelector('[style]'), 'KaTeX retains its generated layout styles');
  }
});

test('invalid TeX, expansion loops, and oversized formulas return editable errors', () => {
  for (const source of [String.raw`\frac{1}{`, String.raw`\unknownPrismCommand{x}`, String.raw`\def\loop{\loop}\loop`, 'x'.repeat(MAX_MATH_LENGTH + 1)]) {
    const result = renderMath(source, false);
    assert.equal(result.ok, false, source.slice(0, 100));
    if (!result.ok) assert.ok(result.error.length > 0);
  }
});

test('KaTeX cannot create links, images, custom HTML styles, attributes, or scripts', () => {
  const source = String.raw`\href{javascript:alert(1)}{x}\includegraphics{https://example.com/track}\htmlStyle{position:fixed}{x}\htmlClass{injected}{y}\htmlId{injected}{z}`;
  const result = renderMath(source, false);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  const fragment = JSDOM.fragment(result.html);
  assert.equal(fragment.querySelector('a, img, script, iframe, .injected, #injected, [onclick], [onerror]'), null);
  assert.ok([...fragment.querySelectorAll('[style]')].every(element => !/position\s*:\s*fixed/.test(element.getAttribute('style') || '')));
});

test('formula macros do not leak into subsequent expressions', () => {
  assert.equal(renderMath(String.raw`\gdef\prismMacro{x}\prismMacro`, false).ok, true);
  assert.equal(renderMath(String.raw`\prismMacro`, false).ok, false);
  assert.equal(renderMath(String.raw`\sqrt{x}`, false).ok, true);
});

test('math heading labels contain TeX once instead of combining visual and accessible layers', () => {
  const result = renderMath('x^2', false);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  const heading = JSDOM.fragment(`<h2>Energy ${result.html}</h2>`).querySelector('h2')!;
  assert.equal(mathTextContent(heading), 'Energy x^2');
  assert.ok(heading.querySelector('.katex'), 'label extraction leaves rendered DOM intact');
});


test('math outside inline HTML still renders while its contents and attributes stay literal', () => {
  assert.deepEqual(tex('$before$ <span data-label="$attribute$">$inside$ <b>$nested$</b></span> $after$'), [
    { tex: 'before', display: false }, { tex: 'after', display: false },
  ]);
  assert.deepEqual(tex('$before$ <br> $after$'), [{ tex: 'before', display: false }, { tex: 'after', display: false }]);
});

test('large price lists and incomplete explicit delimiters preserve the final real formula', () => {
  const content = ('Prices $5 and $10; '.repeat(5_000)) + '\\[ unfinished '.repeat(5_000) + '\n\n$x^2$';
  assert.deepEqual(tex(content), [{ tex: 'x^2', display: false }]);
});


test('display math strips parsed quote prefixes while retaining exact editable source positions', () => {
  for (const source of ['> $$\n> x^2\n> $$', '- > $$\n  > x^2\n  > $$', '> - $$\n>   x^2\n>   $$', '> > $$\n> > x^2\n> > $$']) {
    const [math] = scanMarkdownMath(source);
    assert.equal(math.tex.trim(), 'x^2', source);
    assert.equal(source.slice(math.from, math.to), math.raw);
    assert.ok(source.slice(math.contentFrom, math.contentTo).includes('>'), 'source offsets retain quote markers');
  }
  assert.equal(scanMarkdownMath('> $$x > y\n> > z\n> $$')[0].tex.trim(), 'x > y\n> z');
  assert.equal(scanMarkdownMath('> $$\r\n> x^2\r\n> $$')[0].tex, '\r\nx^2\r\n');
});

test('indented continuation after a blank line remains part of an already open math block', () => {
  const [math] = scanMarkdownMath('$$\nx^2\n\n    + y^2\n$$');
  assert.equal(math.tex, '\nx^2\n\n    + y^2\n');
  assert.equal(renderMath(math.tex, true).ok, true);
  assert.deepEqual(scanMarkdownMath('    $$\n    x^2\n    $$'), [], 'a code block that starts before the delimiter remains literal');
});

test('many mismatched inline HTML names leave math outside their paragraph available', () => {
  const source = 'Text ' + '<b>'.repeat(30_000) + '</c>'.repeat(30_000) + ' $inside$\n\n$outside$';
  assert.deepEqual(tex(source), [{ tex: 'outside', display: false }]);
});
