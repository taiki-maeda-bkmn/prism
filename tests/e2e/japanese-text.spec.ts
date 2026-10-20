import { electronLaunchArguments } from '../../scripts/electron-launch.mjs';
import { _electron as electron, expect, test, type CDPSession, type ElectronApplication, type Locator, type Page } from '@playwright/test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const title = '日本語のノート';
const paragraph = '漢字とひらがな、カタカナを読み書きします。髙﨑、𠮷。';
const paragraphGlyphs = Array.from(paragraph).length;
const editable = '編集する場所です。';
const initial = `# ${title}\n\n${paragraph}\n\n**大切な考え**\n\n\`\`\`js\nconst 言葉 = "こんにちは";\n\`\`\`\n\n$\\text{日本語}$\n\n[[つながる考え]]\n\n${editable}\n`;
let temporary: string;
let notebook: string;
let desktop: ElectronApplication | undefined;
let page: Page;
let cdp: CDPSession;
let probeNumber = 0;

const mode = (name: string) => page.getByRole('group', { name: 'Editor mode', exact: true }).getByRole('button', { name, exact: true });
const liveEditor = () => page.getByLabel('Live Markdown editor', { exact: true });

async function fontsReady() {
  await page.evaluate(async () => {
    await document.fonts.ready;
    // Let CodeMirror measure the final glyph widths before clicking a caret position.
    await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
  });
}

async function renderedFonts(locator: Locator) {
  const probe = String(++probeNumber);
  await locator.evaluate((element, id) => element.setAttribute('data-prism-font-probe', id), probe);
  try {
    const { root } = await cdp.send('DOM.getDocument');
    const { nodeId } = await cdp.send('DOM.querySelector', { nodeId: root.nodeId, selector: `[data-prism-font-probe="${probe}"]` });
    const { fonts } = await cdp.send('CSS.getPlatformFontsForNode', { nodeId });
    return fonts;
  } finally {
    await locator.evaluate(element => element.removeAttribute('data-prism-font-probe'));
  }
}

async function expectJapaneseGlyphs(locator: Locator, minimum: number) {
  await expect(locator).toBeVisible();
  await fontsReady();
  await expect.poll(async () => {
    // Checking CSS font-family or textContent alone also passes when every
    // Japanese character is a missing-glyph box. Inspect the actual glyph font.
    const fonts = await renderedFonts(locator);
    return fonts.filter(font => font.isCustomFont && /Noto Sans JP/.test(font.familyName))
      .reduce((count, font) => count + font.glyphCount, 0);
  }, { message: 'Japanese glyphs should come from the bundled Noto font' }).toBeGreaterThanOrEqual(minimum);
}

async function expectMonospacedCode(locator: Locator) {
  const widths = await locator.evaluate(element => {
    const style = getComputedStyle(element);
    const canvas = document.createElement('canvas');
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Canvas text measurement is unavailable.');
    context.font = `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
    context.fontKerning = 'none';
    return { narrow: context.measureText('iiiiiiii').width, wide: context.measureText('mmmmmmmm').width };
  });
  // A Japanese fallback must not replace the code font's Latin characters
  // with proportional glyphs. Compare real advances, not the CSS stack name.
  expect(widths.narrow).toBeGreaterThan(0);
  expect(widths.wide).toBeCloseTo(widths.narrow, 3);
}

async function insertAtJapaneseBoundary() {
  const line = liveEditor().locator('.cm-line').filter({ hasText: new RegExp(`^${editable}$`) });
  await line.scrollIntoViewIfNeeded();
  await fontsReady();
  const point = await line.evaluate(element => {
    const text = element.firstChild;
    if (!text || text.nodeType !== Node.TEXT_NODE) throw new Error('The Japanese editing line is missing its text.');
    const range = document.createRange();
    range.setStart(text, '編集する'.length);
    range.collapse(true);
    const box = range.getBoundingClientRect();
    return { x: box.x, y: box.y + box.height / 2 };
  });
  await page.mouse.click(point.x, point.y);
  await page.keyboard.insertText('大切な');
  await expect(liveEditor()).toContainText('編集する大切な場所です。');
}

test.beforeEach(async () => {
  temporary = await mkdtemp(path.join(os.tmpdir(), 'prism-japanese-text-test-'));
  notebook = path.join(temporary, '日本語のノートブック');
  const userData = path.join(temporary, 'profile');
  await Promise.all([mkdir(notebook), mkdir(userData)]);
  await Promise.all([
    writeFile(path.join(notebook, `${title}.md`), initial),
    writeFile(path.join(notebook, 'つながる考え.md'), `# つながる考え\n\n[[${title}]]\n`),
  ]);
  desktop = await electron.launch({
    args: electronLaunchArguments(['--no-sandbox', '.']), cwd: process.cwd(),
    env: { ...process.env, PRISM_USER_DATA: userData, PRISM_WORKSPACE: notebook },
  });
  page = await desktop.firstWindow();
  // firstWindow can arrive before loadFile finishes. Reloading that hidden,
  // still-loading window can interrupt the main process's startup show path.
  await expect(page.locator('.note-heading h1')).toBeVisible();
  await expect.poll(() => desktop!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible())).toBe(true);
  // Reload without network access so a remote font service cannot stand in
  // for Prism's bundled files. The glyph checks also reject system substitutes.
  await page.context().setOffline(true);
  await page.reload();
  await page.getByRole('navigation', { name: 'Notes', exact: true }).getByTitle(`${title}.md`, { exact: true }).click();
  await expect(page.locator('.note-heading h1')).toHaveText(title);
  await expect.poll(() => desktop!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible())).toBe(true);
  cdp = await page.context().newCDPSession(page);
  await cdp.send('DOM.enable');
  await cdp.send('CSS.enable');
});

test.afterEach(async ({}, testInfo) => {
  if (page && !page.isClosed() && testInfo.status !== testInfo.expectedStatus) {
    const screenshot = await page.screenshot().catch(() => undefined);
    if (screenshot) await testInfo.attach('Japanese text at failure', { body: screenshot, contentType: 'image/png' });
  }
  if (desktop) {
    // Close only the disposable process/profile created by this test.
    const child = desktop.process();
    const closed = desktop.waitForEvent('close', { timeout: 5_000 }).catch(() => undefined);
    await desktop.evaluate(({ app }) => app.exit(0)).catch(() => undefined);
    await closed;
    if (child.exitCode === null) child.kill();
    desktop = undefined;
  }
  if (temporary) await rm(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

test('renders bundled Japanese glyphs offline in every mode and theme, with accurate editing and saving', async ({}, testInfo) => {
  for (const theme of ['Prism', 'Paper', 'Sci-fi']) {
    await test.step(`${theme} Japanese text and caret positions`, async () => {
      await page.getByRole('button', { name: 'Window appearance', exact: true }).click();
      const appearance = page.getByRole('dialog', { name: 'Make a little space', exact: true });
      await appearance.getByRole('radio', { name: `${theme} theme`, exact: true }).check();
      await appearance.getByRole('button', { name: 'Done', exact: true }).click();
      await expectJapaneseGlyphs(page.locator('.note-heading h1'), title.length);
      await expectJapaneseGlyphs(page.getByRole('navigation', { name: 'Notes', exact: true }).getByTitle(`${title}.md`, { exact: true }).locator('span').first(), title.length);

      for (const name of ['Source', 'Split', 'Read', 'Live']) {
        await mode(name).click();
        if (name === 'Source' || name === 'Split') {
          const source = page.getByLabel('Markdown source', { exact: true });
          await expectJapaneseGlyphs(source.locator('.cm-line').filter({ hasText: paragraph }), paragraphGlyphs);
          const code = source.locator('.cm-line').filter({ hasText: 'const 言葉' });
          await expectJapaneseGlyphs(code, '言葉こんにちは'.length);
          await expectMonospacedCode(code);
        }
        if (name === 'Split' || name === 'Read') {
          const preview = page.locator('.markdown-body');
          await expectJapaneseGlyphs(preview.locator('h1'), title.length);
          await expectJapaneseGlyphs(preview.locator('p').filter({ hasText: paragraph }), paragraphGlyphs);
          await expectJapaneseGlyphs(preview.locator('strong'), '大切な考え'.length);
          await expectJapaneseGlyphs(preview.locator('pre code'), '言葉こんにちは'.length);
          await expectMonospacedCode(preview.locator('pre code'));
          await expectJapaneseGlyphs(preview.locator('.katex-html .cjk_fallback'), '日本語'.length);
        }
        if (name === 'Live') {
          await expectJapaneseGlyphs(liveEditor().locator('.cm-live-heading-1'), title.length);
          await expectJapaneseGlyphs(liveEditor().locator('.cm-line').filter({ hasText: paragraph }), paragraphGlyphs);
          await expectJapaneseGlyphs(liveEditor().locator('.cm-live-strong'), '大切な考え'.length);
          const code = liveEditor().locator('.cm-live-codeblock').filter({ hasText: 'const 言葉' });
          await expectJapaneseGlyphs(code, '言葉こんにちは'.length);
          await expectMonospacedCode(code);
          const keyword = code.locator('span').filter({ hasText: /^const$/ }).first();
          await expect(keyword).toBeVisible();
          const latinFonts = (await renderedFonts(keyword)).filter(font => font.glyphCount > 0);
          expect(latinFonts.reduce((count, font) => count + font.glyphCount, 0)).toBe('const'.length);
          expect(latinFonts.every(font => !/Noto Sans JP/.test(font.familyName))).toBe(true);
          await expectJapaneseGlyphs(liveEditor().locator('.katex-html .cjk_fallback'), '日本語'.length);
        }
      }

      await insertAtJapaneseBoundary();
      await liveEditor().press('ControlOrMeta+z');
      await expect(liveEditor()).toContainText(editable);
      await expect(page.locator('.statusbar')).toContainText('All changes saved');
      expect(await readFile(path.join(notebook, `${title}.md`), 'utf8')).toBe(initial);
      await testInfo.attach(`${theme} Japanese text`, { body: await page.screenshot(), contentType: 'image/png' });

      await page.getByRole('button', { name: 'Graph view', exact: true }).click();
      await expectJapaneseGlyphs(page.locator('.graph-page .graph-node-label').filter({ hasText: new RegExp(`^${title}$`) }), title.length);
      await page.getByRole('button', { name: 'Back to note', exact: true }).click();
    });
  }

  const fonts = await page.evaluate(() => ({
    loaded: Array.from(document.fonts).filter(font => /Noto Sans JP/.test(font.family) && font.status === 'loaded').map(font => font.family),
    // Chromium omits some file: fonts from resource-timing entries. Inspect
    // their local sources in addition to the actual glyph usage checked above.
    resources: Array.from(document.styleSheets).flatMap(sheet => Array.from(sheet.cssRules))
      .filter((rule): rule is CSSFontFaceRule => rule instanceof CSSFontFaceRule && /Noto Sans JP/.test(rule.style.fontFamily))
      .flatMap(rule => Array.from(rule.style.getPropertyValue('src').matchAll(/url\(["']?([^"')]+)["']?\)/g), match => new URL(match[1], document.baseURI).href)),
  }));
  expect(fonts.loaded.length).toBeGreaterThan(0);
  expect(fonts.resources.length).toBeGreaterThan(0);
  expect(fonts.resources.every(url => new URL(url).protocol === 'file:')).toBe(true);
  await testInfo.attach('Loaded Japanese font files', { body: JSON.stringify(fonts, null, 2), contentType: 'application/json' });

  // Unicode input here verifies editing and exact UTF-8 publication. The
  // operating system's IME candidate window is not simulated by this test.
  await insertAtJapaneseBoundary();
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.locator('.statusbar')).toContainText('All changes saved');
  expect(await readFile(path.join(notebook, `${title}.md`), 'utf8')).toBe(initial.replace(editable, '編集する大切な場所です。'));
  await expect(page.locator('.message-banner.error')).toHaveCount(0);
});
