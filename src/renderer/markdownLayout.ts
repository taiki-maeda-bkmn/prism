export interface MarkdownLayout {
  heading: boolean;
  paneLabels: boolean;
  saveNotifications: boolean;
  compact: boolean;
  topicTools: boolean;
}

export const markdownLayoutStorageKey = 'prism.markdown-layout';
export const defaultMarkdownLayout: Readonly<MarkdownLayout> = Object.freeze({
  heading: true,
  paneLabels: true,
  saveNotifications: true,
  compact: false,
  topicTools: true,
});

const booleanSettings = ['heading', 'paneLabels', 'saveNotifications', 'compact', 'topicTools'] as const;

function normalizeMarkdownLayout(value: Record<string, unknown>): MarkdownLayout {
  const layout = { ...defaultMarkdownLayout };
  for (const key of booleanSettings) {
    if (typeof value[key] === 'boolean') layout[key] = value[key];
  }
  return layout;
}

/** Invalid or future settings must leave a usable, fully visible editor. */
export function parseMarkdownLayout(raw: string | null): MarkdownLayout {
  try {
    const value: unknown = raw === null ? null : JSON.parse(raw);
    if (value && typeof value === 'object' && !Array.isArray(value) && 'version' in value && value.version === 1) {
      return normalizeMarkdownLayout(value as Record<string, unknown>);
    }
  } catch { /* A damaged preference must not prevent the notebook from opening. */ }
  return { ...defaultMarkdownLayout };
}

export function serializeMarkdownLayout(layout: MarkdownLayout): string {
  return JSON.stringify({ version: 1, ...normalizeMarkdownLayout({ ...layout }) });
}

export function moreWritingSpace(current: MarkdownLayout): MarkdownLayout {
  return {
    ...current,
    heading: false,
    paneLabels: false,
    saveNotifications: false,
    compact: true,
    topicTools: false,
  };
}
