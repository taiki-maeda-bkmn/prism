/** Canonical bare arXiv identity. URLs and user-supplied paths are not identities. */
export function normalizeArxivId(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 100) return null;
  const id = value.trim().toLowerCase();
  const version = '(?:v[1-9][0-9]{0,5})?';
  const modern = new RegExp(`^[0-9]{2}(?:0[1-9]|1[0-2])\\.[0-9]{4,5}${version}$`);
  const legacy = new RegExp(`^[a-z][a-z0-9.-]{0,39}/[0-9]{2}(?:0[1-9]|1[0-2])[0-9]{3}${version}$`);
  return modern.test(id) || legacy.test(id) ? id : null;
}

export function baseArxivId(value: unknown): string | null {
  return normalizeArxivId(value)?.replace(/v[0-9]+$/, '') ?? null;
}
