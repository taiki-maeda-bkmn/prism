import { _electron as electron, expect } from '@playwright/test';
import { build } from 'esbuild';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { electronLaunchArguments } from './electron-launch.mjs';

// Run against an existing build. All PDFs, notes, and app profiles are disposable.
// Example: node scripts/profile-pdf.mjs --output=/tmp/prism-pdf-profile-before
const root = fileURLToPath(new URL('..', import.meta.url));
const output = path.resolve(process.argv.find(value => value.startsWith('--output='))?.slice(9)
  ?? path.join(os.tmpdir(), `prism-pdf-profile-${Date.now()}`));
const temporary = await mkdtemp(path.join(os.tmpdir(), 'prism-pdf-profile-data-'));
const notebook = path.join(temporary, 'notebook'), profile = path.join(temporary, 'notes-profile');
const pdfProfile = path.join(temporary, 'pdf-profile');
const report = { startedAt: new Date().toISOString(), output, phases: [], errors: [],
  caveats: ['Synthetic PDFs; timings depend on host/display/GPU.',
    'CPU profile covers the renderer main thread, not PDF worker CPU.',
    'Canvas counters count first HTMLCanvasElement 2D contexts; OffscreenCanvas allocations are excluded.'] };
let desktop, page, client, cpuStarted = false;
let electronStderr = '';
const pause = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const pdf = () => page.locator('.pdf-workspace');
const workspace = name => page.getByRole('navigation', { name: 'Workspaces', exact: true }).getByRole('button', { name, exact: true });
const divider = () => page.getByRole('separator', { name: 'Resize note and PDF panes', exact: true });

async function seed() {
  const bundled = await build({ stdin: {
    contents: "export { performancePdf } from './tests/fixtures/pdf-performance.ts'; export { fixturePdf } from './tests/fixtures/pdf.ts';",
    resolveDir: root, loader: 'ts',
  }, bundle: true, write: false, platform: 'node', format: 'esm', target: 'node22' });
  const fixtures = await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].contents).toString('base64')}`);
  const sources = { Vector: fixtures.performancePdf('vector'), Scan: fixtures.performancePdf('scan'), Simple: fixtures.fixturePdf() };
  await mkdir(notebook); await mkdir(path.join(pdfProfile, 'library/documents'), { recursive: true });
  await writeFile(path.join(notebook, 'Profile.md'), '# PDF performance\n\nA temporary reading note.\n');
  const documents = [];
  for (let copy = 1; copy <= 4; copy++) for (const [kind, source] of Object.entries(sources)) {
    const bytes = Buffer.concat([source, Buffer.from(`\n% Profile variant ${copy}\n`)]), id = randomUUID();
    await writeFile(path.join(pdfProfile, 'library/documents', `${id}.pdf`), bytes);
    documents.push({ id, title: `${kind} ${copy}`, filename: `${kind}-${copy}.pdf`, size: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'), importedAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z', tags: [kind], favorite: false, lastOpenedAt: null,
      lastPage: 1, pageCount: null });
  }
  await writeFile(path.join(pdfProfile, 'library/catalog.json'), JSON.stringify({ version: 1, documents }));
  report.fixtures = documents.map(({ title, size }) => ({ title, size }));
}

async function installProbe() {
  await page.evaluate(() => {
    let current = null, lastFrame = performance.now();
    const seen = new WeakSet(), nativeContext = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (...args) {
      const result = nativeContext.apply(this, args);
      if (result && args[0] === '2d' && !seen.has(this)) {
        seen.add(this);
        if (current) { current.allocations++; current.canvasPixels += this.width * this.height; }
      }
      return result;
    };
    window.Worker = new Proxy(window.Worker, { construct(target, args, newTarget) {
      if (current) current.workers++;
      return Reflect.construct(target, args, newTarget);
    } });
    const longtasks = new PerformanceObserver(list => {
      if (current) for (const entry of list.getEntries()) {
        if (entry.startTime >= current.start) current.longtasks.push(entry.duration);
      }
    });
    longtasks.observe({ type: 'longtask', buffered: false });
    const publications = new MutationObserver(records => {
      if (!current) return;
      for (const record of records) if (record.target instanceof Element && record.target.matches('.pdf-paper')) {
        for (const node of record.addedNodes) if (node instanceof HTMLCanvasElement) current.publications++;
      }
    });
    publications.observe(document.documentElement, { subtree: true, childList: true });
    const tick = now => {
      if (current) current.frames.push(now - lastFrame);
      lastFrame = now; requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
    const sum = values => values.reduce((total, value) => total + value, 0);
    window.__prismProfile = {
      begin(name) {
        lastFrame = performance.now();
        current = { name, start: lastFrame, allocations: 0, canvasPixels: 0, workers: 0,
          publications: 0, longtasks: [], frames: [] };
      },
      end() {
        const value = current; current = null;
        const frames = value.frames.sort((a, b) => a - b), long = value.longtasks;
        return { name: value.name, wallMs: performance.now() - value.start,
          longTasks: long.length, longTaskTotalMs: sum(long), longTaskMaxMs: Math.max(0, ...long),
          rafFrames: frames.length, rafGapP95Ms: frames[Math.max(0, Math.ceil(frames.length * .95) - 1)] ?? 0,
          rafGapMaxMs: Math.max(0, ...frames), rafGapsOver34Ms: frames.filter(gap => gap > 34).length,
          canvasAllocations: value.allocations, canvasPixels: value.canvasPixels,
          workers: value.workers, pagePublications: value.publications };
      },
    };
  });
}

async function phase(name, action) {
  await page.evaluate(name => window.__prismProfile.begin(name), name);
  try { await action(); }
  finally {
    const result = await page.evaluate(() => window.__prismProfile.end());
    report.phases.push(result);
    console.log(`${name}: ${Math.round(result.wallMs)}ms; ${result.longTasks} long tasks; ${result.canvasAllocations} canvases; ${result.pagePublications} pages`);
  }
}
async function ready(number) {
  await expect(pdf().locator(`.pdf-paper canvas[data-page-number="${number}"]`)).toBeVisible({ timeout: 30000 });
  await expect(pdf().locator('.pdf-paper')).toHaveAttribute('aria-busy', 'false', { timeout: 30000 });
}
async function scroll(name) {
  const viewport = pdf().getByLabel('PDF page viewport', { exact: true });
  await viewport.evaluate(element => { element.scrollTop = Math.max(20, (element.scrollHeight - element.clientHeight) / 2); });
  const bounds = await viewport.boundingBox();
  await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
  await phase(name, async () => {
    for (let step = 0; step < 12; step++) { await page.mouse.wheel(0, step < 6 ? 18 : -18); await pause(35); }
    await pause(100);
  });
}
async function transparency(enabled) {
  await page.getByRole('button', { name: 'Window appearance', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Make a little space', exact: true });
  const toggle = dialog.getByRole('switch', { name: 'Transparent window', exact: true });
  if ((await toggle.getAttribute('aria-checked') === 'true') !== enabled) await toggle.click();
  if (enabled) await dialog.getByRole('slider', { name: 'Background opacity', exact: true }).fill('50');
  await dialog.getByRole('button', { name: 'Done', exact: true }).click();
  await pause(100);
}
async function resize(name, zoom) {
  await pdf().getByLabel('Page zoom', { exact: true }).selectOption(zoom);
  await pause(100); await ready(1);
  const bounds = await divider().boundingBox();
  await phase(name, async () => {
    await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + 140); await page.mouse.down();
    for (let step = 1; step <= 12; step++) {
      await page.mouse.move(bounds.x + bounds.width / 2 + step * 10, bounds.y + 140); await pause(42);
    }
    await page.mouse.up(); await pause(350); await ready(1);
  });
  await divider().press('Home'); await pause(350); await ready(1);
}

try {
  await mkdir(output, { recursive: true }); await seed();
  const args = electronLaunchArguments(['--no-sandbox', '.']);
  desktop = await electron.launch({ args, cwd: root,
    env: { ...process.env, PRISM_USER_DATA: profile, PRISM_WORKSPACE: notebook, PRISM_PDF_USER_DATA: pdfProfile } });
  desktop.process().stderr?.on('data', bytes => {
    if (electronStderr.length < 2_000_000) electronStderr += String(bytes);
  });
  page = await desktop.firstWindow(); page.setDefaultTimeout(30000);
  page.on('pageerror', error => report.errors.push(error.message));
  await expect(page.locator('.note-heading h1')).toHaveText('PDF performance');
  await page.setViewportSize({ width: 1440, height: 1000 });
  report.environment = { args, platform: process.platform, display: process.env.DISPLAY, wayland: process.env.WAYLAND_DISPLAY,
    ...await page.evaluate(() => ({ viewport: { width: innerWidth, height: innerHeight }, dpr: devicePixelRatio, userAgent: navigator.userAgent })) };
  report.gpu = await desktop.evaluate(async ({ app }) => {
    const result = { features: app.getGPUFeatureStatus() };
    try { result.basic = await app.getGPUInfo('basic'); }
    catch (error) { result.infoError = error.message; }
    return result;
  });
  await installProbe(); client = await page.context().newCDPSession(page);
  await client.send('Profiler.enable'); await client.send('Profiler.start'); cpuStarted = true;
  await phase('library-initial-thumbnails', async () => {
    await workspace('PDFs').click();
    await expect.poll(() => pdf().locator('.pdf-thumbnail-ready').count(), { timeout: 60000 }).toBeGreaterThanOrEqual(6);
    await pause(300);
  });
  for (const kind of ['Vector', 'Scan']) {
    await phase(`${kind}-open`, async () => {
      await pdf().getByRole('button', { name: `Open ${kind} 1`, exact: true }).click(); await ready(1);
    });
    for (const number of [2, 3, 2, 1]) await phase(`${kind}-page-${number}`, async () => {
      const current = Number(await pdf().getByLabel('Page number', { exact: true }).inputValue());
      await pdf().getByRole('button', { name: number > current ? 'Next page' : 'Previous page', exact: true }).click();
      await ready(number);
    });
    await page.getByRole('button', { name: 'Read & write', exact: true }).click(); await ready(1); await pause(350);
    await resize(`${kind}-resize-150-percent`, '1.5'); await resize(`${kind}-resize-fit`, 'fit');
    await pdf().getByLabel('Page zoom', { exact: true }).selectOption('1.5'); await pause(100); await ready(1);
    await transparency(false); await scroll(`${kind}-scroll-opaque`);
    await transparency(true); await scroll(`${kind}-scroll-transparent`); await transparency(false);
    await page.getByRole('button', { name: 'Read & write', exact: true }).click();
    await workspace('PDFs').click(); await pdf().getByRole('button', { name: 'Back to library', exact: true }).click();
    // Cached thumbnail copies should finish before timing the next document.
    await expect.poll(() => pdf().locator('.pdf-thumbnail-ready').count(), { timeout: 60000 }).toBeGreaterThanOrEqual(6);
    await pause(300);
  }
} catch (error) {
  report.failure = error.stack ?? String(error); process.exitCode = 1;
} finally {
  if (cpuStarted) try {
    const { profile: cpu } = await client.send('Profiler.stop');
    await writeFile(path.join(output, 'renderer.cpuprofile'), JSON.stringify(cpu));
    const times = new Map();
    cpu.samples?.forEach((id, index) => times.set(id, (times.get(id) ?? 0) + (cpu.timeDeltas?.[index] ?? 0) / 1000));
    report.cpuTop = cpu.nodes.map(node => ({ function: node.callFrame.functionName, url: node.callFrame.url,
      line: node.callFrame.lineNumber + 1, selfMs: times.get(node.id) ?? 0 })).sort((a, b) => b.selfMs - a.selfMs).slice(0, 25);
  } catch (error) { report.errors.push(`CPU profile: ${error.message}`); }
  if (desktop) {
    const child = desktop.process(), closed = desktop.waitForEvent('close', { timeout: 5000 }).catch(() => {});
    await desktop.evaluate(({ app }) => app.exit(0)).catch(() => {}); await closed;
    if (child.exitCode === null) child.kill();
  }
  await rm(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  await writeFile(path.join(output, 'electron-stderr.log'), electronStderr);
  await writeFile(path.join(output, 'summary.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(`Profile saved to ${output}`);
  if (report.failure) console.error(report.failure);
}
