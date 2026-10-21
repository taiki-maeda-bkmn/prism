import { electronLaunchArguments } from '../../scripts/electron-launch.mjs';
import { _electron as electron, expect, test, type ElectronApplication, type Locator, type Page } from '@playwright/test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const initialNotes: Record<string, string> = {
  'Welcome to Prism.md': '# Welcome to Prism\n\nExplore [[Garden]] and [[Research]].\n',
  'Garden.md': '\ufeff# Garden\r\n\r\nReturn to [[Welcome to Prism]].\r\n',
  'Research.md': '# Research\n\nQuestions about [[Garden]].\n',
  'Orchid.md': '# Orchid\n\nAn unconnected thought.\n',
};
interface Point { x: number; y: number }
let temporary: string;
let notebook: string;
let desktop: ElectronApplication | undefined;
let page: Page;
let pageErrors: string[];

const graph = () => page.locator('.graph-view:not(.graph-compact) .graph-canvas');
const node = (name: string) => graph().getByRole('button', { name: `Open ${name}`, exact: true });
const distance = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);

async function openGraph() {
  if (!await graph().isVisible()) await page.getByRole('button', { name: 'Graph view', exact: true }).click();
  await expect(graph()).toBeVisible();
}

async function point(target: Locator, space: 'screen' | 'graph' = 'screen'): Promise<Point> {
  return target.evaluate((element, coordinateSpace) => {
    const graphics = element as SVGGraphicsElement;
    const matrix = coordinateSpace === 'screen' ? graphics.getScreenCTM() : graphics.transform.baseVal.consolidate()?.matrix;
    if (!matrix) throw new Error('The graph node has no rendered transform.');
    const position = new DOMPoint(0, 0).matrixTransform(matrix);
    return { x: position.x, y: position.y };
  }, space);
}

async function expectPoint(target: Locator, expected: Point, space: 'screen' | 'graph' = 'screen') {
  await expect.poll(async () => distance(await point(target, space), expected)).toBeLessThan(1.5);
}

async function dragNode(name: string, delta: Point, hit: 'dot' | 'label' = 'dot') {
  const start = await point(node(name));
  const label = hit === 'label' ? await node(name).locator('.graph-node-label').boundingBox() : null;
  if (hit === 'label' && !label) throw new Error('The graph label is not visible.');
  const cursor = label ? { x: label.x + label.width / 2, y: label.y + label.height / 2 } : start;
  await page.mouse.move(cursor.x, cursor.y);
  await page.mouse.down();
  await page.mouse.move(cursor.x + delta.x, cursor.y + delta.y, { steps: 6 });
  await page.mouse.up();
  // A drag must leave the graph open, and its dot must follow the actual cursor
  // regardless of zoom, letterboxing, or the SVG's rendered dimensions.
  await expect(graph()).toBeVisible();
  await expectPoint(node(name), { x: start.x + delta.x, y: start.y + delta.y });
}

async function edges() {
  return graph().locator('.graph-edge').evaluateAll(elements => elements.map(element => {
    const line = element as SVGLineElement;
    const matrix = line.getScreenCTM();
    if (!matrix) throw new Error('The graph edge has no rendered transform.');
    const start = new DOMPoint(line.x1.baseVal.value, line.y1.baseVal.value).matrixTransform(matrix);
    const end = new DOMPoint(line.x2.baseVal.value, line.y2.baseVal.value).matrixTransform(matrix);
    return [{ x: start.x, y: start.y }, { x: end.x, y: end.y }];
  }));
}

async function expectUnchangedFiles(directory = notebook) {
  for (const [name, original] of Object.entries(initialNotes)) {
    expect(await readFile(path.join(directory, name))).toEqual(Buffer.from(original));
  }
}

test.beforeEach(async () => {
  temporary = await mkdtemp(path.join(os.tmpdir(), 'prism-graph-test-'));
  notebook = path.join(temporary, 'First notebook');
  const userData = path.join(temporary, 'profile');
  await Promise.all([mkdir(notebook), mkdir(userData)]);
  await Promise.all(Object.entries(initialNotes).map(([name, content]) => writeFile(path.join(notebook, name), content)));
  desktop = await electron.launch({
    args: electronLaunchArguments(['--no-sandbox', '.']), cwd: process.cwd(),
    env: { ...process.env, PRISM_USER_DATA: userData, PRISM_WORKSPACE: notebook },
  });
  page = await desktop.firstWindow();
  pageErrors = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  await expect(page.locator('.note-heading h1')).toHaveText('Welcome to Prism');
  await expect.poll(() => desktop!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible())).toBe(true);
  await openGraph();
});

test.afterEach(async ({}, testInfo) => {
  if (page && !page.isClosed() && testInfo.status !== testInfo.expectedStatus) {
    const screenshot = await page.screenshot().catch(() => undefined);
    if (screenshot) await testInfo.attach('Graph at failure', { body: screenshot, contentType: 'image/png' });
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

test('drags nodes and connected edges accurately through zoom, pan, resize, and independent resets', async ({}, testInfo) => {
  const originalGarden = await point(node('Garden'), 'graph');
  const originalResearch = await point(node('Research'), 'graph');
  const start = await point(node('Garden'));
  const originalEdges = await edges();
  const connected = originalEdges.flatMap((ends, index) => ends.flatMap((end, endpoint) =>
    distance(end, start) < 1 ? [{ index, endpoint, other: ends[1 - endpoint] }] : []));
  expect(connected).toHaveLength(2);
  await dragNode('Garden', { x: 75, y: 30 });
  const moved = await point(node('Garden'));
  for (const connection of connected) {
    await expect.poll(async () => distance((await edges())[connection.index][connection.endpoint], moved)).toBeLessThan(1.5);
    expect(distance((await edges())[connection.index][1 - connection.endpoint], connection.other)).toBeLessThan(1.5);
  }
  await expectPoint(node('Research'), originalResearch, 'graph');

  await page.getByRole('button', { name: 'Zoom in', exact: true }).click();
  await page.getByRole('button', { name: 'Zoom in', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Reset graph view', exact: true })).toHaveText('140%');
  // Emulate a real renderer resize with a different aspect ratio. The native
  // Electron page still handles the pointer events and renders the SVG.
  await page.setViewportSize({ width: 1080, height: 800 });
  await dragNode('Garden', { x: -45, y: 25 });
  const beforePan = await point(node('Garden'));
  const saved = await point(node('Garden'), 'graph');
  const bounds = await graph().boundingBox();
  if (!bounds) throw new Error('The graph canvas is not visible.');
  const background = { x: bounds.x + 12, y: bounds.y + bounds.height * 0.55 };
  await page.mouse.move(background.x, background.y);
  await page.mouse.down();
  await page.mouse.move(background.x + 45, background.y + 20, { steps: 5 });
  await page.mouse.up();
  await expectPoint(node('Garden'), { x: beforePan.x + 45, y: beforePan.y + 20 });
  await expectPoint(node('Garden'), saved, 'graph');
  await dragNode('Garden', { x: 30, y: -25 });
  await page.setViewportSize({ width: 1440, height: 900 });
  await dragNode('Garden', { x: -35, y: 15 }, 'label');

  const arranged = await point(node('Garden'), 'graph');
  await page.getByRole('button', { name: 'Reset graph view', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Reset graph view', exact: true })).toHaveText('100%');
  await expectPoint(node('Garden'), arranged, 'graph');
  await testInfo.attach('Rearranged note graph', { body: await page.screenshot(), contentType: 'image/png' });
  await page.getByRole('button', { name: 'Zoom out', exact: true }).click();
  await page.getByRole('button', { name: 'Reset graph layout', exact: true }).click();
  await expectPoint(node('Garden'), originalGarden, 'graph');
  await expectPoint(node('Research'), originalResearch, 'graph');
  await expect(page.getByRole('button', { name: 'Reset graph view', exact: true })).toHaveText('100%');

  await node('Garden').click();
  await expect(page.locator('.note-heading h1')).toHaveText('Garden');
  for (const [name, key] of [['Welcome to Prism', 'Enter'], ['Research', 'Space']]) {
    await openGraph();
    await node(name).focus();
    await node(name).press(key);
    await expect(page.locator('.note-heading h1')).toHaveText(name);
  }
  const local = page.getByRole('group', { name: 'Local note graph', exact: true });
  const compactGarden = local.getByRole('button', { name: 'Open Garden', exact: true });
  const compactPosition = await point(compactGarden, 'graph');
  await compactGarden.focus();
  await compactGarden.press('ArrowRight');
  await expectPoint(compactGarden, compactPosition, 'graph');
  await expect(page.locator('.note-heading h1')).toHaveText('Research');
  await compactGarden.click();
  await expect(page.locator('.note-heading h1')).toHaveText('Garden');
  await expectUnchangedFiles();
  expect(pageErrors).toEqual([]);
});

test('retains keyboard-arranged nodes through note edits and refresh, and isolates notebooks with matching paths', async () => {
  const original = await point(node('Garden'), 'graph');
  await node('Garden').focus();
  await node('Garden').press('ArrowRight');
  await node('Garden').press('Shift+ArrowDown');
  const arranged = { x: original.x + 10, y: original.y + 40 };
  await expectPoint(node('Garden'), arranged, 'graph');
  await expect(page.locator('.statusbar')).toContainText('All changes saved');
  await node('Garden').press('Enter');
  await expect(page.locator('.note-heading h1')).toHaveText('Garden');
  await openGraph();
  await expectPoint(node('Garden'), arranged, 'graph');

  for (const addition of ['\n\nA new paragraph.', '\n\nNow linked to [[Orchid]].']) {
    await node('Garden').click();
    await page.getByRole('group', { name: 'Editor mode', exact: true }).getByRole('button', { name: 'Source', exact: true }).click();
    const editor = page.getByLabel('Markdown source', { exact: true });
    await editor.focus();
    await editor.press('ControlOrMeta+End');
    await page.keyboard.insertText(addition);
    await expect(editor).toContainText(addition.trim());
    await openGraph();
    await expectPoint(node('Garden'), arranged, 'graph');
  }
  await expect(graph().locator('.graph-edge')).toHaveCount(4);
  await expectUnchangedFiles();
  await page.getByRole('button', { name: 'Refresh notebook', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Discard changes', exact: true }).click();
  await expect(page.locator('.statusbar')).toContainText('All changes saved');
  await openGraph();
  await expect(graph().locator('.graph-edge')).toHaveCount(3);
  await expectPoint(node('Garden'), arranged, 'graph');

  const secondNotebook = path.join(temporary, 'Second notebook');
  await mkdir(secondNotebook);
  await Promise.all(Object.entries(initialNotes).map(([name, content]) => writeFile(path.join(secondNotebook, name), content)));
  // Only the OS folder picker is replaced; loading and replacing the notebook
  // still uses the production preload bridge and main-process filesystem code.
  await desktop!.evaluate(({ dialog }, directory) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [directory] });
  }, secondNotebook);
  await page.getByRole('button', { name: 'Open notebook', exact: true }).click();
  await expect(page.locator('.workspace-switch strong')).toHaveText('Second notebook');
  await openGraph();
  await expectPoint(node('Garden'), original, 'graph');
  await expectUnchangedFiles();
  await expectUnchangedFiles(secondNotebook);
  expect(pageErrors).toEqual([]);
});

test('ends interrupted drags without opening notes or leaving the next gesture stuck', async () => {
  for (const interruption of ['cancel', 'lost capture']) {
    const start = await point(node('Garden'));
    await graph().evaluate(element => {
      element.addEventListener('pointerdown', event => {
        (element as SVGElement).dataset.testPointerId = String((event as PointerEvent).pointerId);
      }, { once: true });
    });
    await page.mouse.move(start.x, start.y);
    await page.mouse.down();
    await page.mouse.move(start.x + 35, start.y + 20, { steps: 4 });
    await expectPoint(node('Garden'), { x: start.x + 35, y: start.y + 20 });
    const stopped = await point(node('Garden'));
    const pointerId = Number(await graph().getAttribute('data-test-pointer-id'));
    expect(pointerId).toBeGreaterThan(0);
    if (interruption === 'cancel') {
      // Browser automation cannot revoke a hardware pointer directly. Deliver
      // the cancellation event with the ID from this real captured gesture.
      await graph().dispatchEvent('pointercancel', { pointerId, pointerType: 'mouse', isPrimary: true, bubbles: true });
    } else {
      await graph().evaluate((element, id) => {
        const capture = [element, ...element.querySelectorAll('*')].find(candidate => candidate.hasPointerCapture(id));
        if (!capture) throw new Error('The active drag did not capture its pointer.');
        capture.releasePointerCapture(id);
      }, pointerId);
    }
    await page.mouse.move(start.x + 75, start.y + 40, { steps: 4 });
    await page.mouse.up();
    await expect(graph()).toBeVisible();
    await expectPoint(node('Garden'), stopped);
    await dragNode('Garden', { x: -20, y: -10 });
  }
  await node('Garden').click();
  await expect(page.locator('.note-heading h1')).toHaveText('Garden');
  await expectUnchangedFiles();
  expect(pageErrors).toEqual([]);
});
