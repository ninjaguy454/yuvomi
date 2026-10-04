import test from 'node:test';
import assert from 'node:assert/strict';
import { renderUserMultiSelect, renderAvatarStack } from '../public/components/user-multi-select.js';

const members = [
  { id: 1, display_name: 'Alex', username: 'alex.one', avatar_color: '#123456' },
  { id: 2, display_name: 'Alex', username: 'alex.two', avatar_color: '#654321' },
  { id: 3, display_name: 'Riley', username: 'riley', avatar_color: '#123456' },
];
test('assignment choices expose the same disambiguated names visually and retain member IDs', () => {
  const html = renderUserMultiSelect(members, [2], 'assignees', 'tasks.assigned');
  assert.match(html, /Alex \(alex.one\)/);
  assert.match(html, /Alex \(alex.two\)/);
  assert.doesNotMatch(html, /Riley \(riley\)/);
  assert.match(html, /value="2" checked/);
});
test('a one-avatar subset still detects a collision against the supplied household roster', () => {
  const html = renderAvatarStack([members[0]], { members });
  assert.match(html, /title="Alex \(alex.one\)"/);
  assert.match(html, />\s*A\s*</);
});
test('suffixes are escaped at HTML boundaries', () => {
  const people = members.map(m => ({ ...m, username: '<private&name>' }));
  const html = renderUserMultiSelect(people, [], 'people', 'tasks.assigned');
  assert.match(html, /Alex \(&lt;private&amp;name&gt;\)/);
  assert.doesNotMatch(html, /<private&name>/);
});
