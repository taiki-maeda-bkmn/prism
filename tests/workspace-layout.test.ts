import assert from 'node:assert/strict';
import test from 'node:test';
import { notesPaneWidth, parseWorkspaceRatio, workspaceSplit } from '../src/renderer/workspaceLayout';

test('invalid saved split preferences recover without accepting coercible values', () => {
  for (const serialized of [null, '{broken', 'null', 'true', '"0.7"', '[]', '{}', '1e309']) {
    assert.equal(parseWorkspaceRatio(serialized), 0.5);
  }
  assert.equal(parseWorkspaceRatio('0.65'), 0.65);
  assert.equal(parseWorkspaceRatio('-1'), 0.2);
  assert.equal(parseWorkspaceRatio('10'), 0.8);
});

test('panes retain their minimum width while a stored proportion adapts to native resizing', () => {
  assert.equal(notesPaneWidth(1320, 0.5), 655);
  assert.equal(notesPaneWidth(960, 0.2), workspaceSplit.minimumPane);
  assert.equal(notesPaneWidth(960, 0.8), 530);
  // Clamping a small window must not change the proportion used after widening.
  const ratio = parseWorkspaceRatio('0.7');
  assert.equal(notesPaneWidth(960, ratio), 530);
  assert.equal(notesPaneWidth(2010, ratio), 1400);
  assert.equal(notesPaneWidth(0, ratio), 0);
});
