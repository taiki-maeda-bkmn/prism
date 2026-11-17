import test from 'node:test';
import assert from 'node:assert/strict';
import { addTabGroup, carryPDFTabs, closeTab, emptyTabs, moveTab, openTab, parseTabs, pruneTabs, removeTabGroup, renameTabGroup, selectTab, selectTabGroup, tabKey, TAB_LIMITS, toggleTabGroup, type TabSession } from '../src/renderer/documentTabState';

const note = (id: string) => ({ kind: 'note' as const, id });
const pdf = (id: string) => ({ kind: 'pdf' as const, id });

test('tabs distinguish PDF and note identities and reopening preserves order and topic', () => {
  let state = openTab(emptyTabs(), note('same'));
  state = addTabGroup(state, 'Research');
  const topic = state.targetGroupId!;
  state = openTab(state, pdf('same'));
  state = moveTab(state, 'pdf:same', topic);
  state = openTab(state, note('Next.md'));
  state = toggleTabGroup(state, topic);
  const before = structuredClone(state);
  const reopened = openTab(state, pdf('same'));
  assert.deepEqual(state, before, 'operations never mutate an earlier session');
  assert.equal(reopened.tabs.length, 3);
  assert.deepEqual(reopened.tabs.map(tab => tab.key), ['note:same', 'pdf:same', 'note:Next.md']);
  assert.equal(reopened.activeKey, 'pdf:same');
  assert.equal(reopened.targetGroupId, topic);
  assert.equal(reopened.tabs[1].groupId, topic);
  assert.equal(reopened.groups[0].collapsed, false);
  assert.equal(selectTab(reopened, 'missing'), reopened);
});

test('closing selects a nearby surviving tab, preserves unrelated selection, and never removes topics', () => {
  let state = addTabGroup(emptyTabs(), 'Rates');
  for (const id of ['One.md', 'Two.md', 'Three.md']) state = openTab(state, note(id));
  state = selectTab(state, 'note:Two.md');
  assert.equal(closeTab(state, 'note:One.md').activeKey, 'note:Two.md');
  const next = closeTab(state, 'note:Two.md');
  assert.equal(next.activeKey, 'note:Three.md');
  assert.equal(closeTab(next, 'note:Three.md').activeKey, 'note:One.md');
  const empty = pruneTabs(next, () => false);
  assert.equal(empty.activeKey, null);
  assert.equal(empty.tabs.length, 0);
  assert.equal(empty.groups[0].name, 'Rates');
  assert.equal(empty.targetGroupId, state.targetGroupId);
  assert.equal(closeTab(state, 'missing'), state);
});

test('pruning missing documents keeps mixed groups and picks the next surviving neighbor', () => {
  let state = addTabGroup(emptyTabs(), 'Execution');
  const topic = state.targetGroupId!;
  state = openTab(state, note('A.md'));
  state = moveTab(state, 'note:A.md', topic);
  state = openTab(state, pdf('paper'));
  state = moveTab(state, 'pdf:paper', topic);
  state = openTab(state, note('B.md'));
  state = openTab(state, pdf('report'));
  state = selectTab(state, 'note:A.md');
  const pruned = pruneTabs(state, tab => tab.kind === 'pdf');
  assert.deepEqual(pruned.tabs.map(tab => tab.key), ['pdf:paper', 'pdf:report']);
  assert.equal(pruned.activeKey, 'pdf:paper');
  assert.equal(pruned.targetGroupId, topic, 'the replacement document reveals its group');
  assert.equal(pruned.tabs[0].groupId, topic);
  assert.equal(pruned.tabs[1].groupId, null);
  assert.equal(pruned.groups[0].name, 'Execution');
  assert.equal(pruneTabs(pruned, () => true), pruned);
});

test('notebook switches carry open PDFs without leaking notes or topic membership', () => {
  let previous = addTabGroup(emptyTabs(), 'Old notebook research');
  const previousTopic = previous.targetGroupId!;
  previous = openTab(previous, note('Old-only.md'));
  previous = openTab(previous, note('Shared path.md'));
  previous = openTab(previous, pdf('already-open'));
  previous = openTab(previous, pdf('carry-one'));
  previous = openTab(previous, pdf('carry-two'));
  for (const tab of previous.tabs) previous = moveTab(previous, tab.key, previousTopic);
  let destination = addTabGroup(emptyTabs(), 'New notebook research');
  const destinationTopic = destination.targetGroupId!;
  destination = openTab(destination, pdf('already-open'));
  destination = moveTab(destination, 'pdf:already-open', destinationTopic);
  destination = openTab(destination, note('Shared path.md'));
  destination = selectTabGroup(destination, destinationTopic);
  destination = toggleTabGroup(destination, destinationTopic);
  const beforeDestination = structuredClone(destination);
  const beforePrevious = structuredClone(previous);
  const carried = carryPDFTabs(destination, previous);
  assert.deepEqual(carried.tabs.map(tab => tab.key), ['pdf:already-open', 'note:Shared path.md', 'pdf:carry-one', 'pdf:carry-two']);
  assert.equal(carried.tabs[0].groupId, destination.tabs[0].groupId, 'existing destination assignments win');
  assert.deepEqual(carried.tabs.slice(2).map(tab => tab.groupId), [null, null], 'old topic identity cannot leak even when IDs overlap');
  assert.deepEqual(carried.groups, destination.groups);
  assert.equal(carried.activeKey, destination.activeKey);
  assert.equal(carried.targetGroupId, destination.targetGroupId);
  assert.equal(carried.groups[0].collapsed, true);
  assert.deepEqual(destination, beforeDestination);
  assert.deepEqual(previous, beforePrevious);
  assert.equal(carryPDFTabs(carried, previous), carried, 'carrying again is a no-op');
});

test('carried PDFs respect the tab bound without evicting destination tabs or choosing an active tab', () => {
  let previous = openTab(emptyTabs(), note('Never carry.md'));
  previous = openTab(previous, pdf('one'));
  previous = openTab(previous, pdf('two'));
  const emptyDestination = addTabGroup(emptyTabs(), 'Empty destination topic');
  const filled = carryPDFTabs(emptyDestination, previous);
  assert.deepEqual(filled.tabs.map(tab => tab.key), ['pdf:one', 'pdf:two']);
  assert.equal(filled.activeKey, null, 'the parent decides which pane should remain selected');
  assert.equal(filled.targetGroupId, emptyDestination.targetGroupId);

  let nearlyFull = emptyTabs();
  for (let index = 0; index < TAB_LIMITS.tabs - 1; index++) nearlyFull = openTab(nearlyFull, note(`Destination ${index}.md`));
  const limited = carryPDFTabs(nearlyFull, previous);
  assert.equal(limited.tabs.length, TAB_LIMITS.tabs);
  assert.deepEqual(limited.tabs.slice(0, -1), nearlyFull.tabs);
  assert.equal(limited.tabs.at(-1)?.key, 'pdf:one');
  assert.equal(limited.activeKey, nearlyFull.activeKey);
  assert.equal(carryPDFTabs(limited, previous), limited);
});

test('moving mixed tabs and renaming or removing a topic preserves all document identities', () => {
  let state = openTab(emptyTabs(), note('研究/確率.md'));
  state = openTab(state, pdf('paper-1'));
  state = addTabGroup(state, ' 確率と市場 ');
  const topic = state.targetGroupId!;
  state = moveTab(state, 'note:研究/確率.md', topic);
  state = moveTab(state, 'pdf:paper-1', topic);
  assert.ok(state.tabs.every(tab => tab.groupId === topic));
  state = renameTabGroup(state, topic, '市場の研究');
  assert.equal(state.groups[0].name, '市場の研究');
  const before = state.tabs.map(({ key, id, kind }) => ({ key, id, kind }));
  state = removeTabGroup(state, topic);
  assert.deepEqual(state.tabs.map(({ key, id, kind }) => ({ key, id, kind })), before);
  assert.ok(state.tabs.every(tab => tab.groupId === null));
  assert.equal(state.activeKey, 'pdf:paper-1');
  assert.equal(state.targetGroupId, null);
  assert.equal(state.groups.length, 0);
  assert.equal(moveTab(state, 'pdf:paper-1', 'missing'), state);
});

test('new notes and PDFs start ungrouped even when a topic is viewed or its document is active', () => {
  let state = addTabGroup(emptyTabs(), 'Topic one');
  const firstGroup = state.targetGroupId!;
  state = openTab(state, note('One.md'));
  assert.equal(state.tabs[0].groupId, null);
  assert.equal(state.targetGroupId, null);
  state = moveTab(state, 'note:One.md', firstGroup);
  state = addTabGroup(state, 'Topic two');
  assert.equal(state.activeKey, 'note:One.md');
  state = openTab(state, pdf('two'));
  assert.equal(state.tabs[1].groupId, null, 'viewing a group does not classify an opened PDF');
  assert.equal(state.targetGroupId, null, 'the newly opened document is visible in Ungrouped');
  state = selectTab(state, 'note:One.md');
  assert.equal(state.targetGroupId, firstGroup);
  state = openTab(state, pdf('three'));
  assert.equal(state.tabs[2].groupId, null, 'the active document does not classify an opened PDF');
  state = moveTab(state, 'pdf:three', firstGroup);
  state = openTab(state, note('Four.md'));
  assert.equal(state.tabs[3].groupId, null, 'new Markdown documents follow the same explicit-assignment rule');
  assert.equal(state.targetGroupId, null);
  assert.deepEqual(state.tabs.map(tab => tab.groupId), [firstGroup, null, firstGroup, null]);
  state = openTab(state, pdf('three'));
  assert.equal(state.tabs.length, 4, 'reopening an assigned PDF does not create a second tab');
  assert.equal(state.tabs[2].groupId, firstGroup, 'reopening keeps an existing assignment');
  assert.equal(state.targetGroupId, firstGroup, 'reopening reveals the existing group');
});

test('viewing groups leaves the active document, membership, order and legacy metadata unchanged', () => {
  let state = openTab(emptyTabs(), note('Draft.md'));
  state = addTabGroup(state, 'Research');
  const topic = state.targetGroupId!;
  state = moveTab(state, 'note:Draft.md', topic);
  state = toggleTabGroup(state, topic);
  const before = structuredClone(state);
  const ungrouped = selectTabGroup(state, null);
  assert.equal(ungrouped.targetGroupId, null);
  assert.equal(ungrouped.activeKey, 'note:Draft.md');
  assert.equal(ungrouped.tabs, state.tabs, 'browsing another group must not alter document metadata');
  assert.equal(ungrouped.groups, state.groups);
  assert.deepEqual(state, before, 'an earlier session remains immutable');
  assert.equal(selectTabGroup(ungrouped, 'missing'), ungrouped);
  assert.equal(selectTabGroup(ungrouped, null), ungrouped);
  assert.deepEqual(selectTabGroup(ungrouped, topic), state);

  const moved = moveTab(ungrouped, 'note:Draft.md', null);
  assert.equal(moved.activeKey, state.activeKey);
  assert.equal(moved.targetGroupId, null);
  assert.equal(moved.tabs[0].groupId, null, 'membership changes only through an explicit move');
});

test('closing hidden documents preserves the viewed group unless the active document changes', () => {
  let state = addTabGroup(emptyTabs(), 'Research');
  const topic = state.targetGroupId!;
  state = openTab(state, note('Draft.md'));
  state = moveTab(state, 'note:Draft.md', topic);
  state = openTab(state, pdf('reference'));
  state = openTab(state, pdf('spare'));
  state = selectTab(state, 'pdf:reference');
  state = selectTabGroup(state, topic);
  const withoutSpare = closeTab(state, 'pdf:spare');
  assert.equal(withoutSpare.targetGroupId, topic);
  assert.equal(withoutSpare.activeKey, 'pdf:reference');
  const withoutActive = closeTab(withoutSpare, 'pdf:reference');
  assert.equal(withoutActive.activeKey, 'note:Draft.md');
  assert.equal(withoutActive.targetGroupId, topic);
  const emptyGroup = closeTab(state, 'note:Draft.md');
  assert.equal(emptyGroup.targetGroupId, topic, 'an empty viewed group remains available');
  assert.equal(emptyGroup.activeKey, 'pdf:reference');
});

test('removing a viewed group reveals Ungrouped without switching or closing the current document', () => {
  let state = addTabGroup(emptyTabs(), 'One');
  const firstGroup = state.targetGroupId!;
  state = openTab(state, pdf('one'));
  state = moveTab(state, 'pdf:one', firstGroup);
  state = addTabGroup(state, 'Two');
  const secondGroup = state.targetGroupId!;
  state = openTab(state, note('Two.md'));
  state = moveTab(state, 'note:Two.md', secondGroup);
  state = selectTabGroup(state, firstGroup);
  const removed = removeTabGroup(state, firstGroup);
  assert.equal(removed.targetGroupId, null);
  assert.equal(removed.activeKey, state.activeKey);
  assert.deepEqual(removed.tabs.map(tab => tab.groupId), [null, secondGroup]);
  assert.deepEqual(removed.tabs.map(tab => tab.key), state.tabs.map(tab => tab.key));
  assert.equal(removeTabGroup(state, secondGroup).targetGroupId, firstGroup, 'removing a different group preserves the viewed group');
});

test('topic validation rejects blank, control, duplicate and excessive names without changing state', () => {
  const state = addTabGroup(emptyTabs(), 'Research');
  for (const invalid of ['', '  ', 'X\nY', 'X\u0000Y', 'X'.repeat(81), ' research ', 'Ungrouped', ' UNGROUPED ']) {
    assert.throws(() => addTabGroup(state, invalid));
  }
  const withSecond = addTabGroup(state, 'Ideas');
  assert.throws(() => renameTabGroup(withSecond, withSecond.targetGroupId!, 'RESEARCH'));
  assert.throws(() => renameTabGroup(withSecond, withSecond.targetGroupId!, 'unGrouped'), /reserved/);
  assert.equal(renameTabGroup(state, state.targetGroupId!, 'RESEARCH').groups[0].name, 'RESEARCH');
  assert.deepEqual(state.groups.map(group => group.name), ['Research']);
});

test('saved sessions round trip and discard malformed entries, dangling references and duplicate identities', () => {
  let state = addTabGroup(emptyTabs(), '研究');
  const topic = state.targetGroupId!;
  state = openTab(state, note('研究/問題.md'));
  state = moveTab(state, 'note:研究/問題.md', topic);
  state = openTab(state, pdf('report'));
  state = selectTabGroup(state, topic);
  state = toggleTabGroup(state, topic);
  assert.deepEqual(parseTabs(JSON.stringify(state)), state);
  assert.equal(state.activeKey, 'pdf:report', 'the viewed group can differ from the active document group');
  assert.equal(state.groups[0].collapsed, true, 'legacy collapse metadata remains readable');
  const parsed = parseTabs(JSON.stringify({ ...state,
    groups: [...state.groups, { id: '__proto__', name: 'Other', collapsed: true }, { id: 'duplicate-name', name: '研究' }, { id: state.groups[0].id, name: 'Duplicate id' }, { id: 'blank', name: ' ' }, { id: 'reserved-name', name: ' UnGrouped ' }, { id: 'ungrouped', name: 'An ordinary topic ID' }, null],
    tabs: [...state.tabs, { ...state.tabs[0] }, { key: 'note:new.md', kind: 'note', id: 'new.md', groupId: 'missing' },
      { key: 'pdf:__proto__', kind: 'pdf', id: '__proto__', groupId: '__proto__' }, { key: 'wrong', kind: 'note', id: 'Wrong.md' },
      { key: 'unknown:bad', kind: 'unknown', id: 'bad' }, { key: 'note:', kind: 'note', id: '' },
      { key: 'note:reserved.md', kind: 'note', id: 'reserved.md', groupId: 'reserved-name' }, null],
    activeKey: 'missing', targetGroupId: 'missing', ignored: { contents: 'not retained' },
  }));
  assert.deepEqual(parsed.tabs.map(tab => tab.key), ['note:研究/問題.md', 'pdf:report', 'note:new.md', 'pdf:__proto__', 'note:reserved.md']);
  assert.equal(parsed.tabs[2].groupId, null);
  assert.equal(parsed.tabs[3].groupId, '__proto__');
  assert.equal(parsed.tabs[4].groupId, null, 'ignored reserved topic names leave their documents ungrouped');
  assert.equal(parsed.groups.length, 3);
  assert.equal(parsed.groups[2].id, 'ungrouped', 'group IDs remain independent of the reserved display name');
  assert.equal(parsed.activeKey, 'note:研究/問題.md');
  assert.equal(parsed.targetGroupId, null);
  assert.equal(Object.hasOwn(parsed, 'ignored'), false);
});

test('malformed and unsupported saved sessions recover to an empty session', () => {
  for (const raw of [null, '', 'bad JSON', 'null', '[]', '{}', '{"version":2,"groups":[],"tabs":[]}', '{"version":1,"groups":{},"tabs":[]}', ' '.repeat(TAB_LIMITS.savedBytes / 2 + 1)]) {
    assert.deepEqual(parseTabs(raw), emptyTabs());
  }
  assert.throws(() => openTab(emptyTabs(), note('bad\u0000path')));
  assert.throws(() => openTab(emptyTabs(), pdf('x'.repeat(TAB_LIMITS.id + 1))));
});

test('metadata bounds refuse additional live tabs/topics but still allow switching existing tabs', () => {
  let state = emptyTabs();
  for (let index = 0; index < TAB_LIMITS.tabs; index++) state = openTab(state, note(`${index}.md`));
  assert.throws(() => openTab(state, pdf('overflow')), /Close a tab/);
  assert.equal(openTab(state, note('0.md')).activeKey, 'note:0.md');
  for (let index = 0; index < TAB_LIMITS.groups; index++) state = addTabGroup(state, `Topic ${index}`);
  assert.throws(() => addTabGroup(state, 'Another topic'), /32 tab topics/);
  const extra: TabSession = { ...state,
    tabs: [...state.tabs, { key: tabKey('pdf', 'overflow'), kind: 'pdf', id: 'overflow', groupId: null }],
    groups: [...state.groups, { id: 'extra', name: 'Extra', collapsed: false }],
  };
  const parsed = parseTabs(JSON.stringify(extra));
  assert.equal(parsed.tabs.length, TAB_LIMITS.tabs);
  assert.equal(parsed.groups.length, TAB_LIMITS.groups);
});
