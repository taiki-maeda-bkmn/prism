import { electronLaunchArguments } from '../../scripts/electron-launch.mjs';
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const paragraph = 'Editing paragraph 日本語。';
const sections = Array.from({ length: 24 }, (_, index) => `## Calculation ${index + 1}\n\n`
  + `確率を考える段落です。Inline $x_{${index + 1}}^2+1$ stays unchanged while another paragraph is edited.\n\n`
  + `$$\n\\begin{aligned}\\mathbb{E}[X_{${index + 1}}]&=\\frac{1}{2}\\\\\\operatorname{Var}(X_{${index + 1}})&=\\frac{1}{4}\\end{aligned}\n$$\n\n`).join('');
const initial = `# Performance practice\n\n${paragraph}\n\n${sections}`
  + '<h2 id="legacy-heading">HTML outline section</h2>\n\n## Target section\n\n最後の段落。\n';
const diskText = (content: string) => '\ufeff' + content.replace(/\n/g, '\r\n');

let temporary: string;
let notebook: string;
let desktop: ElectronApplication | undefined;
let page: Page;
let pageErrors: string[];

const mode = (name: string) => page.getByRole('group', { name: 'Editor mode', exact: true }).getByRole('button', { name, exact: true });
const outline = () => page.getByRole('navigation', { name: 'Note outline', exact: true });

interface MarkdownProbe {
  previewFormulas: number;
  liveFormulas: number;
  restore: () => void;
}
type ProbeWindow = Window & { __prismMarkdownProbe?: MarkdownProbe };

async function installMathProbe() {
  await page.evaluate(() => {
    const host = window as ProbeWindow;
    host.__prismMarkdownProbe?.restore();
    const descriptor = Object.getOwnPropertyDescriptor(Element.prototype, 'innerHTML')!;
    const probe: MarkdownProbe = {
      previewFormulas: 0,
      liveFormulas: 0,
      restore: () => Object.defineProperty(Element.prototype, 'innerHTML', descriptor),
    };
    host.__prismMarkdownProbe = probe;
    Object.defineProperty(Element.prototype, 'innerHTML', {
      ...descriptor,
      set(this: Element, html: string) {
        if (typeof html === 'string' && html.includes('class="katex"')) {
          // The detached reading renderer and visible CodeMirror widgets both
          // assign KaTeX HTML. Count them separately: scrolling can legitimately
          // create Live widgets, but must not typeset a discarded full preview.
          if (this.classList.contains('prism-math-inline') || this.classList.contains('prism-math-display')) probe.previewFormulas++;
          if (this.classList.contains('cm-live-math')) probe.liveFormulas++;
        }
        descriptor.set!.call(this, html);
      },
    });
  });
}

async function previewFormulaCount() {
  return page.evaluate(() => (window as ProbeWindow).__prismMarkdownProbe!.previewFormulas);
}

async function saveAndExpect(content: string) {
  await page.keyboard.press('ControlOrMeta+s');
  await expect(page.locator('.statusbar')).toContainText('All changes saved');
  await expect.poll(async () => {
    try { return await readFile(path.join(notebook, 'Welcome to Prism.md'), 'utf8'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
  }).toBe(diskText(content));
}

test.beforeEach(async () => {
  temporary = await mkdtemp(path.join(os.tmpdir(), 'prism-markdown-performance-test-'));
  notebook = path.join(temporary, 'Notebook');
  const userData = path.join(temporary, 'profile');
  const pdfUserData = path.join(temporary, 'pdf-profile');
  await Promise.all([mkdir(notebook), mkdir(userData), mkdir(pdfUserData)]);
  await writeFile(path.join(notebook, 'Welcome to Prism.md'), diskText(initial));
  desktop = await electron.launch({
    args: electronLaunchArguments(['--no-sandbox', '.']), cwd: process.cwd(),
    env: { ...process.env, PRISM_USER_DATA: userData, PRISM_WORKSPACE: notebook, PRISM_PDF_USER_DATA: pdfUserData },
  });
  page = await desktop.firstWindow();
  pageErrors = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  await expect(page.locator('.note-heading h1')).toHaveText('Performance practice');
  await expect.poll(() => desktop!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible())).toBe(true);
});

test.afterEach(async ({}, testInfo) => {
  if (page && !page.isClosed()) {
    if (testInfo.status !== testInfo.expectedStatus) {
      const screenshot = await page.screenshot().catch(() => undefined);
      if (screenshot) await testInfo.attach('Markdown performance regression', { body: screenshot, contentType: 'image/png' });
    }
    await page.evaluate(() => (window as ProbeWindow).__prismMarkdownProbe?.restore()).catch(() => undefined);
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

for (const editingMode of ['Source', 'Live'] as const) {
  test(`${editingMode} typing avoids discarded math previews while keeping outline, preview, undo, and saves current`, async () => {
    await mode(editingMode).click();
    const editor = page.getByLabel(editingMode === 'Live' ? 'Live Markdown editor' : 'Markdown source', { exact: true });
    await expect(editor).toBeVisible();
    await expect(outline().getByRole('button', { name: 'Performance practice', exact: true })).toBeVisible();
    await expect(outline().getByRole('button', { name: 'HTML outline section', exact: true })).toHaveCount(editingMode === 'Source' ? 1 : 0);
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    await installMathProbe();

    await editor.locator('.cm-line').filter({ hasText: paragraph }).click();
    await editor.press('End');
    // Unicode insertion checks editor/save behavior; it does not claim to
    // automate an operating system's IME candidate window.
    await page.keyboard.insertText(' 追記テスト。');
    await page.keyboard.type(' abc');
    const editedParagraph = `${paragraph} 追記テスト。 abc`;
    await expect(editor).toContainText(editedParagraph);
    await editor.press('ControlOrMeta+Home');
    await editor.press('End');
    await page.keyboard.insertText(' updated');
    // The outline uses deferred document metadata. Observing the newest heading
    // ensures that work has finished before checking structural work counts.
    await expect(outline().getByRole('button', { name: 'Performance practice updated', exact: true })).toBeVisible();
    expect(await previewFormulaCount()).toBe(0);
    await expect(page.locator('.markdown-body')).toHaveCount(0);

    const proseEdited = initial.replace(paragraph, editedParagraph);
    const edited = proseEdited.replace('# Performance practice', '# Performance practice updated');
    await saveAndExpect(edited);

    await outline().getByRole('button', { name: editingMode === 'Source' ? 'HTML outline section' : 'Target section', exact: true }).click();
    if (editingMode === 'Live') {
      await expect(editor.locator('.cm-live-heading-2').filter({ hasText: 'Target section' })).toBeInViewport();
      await mode('Split').click();
    } else {
      await expect(mode('Split')).toHaveAttribute('aria-pressed', 'true');
      await expect(page.locator('.markdown-body h2').filter({ hasText: /^HTML outline section$/ })).toBeInViewport();
    }
    const preview = page.locator('.markdown-body');
    await expect(preview.locator('.katex')).toHaveCount(48);
    await expect(preview).toContainText(editedParagraph);
    await expect(preview.locator('h1')).toHaveText('Performance practice updated');
    // Positive control: the same probe observes actual full-preview work when
    // Split needs it, so zero above cannot pass because instrumentation failed.
    expect(await previewFormulaCount()).toBeGreaterThan(0);

    await mode('Read').click();
    await outline().getByRole('button', { name: 'Target section', exact: true }).click();
    await expect(preview.locator('h2').filter({ hasText: /^Target section$/ })).toBeInViewport();
    await mode('Source').click();
    const source = page.getByLabel('Markdown source', { exact: true });
    await source.focus();
    await source.press('ControlOrMeta+z');
    await expect(page.locator('.note-heading h1')).toHaveText('Performance practice');
    await expect(outline().getByRole('button', { name: 'Performance practice', exact: true })).toBeVisible();
    await saveAndExpect(proseEdited);
    expect(pageErrors).toEqual([]);
    await expect(page.locator('.message-banner.error')).toHaveCount(0);
  });
}
