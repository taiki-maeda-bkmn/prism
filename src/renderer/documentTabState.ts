export interface DocumentTab {
  key: string;
  kind: 'note' | 'pdf';
  id: string;
  groupId: string | null;
}

export interface TabGroup {
  id: string;
  name: string;
  collapsed: boolean;
}

export interface TabSession {
  version: 1;
  tabs: DocumentTab[];
  groups: TabGroup[];
  activeKey: string | null;
  targetGroupId: string | null;
}

export const TAB_LIMITS = { tabs: 256, groups: 32, name: 80, id: 4096, savedBytes: 8 * 1024 * 1024 } as const;
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const validText = (value: unknown, length: number): value is string => typeof value === 'string'
  && value.length > 0 && value.length <= length && !/[\u0000-\u001f\u007f]/.test(value);
const groupExists = (state: TabSession, id: string | null) => id === null || state.groups.some(group => group.id === id);

export function emptyTabs(): TabSession {
  return { version: 1, tabs: [], groups: [], activeKey: null, targetGroupId: null };
}

export function tabKey(kind: DocumentTab['kind'], id: string): string { return `${kind}:${id}`; }

/** Saved tab metadata is optional. Document contents and paths still come from the current notebook/library. */
export function parseTabs(raw: string | null): TabSession {
  if (!raw || raw.length * 2 > TAB_LIMITS.savedBytes) return emptyTabs();
  let value: unknown;
  try { value = JSON.parse(raw); } catch { return emptyTabs(); }
  if (!record(value) || value.version !== 1 || !Array.isArray(value.tabs) || !Array.isArray(value.groups)) return emptyTabs();
  const groups: TabGroup[] = [];
  const groupIds = new Set<string>();
  const names = new Set<string>();
  for (const item of value.groups.slice(0, TAB_LIMITS.groups)) {
    if (!record(item) || !validText(item.id, 128) || !validText(item.name, TAB_LIMITS.name)) continue;
    const name = item.name.trim();
    const folded = name.toLocaleLowerCase();
    if (!name || folded === 'ungrouped' || groupIds.has(item.id) || names.has(folded)) continue;
    groups.push({ id: item.id, name, collapsed: item.collapsed === true });
    groupIds.add(item.id); names.add(folded);
  }
  const tabs: DocumentTab[] = [];
  const keys = new Set<string>();
  for (const item of value.tabs.slice(0, TAB_LIMITS.tabs)) {
    if (!record(item) || (item.kind !== 'note' && item.kind !== 'pdf') || !validText(item.id, TAB_LIMITS.id)) continue;
    const key = tabKey(item.kind, item.id);
    if (item.key !== key || keys.has(key)) continue;
    tabs.push({ key, kind: item.kind, id: item.id, groupId: typeof item.groupId === 'string' && groupIds.has(item.groupId) ? item.groupId : null });
    keys.add(key);
  }
  const activeKey = typeof value.activeKey === 'string' && keys.has(value.activeKey) ? value.activeKey : tabs[0]?.key ?? null;
  return { version: 1, tabs, groups, activeKey,
    targetGroupId: typeof value.targetGroupId === 'string' && groupIds.has(value.targetGroupId) ? value.targetGroupId : null };
}

export function selectTab(state: TabSession, key: string): TabSession {
  const tab = state.tabs.find(tab => tab.key === key);
  if (!tab) return state;
  return { ...state, activeKey: key, targetGroupId: tab.groupId,
    groups: state.groups.map(group => group.id === tab.groupId && group.collapsed ? { ...group, collapsed: false } : group) };
}

export function openTab(state: TabSession, document: Pick<DocumentTab, 'kind' | 'id'>): TabSession {
  if ((document.kind !== 'note' && document.kind !== 'pdf') || !validText(document.id, TAB_LIMITS.id)) throw new Error('This document cannot be opened as a tab.');
  const key = tabKey(document.kind, document.id);
  if (state.tabs.some(tab => tab.key === key)) return selectTab(state, key);
  if (state.tabs.length >= TAB_LIMITS.tabs) throw new Error(`Close a tab before opening another. Prism supports up to ${TAB_LIMITS.tabs} open tabs.`);
  const groupId = groupExists(state, state.targetGroupId) ? state.targetGroupId : null;
  return selectTab({ ...state, tabs: [...state.tabs, { key, ...document, groupId }] }, key);
}

/** Choose the next surviving neighbor, then the previous one, when the active tab disappears. */
export function pruneTabs(state: TabSession, keep: (tab: DocumentTab) => boolean): TabSession {
  const tabs = state.tabs.filter(keep);
  if (tabs.length === state.tabs.length) return state;
  if (tabs.some(tab => tab.key === state.activeKey)) return { ...state, tabs };
  const surviving = new Set(tabs.map(tab => tab.key));
  const index = Math.max(0, state.tabs.findIndex(tab => tab.key === state.activeKey));
  const next = state.tabs.slice(index).find(tab => surviving.has(tab.key))
    ?? state.tabs.slice(0, index).reverse().find(tab => surviving.has(tab.key));
  const pruned = { ...state, tabs, activeKey: next?.key ?? null };
  return next ? selectTab(pruned, next.key) : pruned;
}

export function closeTab(state: TabSession, key: string): TabSession {
  return pruneTabs(state, tab => tab.key !== key);
}

/** PDF library sessions outlive a notebook switch; note/topic membership does not. */
export function carryPDFTabs(destination: TabSession, previous: TabSession): TabSession {
  const keys = new Set(destination.tabs.map(tab => tab.key));
  const additions: DocumentTab[] = [];
  for (const tab of previous.tabs) {
    if (destination.tabs.length + additions.length >= TAB_LIMITS.tabs) break;
    if (tab.kind !== 'pdf' || keys.has(tab.key)) continue;
    additions.push({ ...tab, groupId: null });
    keys.add(tab.key);
  }
  return additions.length ? { ...destination, tabs: [...destination.tabs, ...additions] } : destination;
}

function checkedName(state: TabSession, value: string, except?: string): string {
  const name = value.trim();
  if (!validText(name, TAB_LIMITS.name)) throw new Error(`Enter a topic name of 1–${TAB_LIMITS.name} characters without line breaks.`);
  if (name.toLocaleLowerCase() === 'ungrouped') throw new Error('Ungrouped is reserved for tabs without a topic. Choose another name.');
  if (state.groups.some(group => group.id !== except && group.name.toLocaleLowerCase() === name.toLocaleLowerCase())) throw new Error('A topic with that name already exists.');
  return name;
}

export function addTabGroup(state: TabSession, value: string): TabSession {
  const name = checkedName(state, value);
  if (state.groups.length >= TAB_LIMITS.groups) throw new Error(`Prism supports up to ${TAB_LIMITS.groups} tab topics. Remove a topic before adding another.`);
  let number = 1;
  while (state.groups.some(group => group.id === `topic-${number}`)) number++;
  const id = `topic-${number}`;
  return { ...state, groups: [...state.groups, { id, name, collapsed: false }], targetGroupId: id };
}

export function renameTabGroup(state: TabSession, id: string, value: string): TabSession {
  if (!state.groups.some(group => group.id === id)) return state;
  const name = checkedName(state, value, id);
  return { ...state, groups: state.groups.map(group => group.id === id ? { ...group, name } : group) };
}

export function removeTabGroup(state: TabSession, id: string): TabSession {
  if (!state.groups.some(group => group.id === id)) return state;
  return { ...state, groups: state.groups.filter(group => group.id !== id),
    tabs: state.tabs.map(tab => tab.groupId === id ? { ...tab, groupId: null } : tab),
    targetGroupId: state.targetGroupId === id ? null : state.targetGroupId };
}

export function moveTab(state: TabSession, key: string, groupId: string | null): TabSession {
  if (!groupExists(state, groupId)) return state;
  const tab = state.tabs.find(tab => tab.key === key);
  if (!tab) return state;
  return { ...state, tabs: state.tabs.map(tab => tab.key === key ? { ...tab, groupId } : tab),
    groups: state.groups.map(group => group.id === groupId && group.collapsed ? { ...group, collapsed: false } : group),
    targetGroupId: state.activeKey === key ? groupId : state.targetGroupId };
}

export function toggleTabGroup(state: TabSession, id: string): TabSession {
  return { ...state, groups: state.groups.map(group => group.id === id ? { ...group, collapsed: !group.collapsed } : group) };
}
