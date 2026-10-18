import { electronLaunchArguments } from '../../scripts/electron-launch.mjs';
import { _electron as electron, expect, test, type ElectronApplication, type Locator, type Page } from '@playwright/test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const initial = '# Math\n\nInline $e^{i\\pi}+1=0$ and \\(a+b\\).\n\n$$\n\\frac{a}{b}=\\sqrt{x}\n$$\n\n\\[\\sum_{n=1}^{3} n=6\\]\n\nLiteral `$x^2$`, \\$5 and \\$10.\n\n```tex\n$not_math$\n```\n\nAfter equations.\n';
const windows = '\ufeff# Windows math\r\n\r\nInline $a^2$.\r\n\r\n$$\r\n\\frac{1}{2}\r\n$$\r\n\r\nAfter equations.\r\n';
let temporary: string;
let notebook: string;
let desktop: ElectronApplication | undefined;
let page: Page;
let pageErrors: string[];
let failedFonts: string[];

const editor = () => page.getByLabel('Live Markdown editor', { exact: true });
const mode = (name: string) => page.getByRole('group', { name: 'Editor mode', exact: true }).getByRole('button', { name, exact: true });
const formula = (tex: string) => editor().getByRole('button', { name: `Edit formula: ${tex}`, exact: true });

async function saveAndExpect(name: string, content: string) {
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.locator('.statusbar')).toContainText('All changes saved');
  expect(await readFile(path.join(notebook, name), 'utf8')).toBe(content);
}

async function replaceDocument(content: string) {
  await editor().focus();
  await editor().press('ControlOrMeta+A');
  await page.keyboard.insertText(content);
}

async function expectFormulas(container: Locator) {
  await expect(container.locator('.katex')).toHaveCount(4);
  await expect(container.locator('.katex-html')).toHaveCount(4);
  await expect(container.locator('.katex-mathml math')).toHaveCount(4);
  await expect(container.locator('.katex-mathml annotation')).toHaveText([
    'e^{i\\pi}+1=0', 'a+b', '\\frac{a}{b}=\\sqrt{x}', '\\sum_{n=1}^{3} n=6',
  ]);
  await expect(container.locator('.katex-display')).toHaveCount(2);
}

test.beforeEach(async () => {
  temporary = await mkdtemp(path.join(os.tmpdir(), 'prism-math-test-'));
  notebook = path.join(temporary, 'Notebook');
  const userData = path.join(temporary, 'profile');
  await Promise.all([mkdir(notebook), mkdir(userData)]);
  await Promise.all([
    writeFile(path.join(notebook, 'Welcome to Prism.md'), initial),
    writeFile(path.join(notebook, 'Windows math.md'), windows),
  ]);
  desktop = await electron.launch({
    args: electronLaunchArguments(['--no-sandbox', '.']), cwd: process.cwd(),
    env: { ...process.env, PRISM_USER_DATA: userData, PRISM_WORKSPACE: notebook },
  });
  page = await desktop.firstWindow();
  pageErrors = [];
  failedFonts = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  page.on('requestfailed', request => {
    if (request.resourceType() === 'font') failedFonts.push(request.url());
  });
  await expect(page.locator('.note-heading h1')).toBeVisible();
  await expect.poll(() => desktop!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible())).toBe(true);
});

test.afterEach(async ({}, testInfo) => {
  if (page && !page.isClosed() && testInfo.status !== testInfo.expectedStatus) {
    const screenshot = await page.screenshot({ path: testInfo.outputPath('math-failure.png') }).catch(() => undefined);
    if (screenshot) await testInfo.attach('Math at failure', { body: screenshot, contentType: 'image/png' });
  }
  if (desktop) {
    const child = desktop.process();
    const closed = desktop.waitForEvent('close', { timeout: 5_000 }).catch(() => undefined);
    await desktop.evaluate(({ app }) => app.exit(0)).catch(() => undefined);
    await closed;
    if (child.exitCode === null) child.kill();
    desktop = undefined;
  }
  if (temporary) await rm(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

test('typesets inline and display LaTeX offline in Split, Read, and Live with the chosen appearance', async ({}, testInfo) => {
  for (const name of ['Split', 'Read']) {
    await mode(name).click();
    const preview = page.locator('.markdown-body');
    await expectFormulas(preview);
    await expect(preview.locator('code').filter({ hasText: /^\$x\^2\$$/ })).toHaveText('$x^2$');
    await expect(preview.locator('pre code')).toHaveText('$not_math$\n');
    await expect(preview).toContainText('$5 and $10.');
  }

  await mode('Live').click();
  await expectFormulas(editor());
  await expect(editor()).toContainText('$x^2$');
  await expect(editor().locator('.cm-live-codeblock').filter({ hasText: '$not_math$' })).toHaveText('$not_math$');
  const rendered = editor().locator('.katex').first();
  const originalSize = await rendered.evaluate(element => parseFloat(getComputedStyle(element).fontSize));

  // A font-family string alone could still be silently falling back to Arial.
  await page.evaluate(() => document.fonts.ready);
  const fonts = await page.evaluate(() => ({
    loaded: Array.from(document.fonts).filter(font => font.family.startsWith('KaTeX') && font.status === 'loaded').map(font => font.family),
    // Chromium does not expose resource-timing entries for every file: font.
    // Check the actual @font-face sources alongside their loaded FontFace state.
    resources: Array.from(document.styleSheets).flatMap(sheet => Array.from(sheet.cssRules))
      .filter((rule): rule is CSSFontFaceRule => rule instanceof CSSFontFaceRule && rule.style.fontFamily.includes('KaTeX'))
      .flatMap(rule => Array.from(rule.style.getPropertyValue('src').matchAll(/url\(["']?([^"')]+)["']?\)/g), match => new URL(match[1], document.baseURI).href)),
  }));
  expect(fonts.loaded).toContain('KaTeX_Main');
  expect(fonts.loaded).toContain('KaTeX_Math');
  expect(fonts.resources.length).toBeGreaterThan(0);
  expect(fonts.resources.every(url => new URL(url).protocol === 'file:')).toBe(true);
  expect(failedFonts).toEqual([]);

  await page.getByRole('button', { name: 'Window appearance', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Make a little space', exact: true });
  await dialog.getByLabel('Text hex', { exact: true }).fill('#ddeeff');
  await dialog.getByLabel('Page background hex', { exact: true }).fill('#1c2430');
  const size = dialog.getByRole('slider', { name: 'Text size', exact: true });
  await size.focus();
  await size.press('End');
  await expect(size).toHaveValue('150');
  await dialog.getByRole('switch', { name: 'Transparent window', exact: true }).click();
  const opacity = dialog.getByRole('slider', { name: 'Background opacity', exact: true });
  await opacity.focus();
  await opacity.press('Home');
  for (let index = 0; index < 10; index++) await opacity.press('ArrowRight');
  await expect(opacity).toHaveValue('35');
  await dialog.getByRole('button', { name: 'Done', exact: true }).click();

  await expect.poll(() => rendered.evaluate(element => parseFloat(getComputedStyle(element).fontSize))).toBeCloseTo(originalSize * 1.25, 1);
  await expect(rendered.locator('.mathnormal').first()).toHaveCSS('color', 'rgb(221, 238, 255)');
  await expect(rendered).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
  await expect(page.locator('.workspace-main')).toHaveCSS('background-color', 'rgba(28, 36, 48, 0.35)');
  await expectFormulas(editor());
  for (const name of ['Read', 'Split']) {
    await mode(name).click();
    await expectFormulas(page.locator('.markdown-body'));
    await expect(page.locator('.markdown-body .katex .mathnormal').first()).toHaveCSS('color', 'rgb(221, 238, 255)');
  }
  await mode('Live').click();
  await testInfo.attach('Rendered LaTeX with custom appearance', { body: await page.screenshot({ path: testInfo.outputPath('math-rendered.png') }), contentType: 'image/png' });
  expect(await readFile(path.join(notebook, 'Welcome to Prism.md'), 'utf8')).toBe(initial);
  expect(pageErrors).toEqual([]);
  await expect(page.locator('.message-banner.error')).toHaveCount(0);
});

test('edits rendered formulas, rerenders on leaving, and preserves undo and exact BOM/CRLF saves', async () => {
  await page.getByRole('navigation', { name: 'Notes', exact: true }).getByRole('button', { name: 'Windows math', exact: true }).click();
  await mode('Live').click();
  // Click the displayed glyph to check source reveal at its on-screen position.
  await formula('a^2').scrollIntoViewIfNeeded();
  const point = await formula('a^2').evaluate(element => {
    const box = element.getBoundingClientRect();
    const x = box.x + box.width / 2;
    const y = box.y + box.height / 2;
    return { x, y, receivesClick: element.contains(document.elementFromPoint(x, y)) };
  });
  expect(point.receivesClick).toBe(true);
  await page.mouse.click(point.x, point.y);
  await expect(editor().locator('.cm-line').filter({ hasText: 'Inline $a^2$.' })).toBeVisible();
  await expect(formula('a^2')).toHaveCount(0);
  await editor().press('Home');
  for (let index = 0; index < 'Inline $'.length; index++) await editor().press('ArrowRight');
  for (let index = 0; index < 'a^2'.length; index++) await editor().press('Shift+ArrowRight');
  await page.keyboard.insertText('a^3');
  await editor().press('ControlOrMeta+Home');
  await expect(formula('a^3')).toBeVisible();
  const inlineEdited = windows.replace('$a^2$', '$a^3$');
  await saveAndExpect('Windows math.md', inlineEdited);

  await formula('\\frac{1}{2}').click();
  const numerator = editor().locator('.cm-line').filter({ hasText: /^\\frac\{1\}\{2\}$/ });
  await expect(numerator).toBeVisible();
  await numerator.click();
  await editor().press('Home');
  await editor().press('Shift+End');
  await page.keyboard.insertText('\\frac{3}{4}');
  await editor().press('ControlOrMeta+Home');
  await expect(formula('\\frac{3}{4}')).toBeVisible();
  const edited = inlineEdited.replace('\\frac{1}{2}', '\\frac{3}{4}');
  await saveAndExpect('Windows math.md', edited);

  for (const name of ['Source', 'Read', 'Live']) await mode(name).click();
  await editor().focus();
  await editor().press('ControlOrMeta+z');
  await editor().press('ControlOrMeta+Home');
  await expect(formula('\\frac{1}{2}')).toBeVisible();
  await expect(formula('a^3')).toBeVisible();
  await saveAndExpect('Windows math.md', inlineEdited);
  await editor().focus();
  await editor().press(process.platform === 'darwin' ? 'Meta+Shift+Z' : 'Control+y');
  await editor().press('ControlOrMeta+Home');
  await expect(formula('\\frac{3}{4}')).toBeVisible();
  await saveAndExpect('Windows math.md', edited);
  expect(pageErrors).toEqual([]);
  await expect(page.locator('.message-banner.error')).toHaveCount(0);
});

test('keeps incomplete and invalid LaTeX editable and recovers when the formula is corrected', async () => {
  await mode('Live').click();
  const incomplete = '# Recovery\n\nIncomplete $\\frac{1}{2}';
  await replaceDocument(incomplete);
  await expect(editor().locator('.katex')).toHaveCount(0);
  await expect(editor()).toContainText('Incomplete $\\frac{1}{2}');
  await page.keyboard.insertText('$');
  await editor().press('ControlOrMeta+Home');
  await expect(formula('\\frac{1}{2}')).toBeVisible();
  await saveAndExpect('Welcome to Prism.md', incomplete + '$');

  const openBlock = '# Recovery\n\n$$\n\\frac{1}{2}\n';
  await replaceDocument(openBlock);
  await expect(editor().locator('.katex')).toHaveCount(0);
  await page.keyboard.insertText('$$');
  await editor().press('ControlOrMeta+Home');
  await expect(formula('\\frac{1}{2}')).toBeVisible();
  await expect(editor().locator('.katex-display')).toHaveCount(1);
  await saveAndExpect('Welcome to Prism.md', openBlock + '$$');

  const invalid = '# Recovery\n\nInvalid $\\prismUnknownCommand{a}$.\n\nAfter equations.';
  await replaceDocument(invalid);
  await expect(editor().locator('.katex')).toHaveCount(0);
  await expect(editor()).toContainText('$\\prismUnknownCommand{a}$');
  await mode('Read').click();
  await expect(page.locator('.markdown-body .prism-math-error')).toContainText('\\prismUnknownCommand{a}');
  await expect(page.locator('.markdown-body .katex')).toHaveCount(0);
  await mode('Live').click();
  await editor().locator('.cm-line').filter({ hasText: 'Invalid $\\prismUnknownCommand{a}$.' }).click();
  await editor().press('Home');
  await editor().press('Shift+End');
  await page.keyboard.insertText('Valid $x^2$.');
  await editor().press('ControlOrMeta+Home');
  await expect(formula('x^2')).toBeVisible();
  await saveAndExpect('Welcome to Prism.md', invalid.replace('Invalid $\\prismUnknownCommand{a}$.', 'Valid $x^2$.'));
  await mode('Read').click();
  await expect(page.locator('.markdown-body .katex')).toHaveCount(1);
  await expect(page.locator('.markdown-body .prism-math-error')).toHaveCount(0);

  const quoted = '# Recovery\n\n> $$\n> \\frac{x^2}{2}\n> $$\n\nAfter equations.';
  await mode('Live').click();
  await replaceDocument(quoted);
  await expect(formula('\\frac{x^2}{2}')).toBeVisible();
  await expect(editor().locator('.katex annotation')).toHaveText('\\frac{x^2}{2}');
  await formula('\\frac{x^2}{2}').click();
  await expect(editor()).toContainText('> \\frac{x^2}{2}');
  await editor().press('Home');
  await editor().press('Shift+End');
  await page.keyboard.insertText('> \\frac{x^3}{2}');
  await editor().press('ControlOrMeta+Home');
  await expect(formula('\\frac{x^3}{2}')).toBeVisible();
  await saveAndExpect('Welcome to Prism.md', quoted.replace('x^2', 'x^3'));
  await mode('Read').click();
  await expect(page.locator('.markdown-body blockquote .katex annotation')).toHaveText('\\frac{x^3}{2}');
  expect(pageErrors).toEqual([]);
  await expect(page.locator('.message-banner.error')).toHaveCount(0);
});
