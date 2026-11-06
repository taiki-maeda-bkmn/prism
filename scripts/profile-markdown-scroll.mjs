import { _electron as electron, expect } from '@playwright/test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { electronLaunchArguments } from './electron-launch.mjs';

// Opt in against an existing build. No user notebook/profile is opened.
// node scripts/profile-markdown-scroll.mjs --mode=Live --output=/tmp/prism-scroll-before
// Optional: --input=raf --transparent --cycles=2 --step=600 --maximize
// --note=/path copies that note into the disposable notebook without altering it.
// --width=1440 --height=1000 sets renderer dimensions unless --maximize is used.
const root = fileURLToPath(new URL('..', import.meta.url));
const option = name => process.argv.find(value => value.startsWith(`--${name}=`))?.slice(name.length + 3);
const modes = (option('mode') ?? 'Source,Live,Read').split(',');
const input = option('input') ?? 'wheel';
const cycles = Number(option('cycles') ?? 2), step = Number(option('step') ?? 600);
const transparent = process.argv.includes('--transparent');
const maximize = process.argv.includes('--maximize') || process.argv.includes('--maximized');
const width = Number(option('width') ?? 1440), height = Number(option('height') ?? 1000);
if (modes.some(mode => !['Source', 'Live', 'Read'].includes(mode)) || !['wheel', 'raf'].includes(input)
  || !Number.isInteger(cycles) || cycles < 1 || cycles > 5 || !Number.isFinite(step) || step < 20 || step > 2000
  || !Number.isInteger(width) || !Number.isInteger(height) || width < 300 || height < 300 || width > 16384 || height > 16384) {
  throw new Error('Use --mode=Source,Live,Read --input=wheel|raf --cycles=1..5 --step=20..2000 --width/height=300..16384');
}
const output = path.resolve(option('output') ?? path.join(os.tmpdir(), `prism-scroll-profile-${Date.now()}`));
const generated = '# Scrolling performance\n\n' + Array.from({ length: 40 }, (_, index) => [
  `## Calculation ${index + 1}`, '',
  '自分の答案。確率変数の期待値と分散を求めます。計算の過程を確認し、結果を比較します。 '.repeat(2)
    + 'The explanation includes **important reasoning**, $E[X] = \\mu$, and a [[Related|related note]].',
  '', '$$', '\\begin{aligned}',
  `\\mathbb{E}[X_${index + 1}] &= \\int_{0}^{1} x^{2}(1-x)\\,dx = \\frac{1}{12} \\\\`,
  '\\operatorname{Var}(X) &= \\mathbb{E}[X^2] - \\mathbb{E}[X]^2',
  '\\end{aligned}', '$$', '',
  '| 条件 | 期待値 | 分散 |', '| :--- | ---: | ---: |',
  `| Case ${index + 1} | $\\frac{1}{2}$ | $\\frac{1}{4}$ |`,
  '| 比較する場合 | **定数** | [説明](Related.md) |', '',
  '- [x] Check the formula\n- [ ] Compare with the previous result', '',
].join('\n')).join('\n') + '\nEnd of scrolling fixture.\n';
const initial = option('note') ? await readFile(path.resolve(option('note')), 'utf8') : generated;
const temporary = await mkdtemp(path.join(os.tmpdir(), 'prism-scroll-data-'));
const notebook = path.join(temporary, 'notebook'), profile = path.join(temporary, 'profile');
const notePath = path.join(notebook, 'Profile.md');
const pause = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const report = {
  startedAt: new Date().toISOString(), output, input, cycles, step, transparent, phases: [], errors: [],
  fixture: { copiedNote: Boolean(option('note')), bytes: Buffer.byteLength(initial), lines: initial.split('\n').length,
    ...(option('note') ? {} : { displayEquations: 40, tables: 40 }) },
  caveats: ['A synthetic or explicitly selected copied note runs in disposable profiles. Original files/preferences are never changed.',
    'Wheel input is Chromium automation, not the physical Windows pointer/input route.',
    'Animation-frame intervals measure renderer scheduling, not Windows compositor presentation.',
    'CPU sampling, probes, and automation add overhead. Compare the same settings and backend.',
    'Scroll height changes/reversals are observations, not automatically proof of a rendering defect.',
    'Renderer duration metrics use CDP seconds; frame/long-task distributions use milliseconds.',
    'Math counters record successful HTML assignments; table counters record rendered table template writes.'],
};
let desktop, child, page, client, cpuStarted = false, electronStderr = '';

async function installProbe() {
  await page.evaluate(() => {
    let phase = null, scroller = null, lastFrame = null;
    const nativeHTML = Object.getOwnPropertyDescriptor(Element.prototype, 'innerHTML');
    Object.defineProperty(Element.prototype, 'innerHTML', { ...nativeHTML, set(value) {
      if (phase && typeof value === 'string') {
        if (this.classList.contains('cm-live-math')) phase.liveMathAssignments++;
        if (this.classList.contains('prism-math-inline') || this.classList.contains('prism-math-display')) phase.previewMathAssignments++;
        if (this.tagName === 'TEMPLATE' && value.includes('<table')) phase.tableTemplateAssignments++;
      }
      nativeHTML.set.call(this, value);
    } });
    const observer = new MutationObserver(records => {
      if (!phase) return;
      for (const record of records) {
        phase.mutations++; phase.addedNodes += record.addedNodes.length; phase.removedNodes += record.removedNodes.length;
      }
    });
    observer.observe(document.querySelector('.editor-layout'), { subtree: true, childList: true, characterData: true });
    new PerformanceObserver(list => {
      if (phase) for (const entry of list.getEntries()) if (entry.startTime >= phase.started) phase.longtasks.push(entry.duration);
    }).observe({ type: 'longtask', buffered: false });
    const distribution = values => {
      const sorted = [...values].sort((a, b) => a - b);
      return { count: sorted.length, p50Ms: sorted[Math.max(0, Math.ceil(sorted.length * .5) - 1)] ?? 0,
        p95Ms: sorted[Math.max(0, Math.ceil(sorted.length * .95) - 1)] ?? 0, maxMs: Math.max(0, ...sorted),
        over33ms: sorted.filter(value => value > 33).length, over50ms: sorted.filter(value => value > 50).length };
    };
    const position = () => ({ top: scroller.scrollTop, height: scroller.scrollHeight, viewport: scroller.clientHeight });
    function tick(time) {
      if (phase) {
        if (lastFrame !== null) phase.frames.push(time - lastFrame);
        const sample = { timeMs: performance.now() - phase.started, ...position() };
        const previous = phase.samples.at(-1);
        if (previous) {
          const delta = sample.top - previous.top;
          if (delta * phase.direction < -2) phase.reverseFrames++;
          phase.maxHeightChange = Math.max(phase.maxHeightChange, Math.abs(sample.height - previous.height));
        }
        phase.samples.push(sample);
      }
      lastFrame = time; requestAnimationFrame(tick);
    }
    requestAnimationFrame(tick);
    window.__prismScrollProfile = {
      begin(name, selector, direction) {
        scroller = document.querySelector(selector); lastFrame = null;
        phase = { name, direction, started: performance.now(), initial: position(),
          documentState: { visibility: document.visibilityState, focused: document.hasFocus() }, frames: [], samples: [], longtasks: [],
          mutations: 0, addedNodes: 0, removedNodes: 0, liveMathAssignments: 0, previewMathAssignments: 0,
          tableTemplateAssignments: 0, reverseFrames: 0, maxHeightChange: 0, afterInput: null };
      },
      afterInput() { phase.afterInput = position(); },
      end() {
        const value = phase; phase = null;
        return { ...value, wallMs: performance.now() - value.started, final: position(),
          finalDocumentState: { visibility: document.visibilityState, focused: document.hasFocus() },
          settlingDelta: scroller.scrollTop - value.afterInput.top, frames: distribution(value.frames),
          longtasks: distribution(value.longtasks) };
      },
    };
  });
}

async function metrics() {
  const { metrics } = await client.send('Performance.getMetrics');
  return Object.fromEntries(metrics.map(({ name, value }) => [name, value]));
}

async function assertFixtureActive() {
  // Workspace loading may skip unsupported/unreadable notes and select the
  // small Related.md fallback. Never report that as a profile of this fixture.
  await expect(page.locator('.note-item[title="Profile.md"]'), 'The copied Profile.md fixture must be loaded and selected')
    .toHaveAttribute('aria-current', 'page');
}

async function traverse(name, selector, direction) {
  await assertFixtureActive();
  const before = await metrics();
  await page.evaluate(({ name, selector, direction }) => window.__prismScrollProfile.begin(name, selector, direction), { name, selector, direction });
  const scroller = page.locator(selector);
  let steps = 0, reachedEnd = false, timedOut = false;
  if (input === 'wheel') {
    const box = await scroller.boundingBox();
    await page.mouse.move(box.x + box.width * .55, box.y + box.height * .5);
    for (; steps < 400; steps++) {
      await page.mouse.wheel(0, direction * step); await pause(16);
      reachedEnd = await scroller.evaluate((element, direction) => direction > 0
        ? element.scrollTop >= element.scrollHeight - element.clientHeight - 2 : element.scrollTop <= 2, direction);
      if (reachedEnd) break;
    }
  } else {
    ({ steps, reachedEnd, timedOut } = await scroller.evaluate((element, { direction, step }) => new Promise(resolve => {
      let steps = 0, frame, finished = false;
      const finish = (reachedEnd, timedOut = false) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        cancelAnimationFrame(frame);
        resolve({ steps, reachedEnd, timedOut });
      };
      // A minimized diagnostic window can suspend animation frames. Timers
      // still give the traversal an independent deadline and permit cleanup.
      const timer = setTimeout(() => finish(false, true), 60_000);
      const next = () => {
        if (finished) return;
        element.scrollTop += direction * step; steps++;
        const reachedEnd = direction > 0 ? element.scrollTop >= element.scrollHeight - element.clientHeight - 2 : element.scrollTop <= 2;
        if (reachedEnd || steps >= 400) finish(reachedEnd);
        else frame = requestAnimationFrame(next);
      };
      frame = requestAnimationFrame(next);
    }), { direction, step }));
  }
  await page.evaluate(() => window.__prismScrollProfile.afterInput());
  await pause(300);
  const result = await page.evaluate(() => window.__prismScrollProfile.end());
  const after = await metrics();
  result.steps = input === 'wheel' ? Math.min(400, steps + 1) : steps; result.reachedEnd = reachedEnd;
  result.timedOut = timedOut;
  result.renderer = Object.fromEntries(['LayoutDuration', 'RecalcStyleDuration', 'ScriptDuration', 'TaskDuration', 'LayoutCount', 'RecalcStyleCount']
    .map(key => [key, (after[key] ?? 0) - (before[key] ?? 0)]));
  report.phases.push(result);
  await assertFixtureActive();
  console.log(`${name}: ${Math.round(result.wallMs)}ms; frame p95 ${result.frames.p95Ms.toFixed(1)}ms, max ${result.frames.maxMs.toFixed(1)}ms; `
    + `${result.liveMathAssignments} Live formulas, ${result.tableTemplateAssignments} tables; ${result.reverseFrames} reverse frames; height Δ ${result.maxHeightChange}px`);
  if (!reachedEnd) throw new Error(`${name} did not reach the scroll endpoint ${timedOut ? 'within 60 seconds' : 'within 400 steps'}`);
}

try {
  await mkdir(output, { recursive: true }); await mkdir(notebook);
  await writeFile(notePath, initial); await writeFile(path.join(notebook, 'Related.md'), '# Related\n\n[[Profile]]\n');
  const args = electronLaunchArguments(['--no-sandbox', '.']);
  desktop = await electron.launch({ args, cwd: root, env: { ...process.env,
    PRISM_USER_DATA: profile, PRISM_WORKSPACE: notebook, PRISM_PDF_USER_DATA: path.join(temporary, 'pdf-profile') } });
  child = desktop.process();
  child.stderr?.on('data', bytes => { if (electronStderr.length < 2_000_000) electronStderr += String(bytes); });
  page = await desktop.firstWindow(); page.setDefaultTimeout(30000);
  page.on('pageerror', error => report.errors.push(error.message));
  await assertFixtureActive();
  await page.evaluate(transparent => localStorage.setItem('prism.preferences', JSON.stringify({ mode: 'source', transparent, opacity: 65 })), transparent);
  await page.reload(); await assertFixtureActive();
  if (maximize) {
    await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].maximize());
    await expect.poll(() => desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isMaximized())).toBe(true);
    await pause(300);
  } else await page.setViewportSize({ width, height });
  await page.evaluate(() => document.fonts.ready);
  report.environment = { args, display: process.env.DISPLAY, wayland: process.env.WAYLAND_DISPLAY,
    ...await desktop.evaluate(({ app, BrowserWindow, screen }) => ({ gpu: app.getGPUFeatureStatus(),
      windowBounds: BrowserWindow.getAllWindows()[0].getBounds(), maximized: BrowserWindow.getAllWindows()[0].isMaximized(),
      displays: screen.getAllDisplays().map(display => ({ bounds: display.bounds, workArea: display.workArea, scaleFactor: display.scaleFactor })) })),
    ...await page.evaluate(() => ({ viewport: { width: innerWidth, height: innerHeight }, dpr: devicePixelRatio, userAgent: navigator.userAgent,
      visibility: document.visibilityState, focused: document.hasFocus() })) };
  client = await page.context().newCDPSession(page);
  await client.send('Performance.enable'); await client.send('Profiler.enable'); await client.send('Profiler.start'); cpuStarted = true;
  await installProbe();
  for (const name of modes) {
    await page.getByRole('group', { name: 'Editor mode', exact: true }).getByRole('button', { name, exact: true }).click();
    const selector = name === 'Read' ? '.markdown-body' : '.cm-scroller';
    await page.locator(selector).evaluate(element => { element.scrollTop = 0; }); await pause(400);
    for (let cycle = 1; cycle <= cycles; cycle++) {
      await traverse(`${name}-${cycle}-down`, selector, 1);
      await traverse(`${name}-${cycle}-up`, selector, -1);
    }
    await expect(page.locator('.statusbar')).toContainText('All changes saved');
  }
  report.exactSavedContent = await readFile(notePath, 'utf8') === initial;
  if (!report.exactSavedContent) throw new Error('Scrolling changed the saved note');
} catch (error) { report.failure = error.stack ?? String(error); process.exitCode = 1; }
finally {
  if (cpuStarted) try {
    const { profile: cpu } = await client.send('Profiler.stop');
    await writeFile(path.join(output, 'renderer.cpuprofile'), JSON.stringify(cpu));
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
  console.log(`Scroll profile saved to ${output}`);
  if (report.failure) console.error(report.failure);
}
