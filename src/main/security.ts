import * as fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Notebook content cannot make the renderer read arbitrary files or fetch remote assets. */
export async function isRendererResource(value: string, rendererRoot: string): Promise<boolean> {
  try {
    const url = new URL(value);
    if (url.protocol !== 'file:' || (url.hostname && url.hostname !== 'localhost')) return false;
    const [absolute, canonicalRoot] = await Promise.all([
      fs.realpath(fileURLToPath(url)),
      fs.realpath(rendererRoot),
    ]);
    const relative = path.relative(canonicalRoot, absolute);
    if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return false;
    return (await fs.stat(absolute)).isFile();
  } catch { return false; }
}
