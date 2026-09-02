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
import { evaluatePresence } from './presence.js';

export const PROFICIENCY = Object.freeze({
  EXCLUDED: 'excluded',
  SUPERVISED: 'supervised',
  NORMAL: 'normal',
});

export const BUILT_IN_SKILL_KEYS = Object.freeze({
  MEAL_CHOOSING: 'meal_choosing',
  MEAL_PREPARATION: 'meal_preparation',
  COOKING: 'cooking',
  MEAL_SUPERVISION: 'meal_supervision',
  SERVING: 'serving',
  CLEANUP: 'cleanup',
});

export const ASSIGNMENT_STRATEGIES = Object.freeze([
  'subject_skill',
  'eligible_round_robin',
  'eligible_random',
  'open_claimable',
  'rotating_multi',
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
  // Guest and housekeeping-worker accounts are real login users but are not
  // household chore participants. Keep them out of subject pickers and every
  // automatically derived eligible rotation.
  return d.prepare(`
    SELECT u.id, u.display_name, u.family_role, b.birth_date
      FROM users u
      LEFT JOIN birthdays b ON b.family_user_id = u.id
     WHERE NOT EXISTS (
       SELECT 1 FROM split_expense_guest_users g WHERE g.user_id = u.id
     )
       AND NOT EXISTS (
       SELECT 1 FROM housekeeping_workers hw WHERE hw.user_id = u.id
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
  // `skills.active` controls whether an admin can choose a skill for NEW
  // configuration. It must not erase a requirement already attached to an
  // activity: deactivating an adult-only or age-gated skill must never make an
  // existing activity silently unrestricted.
  return d.prepare(`
    SELECT s.*, ats.sort_order
      FROM activity_template_skills ats
      JOIN skills s ON s.id = ats.skill_id
     WHERE ats.activity_template_id = ?
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
  // Built-in household skills must remain usable for clearly identified adult
  // household roles even when an older installation has no birthday recorded.
  // Custom skills retain their existing age-unknown behavior.
  const eligibilityAge = age ?? (skill.system_key && definitelyAdult(member, age) ? 18 : null);
  if (eligibilityAge === null && minimumAge > 0) {
    return {
      proficiency: PROFICIENCY.EXCLUDED,
      source: 'automatic',
      age,
      reason: 'age_unknown',
    };
  }
  if (eligibilityAge !== null && eligibilityAge < minimumAge) {
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

export function eligibleUserIdsForBuiltInSkill(
  d,
  systemKey,
  userIds,
  { dateKey = todayKey(d), includeSupervised = false } = {},
) {
  const skill = d.prepare('SELECT * FROM skills WHERE system_key = ? AND active = 1').get(systemKey);
  if (!skill) return [];
  const candidates = new Set((userIds || []).map(Number));
  return householdMembers(d)
    .filter((member) => candidates.has(Number(member.id)))
    .filter((member) => {
      const proficiency = effectiveSkillProficiency(d, skill, member, dateKey).proficiency;
      return proficiency === PROFICIENCY.NORMAL
        || (includeSupervised && proficiency === PROFICIENCY.SUPERVISED);
    })
    .map((member) => Number(member.id));
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

/**
 * Pick the next eligible member without letting an eligibility change reset the
 * rotation to the first person. `orderedMembers` is the stable household order;
 * an excluded/supervised previous assignee still provides a place to continue
 * scanning from, while only members in `eligible` can actually be selected.
 */
function chooseRoundRobin(d, activityTemplateId, purpose, eligible, {
  commit = false,
  orderedMembers = eligible,
} = {}) {
  if (!eligible.length) return null;
  const eligibleById = new Map(eligible.map((member) => [Number(member.id), member]));
  const order = orderedMembers
    .map((member) => Number(member.id))
    .filter((id, index, ids) => Number.isInteger(id) && ids.indexOf(id) === index);
  // Defensive fallback for a caller that supplied a partial order.
  for (const member of eligible) {
    const id = Number(member.id);
    if (!order.includes(id)) order.push(id);
  }

  const state = d.prepare(`
    SELECT last_user_id
      FROM activity_rotation_state
     WHERE activity_template_id = ? AND purpose = ?
  `).get(activityTemplateId, purpose);

  let selected = null;
  if (state?.last_user_id != null) {
    const previous = order.indexOf(Number(state.last_user_id));
    if (previous >= 0) {
      for (let offset = 1; offset <= order.length; offset += 1) {
        const candidate = eligibleById.get(order[(previous + offset) % order.length]);
        if (candidate) {
          selected = candidate;
          break;
        }
      }
    }
  }
  if (!selected) {
    selected = order.map((id) => eligibleById.get(id)).find(Boolean) ?? eligible[0];
  }

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

function assignmentPolicy(activity, override = null) {
  return override || activity.assignment_policy || activity.assignment_strategy || 'subject_skill';
}

function rotationKey(activity, purpose = 'primary') {
  return activity.rotation_group
    ? `activity-group:${activity.rotation_group}:${purpose}`
    : `activity:${activity.id}:${purpose}`;
}

function chooseRotatingMembers(d, activity, eligible, count, {
  commit = false,
  purpose = 'primary',
  orderedMembers = eligible,
} = {}) {
  if (!eligible.length || count < 1) return [];
  const key = rotationKey(activity, purpose);
  const eligibleById = new Map(eligible.map((member) => [Number(member.id), member]));
  const order = orderedMembers.map((member) => Number(member.id));
  const state = d.prepare('SELECT cursor_user_id FROM assignment_rotation_state WHERE rotation_key = ?').get(key);
  const previous = state?.cursor_user_id == null ? -1 : order.indexOf(Number(state.cursor_user_id));
  const selected = [];
  for (let offset = 1; offset <= order.length && selected.length < Math.min(count, eligible.length); offset += 1) {
    const member = eligibleById.get(order[(previous + offset + order.length) % order.length]);
    if (member && !selected.some((row) => Number(row.id) === Number(member.id))) selected.push(member);
  }
  if (commit && selected.length) {
    d.prepare(`
      INSERT INTO assignment_rotation_state (rotation_key, cursor_user_id, occurrence_count, updated_at)
      VALUES (?, ?, 1, strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
      ON CONFLICT(rotation_key) DO UPDATE SET
        cursor_user_id = excluded.cursor_user_id,
        occurrence_count = assignment_rotation_state.occurrence_count + 1,
        updated_at = excluded.updated_at
    `).run(key, selected.at(-1).id);
  }
  return selected;
}

export function eligibleMembersForActivity(d, activity, {
  dateKey = todayKey(d),
  presence = null,
  includeSupervised = false,
} = {}) {
  return householdMembers(d).filter((member) => {
    const proficiency = effectiveActivityProficiency(d, activity.id, member, dateKey).proficiency;
    if (proficiency !== PROFICIENCY.NORMAL && !(includeSupervised && proficiency === PROFICIENCY.SUPERVISED)) return false;
    const policy = presence?.policy || activity.presence_policy || 'ignore';
    if (policy === 'ignore') return true;
    try {
      return evaluatePresence(d, {
        userId: member.id,
        startAt: presence?.startAt || `${dateKey}T00:00:00`,
        endAt: presence?.endAt || `${dateKey}T23:59:00`,
        targetPlaceId: presence?.targetPlaceId ?? activity.place_id ?? null,
        policy,
      }).eligible;
    } catch { return false; }
  });
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
  presence = null,
  assignmentPolicyOverride = null,
  fixedUserIdOverride = null,
  random = Math.random,
} = {}) {
  const members = householdMembers(d);
  const subject = subjectUserId == null
    ? null
    : members.find((member) => Number(member.id) === Number(subjectUserId)) ?? null;

  if (activity.subject_required && !subject) {
    throw new Error('This activity requires a household member subject.');
  }

  const isPresent = (member) => {
    const policy = presence?.policy || activity.presence_policy || 'ignore';
    if (policy === 'ignore') return true;
    try {
      return evaluatePresence(d, {
        userId: member.id,
        startAt: presence?.startAt || `${dateKey}T00:00:00`,
        endAt: presence?.endAt || `${dateKey}T23:59:00`,
        targetPlaceId: presence?.targetPlaceId ?? activity.place_id ?? null,
        policy,
      }).eligible;
    } catch { return false; }
  };

  const policy = assignmentPolicy(activity, assignmentPolicyOverride);

  if (policy === 'fixed') {
    const fixedId = fixedUserIdOverride ?? activity.fixed_user_id;
    const fixed = members.find((member) => Number(member.id) === Number(fixedId));
    if (!fixed) throw new Error('The fixed assignee is no longer available.');
    // Fixed means "this specific qualified person", not "ignore the skill
    // engine". Otherwise an adult-only requirement could be bypassed simply by
    // selecting a child as the fixed assignee.
    const fixedProficiency = effectiveActivityProficiency(d, activity.id, fixed, dateKey);
    if (fixedProficiency.proficiency !== PROFICIENCY.NORMAL) {
      throw new Error('The fixed assignee is not independently qualified for this activity.');
    }
    if (!isPresent(fixed)) throw new Error('The fixed assignee does not meet this activity’s presence requirement.');
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

  const eligible = members.filter((member) =>
    effectiveActivityProficiency(d, activity.id, member, dateKey).proficiency === PROFICIENCY.NORMAL
    && isPresent(member)
  );

  if (policy === 'eligible_round_robin') {
    const primary = activity.rotation_group
      ? chooseRotatingMembers(d, activity, eligible, 1, {
        commit: commitRotation,
        orderedMembers: members,
      })[0]
      : chooseRoundRobin(d, activity.id, 'primary', eligible, {
        commit: commitRotation,
        orderedMembers: members,
      });
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

  if (policy === 'eligible_random') {
    if (!eligible.length) throw new Error('No household member is currently qualified for this activity.');
    const bounded = Math.min(0.999999999999, Math.max(0, Number(random()) || 0));
    const primary = eligible[Math.floor(bounded * eligible.length)];
    return { primary, supervisor: null, participants: [primary], subject, subjectProficiency: subject
      ? effectiveActivityProficiency(d, activity.id, subject, dateKey) : null, eligible, strategy: policy };
  }

  if (policy === 'open_claimable') {
    return {
      primary: null,
      supervisor: null,
      participants: [],
      subject,
      subjectProficiency: subject ? effectiveActivityProficiency(d, activity.id, subject, dateKey) : null,
      eligible,
      strategy: policy,
      unavailable: eligible.length === 0,
    };
  }

  if (policy === 'rotating_multi') {
    const requested = Math.max(1, Number(activity.participant_count) || 1);
    const selected = chooseRotatingMembers(d, activity, eligible, requested, {
      commit: commitRotation,
      orderedMembers: members,
    });
    if (!selected.length) throw new Error('No household member is currently qualified for this activity.');
    return {
      primary: selected[0], supervisor: null, participants: selected, subject,
      subjectProficiency: subject ? effectiveActivityProficiency(d, activity.id, subject, dateKey) : null,
      eligible, strategy: policy,
    };
  }

  // subject_skill: the subject does work they can do normally, gets a Normal
  // helper when excluded, and gets a separate supervisor when supervised.
  if (!subject) throw new Error('Subject-based assignment requires a household member subject.');
  const subjectProficiency = effectiveActivityProficiency(d, activity.id, subject, dateKey);
  const subjectMeetsPresence = isPresent(subject);

  if (subjectProficiency.proficiency === PROFICIENCY.NORMAL && subjectMeetsPresence) {
    return { primary: subject, supervisor: null, participants: [subject], subject, subjectProficiency, eligible: [subject], strategy: policy };
  }

  const eligibleHelpers = members.filter((member) =>
    Number(member.id) !== Number(subject.id)
    && effectiveActivityProficiency(d, activity.id, member, dateKey).proficiency === PROFICIENCY.NORMAL
    && isPresent(member)
  );
  const purpose = subjectProficiency.proficiency === PROFICIENCY.SUPERVISED ? 'supervisor' : 'primary';
  const helper = chooseRoundRobin(d, activity.id, purpose, eligibleHelpers, {
    commit: commitRotation,
    orderedMembers: members,
  });
  if (!helper) throw new Error('No qualified household member is available to help with this activity.');

  if (subjectProficiency.proficiency === PROFICIENCY.SUPERVISED && subjectMeetsPresence) {
    return {
      primary: subject,
      supervisor: helper,
      participants: [subject],
      subject,
      subjectProficiency,
      eligible: eligibleHelpers,
    };
  }

  return {
    primary: helper,
    supervisor: null,
    participants: [helper],
    subject,
    subjectProficiency,
    eligible: eligibleHelpers,
  };
}

export function assertEligibleActivityMember(d, activity, userId, options = {}) {
  const member = householdMembers(d).find((row) => Number(row.id) === Number(userId));
  if (!member) throw new Error('Choose a valid household member.');
  const proficiency = effectiveActivityProficiency(d, activity.id, member, options.dateKey || todayKey(d));
  if (proficiency.proficiency !== PROFICIENCY.NORMAL) {
    throw new Error('That household member is not independently qualified for this activity.');
  }
  if (!eligibleMembersForActivity(d, activity, options).some((row) => Number(row.id) === Number(member.id))) {
    throw new Error('That household member does not meet this activity\'s availability or presence requirements.');
  }
  return member;
}

export function renderActivityTitle(activity, subject) {
  const subjectName = subject?.display_name || '';
  return String(activity.title_template || activity.name || 'Activity')
    .replaceAll('{subject}', subjectName)
    .replaceAll('{activity}', activity.name || 'Activity')
    .trim();
}
