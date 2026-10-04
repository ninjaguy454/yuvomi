import { isDevicePrincipal, authenticationSnapshot, sameAuthentication } from './device-context.js';
import { todayKey } from './timezone.js';
import { ageOnCalendarDate } from './member-age.js';
import { sessionRevision } from './session-lifecycle.js';

const displayName = member => String(member?.display_name ?? '');
const collisionKey = value => String(value).trim().replace(/\s+/g, ' ').normalize('NFC').toLocaleLowerCase();
const isHouseholdMember = member => member?.id != null && !member.is_worker && member.access_scope !== 'split_guest';

let roster = null, rosterContext = null, generation = 0, cleared = false;
export function memberLabelSnapshot() {
  return { authentication: authenticationSnapshot(), session: sessionRevision(), generation };
}
export function sameMemberLabelContext(captured) {
  return captured?.generation === generation && captured.session === sessionRevision() && sameAuthentication(captured.authentication);
}
export function clearMemberLabels() { generation++; roster = null; rosterContext = null; cleared = true; }
export function setMemberLabels(members, captured = memberLabelSnapshot()) {
  if (!sameMemberLabelContext(captured)) return false;
  roster = (members || []).map(({ id, display_name, first_name, last_name, age, username }) =>
    ({ id, display_name, first_name, last_name, age, username }));
  rosterContext = captured;
  cleared = false;
  return true;
}

/** Birthday age in the application's display timezone, without parsing dates as UTC instants. */
export function memberAge(birthDate, today = todayKey()) {
  return ageOnCalendarDate(birthDate, today);
}

/** Optional compact presentation; collision detection uses this rendered label too. */
export function firstLastInitial(member) {
  const words = displayName(member).trim().split(/\s+/).filter(Boolean);
  const first = String(member?.first_name || words[0] || '').trim();
  const last = String(member?.last_name || (words.length > 1 ? words.at(-1) : '')).trim();
  return first + (last ? ` ${Array.from(last)[0]}.` : '');
}

/**
 * Presentation only. The current authenticated household projection is preferred;
 * standalone components can pass an authorized roster, never an assignment subset.
 * No fetching, persistent storage, or record mutation.
 * Unknown members and projections without age/username retain their existing label.
 * Callers still escape the returned plain text at their HTML boundary.
 */
export function memberLabel(member, members = [], { format = displayName, today = todayKey() } = {}) {
  const current = roster !== null && sameMemberLabelContext(rosterContext);
  if (current) members = roster;
  const id = Object.hasOwn(member || {}, 'user_id') ? member.user_id : member?.id;
  const known = id == null ? null : members.find(person => String(person?.id) === String(id));
  const person = { ...known, ...member, id };
  const name = String(format(person) ?? '');
  if (!name.trim() || cleared || (rosterContext && !current) || (isDevicePrincipal() && !current) || !isHouseholdMember(person) || !known) return name;
  const key = collisionKey(name);
  const duplicate = members.some(other => isHouseholdMember(other)
    && String(other.id) !== String(person.id) && collisionKey(format(other)) === key);
  if (!duplicate) return name;
  const identity = current ? known : person;
  const birthdayAge = current ? null : memberAge(identity.birth_date, today);
  const age = birthdayAge ?? (Number.isInteger(identity.age) && identity.age >= 0 ? identity.age : null);
  const suffix = age ?? (typeof identity.username === 'string' ? identity.username.trim() : '');
  return suffix === '' || suffix == null ? name : `${name} (${suffix})`;
}
