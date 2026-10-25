export const workspaceSplit = { minimumWidth: 960, minimumPane: 420, divider: 10, defaultRatio: 0.5 };

/** Saved proportions are independent of a temporarily smaller native window. */
export function parseWorkspaceRatio(serialized: string | null): number {
  try {
    const value: unknown = JSON.parse(serialized ?? 'null');
    if (typeof value === 'number' && Number.isFinite(value)) return Math.max(0.2, Math.min(0.8, value));
  } catch { /* A damaged preference must not prevent opening the notebook. */ }
  return workspaceSplit.defaultRatio;
}

export function notesPaneWidth(containerWidth: number, ratio: number): number {
  const available = Math.max(0, containerWidth - workspaceSplit.divider);
  const minimum = Math.min(workspaceSplit.minimumPane, available / 2);
  return Math.round(Math.max(minimum, Math.min(available - minimum, available * ratio)));
}
