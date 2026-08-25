/**
 * Skills/proficiency and assignment resolution for reusable activity templates.
 *
 * The important split is deliberate:
 *   - skills describe capability;
 *   - member proficiency says how independently a person can use that skill;
 *   - activity templates say which skills a piece of work needs;
 *   - this service turns those facts into an assignee without storing a manual
 *     roster on every activity.
 */

import { todayKey } from '../utils/timezone.js';

export const PROFICIENCY = Object.freeze({
  EXCLUDED: 'excluded',
  SUPERVISED: 'supervised',
  NORMAL: 'normal',
});

export const ASSIGNMENT_STRATEGIES = Object.freeze([
  'subject_skill',
  'eligible_round_robin',
  'fixed',
]);

const PROFICIENCY_RANK = {
  [PROFICIENCY.EXCLUDED]: 0,
  [PROFICIENCY.SUPERVISED]: 1,
  [PROFICIENCY.NORMAL]: 2,
};

export function ageOnDate(birthDate, dateKey) {
  const birth = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(birthDate ?? ''));
  const today = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(dateKey ?? ''));
  if (!birth || !today) return null;
  const by = Number(birth[1]);
  const bm = Number(birth[2]);
  const bd = Number(birth[3]);
  const ty = Number(today[1]);
  const tm = Number(today[2]);
  const td = Number(today[3]);
  let age = ty - by;
  if (tm < bm || (tm === bm && td < bd)) age -= 1;
  return Number.isInteger(age) && age >= 0 ? age : null;
}

export function householdMembers(d) {
  // Shared-expense guest accounts are not household chore participants.
  return d.prepare(`
    SELECT u.id, u.display_name, u.family_role, b.birth_date
      FROM users u
      LEFT JOIN birthdays b ON b.family_user_id = u.id
     WHERE NOT EXISTS (
       SELECT 1 FROM split_expense_guest_users g WHERE g.user_id = u.id
     )
     ORDER BY u.id ASC
  `).all();
}

export function memberAge(d, userId, dateKey = todayKey(d)) {
  const row = d.prepare(`
    SELECT b.birth_date
      FROM birthdays b
     WHERE b.family_user_id = ?
     LIMIT 1
  `).get(userId);
  return ageOnDate(row?.birth_date, dateKey);
}

function definitelyAdult(member, age) {
  if (age !== null) return age >= 18;
  return ['dad', 'mom', 'parent', 'grandparent'].includes(member?.family_role);
}

export function loadSkillRequirements(d, activityTemplateId) {
  return d.prepare(`
    SELECT s.*, ats.sort_order
      FROM activity_template_skills ats
      JOIN skills s ON s.id = ats.skill_id
     WHERE ats.activity_template_id = ? AND s.active = 1
     ORDER BY ats.sort_order ASC, s.id ASC
  `).all(activityTemplateId);
}

/**
 * Effective proficiency has a safe automatic default and an optional manual
 * override. The hard adult-only guard wins over every override.
 */
export function effectiveSkillProficiency(d, skill, member, dateKey = todayKey(d)) {
  const age = ageOnDate(member?.birth_date, dateKey);

  if (skill.adult_only && !definitelyAdult(member, age)) {
    return {
      proficiency: PROFICIENCY.EXCLUDED,
      source: 'safety',
      age,
      reason: 'adult_only',
    };
  }

  const explicit = d.prepare(`
    SELECT proficiency, source
      FROM user_skill_proficiency
     WHERE user_id = ? AND skill_id = ?
  `).get(member.id, skill.id);

  if (explicit) {
    return {
      proficiency: explicit.proficiency,
      source: explicit.source || 'manual',
      age,
      reason: 'override',
    };
  }

  const minimumAge = skill.minimum_age == null ? 0 : Number(skill.minimum_age);
  if (age === null && minimumAge > 0) {
    return {
      proficiency: PROFICIENCY.EXCLUDED,
      source: 'automatic',
      age,
      reason: 'age_unknown',
    };
  }
  if (age !== null && age < minimumAge) {
    return {
      proficiency: PROFICIENCY.EXCLUDED,
      source: 'automatic',
      age,
      reason: 'under_age',
    };
  }

  return {
    proficiency: skill.age_promotion === PROFICIENCY.NORMAL
      ? PROFICIENCY.NORMAL
      : PROFICIENCY.SUPERVISED,
    source: 'automatic',
    age,
    reason: 'age_qualified',
  };
}

/** Lowest proficiency across all skills required by an activity. */
export function effectiveActivityProficiency(d, activityTemplateId, member, dateKey = todayKey(d)) {
  const skills = loadSkillRequirements(d, activityTemplateId);
  if (!skills.length) {
    return {
      proficiency: PROFICIENCY.NORMAL,
      source: 'no_skill_requirement',
      skills: [],
    };
  }

  const evaluated = skills.map((skill) => ({
    skill,
    ...effectiveSkillProficiency(d, skill, member, dateKey),
  }));
  evaluated.sort((a, b) => PROFICIENCY_RANK[a.proficiency] - PROFICIENCY_RANK[b.proficiency]);

  return {
    proficiency: evaluated[0].proficiency,
    source: evaluated[0].source,
    skills: evaluated,
  };
}

export function eligibleNormalMembers(d, activityTemplateId, { excludeUserIds = [], dateKey = todayKey(d) } = {}) {
  const excluded = new Set(excludeUserIds.map(Number));
  return householdMembers(d).filter((member) => {
    if (excluded.has(Number(member.id))) return false;
    return effectiveActivityProficiency(d, activityTemplateId, member, dateKey).proficiency === PROFICIENCY.NORMAL;
  });
}

function chooseRoundRobin(d, activityTemplateId, purpose, eligible, { commit = false } = {}) {
  if (!eligible.length) return null;
  const ids = eligible.map((member) => Number(member.id));
  const state = d.prepare(`
    SELECT last_user_id
      FROM activity_rotation_state
     WHERE activity_template_id = ? AND purpose = ?
  `).get(activityTemplateId, purpose);

  let index = 0;
  if (state?.last_user_id != null) {
    const previous = ids.indexOf(Number(state.last_user_id));
    if (previous >= 0) index = (previous + 1) % ids.length;
  }

  const selected = eligible[index];
  if (commit && selected) {
    d.prepare(`
      INSERT INTO activity_rotation_state (activity_template_id, purpose, last_user_id, updated_at)
      VALUES (?, ?, ?, strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
      ON CONFLICT(activity_template_id, purpose)
      DO UPDATE SET last_user_id = excluded.last_user_id, updated_at = excluded.updated_at
    `).run(activityTemplateId, purpose, selected.id);
  }
  return selected;
}

/**
 * Resolve one activity into concrete work.
 *
 * Returns a primary assignee and, when a supervised subject is doing the work,
 * a second Normal member to supervise. `commitRotation=false` is used for Quick
 * Add previews so looking at a preview never consumes somebody's turn.
 */
export function resolveActivityAssignment(d, activity, {
  subjectUserId = null,
  commitRotation = false,
  dateKey = todayKey(d),
} = {}) {
  const members = householdMembers(d);
  const subject = subjectUserId == null
    ? null
    : members.find((member) => Number(member.id) === Number(subjectUserId)) ?? null;

  if (activity.subject_required && !subject) {
    throw new Error('This activity requires a household member subject.');
  }

  if (activity.assignment_strategy === 'fixed') {
    const fixed = members.find((member) => Number(member.id) === Number(activity.fixed_user_id));
    if (!fixed) throw new Error('The fixed assignee is no longer available.');
    return {
      primary: fixed,
      supervisor: null,
      subject,
      subjectProficiency: subject
        ? effectiveActivityProficiency(d, activity.id, subject, dateKey)
        : null,
      eligible: [fixed],
    };
  }

  if (activity.assignment_strategy === 'eligible_round_robin') {
    const eligible = eligibleNormalMembers(d, activity.id, { dateKey });
    const primary = chooseRoundRobin(d, activity.id, 'primary', eligible, { commit: commitRotation });
    if (!primary) throw new Error('No household member is currently qualified for this activity.');
    return {
      primary,
      supervisor: null,
      subject,
      subjectProficiency: subject
        ? effectiveActivityProficiency(d, activity.id, subject, dateKey)
        : null,
      eligible,
    };
  }

  // subject_skill: the subject does work they can do normally, gets a Normal
  // helper when excluded, and gets a separate supervisor when supervised.
  if (!subject) throw new Error('Subject-based assignment requires a household member subject.');
  const subjectProficiency = effectiveActivityProficiency(d, activity.id, subject, dateKey);

  if (subjectProficiency.proficiency === PROFICIENCY.NORMAL) {
    return { primary: subject, supervisor: null, subject, subjectProficiency, eligible: [subject] };
  }

  const eligibleHelpers = eligibleNormalMembers(d, activity.id, {
    excludeUserIds: [subject.id],
    dateKey,
  });
  const purpose = subjectProficiency.proficiency === PROFICIENCY.SUPERVISED ? 'supervisor' : 'primary';
  const helper = chooseRoundRobin(d, activity.id, purpose, eligibleHelpers, { commit: commitRotation });
  if (!helper) throw new Error('No qualified household member is available to help with this activity.');

  if (subjectProficiency.proficiency === PROFICIENCY.SUPERVISED) {
    return {
      primary: subject,
      supervisor: helper,
      subject,
      subjectProficiency,
      eligible: eligibleHelpers,
    };
  }

  return {
    primary: helper,
    supervisor: null,
    subject,
    subjectProficiency,
    eligible: eligibleHelpers,
  };
}

export function renderActivityTitle(activity, subject) {
  const subjectName = subject?.display_name || '';
  return String(activity.title_template || activity.name || 'Activity')
    .replaceAll('{subject}', subjectName)
    .replaceAll('{activity}', activity.name || 'Activity')
    .trim();
}
