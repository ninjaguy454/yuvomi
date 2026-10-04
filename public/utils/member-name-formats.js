/** Shared rendered-name formats for household collision detection and presentation. */
export const displayName = member => String(member?.display_name ?? '');
export const firstDisplayName = member => displayName(member).trim().split(/\s+/)[0] || displayName(member);
export const collisionKey = value => String(value).trim().replace(/\s+/g, ' ').normalize('NFC').toLowerCase();
export function firstLastInitial(member) {
  const words = displayName(member).trim().split(/\s+/).filter(Boolean);
  const first = String(member?.first_name || words[0] || '').trim();
  const last = String(member?.last_name || (words.length > 1 ? words.at(-1) : '')).trim();
  return first + (last ? ` ${Array.from(last)[0]}.` : '');
}
export const MEMBER_NAME_FORMATS = Object.freeze({
  display: displayName,
  first: firstDisplayName,
  first_last_initial: firstLastInitial,
});
