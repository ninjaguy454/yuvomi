import test from 'node:test';
import assert from 'node:assert/strict';
import { memberLabel, memberAge, firstLastInitial, setMemberLabels, clearMemberLabels, memberLabelSnapshot } from '../public/utils/member-label.js';
import { acceptAuthentication, invalidateAuthentication, authenticationSnapshot } from '../public/utils/device-context.js';

const today = '2026-10-04';
const family = [
  { id: 1, display_name: 'Alex', birth_date: '2014-10-04', username: 'alex.one' },
  { id: 2, display_name: 'Alex', username: 'alex.two' },
  { id: 3, display_name: 'Riley', birth_date: '2011-01-01', username: 'riley' },
];
const label = (member, roster = family, options = {}) => memberLabel(member, roster, { today, ...options });

test('only household name collisions receive age or username parentheses', () => {
  assert.equal(label(family[0]), 'Alex (12)');
  assert.equal(label(family[1]), 'Alex (alex.two)');
  assert.equal(label(family[2]), 'Riley');
  assert.equal(label({ id: 1, display_name: 'Alex' }), 'Alex (12)');
  assert.equal(label({ id: 9, display_name: 'Alex', username: 'outsider' }), 'Alex');
});

test('missing or invalid identity fields leave the label unchanged or use username', () => {
  for (const birth_date of [null, '', 'not-a-date', '2027-01-01', '2015-02-29', '0000-01-01']) {
    const member = { id: 1, display_name: 'Alex', birth_date, username: 'alex.one' };
    assert.equal(label(member, [member, family[1]]), 'Alex (alex.one)');
  }
  const members = family.slice(0, 2).map(({ id, display_name }) => ({ id, display_name }));
  assert.equal(label(members[0], members), 'Alex');
  assert.equal(label(null), '');
});

test('age changes on the birthday using calendar dates, including leap birthdays and newborns', () => {
  assert.equal(memberAge('2014-10-05', today), 11);
  assert.equal(memberAge('2014-10-04', today), 12);
  assert.equal(memberAge('2014-10-03', today), 12);
  assert.equal(memberAge('2026-10-04', today), 0);
  assert.equal(memberAge('2020-02-29', '2025-02-28'), 4);
  assert.equal(memberAge('2020-02-29', '2025-03-01'), 5);
});

test('collisions are based on the rendered format, without changing stored names', () => {
  const members = [
    { id: 1, display_name: 'Alex Smith', first_name: 'Alex', last_name: 'Smith', username: 'smith' },
    { id: 2, display_name: 'Alex Stone', first_name: 'Alex', last_name: 'Stone', username: 'stone' },
    { id: 3, display_name: 'Riley', username: 'riley' },
  ];
  const original = JSON.stringify(members);
  assert.equal(label(members[0], members), 'Alex Smith');
  assert.equal(label(members[0], members, { format: firstLastInitial }), 'Alex S. (smith)');
  assert.equal(label(members[1], members, { format: firstLastInitial }), 'Alex S. (stone)');
  assert.equal(label(members[2], members, { format: firstLastInitial }), 'Riley');
  assert.equal(JSON.stringify(members), original);
});

test('duplicate rows, workers, and split guests do not create household collisions', () => {
  const member = family[0];
  for (const other of [{ ...member }, { ...family[1], is_worker: 1 }, { ...family[1], access_scope: 'split_guest' }]) {
    assert.equal(label(member, [member, other]), 'Alex');
  }
  const worker = { ...family[1], is_worker: 1 };
  assert.equal(label(worker, [family[0], worker]), 'Alex');
});

test('empty names are not collisions; whitespace and case do not conceal duplicate labels', () => {
  assert.equal(label({ id: 1, display_name: '', username: 'one' }, [{ id: 1, display_name: '' }, { id: 2, display_name: '' }]), '');
  const members = [{ ...family[0], display_name: ' Alex  ' }, { ...family[1], display_name: 'alex' }];
  assert.equal(label(members[0], members), ' Alex   (12)');
});

test('paired labels use only the current scoped projection and never a retained birthday or stale response', () => {
  globalThis.window = new EventTarget();
  const personal = memberLabelSnapshot();
  setMemberLabels(family.map(member => ({ ...member, age: 12 })));
  acceptAuthentication({ authContext: 'anonymous', principal: { kind: 'device' }, temporary: null });
  invalidateAuthentication();
  assert.equal(label(family[0]), 'Alex');
  assert.equal(label(family[1]), 'Alex');
  assert.equal(setMemberLabels(family, personal), false);
  setMemberLabels(family.map(member => ({ ...member, age: null })));
  assert.equal(label(family[0]), 'Alex (alex.one)', 'birthday is stripped from the household projection');
  setMemberLabels(family.map(member => ({ ...member, age: member.id === 1 ? 12 : null })));
  assert.equal(label(family[0]), 'Alex (12)');
  acceptAuthentication({ authContext: 'temporary', principal: { kind: 'device' }, temporary: { user_id: 1 } });
  assert.equal(label(family[0]), 'Alex', 'changing authentication invalidates the former roster');
  setMemberLabels(family.map(member => ({ ...member, age: 12 })));
  assert.equal(label(family[0]), 'Alex (12)');
  acceptAuthentication({ authContext: 'returned', principal: { kind: 'device' }, temporary: null });
  assert.equal(label(family[0]), 'Alex');
  acceptAuthentication({ authContext: 'personal', principal: { kind: 'member' } });
  invalidateAuthentication();
  clearMemberLabels();
  delete globalThis.window;
});

test('a filtered component uses the full current household roster for collisions', () => {
  setMemberLabels(family.map(member => ({ ...member, age: member.id === 1 ? 12 : null })));
  assert.equal(label({ id: 1, display_name: 'Alex' }, [{ id: 1, display_name: 'Alex' }]), 'Alex (12)');
  clearMemberLabels();
  assert.equal(label({ id: 1, display_name: 'Alex' }, [{ id: 1, display_name: 'Alex' }]), 'Alex');
});

test('late responses cannot restore labels after ordinary logout or an explicit clear', () => {
  const captured = memberLabelSnapshot();
  clearMemberLabels();
  assert.equal(setMemberLabels(family.map(member => ({ ...member, age: 12 })), captured), false);
  assert.equal(label(family[0]), 'Alex');
});

test('participant record IDs never substitute for their user IDs', () => {
  setMemberLabels([{ id: 1, display_name: 'Alex', age: 12 }, { id: 2, display_name: 'Alex', age: 40 }]);
  assert.equal(memberLabel({ id: 1, user_id: 2, display_name: 'Alex' }), 'Alex (40)');
  assert.equal(memberLabel({ id: 1, user_id: null, display_name: 'Alex' }), 'Alex');
  clearMemberLabels();
});
