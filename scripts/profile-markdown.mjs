import { _electron as electron, expect } from '@playwright/test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { electronLaunchArguments } from './electron-launch.mjs';

// Opt in after npm run build. Uses only synthetic notes and disposable profiles.
// node scripts/profile-markdown.mjs --output=/tmp/prism-markdown-profile-before
const root = fileURLToPath(new URL('..', import.meta.url));
const output = path.resolve(process.argv.find(value => value.startsWith('--output='))?.slice(9)
  ?? path.join(os.tmpdir(), `prism-markdown-profile-${Date.now()}`));
const temporary = await mkdtemp(path.join(os.tmpdir(), 'prism-markdown-profile-data-'));
const notebook = path.join(temporary, 'notebook'), profile = path.join(temporary, 'notes-profile');
const pdfProfile = path.join(temporary, 'pdf-profile');
const notePath = path.join(notebook, 'Profile.md');
const initial = '# Markdown performance\n\n' + Array.from({ length: 50 }, (_, index) => [
  `## Exercise ${index + 1}`, '',
  '自分の答案。確率変数の期待値と分散を求めます。計算の過程を確認し、結果を比較します。 ' +
    'This paragraph gives the equation context, with **important reasoning**, an inline $E[X] = \\mu$ expression, and a [[Related]] note link.',
  '', '$$', '\\begin{aligned}',
  `\\mathbb{E}[X_${index + 1}] &= \\int_{0}^{1} x^{2}(1-x)\\,dx = \\frac{1}{12} \\\\`,
  '\\operatorname{Var}(X) &= \\mathbb{E}[X^2] - \\mathbb{E}[X]^2',
  '\\end{aligned}', '$$', '',
].join('\n')).join('\n') + '\nTyping target: ';
const inserted = 'A thought becomes clearer when it is written down. Continue the calculation carefully. ';
const pacedInserted = 'Paced input keeps the calculation clear. ';
let expected = initial;
const report = { startedAt: new Date().toISOString(), output, phases: [], errors: [],
  fixture: { bytes: Buffer.byteLength(initial), characters: initial.length, lines: initial.split('\n').length, displayEquations: 50 },
  caveats: ['Synthetic Japanese/math-heavy note; does not read or modify user notebooks.',
    'Keyboard-to-frame times begin in the renderer keydown listener, excluding OS input delivery.',
    'requestAnimationFrame measures callback readiness, not Windows compositor presentation.',
    'Phase wall times include automation round trips; CPU sampling adds overhead.',
    'DOM mutation counts measure changed nodes; math assignment counts include detached rendering wrappers.',
    'Math assignments count successful rendered formula wrapper writes, not every attempted KaTeX call.'] };
let desktop, child, page, client, cpuStarted = false, electronStderr = '';
const pause = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const mode = name => page.getByRole('group', { name: 'Editor mode', exact: true }).getByRole('button', { name, exact: true });
const editor = () => page.locator('.source-pane .cm-content');

async function installProbe() {
  await page.evaluate(() => {
    let current = null, lastFrame = performance.now();
    const innerHTML = Object.getOwnPropertyDescriptor(Element.prototype, 'innerHTML');
    Object.defineProperty(Element.prototype, 'innerHTML', {
      ...innerHTML,
      set(value) {
        // Markdown builds preview formulas in a detached fragment. A DOM
        // MutationObserver cannot see that work, but the native setter can.
        if (current) {
          if (this.classList.contains('prism-math-inline') || this.classList.contains('prism-math-display')) {
            current.previewMathAssignments++;
            current.mathAssignments++;
          } else if (this.classList.contains('cm-live-math')) {
            current.liveMathAssignments++;
            current.mathAssignments++;
          }
        }
        innerHTML.set.call(this, value);
      },
    });
    const summary = values => {
      const sorted = [...values].sort((a, b) => a - b);
      return { count: sorted.length, totalMs: sorted.reduce((sum, value) => sum + value, 0),
        p50Ms: sorted[Math.max(0, Math.ceil(sorted.length * .5) - 1)] ?? 0,
        p95Ms: sorted[Math.max(0, Math.ceil(sorted.length * .95) - 1)] ?? 0,
        maxMs: Math.max(0, ...sorted) };
    };
    const longtasks = new PerformanceObserver(list => {
      if (current) for (const entry of list.getEntries()) {
        if (entry.startTime >= current.start) current.longtasks.push(entry.duration);
      }
    });
    longtasks.observe({ type: 'longtask', buffered: false });
    const mutations = new MutationObserver(records => {
      if (!current) return;
      for (const record of records) {
        current.mutations++;
        current.addedNodes += record.addedNodes.length;
        current.removedNodes += record.removedNodes.length;
      }
    });
    mutations.observe(document.querySelector('.source-pane'), { subtree: true, childList: true, characterData: true });
    document.addEventListener('keydown', event => {
      if (!current || !event.target.closest?.('.cm-content')) return;
      const phase = current, start = performance.now();
      phase.keys++;
      requestAnimationFrame(() => {
        if (current === phase) phase.keyToFrame.push(performance.now() - start);
      });
    }, true);
    const tick = now => {
      if (current) current.frames.push(now - lastFrame);
      lastFrame = now; requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
    window.__prismMarkdownProfile = {
      begin(name) {
        lastFrame = performance.now();
        current = { name, start: lastFrame, keys: 0, keyToFrame: [], frames: [], longtasks: [],
          mutations: 0, addedNodes: 0, removedNodes: 0,
          previewMathAssignments: 0, liveMathAssignments: 0, mathAssignments: 0 };
      },
      end() {
        const value = current; current = null;
        return { name: value.name, wallMs: performance.now() - value.start, keys: value.keys,
          keyToFrame: summary(value.keyToFrame), frames: summary(value.frames), longTasks: summary(value.longtasks),
          domMutations: value.mutations, addedNodes: value.addedNodes, removedNodes: value.removedNodes,
          previewMathAssignments: value.previewMathAssignments, liveMathAssignments: value.liveMathAssignments,
          mathAssignments: value.mathAssignments };
      },
    };
  });
}

async function phase(name, action) {
  await page.evaluate(name => window.__prismMarkdownProfile.begin(name), name);
  try { await action(); await pause(150); }
  finally {
    const result = await page.evaluate(() => window.__prismMarkdownProfile.end());
    report.phases.push(result);
    console.log(`${name}: ${Math.round(result.wallMs)}ms; key-to-frame p95 ${result.keyToFrame.p95Ms.toFixed(1)}ms; ${result.longTasks.count} long tasks; ${result.previewMathAssignments} preview / ${result.liveMathAssignments} Live math assignments`);
  }
}

async function saveAndVerify() {
  await page.keyboard.press('ControlOrMeta+s');
  await expect.poll(async () => {
    try { return await readFile(notePath, 'utf8'); }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  }, { timeout: 30000 }).toBe(expected);
}

try {
  await mkdir(output, { recursive: true }); await mkdir(notebook);
  await writeFile(notePath, initial);
  await writeFile(path.join(notebook, 'Related.md'), '# Related\n\nA link back to [[Profile]].\n');
  const args = electronLaunchArguments(['--no-sandbox', '.']);
  desktop = await electron.launch({ args, cwd: root,
    env: { ...process.env, PRISM_USER_DATA: profile, PRISM_WORKSPACE: notebook, PRISM_PDF_USER_DATA: pdfProfile } });
  child = desktop.process();
  child.stderr?.on('data', bytes => { if (electronStderr.length < 2_000_000) electronStderr += String(bytes); });
  page = await desktop.firstWindow(); page.setDefaultTimeout(30000);
  page.on('pageerror', error => report.errors.push(error.message));
  await expect(page.locator('.note-heading h1')).toHaveText('Markdown performance');
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.evaluate(() => document.fonts.ready);
  report.environment = { args, platform: process.platform, display: process.env.DISPLAY, wayland: process.env.WAYLAND_DISPLAY,
    ...await page.evaluate(() => ({ viewport: { width: innerWidth, height: innerHeight }, dpr: devicePixelRatio, userAgent: navigator.userAgent })) };
  await installProbe(); client = await page.context().newCDPSession(page);
  await client.send('Profiler.enable'); await client.send('Profiler.start'); cpuStarted = true;
  for (const name of ['Source', 'Live']) {
    await mode(name).click(); await editor().focus(); await page.keyboard.press('ControlOrMeta+End'); await pause(400);
    await phase(`${name}-typing`, async () => { await page.keyboard.type(inserted); });
    expected += inserted; await saveAndVerify();
    await editor().focus(); await page.keyboard.press('ControlOrMeta+End'); await pause(150);
    await phase(`${name}-paced-typing`, async () => { await page.keyboard.type(pacedInserted, { delay: 25 }); });
    expected += pacedInserted; await saveAndVerify();
    await editor().focus();
    await phase(`${name}-selection`, async () => {
      for (let index = 0; index < 24; index++) await page.keyboard.press('ArrowLeft');
    });
    await page.keyboard.press('ControlOrMeta+Home'); await pause(300);
    const bounds = await page.locator('.cm-scroller').boundingBox();
    await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
    await phase(`${name}-scroll`, async () => {
      for (let step = 0; step < 12; step++) { await page.mouse.wheel(0, 180); await pause(35); }
    });
    // No selection or scroll gesture is allowed to mutate the saved text.
    await expect(page.locator('.statusbar')).toContainText('All changes saved');
  }
  report.exactSavedContent = await readFile(notePath, 'utf8') === expected;
} catch (error) {
  report.failure = error.stack ?? String(error); process.exitCode = 1;
} finally {
  if (cpuStarted) try {
    const { profile: cpu } = await client.send('Profiler.stop');
    await writeFile(path.join(output, 'renderer.cpuprofile'), JSON.stringify(cpu));
    const times = new Map();
    cpu.samples?.forEach((id, index) => times.set(id, (times.get(id) ?? 0) + (cpu.timeDeltas?.[index] ?? 0) / 1000));
    report.cpuTop = cpu.nodes.map(node => ({ function: node.callFrame.functionName, url: node.callFrame.url,
      line: node.callFrame.lineNumber + 1, selfMs: times.get(node.id) ?? 0 })).sort((a, b) => b.selfMs - a.selfMs).slice(0, 35);
  } catch (error) { report.errors.push(`CPU profile: ${error.message}`); }
  if (desktop) {
    const closed = desktop.waitForEvent('close', { timeout: 5000 }).catch(() => {});
    await desktop.evaluate(({ app }) => app.exit(0)).catch(() => {}); await closed;
    if (child?.exitCode === null) child.kill();
  }
  await rm(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  await mkdir(output, { recursive: true });
  await writeFile(path.join(output, 'electron-stderr.log'), electronStderr);
  await writeFile(path.join(output, 'summary.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(`Profile saved to ${output}`);
  if (report.failure) console.error(report.failure);
}
