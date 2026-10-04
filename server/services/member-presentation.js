import { todayKey } from '../utils/timezone.js';
import { ageOnCalendarDate } from '../../public/utils/member-age.js';

/** Household-only presentation fields. The paired caller must supply its allowed IDs.
 * Birthday is read only to calculate age and never leaves this projection.
 * No profile photos, contact fields, roles, credentials, or guest/worker accounts.
 */
export function householdMemberPresentation(d, { memberIds = null, today = todayKey(d) } = {}) {
  const allowed = memberIds === null ? null : new Set(memberIds.map(Number));
  const rows = d.prepare(`SELECT u.id,u.display_name,u.first_name,u.last_name,u.username,
      (SELECT birth_date FROM birthdays b WHERE b.family_user_id=u.id LIMIT 1) AS birth_date
    FROM users u
    WHERE NOT EXISTS(SELECT 1 FROM housekeeping_workers w WHERE w.user_id=u.id)
      AND NOT EXISTS(SELECT 1 FROM split_expense_guest_users g WHERE g.user_id=u.id)
    ORDER BY u.id`).all();
  return rows.filter(row => allowed === null || allowed.has(row.id)).map(row => ({
    id: row.id, display_name: row.display_name, first_name: row.first_name,
    last_name: row.last_name, username: row.username, age: ageOnCalendarDate(row.birth_date, today),
  }));
}
