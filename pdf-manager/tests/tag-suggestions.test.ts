import test from 'node:test';
import assert from 'node:assert/strict';
import { getTagSuggestions, insertTagSuggestion } from '../src/renderer/tagSuggestions';

test('matches the active tag case-insensitively and excludes selected tags and duplicate spelling', () => {
  const value = 'Research, rea';
  const result = getTagSuggestions(value, value.length, value.length, ['Research', 'Reading', 'reading', 'Work']);
  assert.deepEqual(result.options, ['Reading']);
  assert.deepEqual(insertTagSuggestion(value, result, 'Reading'), { value: 'Research, Reading, ', caret: 19 });
});

test('replaces a selected middle tag without dropping neighboring tags or whitespace', () => {
  const value = 'Pinned, read  , 約定';
  const result = getTagSuggestions(value, 8, 12, ['Reading', 'Pinned', '約定']);
  assert.deepEqual(result.options, ['Reading']);
  assert.deepEqual(insertTagSuggestion(value, result, 'Reading'), { value: 'Pinned, Reading  , 約定', caret: 15 });
  assert.deepEqual(getTagSuggestions(value, 8, 16, ['Reading']).options, []);
});

test('shows unused tags in an empty segment and never repeats an exact current tag', () => {
  assert.deepEqual(getTagSuggestions('Reading', 7, 7, ['Reading', 'reading']).options, []);
  assert.deepEqual(getTagSuggestions('Reading, ', 9, 9, ['Research', 'Reading', '約定']).options, ['Research', '約定']);
  const start = getTagSuggestions(', Research', 0, 0, ['Reading', 'Research']);
  assert.deepEqual(insertTagSuggestion(', Research', start, 'Reading'), { value: 'Reading, Research', caret: 7 });
});

test('supports Japanese matching and leaves new freeform tags available to the input', () => {
  const value = 'Research, 約';
  const result = getTagSuggestions(value, value.length, value.length, ['約定', '約定分析', '研究', 'Research']);
  assert.deepEqual(result.options, ['約定', '約定分析']);
  assert.deepEqual(insertTagSuggestion(value, result, '約定'), { value: 'Research, 約定, ', caret: 14 });
  assert.deepEqual(getTagSuggestions('新しいタグ', 5, 5, ['Research', '約定']).options, []);
});

test('does not offer a completion that exceeds the field limit or introduces a comma as part of a tag', () => {
  const value = 'x'.repeat(790) + ', ';
  const result = getTagSuggestions(value, value.length, value.length, ['Long research topic', 'Short', 'Research, Trading']);
  assert.deepEqual(result.options, ['Short']);
  assert.equal(insertTagSuggestion(value, result, 'Long research topic'), null);
});
