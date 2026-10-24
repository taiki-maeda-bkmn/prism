import * as fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const controlCharacters = /[\u0000-\u001f\u007f-\u009f]/;
const bodyControlCharacters = /[\u0000-\u0009\u000b\u000c\u000e-\u001f\u007f-\u009f]/;
const basicEmailAddress = /^[a-z0-9_+-]+(?:\.[a-z0-9_+-]+)*@[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/i;

function validRecipients(value: string): boolean {
  return !controlCharacters.test(value) && value.split(',').every((part) => {
    const address = part.trim();
    return address.length <= 254 && basicEmailAddress.test(address);
  });
}

/** Validate the entire URL before handing it to an operating-system application. */
export function validateExternalURL(value: unknown): string {
  const unsupported = () => new Error('Only valid HTTP, HTTPS, and email links can be opened.');
  if (typeof value !== 'string' || value.length > 4096 || value.trim() !== value || controlCharacters.test(value)) throw unsupported();
  let url: URL;
  try { url = new URL(value); } catch { throw unsupported(); }
  if (url.username || url.password) throw unsupported();
  if (url.protocol === 'http:' || url.protocol === 'https:') return url.href;
  if (url.protocol !== 'mailto:' || url.host || url.hash) throw unsupported();
  try {
    if (!validRecipients(decodeURIComponent(url.pathname))) throw unsupported();
    const headers = new Set<string>();
    for (const parameter of url.search.slice(1).split('&').filter(Boolean)) {
      const separator = parameter.indexOf('=');
      if (separator < 0) throw unsupported();
      // Mailto uses percent encoding; a literal + remains part of an address.
      const name = decodeURIComponent(parameter.slice(0, separator)).toLowerCase();
      const content = decodeURIComponent(parameter.slice(separator + 1));
      if (!['subject', 'body', 'cc', 'bcc'].includes(name) || headers.has(name)) throw unsupported();
      headers.add(name);
      if ((name === 'body' ? bodyControlCharacters : controlCharacters).test(content)) throw unsupported();
      if ((name === 'cc' || name === 'bcc') && !validRecipients(content)) throw unsupported();
    }
  } catch { throw unsupported(); }
  return url.href;
}

/** Notebook content cannot make the renderer read arbitrary files or fetch remote assets. */
export async function isRendererResource(value: string, rendererRoot: string, resourceType?: string): Promise<boolean> {
  try {
    const url = new URL(value);
    // PDF.js uses an in-memory module wrapper for its bundled worker on the
    // opaque file origin, plus decoded fonts/images. No navigation or fetch
    // request can use this exception to access an arbitrary blob or data URL.
    if (url.protocol === 'blob:') {
      return value.startsWith('blob:null/') && ['script', 'other', 'font', 'image'].includes(resourceType ?? '');
    }
    if (url.protocol === 'data:') {
      return (resourceType === 'image' && /^data:image\//i.test(value))
        || (resourceType === 'font' && /^data:(?:font\/|application\/(?:font-|x-font-))/i.test(value));
    }
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
