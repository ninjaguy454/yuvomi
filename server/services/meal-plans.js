import { createHash, randomUUID } from 'node:crypto';
import { addDays, mealWeekday } from './meal-recurrence.js';
import { evaluatePresence } from './presence.js';
import { normalizeDishSelection, syncAutoPortions } from './meal-dishes.js';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
const MEAL_TYPES = new Set(['breakfast', 'lunch', 'dinner', 'snack', 'custom']);
const POLICIES = new Set(['fixed', 'round_robin', 'personal_choice']);
const BACKUP_STRATEGIES = new Set(['next_eligible', 'random_eligible', 'fixed']);
const TERMINAL_CHOOSER_STRATEGIES = new Set(['personal_choice', 'eligible_round_robin', 'fixed']);
const DELEGATION_STRATEGIES = new Set(['none', 'fixed', 'round_robin']);
const DEADLINE_MODES = new Set(['relative', 'weekly_cutoff']);
const DEADLINE_UNITS = new Map([['minutes', 1], ['hours', 60], ['days', 1440]]);
const EXECUTION_ROLES = ['preparation', 'cooking', 'supervision', 'serving', 'cleanup'];
const EXECUTION_ASSIGNMENT_STRATEGIES = new Set([
  'cook', 'supervisor', 'chooser', 'eligible_round_robin', 'open_claimable',
]);
const PLAN_STATUSES = new Set(['active', 'archived']);
const PARTICIPATION = new Set(['participating', 'not_participating', 'away', 'pending']);
const CHOICE_KINDS = new Set(['household', 'backup', 'personal', 'restaurant', 'takeout', 'pending']);
const MENU_ITEM_TYPES = new Set(['entree', 'side', 'backup']);

function mealPlanError(message, status = 400, code = 'INVALID_MEAL_PLAN') {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  return error;
}

function text(value, { required = false, max = 2000, field = 'Value' } = {}) {
  const clean = value == null ? '' : String(value).trim();
  if (required && !clean) throw mealPlanError(`${field} is required.`);
  if (clean.length > max) throw mealPlanError(`${field} may be at most ${max} characters long.`);
  return clean || null;
}

function integer(value, { fallback = null, min = null, max = null, field = 'Value' } = {}) {
  const number = value == null || value === '' ? fallback : Number(value);
  if (number == null) return null;
  if (!Number.isInteger(number) || (min != null && number < min) || (max != null && number > max)) {
    throw mealPlanError(`${field} is invalid.`);
  }
  return number;
}

function bool(value, fallback = false) {
  if (value == null) return fallback;
  return value === true || value === 1 || value === '1';
}

function parseJson(value, fallback = null) {
  try { return value == null ? fallback : JSON.parse(value); } catch { return fallback; }
}

function deadlineHumanFields(minutes) {
  const total = Math.max(0, Number(minutes) || 0);
  if (total > 0 && total % 1440 === 0) return { selection_deadline_value: total / 1440, selection_deadline_unit: 'days' };
  if (total > 0 && total % 60 === 0) return { selection_deadline_value: total / 60, selection_deadline_unit: 'hours' };
  return { selection_deadline_value: total, selection_deadline_unit: 'minutes' };
}

function normalizeExecutionAssignments(raw, current = null) {
  const currentValue = parseJson(current?.execution_assignment_strategies_json, current?.execution_assignment_strategies || {});
  const source = raw?.execution_assignment_strategies ?? currentValue ?? {};
  if (!source || typeof source !== 'object' || Array.isArray(source)) {
    throw mealPlanError('Execution assignment strategies must be an object keyed by Task kind.');
  }
  const normalized = {};
  for (const role of EXECUTION_ROLES) {
    const value = source[role];
    if (value == null || value === '') continue;
    if (!EXECUTION_ASSIGNMENT_STRATEGIES.has(String(value))) {
      throw mealPlanError(`Choose a valid assignment strategy for ${role}.`);
    }
    normalized[role] = String(value);
  }
  return normalized;
}

function normalizeDeadline(raw, current = null) {
  const nested = raw?.deadline && typeof raw.deadline === 'object' ? raw.deadline : {};
  const mode = String(raw?.deadline_mode ?? nested.mode ?? current?.deadline_mode ?? 'relative');
  if (!DEADLINE_MODES.has(mode)) throw mealPlanError('Choose a relative or weekly cutoff deadline.');
  let minutes;
  const humanValue = raw?.selection_deadline_value ?? nested.value;
  const humanUnit = String(raw?.selection_deadline_unit ?? nested.unit ?? 'minutes');
  if (humanValue != null && humanValue !== '') {
    if (!DEADLINE_UNITS.has(humanUnit)) throw mealPlanError('Selection deadline units must be minutes, hours, or days.');
    const value = Number(humanValue);
    minutes = value * DEADLINE_UNITS.get(humanUnit);
  } else {
    minutes = raw?.selection_deadline_minutes ?? current?.selection_deadline_minutes ?? 1440;
  }
  minutes = integer(minutes, { min: 0, max: 10080, field: 'Selection deadline' });
  const deadlineWeekday = integer(raw?.deadline_weekday ?? nested.weekday ?? current?.deadline_weekday, {
    min: 0, max: 6, field: 'Weekly deadline weekday',
  });
  const deadlineTime = assertTime(raw?.deadline_time ?? nested.time ?? current?.deadline_time, 'Weekly deadline time');
  if (mode === 'weekly_cutoff' && (deadlineWeekday == null || !deadlineTime)) {
    throw mealPlanError('A weekly cutoff needs a weekday and local time.');
  }
  return {
    deadline_mode: mode,
    selection_deadline_minutes: minutes,
    deadline_weekday: mode === 'weekly_cutoff' ? deadlineWeekday : null,
    deadline_time: mode === 'weekly_cutoff' ? deadlineTime : null,
  };
}

function assertDate(value, field, { optional = false } = {}) {
  if ((value == null || value === '') && optional) return null;
  const clean = String(value || '');
  const parsed = new Date(`${clean}T00:00:00Z`);
  if (!DATE_RE.test(clean) || Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== clean) {
    throw mealPlanError(`${field} must use a valid YYYY-MM-DD date.`);
  }
  return clean;
}

function assertTime(value, field) {
  if (value == null || value === '') return null;
  if (!TIME_RE.test(String(value))) throw mealPlanError(`${field} must use HH:MM.`);
  return String(value);
}

function householdMembers(database) {
  return database.prepare(`
    SELECT u.id, u.display_name, u.avatar_color, u.role
      FROM users u
     WHERE NOT EXISTS (SELECT 1 FROM split_expense_guest_users g WHERE g.user_id = u.id)
       AND NOT EXISTS (SELECT 1 FROM housekeeping_workers hw WHERE hw.user_id = u.id)
     ORDER BY u.display_name COLLATE NOCASE, u.id
  `).all();
}

function assertUserIds(database, ids) {
  const valid = new Set(householdMembers(database).map((row) => Number(row.id)));
  for (const id of ids.filter(Boolean)) {
    if (!valid.has(Number(id))) throw mealPlanError('Choose a valid household member.');
  }
}

function orderedUserIds(value, { field = 'Household members', duplicateCode = 'DUPLICATE_HOUSEHOLD_MEMBER' } = {}) {
  if (value == null) return [];
  if (!Array.isArray(value)) {
    throw mealPlanError(`${field} must be an ordered list of household members.`, 400, 'INVALID_HOUSEHOLD_MEMBER_LIST');
  }
  const ids = value.map((raw) => integer(raw, { min: 1, field }));
  if (new Set(ids).size !== ids.length) {
    throw mealPlanError(`${field} cannot contain the same household member more than once.`, 409, duplicateCode);
  }
  return ids;
}

export function getMealPlanDefaultSettings(database) {
  const row = database.prepare('SELECT * FROM meal_plan_default_settings WHERE id = 1').get();
  if (!row) throw mealPlanError('Meal Plan Default Settings are unavailable.', 500, 'MEAL_PLAN_DEFAULTS_MISSING');
  return {
    ...row,
    chooser_round_robin_user_ids: orderedUserIds(
      parseJson(row.chooser_round_robin_user_ids_json, []),
      { field: 'Eligible round-robin group', duplicateCode: 'DUPLICATE_CHOOSER_ROUND_ROBIN_MEMBER' },
    ),
  };
}

export function saveMealPlanDefaultSettings(database, body, actorId) {
  const current = getMealPlanDefaultSettings(database);
  const strategy = String(body?.chooser_terminal_strategy ?? current.chooser_terminal_strategy);
  if (!TERMINAL_CHOOSER_STRATEGIES.has(strategy)) {
    throw mealPlanError(
      'Choose Personal Choice, eligible round robin, or a fixed last-resort member.',
      400,
      'INVALID_CHOOSER_TERMINAL_STRATEGY',
    );
  }
  const terminalUserId = integer(
    body?.chooser_terminal_user_id ?? current.chooser_terminal_user_id,
    { field: 'Fixed last-resort chooser' },
  );
  const roundRobinIds = orderedUserIds(
    body?.chooser_round_robin_user_ids ?? current.chooser_round_robin_user_ids,
    { field: 'Eligible round-robin group', duplicateCode: 'DUPLICATE_CHOOSER_ROUND_ROBIN_MEMBER' },
  );
  assertUserIds(database, [terminalUserId, ...roundRobinIds]);
  if (strategy === 'fixed' && !terminalUserId) {
    throw mealPlanError(
      'Choose the household member who should receive the last-resort meal request.',
      409,
      'FIXED_CHOOSER_TERMINAL_MEMBER_REQUIRED',
    );
  }
  database.prepare(`
    UPDATE meal_plan_default_settings
       SET chooser_terminal_strategy = ?, chooser_terminal_user_id = ?,
           chooser_round_robin_user_ids_json = ?, updated_by = ?,
           updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
     WHERE id = 1
  `).run(
    strategy,
    strategy === 'fixed' ? terminalUserId : null,
    JSON.stringify(roundRobinIds),
    actorId || null,
  );
  return getMealPlanDefaultSettings(database);
}

function normalizeRule(database, raw, index, current = null) {
  const weekday = integer(raw?.weekday ?? current?.weekday, { min: 0, max: 6, field: 'Weekday' });
  const mealType = String(raw?.meal_type ?? current?.meal_type ?? '');
  const policy = String(raw?.policy ?? current?.policy ?? 'fixed');
  if (weekday == null || !MEAL_TYPES.has(mealType)) throw mealPlanError('Choose a valid weekday and meal type.');
  if (!POLICIES.has(policy)) throw mealPlanError('Choose a valid meal-selection policy.');
  const customLabel = text(raw?.custom_label ?? current?.custom_label, { max: 160, field: 'Custom meal label' });
  if (mealType === 'custom' && !customLabel) throw mealPlanError('Name the custom meal slot.');

  let chooserBackupStrategy = String(
    raw?.chooser_backup_strategy
      ?? current?.chooser_backup_strategy
      ?? ((raw?.fallback_user_id ?? current?.fallback_user_id) ? 'fixed' : 'next_eligible'),
  );
  if (!BACKUP_STRATEGIES.has(chooserBackupStrategy)) throw mealPlanError('Choose a valid chooser backup strategy.');
  const cookStrategy = String(
    raw?.cook_strategy ?? current?.cook_strategy ?? ((raw?.cook_user_id ?? current?.cook_user_id) ? 'fixed' : 'none'),
  );
  const supervisorStrategy = String(
    raw?.supervisor_strategy ?? current?.supervisor_strategy
      ?? ((raw?.supervisor_user_id ?? current?.supervisor_user_id) ? 'fixed' : 'none'),
  );
  if (!DELEGATION_STRATEGIES.has(cookStrategy) || !DELEGATION_STRATEGIES.has(supervisorStrategy)) {
    throw mealPlanError('Choose none, fixed, or round robin for cook and supervisor delegation.');
  }

  const earliest = assertTime(raw?.earliest_time, 'Earliest time');
  const preferred = assertTime(raw?.preferred_time, 'Preferred time');
  const latest = assertTime(raw?.latest_time, 'Latest time');
  const ordered = [earliest, preferred, latest].filter(Boolean);
  if (ordered.some((value, position) => position > 0 && ordered[position - 1] > value)) {
    throw mealPlanError('Meal timing must run from earliest to preferred to latest.');
  }

  const participantIds = [...new Set((Array.isArray(raw?.participant_ids)
    ? raw.participant_ids
    : (current?.participant_ids || []))
    .map(Number).filter(Number.isInteger))];
  const fixedUserId = integer(raw?.fixed_user_id ?? current?.fixed_user_id, { field: 'Fixed chooser' });
  let fallbackUserId = integer(raw?.fallback_user_id ?? current?.fallback_user_id, { field: 'Fallback chooser' });
  const storedFallbackIds = parseJson(current?.chooser_fallback_user_ids_json, current?.chooser_fallback_user_ids);
  const explicitFallbackList = Array.isArray(raw?.chooser_fallback_user_ids);
  let chooserFallbackUserIds;
  if (explicitFallbackList) {
    chooserFallbackUserIds = orderedUserIds(raw.chooser_fallback_user_ids, {
      field: 'Ordered backup choosers',
      duplicateCode: 'DUPLICATE_CHOOSER_FALLBACK',
    });
  } else if (Object.hasOwn(raw || {}, 'fallback_user_id')) {
    chooserFallbackUserIds = fallbackUserId ? [fallbackUserId] : [];
  } else if (Array.isArray(storedFallbackIds)) {
    chooserFallbackUserIds = orderedUserIds(storedFallbackIds, {
      field: 'Ordered backup choosers',
      duplicateCode: 'DUPLICATE_CHOOSER_FALLBACK',
    });
  } else {
    chooserFallbackUserIds = fallbackUserId ? [fallbackUserId] : [];
  }
  const cookUserId = integer(raw?.cook_user_id ?? current?.cook_user_id, { field: 'Cook' });
  const supervisorUserId = integer(raw?.supervisor_user_id ?? current?.supervisor_user_id, { field: 'Supervisor' });
  if (policy === 'personal_choice') {
    fallbackUserId = null;
    chooserFallbackUserIds = [];
    chooserBackupStrategy = 'next_eligible';
  }
  if (fixedUserId && chooserFallbackUserIds.includes(fixedUserId) && explicitFallbackList) {
    throw mealPlanError(
      'The primary chooser cannot also appear in the ordered backup chooser list.',
      409,
      'CHOOSER_FALLBACK_REPEATS_PRIMARY',
    );
  }
  // Some released legacy slots stored the primary chooser in the single
  // fallback column. Keep those payloads readable without making the primary
  // a second fallback attempt in the new ordered chain.
  chooserFallbackUserIds = chooserFallbackUserIds.filter((userId) => userId !== fixedUserId);
  if (!explicitFallbackList && chooserBackupStrategy === 'fixed' && !chooserFallbackUserIds.length) {
    chooserBackupStrategy = 'next_eligible';
  }
  fallbackUserId = chooserFallbackUserIds[0] || null;
  // A fixed chooser is also a diner in the shared household meal. Make that
  // invariant explicit in authored plans instead of creating a chooser-only
  // responsibility that cannot truthfully submit the main meal.
  if (policy === 'fixed' && fixedUserId && !participantIds.includes(fixedUserId)) {
    participantIds.push(fixedUserId);
  }
  assertUserIds(database, [
    fixedUserId, ...chooserFallbackUserIds, cookUserId, supervisorUserId, ...participantIds,
  ]);
  if (chooserBackupStrategy === 'fixed' && !fallbackUserId && policy !== 'personal_choice') {
    throw mealPlanError(
      'Add at least one ordered backup chooser or choose an eligible backup strategy.',
      409,
      'FIXED_CHOOSER_FALLBACK_REQUIRED',
    );
  }
  if (cookStrategy === 'fixed' && !cookUserId) throw mealPlanError('Choose the fixed cook.');
  if (supervisorStrategy === 'fixed' && !supervisorUserId) throw mealPlanError('Choose the fixed supervisor.');

  const placeId = integer(raw?.place_id ?? current?.place_id, { field: 'Place' });
  if (placeId && !database.prepare('SELECT 1 FROM places WHERE id = ?').get(placeId)) {
    throw mealPlanError('Place not found.', 404, 'PLACE_NOT_FOUND');
  }

  const deadline = normalizeDeadline(raw, current);
  const executionAssignments = normalizeExecutionAssignments(raw, current);
  const slotGroupKey = text(raw?.slot_group_key ?? current?.slot_group_key, {
    max: 120, field: 'Slot group key',
  }) || `slot-group:${randomUUID()}`;
  return {
    id: integer(raw?.id ?? current?.id, { field: 'Meal Plan rule' }),
    rule_key: text(raw?.rule_key ?? current?.rule_key, { max: 120, field: 'Rule key' }) || `rule:${randomUUID()}`,
    slot_group_key: slotGroupKey,
    weekday,
    meal_type: mealType,
    custom_label: mealType === 'custom' ? customLabel : null,
    label: text(raw?.label ?? current?.label, { max: 160, field: 'Rule label' }),
    policy,
    fixed_user_id: fixedUserId,
    fallback_user_id: fallbackUserId,
    chooser_fallback_user_ids: chooserFallbackUserIds,
    chooser_fallback_user_ids_json: JSON.stringify(chooserFallbackUserIds),
    chooser_backup_strategy: chooserBackupStrategy,
    rotation_group: text(raw?.rotation_group ?? current?.rotation_group, { max: 160, field: 'Rotation group' }),
    presence_required: bool(raw?.presence_required, Boolean(current?.presence_required)) ? 1 : 0,
    place_id: placeId,
    earliest_time: earliest,
    preferred_time: preferred,
    latest_time: latest,
    expected_duration_minutes: integer(raw?.expected_duration_minutes, { min: 1, max: 720, field: 'Expected duration' }),
    ...deadline,
    reminder_minutes: integer(raw?.reminder_minutes, { fallback: Number(current?.reminder_minutes ?? 120), min: 0, max: 10080, field: 'Reminder lead time' }),
    // `choice_limit` is the legacy compatibility column and remains at least
    // one even when the canonical side-option maximum is intentionally zero.
    choice_limit: Math.max(1, integer(raw?.choice_limit ?? raw?.snack_choice_limit, {
      fallback: 3, min: 0, max: 20, field: 'Choice limit',
    })),
    max_entree_choices: integer(raw?.max_entree_choices ?? current?.max_entree_choices, {
      fallback: 1, min: 0, max: 9, field: 'Maximum entrée choices',
    }),
    max_side_choices: integer(raw?.max_side_choices ?? current?.max_side_choices, {
      fallback: Math.min(9, Math.max(0, Number(current?.choice_limit ?? 3))),
      min: 0, max: 9, field: 'Maximum side choices',
    }),
    cook_user_id: cookUserId,
    cook_strategy: cookStrategy,
    cook_rotation_group: text(raw?.cook_rotation_group ?? current?.cook_rotation_group, { max: 160, field: 'Cook rotation group' }),
    supervisor_user_id: supervisorUserId,
    supervisor_strategy: supervisorStrategy,
    supervisor_rotation_group: text(raw?.supervisor_rotation_group ?? current?.supervisor_rotation_group, { max: 160, field: 'Supervisor rotation group' }),
    execution_assignment_strategies: executionAssignments,
    execution_assignment_strategies_json: JSON.stringify(executionAssignments),
    generate_preparation: bool(raw?.generate_preparation, true) ? 1 : 0,
    generate_cooking: bool(raw?.generate_cooking, true) ? 1 : 0,
    generate_supervision: bool(raw?.generate_supervision, true) ? 1 : 0,
    generate_serving: bool(raw?.generate_serving, true) ? 1 : 0,
    generate_cleanup: bool(raw?.generate_cleanup, true) ? 1 : 0,
    preparation_duration_minutes: integer(raw?.preparation_duration_minutes ?? raw?.preparation_minutes, { fallback: 60, min: 0, max: 1440, field: 'Preparation duration' }),
    cooking_duration_minutes: integer(raw?.cooking_duration_minutes ?? raw?.cooking_minutes, { fallback: 30, min: 0, max: 1440, field: 'Cooking duration' }),
    cleanup_duration_minutes: integer(raw?.cleanup_duration_minutes ?? raw?.cleanup_minutes, { fallback: 60, min: 0, max: 1440, field: 'Cleanup duration' }),
    active: bool(raw?.active, true) ? 1 : 0,
    sort_order: integer(raw?.sort_order, { fallback: index, min: 0, max: 10000, field: 'Sort order' }),
    participant_ids: participantIds,
  };
}

function normalizePlan(database, body, current = null) {
  const name = text(body?.name ?? current?.name, { required: true, max: 200, field: 'Meal Plan name' });
  const description = text(body?.description ?? current?.description, { max: 4000, field: 'Description' });
  const status = String(body?.status ?? current?.status ?? 'active');
  if (!PLAN_STATUSES.has(status)) throw mealPlanError('Choose active or archived for the Meal Plan status.');
  const effectiveFrom = assertDate(body?.effective_from ?? current?.effective_from, 'Effective-from date', { optional: true });
  const effectiveUntil = assertDate(body?.effective_until ?? current?.effective_until, 'Effective-until date', { optional: true });
  if (effectiveFrom && effectiveUntil && effectiveUntil < effectiveFrom) {
    throw mealPlanError('Effective-until date must not precede effective-from date.');
  }
  const rawRules = body?.slot_groups ?? body?.rules ?? current?.rules ?? [];
  if (!Array.isArray(rawRules) || !rawRules.length) throw mealPlanError('Add at least one Meal Plan rule.');
  const currentRules = current?.rules || [];
  const rules = rawRules.flatMap((rule, index) => {
    const requested = Array.isArray(rule?.weekdays) && rule.weekdays.length
      ? rule.weekdays
      : [rule?.weekday];
    const weekdays = [...new Set(requested.map((weekday) => integer(weekday, {
      min: 0, max: 6, field: 'Weekday',
    })))];
    if (!weekdays.length || weekdays.some((weekday) => weekday == null)) {
      throw mealPlanError('Choose at least one valid weekday for each Meal Plan slot.');
    }
    const priorForGroup = currentRules.find((candidate) => (
      (rule?.slot_group_key && candidate.slot_group_key === rule.slot_group_key)
      || (rule?.rule_key && candidate.rule_key === rule.rule_key)
      || (rule?.id && Number(candidate.id) === Number(rule.id))
    )) || null;
    const slotGroupKey = text(rule?.slot_group_key ?? priorForGroup?.slot_group_key, {
      max: 120, field: 'Slot group key',
    }) || (weekdays.length === 1 && (rule?.rule_key || priorForGroup?.rule_key)) || `slot-group:${randomUUID()}`;
    return weekdays.map((weekday) => {
      const prior = currentRules.find((candidate) => (
        candidate.slot_group_key === slotGroupKey && Number(candidate.weekday) === weekday
      )) || (weekdays.length === 1 ? priorForGroup : null);
      const ruleKey = prior?.rule_key
        || (weekdays.length === 1 && rule?.rule_key)
        || `${slotGroupKey}:weekday:${weekday}`;
      return normalizeRule(database, {
        ...rule,
        id: prior?.id ?? (weekdays.length === 1 ? rule?.id : null),
        rule_key: ruleKey,
        slot_group_key: slotGroupKey,
        weekday,
      }, index, prior);
    });
  });
  const keys = new Set();
  const stableKeys = new Set();
  for (const rule of rules) {
    // Named Meal Plans require an explicit fixed chooser. Legacy schedule slots
    // predate that invariant and are normalized outside normalizePlan so their
    // historical first-eligible fallback remains readable/materializable.
    if (rule.policy === 'fixed' && !rule.fixed_user_id) {
      throw mealPlanError('Choose the fixed meal chooser.');
    }
    const key = `${rule.weekday}:${rule.meal_type}:${rule.sort_order}`;
    if (keys.has(key)) throw mealPlanError('Meal Plan rules must have unique weekday, meal type, and order combinations.');
    keys.add(key);
    if (stableKeys.has(rule.rule_key)) throw mealPlanError('Meal Plan rules must have unique stable identities.');
    stableKeys.add(rule.rule_key);
  }
  return { name, description, status, effective_from: effectiveFrom, effective_until: effectiveUntil, rules };
}

function groupSlotRules(rules) {
  const groups = new Map();
  for (const rule of rules) {
    const key = rule.slot_group_key || rule.rule_key;
    if (!groups.has(key)) {
      groups.set(key, {
        ...rule,
        id: undefined,
        rule_key: undefined,
        weekday: undefined,
        weekdays: [],
        concrete_rule_ids: [],
        concrete_rule_keys: [],
      });
    }
    const group = groups.get(key);
    group.weekdays.push(Number(rule.weekday));
    group.concrete_rule_ids.push(Number(rule.id));
    group.concrete_rule_keys.push(rule.rule_key);
  }
  return [...groups.values()].map((group) => ({
    ...group,
    weekdays: [...new Set(group.weekdays)].sort((a, b) => a - b),
  }));
}

function loadRules(database, planId) {
  const rules = database.prepare(`
    SELECT r.*
      FROM meal_plan_rules r
     WHERE r.meal_plan_id = ? AND r.retired_at IS NULL
     ORDER BY r.weekday,
       CASE r.meal_type WHEN 'breakfast' THEN 0 WHEN 'lunch' THEN 1 WHEN 'dinner' THEN 2 ELSE 3 END,
       r.sort_order, r.id
  `).all(planId);
  const participantRows = database.prepare(`
    SELECT rp.meal_plan_rule_id, rp.user_id, u.display_name, u.avatar_color
      FROM meal_plan_rule_participants rp
      JOIN meal_plan_rules r ON r.id = rp.meal_plan_rule_id
      JOIN users u ON u.id = rp.user_id
     WHERE r.meal_plan_id = ?
     ORDER BY rp.meal_plan_rule_id, u.display_name COLLATE NOCASE, u.id
  `).all(planId);
  const byRule = new Map();
  for (const row of participantRows) {
    const participant = { id: row.user_id, user_id: row.user_id, display_name: row.display_name, avatar_color: row.avatar_color };
    if (!byRule.has(row.meal_plan_rule_id)) byRule.set(row.meal_plan_rule_id, []);
    byRule.get(row.meal_plan_rule_id).push(participant);
  }
  return rules.map((rule) => ({
    ...rule,
    weekdays: [Number(rule.weekday)],
    chooser_fallback_user_ids: parseJson(
      rule.chooser_fallback_user_ids_json,
      rule.fallback_user_id ? [Number(rule.fallback_user_id)] : [],
    ),
    execution_assignment_strategies: parseJson(rule.execution_assignment_strategies_json, {}),
    ...deadlineHumanFields(rule.selection_deadline_minutes),
    presence_required: Boolean(rule.presence_required),
    generate_preparation: Boolean(rule.generate_preparation),
    generate_cooking: Boolean(rule.generate_cooking),
    generate_supervision: Boolean(rule.generate_supervision),
    generate_serving: Boolean(rule.generate_serving),
    generate_cleanup: Boolean(rule.generate_cleanup),
    preparation_minutes: rule.preparation_duration_minutes,
    cooking_minutes: rule.cooking_duration_minutes,
    cleanup_minutes: rule.cleanup_duration_minutes,
    active: Boolean(rule.active),
    participants: byRule.get(rule.id) || [],
    participant_ids: (byRule.get(rule.id) || []).map((row) => row.user_id),
  }));
}

function writeRules(database, planId, rules) {
  const existing = database.prepare(`
    SELECT * FROM meal_plan_rules WHERE meal_plan_id = ? ORDER BY id
  `).all(planId);
  const byId = new Map(existing.map((row) => [Number(row.id), row]));
  const byKey = new Map(existing.filter((row) => row.rule_key).map((row) => [row.rule_key, row]));
  const retained = new Set();

  // Move every current row out of the live UNIQUE(day/type/order) namespace
  // before applying edits. This permits safe reordering/swaps while retaining
  // the stable rule row referenced by historical dated occurrences.
  database.prepare(`
    UPDATE meal_plan_rules
       SET active = 0, sort_order = -id,
           updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
     WHERE meal_plan_id = ?
  `).run(planId);
  const insertRule = database.prepare(`
    INSERT INTO meal_plan_rules (
      meal_plan_id, rule_key, slot_group_key, weekday, meal_type, custom_label, label, policy,
      fixed_user_id, fallback_user_id, chooser_backup_strategy, chooser_fallback_user_ids_json,
      rotation_group,
      presence_required, place_id, earliest_time, preferred_time, latest_time,
      expected_duration_minutes, selection_deadline_minutes, deadline_mode, deadline_weekday,
      deadline_time, reminder_minutes, choice_limit, max_entree_choices, max_side_choices,
      cook_user_id, cook_strategy,
      cook_rotation_group, supervisor_user_id, supervisor_strategy, supervisor_rotation_group,
      execution_assignment_strategies_json, generate_preparation, generate_cooking,
      generate_supervision, generate_serving, generate_cleanup,
      preparation_duration_minutes, cooking_duration_minutes, cleanup_duration_minutes,
      active, sort_order
    ) VALUES (${Array.from({ length: 44 }, () => '?').join(', ')})
  `);
  const updateRule = database.prepare(`
    UPDATE meal_plan_rules SET
      rule_key = ?, slot_group_key = ?, weekday = ?, meal_type = ?, custom_label = ?, label = ?,
      policy = ?, fixed_user_id = ?, fallback_user_id = ?, chooser_backup_strategy = ?,
      chooser_fallback_user_ids_json = ?, rotation_group = ?, presence_required = ?,
      place_id = ?, earliest_time = ?, preferred_time = ?,
      latest_time = ?, expected_duration_minutes = ?, selection_deadline_minutes = ?,
      deadline_mode = ?, deadline_weekday = ?, deadline_time = ?, reminder_minutes = ?,
      choice_limit = ?, max_entree_choices = ?, max_side_choices = ?,
      cook_user_id = ?, cook_strategy = ?, cook_rotation_group = ?,
      supervisor_user_id = ?, supervisor_strategy = ?, supervisor_rotation_group = ?,
      execution_assignment_strategies_json = ?, generate_preparation = ?, generate_cooking = ?,
      generate_supervision = ?, generate_serving = ?, generate_cleanup = ?,
      preparation_duration_minutes = ?, cooking_duration_minutes = ?, cleanup_duration_minutes = ?,
      active = ?, sort_order = ?, retired_at = NULL,
      updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
    WHERE id = ? AND meal_plan_id = ?
  `);
  const insertParticipant = database.prepare(`
    INSERT INTO meal_plan_rule_participants (meal_plan_rule_id, user_id) VALUES (?, ?)
  `);
  for (const rule of rules) {
    const current = byKey.get(rule.rule_key) || byId.get(Number(rule.id)) || null;
    if (current && Number(current.meal_plan_id) !== Number(planId)) {
      throw mealPlanError('Meal Plan rule does not belong to this plan.', 409, 'MEAL_PLAN_RULE_MISMATCH');
    }
    let ruleId;
    const values = [
      rule.rule_key, rule.slot_group_key, rule.weekday, rule.meal_type, rule.custom_label,
      rule.label, rule.policy, rule.fixed_user_id, rule.fallback_user_id,
      rule.chooser_backup_strategy, rule.chooser_fallback_user_ids_json, rule.rotation_group,
      rule.presence_required, rule.place_id, rule.earliest_time, rule.preferred_time,
      rule.latest_time, rule.expected_duration_minutes, rule.selection_deadline_minutes,
      rule.deadline_mode, rule.deadline_weekday, rule.deadline_time,
      rule.reminder_minutes, rule.choice_limit, rule.max_entree_choices,
      rule.max_side_choices, rule.cook_user_id, rule.cook_strategy,
      rule.cook_rotation_group, rule.supervisor_user_id, rule.supervisor_strategy,
      rule.supervisor_rotation_group, rule.execution_assignment_strategies_json,
      rule.generate_preparation, rule.generate_cooking, rule.generate_supervision,
      rule.generate_serving, rule.generate_cleanup, rule.preparation_duration_minutes,
      rule.cooking_duration_minutes, rule.cleanup_duration_minutes, rule.active,
      rule.sort_order,
    ];
    if (current) {
      updateRule.run(...values, current.id, planId);
      ruleId = Number(current.id);
    } else {
      const info = insertRule.run(planId, ...values);
      ruleId = Number(info.lastInsertRowid);
    }
    retained.add(ruleId);
    database.prepare('DELETE FROM meal_plan_rule_participants WHERE meal_plan_rule_id = ?').run(ruleId);
    for (const userId of rule.participant_ids) insertParticipant.run(ruleId, userId);
  }
  const retire = database.prepare(`
    UPDATE meal_plan_rules
       SET active = 0, retired_at = COALESCE(retired_at, strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
           updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
     WHERE id = ?
  `);
  for (const row of existing) if (!retained.has(Number(row.id))) retire.run(row.id);
}

function revisionPayload(database, plan, body = {}) {
  const rules = loadRules(database, plan.id).map((rule) => ({
    ...rule,
    participants: undefined,
  }));
  return {
    id: plan.id,
    name: plan.name,
    description: plan.description,
    status: plan.status,
    effective_from: plan.effective_from,
    effective_until: plan.effective_until,
    revision: plan.current_revision,
    rules,
    task_settings: body.task_settings ?? null,
    grocery_overrides: body.grocery_overrides ?? null,
  };
}

function insertRevision(database, plan, body, actorId, changeNote) {
  const snapshot = revisionPayload(database, plan, body);
  database.prepare(`
    INSERT INTO meal_plan_revisions (meal_plan_id, revision, snapshot_json, change_note, created_by)
    VALUES (?, ?, ?, ?, ?)
  `).run(plan.id, plan.current_revision, JSON.stringify(snapshot), text(changeNote, { max: 1000, field: 'Change note' }), actorId || null);
  return snapshot;
}

export function getMealPlan(database, planId, { includeDeleted = true } = {}) {
  const plan = database.prepare(`
    SELECT p.*, u.display_name AS creator_name
      FROM meal_plans p LEFT JOIN users u ON u.id = p.created_by
     WHERE p.id = ? ${includeDeleted ? '' : "AND p.status != 'deleted'"}
  `).get(Number(planId));
  if (!plan) return null;
  const revisions = database.prepare(`
    SELECT id, revision, change_note, created_by, created_at
      FROM meal_plan_revisions WHERE meal_plan_id = ? ORDER BY revision DESC
  `).all(plan.id);
  const currentRevision = database.prepare(`
    SELECT snapshot_json FROM meal_plan_revisions WHERE meal_plan_id = ? AND revision = ?
  `).get(plan.id, plan.current_revision);
  const snapshot = parseJson(currentRevision?.snapshot_json, {});
  const rules = loadRules(database, plan.id);
  return {
    ...plan,
    rules,
    slot_groups: groupSlotRules(rules),
    revisions,
    task_settings: snapshot?.task_settings ?? null,
    grocery_overrides: snapshot?.grocery_overrides ?? null,
  };
}

export function listMealPlans(database, { includeDeleted = false } = {}) {
  const rows = database.prepare(`
    SELECT p.*, COUNT(r.id) AS rule_count,
           GROUP_CONCAT(DISTINCT r.weekday) AS weekdays,
           GROUP_CONCAT(DISTINCT r.meal_type) AS meal_types
      FROM meal_plans p
      LEFT JOIN meal_plan_rules r ON r.meal_plan_id = p.id AND r.active = 1
     ${includeDeleted ? '' : "WHERE p.status != 'deleted'"}
     GROUP BY p.id
     ORDER BY CASE p.status WHEN 'active' THEN 0 WHEN 'archived' THEN 1 ELSE 2 END,
              p.name COLLATE NOCASE, p.id
  `).all();
  return rows.map((row) => ({
    ...row,
    weekdays: row.weekdays ? row.weekdays.split(',').map(Number).sort((a, b) => a - b) : [],
    meal_types: row.meal_types ? row.meal_types.split(',') : [],
  }));
}

export function createMealPlan(database, body, actorId) {
  const normalized = normalizePlan(database, body);
  let planId;
  database.transaction(() => {
    const info = database.prepare(`
      INSERT INTO meal_plans (name, description, status, current_revision, effective_from, effective_until, created_by)
      VALUES (?, ?, ?, 1, ?, ?, ?)
    `).run(normalized.name, normalized.description, normalized.status, normalized.effective_from, normalized.effective_until, actorId || null);
    planId = Number(info.lastInsertRowid);
    writeRules(database, planId, normalized.rules);
    const plan = database.prepare('SELECT * FROM meal_plans WHERE id = ?').get(planId);
    insertRevision(database, plan, body, actorId, body?.change_note || 'Meal Plan created.');
  })();
  return getMealPlan(database, planId);
}

export function updateMealPlan(database, planId, body, actorId) {
  const current = getMealPlan(database, planId);
  if (!current) throw mealPlanError('Meal Plan not found.', 404, 'MEAL_PLAN_NOT_FOUND');
  if (current.status === 'deleted') throw mealPlanError('Deleted Meal Plans cannot be edited.', 409, 'MEAL_PLAN_DELETED');
  const normalized = normalizePlan(database, body, current);
  database.transaction(() => {
    database.prepare(`
      UPDATE meal_plans SET name = ?, description = ?, status = ?, effective_from = ?, effective_until = ?,
        current_revision = current_revision + 1, updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
      WHERE id = ?
    `).run(normalized.name, normalized.description, normalized.status, normalized.effective_from, normalized.effective_until, current.id);
    writeRules(database, current.id, normalized.rules);
    syncMealPlanHeadToLegacySlot(database, current.id);
    const updated = database.prepare('SELECT * FROM meal_plans WHERE id = ?').get(current.id);
    insertRevision(database, updated, {
      ...body,
      task_settings: body?.task_settings ?? current.task_settings,
      grocery_overrides: body?.grocery_overrides ?? current.grocery_overrides,
    }, actorId, body?.change_note || 'Meal Plan updated.');
  })();
  return getMealPlan(database, current.id);
}

export function deleteMealPlan(database, planId, actorId) {
  const current = getMealPlan(database, planId);
  if (!current) throw mealPlanError('Meal Plan not found.', 404, 'MEAL_PLAN_NOT_FOUND');
  if (current.status === 'deleted') return current;
  database.transaction(() => {
    database.prepare(`
      UPDATE meal_plans SET status = 'deleted', deleted_by = ?,
        deleted_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now'), current_revision = current_revision + 1,
        updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
      WHERE id = ?
    `).run(actorId || null, current.id);
    if (current.legacy_schedule_slot_id) {
      database.prepare(`
        UPDATE meal_schedule_slots SET active = 0,
          updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now') WHERE id = ?
      `).run(current.legacy_schedule_slot_id);
    }
    const deleted = database.prepare('SELECT * FROM meal_plans WHERE id = ?').get(current.id);
    insertRevision(database, deleted, {
      task_settings: current.task_settings,
      grocery_overrides: current.grocery_overrides,
    }, actorId, 'Meal Plan deleted.');
  })();
  return getMealPlan(database, current.id);
}

function legacyPlanName(slot) {
  const meal = { breakfast: 'Breakfast', lunch: 'Lunch', dinner: 'Dinner', snack: 'Snack' }[slot.meal_type] || 'Meal';
  const day = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'][Number(slot.weekday)] || 'Weekly';
  return `${meal} - ${day}`;
}

function legacySlotRule(database, slot, current = null) {
  const settings = database.prepare('SELECT * FROM meal_execution_settings WHERE id = 1').get() || {};
  const timing = database.prepare('SELECT * FROM meal_timing_defaults WHERE meal_type = ?')
    .get(slot.meal_type) || {};
  const participantIds = database.prepare(`
    SELECT user_id FROM meal_schedule_slot_participants WHERE schedule_slot_id = ? ORDER BY user_id
  `).all(slot.id).map((row) => Number(row.user_id));
  return normalizeRule(database, {
    id: current?.id || null,
    rule_key: current?.rule_key || `legacy-slot:${slot.id}`,
    weekday: slot.weekday,
    meal_type: slot.meal_type,
    label: current?.label || null,
    policy: slot.policy,
    fixed_user_id: slot.fixed_user_id,
    fallback_user_id: slot.fallback_user_id,
    rotation_group: slot.rotation_group,
    presence_required: slot.presence_required,
    place_id: slot.place_id,
    earliest_time: slot.earliest_time || timing.earliest_time,
    preferred_time: slot.preferred_time || timing.preferred_time,
    latest_time: slot.latest_time || timing.latest_time,
    expected_duration_minutes: slot.expected_duration_minutes || timing.expected_duration_minutes,
    selection_deadline_minutes: slot.selection_deadline_minutes,
    reminder_minutes: slot.reminder_minutes,
    choice_limit: slot.snack_choice_limit,
    cook_user_id: slot.cook_user_id,
    supervisor_user_id: slot.supervisor_user_id,
    generate_preparation: current?.generate_preparation ?? settings.generate_preparation,
    generate_cooking: current?.generate_cooking ?? settings.generate_cooking,
    generate_supervision: current?.generate_supervision ?? settings.generate_supervision,
    generate_serving: current?.generate_serving ?? settings.generate_serving,
    generate_cleanup: current?.generate_cleanup ?? settings.generate_cleanup,
    preparation_duration_minutes: current?.preparation_duration_minutes ?? settings.preparation_lead_minutes,
    cooking_duration_minutes: current?.cooking_duration_minutes ?? settings.cooking_lead_minutes,
    cleanup_duration_minutes: current?.cleanup_duration_minutes ?? settings.cleanup_delay_minutes,
    active: slot.active,
    sort_order: 0,
    participant_ids: participantIds,
  }, 0, current);
}

function syncMealPlanHeadToLegacySlot(database, planId) {
  const plan = getMealPlan(database, planId);
  if (!plan?.legacy_schedule_slot_id) return null;
  const rules = plan.rules.filter((rule) => rule.retired_at == null);
  if (rules.length !== 1) {
    database.prepare(`
      UPDATE meal_schedule_slots SET active = 0,
        updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now') WHERE id = ?
    `).run(plan.legacy_schedule_slot_id);
    return null;
  }
  const rule = rules[0];
  database.prepare(`
    UPDATE meal_schedule_slots SET
      weekday = ?, meal_type = ?, policy = ?, fixed_user_id = ?, fallback_user_id = ?,
      rotation_group = ?, presence_required = ?, earliest_time = ?, preferred_time = ?,
      latest_time = ?, expected_duration_minutes = ?, active = ?, place_id = ?,
      selection_deadline_minutes = ?, reminder_minutes = ?, snack_choice_limit = ?,
      cook_user_id = ?, supervisor_user_id = ?, revision = ?,
      updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
    WHERE id = ?
  `).run(
    rule.weekday, rule.meal_type, rule.policy, rule.fixed_user_id, rule.fallback_user_id,
    rule.rotation_group, rule.presence_required ? 1 : 0, rule.earliest_time,
    rule.preferred_time, rule.latest_time, rule.expected_duration_minutes,
    plan.status === 'active' && rule.active ? 1 : 0, rule.place_id,
    rule.selection_deadline_minutes, rule.reminder_minutes, rule.choice_limit,
    rule.cook_user_id, rule.supervisor_user_id, plan.current_revision,
    plan.legacy_schedule_slot_id,
  );
  database.prepare('DELETE FROM meal_schedule_slot_participants WHERE schedule_slot_id = ?')
    .run(plan.legacy_schedule_slot_id);
  const addParticipant = database.prepare(`
    INSERT OR IGNORE INTO meal_schedule_slot_participants (schedule_slot_id, user_id) VALUES (?, ?)
  `);
  for (const userId of rule.participant_ids) addParticipant.run(plan.legacy_schedule_slot_id, userId);
  return plan.legacy_schedule_slot_id;
}

export function syncLegacyMealSchedulePlans(database, {
  actorId = null, slotIds = null,
} = {}) {
  const ids = Array.isArray(slotIds) && slotIds.length
    ? [...new Set(slotIds.map(Number).filter(Number.isInteger))]
    : null;
  const slots = database.prepare(`
    SELECT * FROM meal_schedule_slots
     ${ids ? `WHERE id IN (${ids.map(() => '?').join(',')})` : ''}
     ORDER BY id
  `).all(...(ids || []));
  const synced = [];
  const work = () => {
    for (const slot of slots) {
      let plan = slot.meal_plan_id
        ? database.prepare('SELECT * FROM meal_plans WHERE id = ?').get(slot.meal_plan_id)
        : database.prepare('SELECT * FROM meal_plans WHERE legacy_schedule_slot_id = ?').get(slot.id);
      if (plan) {
        if (!slot.meal_plan_id) database.prepare('UPDATE meal_schedule_slots SET meal_plan_id = ? WHERE id = ?').run(plan.id, slot.id);
        continue;
      }
      const info = database.prepare(`
        INSERT INTO meal_plans (
          name, description, status, current_revision, legacy_schedule_slot_id, created_by
        ) VALUES (?, 'Imported from the recurring Meal schedule compatibility view.', ?, 1, ?, ?)
      `).run(legacyPlanName(slot), slot.active ? 'active' : 'archived', slot.id, actorId || slot.created_by || null);
      plan = database.prepare('SELECT * FROM meal_plans WHERE id = ?').get(Number(info.lastInsertRowid));
      const rule = legacySlotRule(database, slot);
      writeRules(database, plan.id, [rule]);
      plan = database.prepare('SELECT * FROM meal_plans WHERE id = ?').get(plan.id);
      insertRevision(database, plan, {}, actorId || slot.created_by, 'Imported from recurring Meal schedule.');
      database.prepare('UPDATE meal_schedule_slots SET meal_plan_id = ? WHERE id = ?').run(plan.id, slot.id);
      synced.push({ slot_id: Number(slot.id), meal_plan_id: Number(plan.id) });
    }
  };
  if (database.inTransaction) work();
  else database.transaction(work)();
  return synced;
}

export function applyLegacyMealScheduleEdits(database, { actorId = null, slotIds = [] } = {}) {
  const ids = [...new Set(slotIds.map(Number).filter(Number.isInteger))];
  if (!ids.length) return [];
  // Promote brand-new legacy slots first. Existing linked plans are then
  // updated only when they are still the one-slot compatibility shape. Richer
  // plans are rejected intact and must be edited in the canonical manager.
  const promoted = new Map(syncLegacyMealSchedulePlans(database, { actorId, slotIds: ids })
    .map((row) => [Number(row.slot_id), row]));
  const updated = [];
  for (const slotId of ids) {
    const slot = database.prepare('SELECT * FROM meal_schedule_slots WHERE id = ?').get(slotId);
    const current = slot?.meal_plan_id ? getMealPlan(database, slot.meal_plan_id) : null;
    if (!slot || !current) throw mealPlanError('Recurring Meal schedule could not be promoted.', 409, 'LEGACY_PLAN_PROMOTION_FAILED');
    if (promoted.has(Number(slot.id))) {
      updated.push({ ...promoted.get(Number(slot.id)), revision: Number(current.current_revision) });
      continue;
    }
    if (Number(current.legacy_schedule_slot_id) !== Number(slot.id) || current.rules.length !== 1
        || current.rules[0].rule_key !== `legacy-slot:${slot.id}`) {
      throw mealPlanError(
        'This schedule has richer Meal Plan configuration. Edit it from Meal Plans so no settings are lost.',
        409,
        'LEGACY_PLAN_TOO_RICH',
      );
    }
    database.prepare(`
      UPDATE meal_plans SET status = ?, current_revision = current_revision + 1,
        updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now') WHERE id = ?
    `).run(slot.active ? 'active' : 'archived', current.id);
    const rule = legacySlotRule(database, slot, current.rules[0]);
    writeRules(database, current.id, [rule]);
    const head = database.prepare('SELECT * FROM meal_plans WHERE id = ?').get(current.id);
    insertRevision(database, head, {
      task_settings: current.task_settings,
      grocery_overrides: current.grocery_overrides,
    }, actorId || slot.created_by, 'Updated from recurring Meal schedule compatibility view.');
    updated.push({ slot_id: Number(slot.id), meal_plan_id: Number(current.id), revision: Number(head.current_revision) });
  }
  return updated;
}

function shiftMinutes(dateKey, time, minutes) {
  const value = new Date(`${dateKey}T${time || '23:59'}:00Z`);
  value.setUTCMinutes(value.getUTCMinutes() - Math.max(0, Number(minutes) || 0));
  return value.toISOString().slice(0, 19);
}

function selectionDeadline(rule, dateKey) {
  if (rule.deadline_mode === 'weekly_cutoff') {
    const weekStart = addDays(dateKey, -mealWeekday(dateKey));
    const cutoffDate = addDays(weekStart, Number(rule.deadline_weekday) - 7);
    return `${cutoffDate}T${rule.deadline_time}:00`;
  }
  return shiftMinutes(dateKey, rule.preferred_time || '23:59', rule.selection_deadline_minutes);
}

function eligibleForPresence(database, rule, context, dateKey, userId) {
  if (!rule.presence_required) return true;
  try {
    return evaluatePresence(database, {
      userId,
      startAt: `${dateKey}T${rule.earliest_time || rule.preferred_time || '00:00'}:00`,
      endAt: `${dateKey}T${rule.latest_time || rule.preferred_time || '23:59'}:00`,
      targetPlaceId: context?.place_id || rule.place_id || null,
      policy: 'available_before_due',
    }).eligible;
  } catch {
    return false;
  }
}

function contextMembers(database, contextId, dateKey = null, rule = null) {
  if (!contextId) return [];
  const rows = database.prepare(`
    SELECT pcm.user_id, pcm.membership_status
      FROM planning_context_members pcm
     WHERE pcm.planning_context_id = ? AND pcm.membership_status IN ('active', 'conflict')
     ORDER BY pcm.user_id
  `).all(contextId);
  if (!dateKey || !rule) {
    return rows.filter((row) => row.membership_status === 'active').map((row) => Number(row.user_id));
  }
  const occurrenceAt = `${dateKey}T${occurrenceTime(rule)}:00`;
  const conflicts = database.prepare(`
    SELECT * FROM planning_context_conflicts
     WHERE status = 'open' AND user_id = ?
       AND (first_context_id = ? OR second_context_id = ?)
       AND julianday(overlap_starts_at) <= julianday(?)
       AND julianday(overlap_ends_at) > julianday(?)
  `);
  return rows.filter((row) => {
    if (row.membership_status === 'active') return true;
    const conflict = conflicts.get(row.user_id, contextId, contextId, occurrenceAt, occurrenceAt);
    if (!conflict) return true;
    return !parseJson(conflict.meal_periods_json, [...MEAL_TYPES]).includes(rule.meal_type);
  }).map((row) => Number(row.user_id));
}

function contextPlanCandidates(database, context) {
  const from = String(context.starts_at).slice(0, 10);
  const to = String(context.ends_at).slice(0, 10);
  return database.prepare(`
    SELECT p.id, p.name, p.description, p.current_revision, p.effective_from,
           p.effective_until, COUNT(r.id) AS rule_count
      FROM meal_plans p
      JOIN meal_plan_rules r ON r.meal_plan_id = p.id AND r.active = 1
     WHERE p.status = 'active' AND p.legacy_schedule_slot_id IS NULL
       AND (p.effective_from IS NULL OR p.effective_from <= ?)
       AND (p.effective_until IS NULL OR p.effective_until >= ?)
     GROUP BY p.id
     ORDER BY p.name COLLATE NOCASE, p.id
  `).all(to, from);
}

function attachedContextPlans(database, contextId) {
  return database.prepare(`
    SELECT cp.*, p.name, p.status, p.current_revision
      FROM planning_context_meal_plans cp
      JOIN meal_plans p ON p.id = cp.meal_plan_id
     WHERE cp.planning_context_id = ?
     ORDER BY cp.is_primary DESC, p.name COLLATE NOCASE, p.id
  `).all(Number(contextId));
}

export function ensureContextMealPlanAssociation(database, contextId, actorId = null) {
  const context = database.prepare('SELECT * FROM planning_contexts WHERE id = ?').get(Number(contextId));
  if (!context) throw mealPlanError('Planning context not found.', 404, 'PLANNING_CONTEXT_NOT_FOUND');
  const attached = attachedContextPlans(database, context.id);
  if (attached.some((row) => row.status === 'active')) {
    return { status: 'attached', plans: attached, candidates: [] };
  }
  const candidates = contextPlanCandidates(database, context);
  if (candidates.length !== 1) {
    return {
      status: 'requires_plan_selection',
      plans: attached,
      candidates,
      reason: candidates.length ? 'multiple_active_plans' : 'no_active_default_plan',
    };
  }
  database.prepare(`
    INSERT OR IGNORE INTO planning_context_meal_plans (
      planning_context_id, meal_plan_id, is_primary, created_by
    ) VALUES (?, ?, 1, ?)
  `).run(context.id, candidates[0].id, actorId || null);
  return { status: 'auto_attached', plans: attachedContextPlans(database, context.id), candidates };
}

export function ensureContextMealPlanAssociationsForRange(database, { from, to, actorId = null } = {}) {
  const contexts = activeContexts(database, from, to);
  return contexts
    .filter((context) => context.context_type !== 'home')
    .map((context) => ({
      context_id: context.id,
      context_key: context.context_key,
      name: context.name,
      ...ensureContextMealPlanAssociation(database, context.id, actorId),
    }));
}

export function attachMealPlanToContext(database, planId, contextId, body, actorId) {
  const plan = database.prepare(`
    SELECT * FROM meal_plans WHERE id = ? AND status = 'active'
  `).get(Number(planId));
  if (!plan) throw mealPlanError('Active Meal Plan not found.', 404, 'MEAL_PLAN_NOT_FOUND');
  const context = database.prepare('SELECT * FROM planning_contexts WHERE id = ?').get(Number(contextId));
  if (!context) throw mealPlanError('Planning context not found.', 404, 'PLANNING_CONTEXT_NOT_FOUND');
  const effectiveFrom = assertDate(body?.effective_from ?? body?.starts_on, 'Effective-from date', { optional: true });
  const effectiveUntil = assertDate(body?.effective_until ?? body?.ends_on, 'Effective-until date', { optional: true });
  if (effectiveFrom && effectiveUntil && effectiveUntil < effectiveFrom) {
    throw mealPlanError('Effective-until date must not precede effective-from date.');
  }
  database.prepare(`
    INSERT INTO planning_context_meal_plans (
      planning_context_id, meal_plan_id, effective_from, effective_until, is_primary, created_by
    ) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(planning_context_id, meal_plan_id) DO UPDATE SET
      effective_from = excluded.effective_from, effective_until = excluded.effective_until,
      is_primary = excluded.is_primary
  `).run(
    context.id, plan.id, effectiveFrom, effectiveUntil,
    bool(body?.is_primary, true) ? 1 : 0, actorId || null,
  );
  return {
    status: 'attached',
    context_id: context.id,
    plans: attachedContextPlans(database, context.id),
  };
}

export function detachMealPlanFromContext(database, planId, contextId) {
  const current = database.prepare(`
    SELECT * FROM planning_context_meal_plans
     WHERE planning_context_id = ? AND meal_plan_id = ?
  `).get(Number(contextId), Number(planId));
  if (!current) throw mealPlanError('That Meal Plan is not attached to this planning context.', 404, 'CONTEXT_MEAL_PLAN_NOT_FOUND');
  database.prepare(`
    DELETE FROM planning_context_meal_plans WHERE planning_context_id = ? AND meal_plan_id = ?
  `).run(Number(contextId), Number(planId));
  return { ...current, detached: true };
}

function occurrenceTime(rule) {
  return rule.preferred_time || rule.earliest_time || rule.latest_time || {
    breakfast: '07:30', lunch: '12:30', dinner: '18:00', snack: '15:00',
  }[rule.meal_type] || '12:00';
}

function contextCoversRule(context, dateKey, rule) {
  const occurrence = Date.parse(`${dateKey}T${occurrenceTime(rule)}:00`);
  const starts = Date.parse(context.starts_at);
  const ends = Date.parse(context.ends_at);
  return !Number.isNaN(occurrence) && !Number.isNaN(starts) && !Number.isNaN(ends)
    && occurrence >= starts && occurrence < ends;
}

function splitMembershipsAt(database, dateKey, rule) {
  const timestamp = `${dateKey}T${occurrenceTime(rule)}:00`;
  return database.prepare(`
    SELECT DISTINCT pc.id AS context_id, pcm.user_id
      FROM planning_context_members pcm
      JOIN planning_contexts pc ON pc.id = pcm.planning_context_id
     WHERE pcm.membership_status = 'active' AND pc.status IN ('active', 'conflict', 'resolved')
       AND pc.context_type != 'home'
       AND julianday(pc.starts_at) <= julianday(?) AND julianday(pc.ends_at) > julianday(?)
     ORDER BY pc.id, pcm.user_id
  `).all(timestamp, timestamp);
}

function travelersAt(database, dateKey, rule) {
  return new Set(splitMembershipsAt(database, dateKey, rule).map((row) => Number(row.user_id)));
}

function chooseRoundRobin(database, rotationKey, eligible) {
  if (!eligible.length) return { selected: null, before: null, after: null };
  const state = database.prepare('SELECT cursor_user_id FROM assignment_rotation_state WHERE rotation_key = ?').get(rotationKey);
  const before = Number(state?.cursor_user_id) || null;
  const previous = eligible.indexOf(before);
  const selected = eligible[(previous + 1 + eligible.length) % eligible.length];
  database.prepare(`
    INSERT INTO assignment_rotation_state (rotation_key, cursor_user_id, occurrence_count, updated_at)
    VALUES (?, ?, 1, strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
    ON CONFLICT(rotation_key) DO UPDATE SET cursor_user_id = excluded.cursor_user_id,
      occurrence_count = assignment_rotation_state.occurrence_count + 1,
      updated_at = excluded.updated_at
  `).run(rotationKey, selected);
  return { selected, before, after: selected };
}

function deterministicIndex(seed, length) {
  if (!length) return -1;
  const value = createHash('sha256').update(String(seed)).digest().readUInt32BE(0);
  return value % length;
}

function nextEligible(eligible, currentUserId, excluded = []) {
  const denied = new Set(excluded.map(Number));
  const candidates = eligible.filter((userId) => !denied.has(Number(userId)));
  if (!candidates.length) return null;
  const previous = candidates.indexOf(Number(currentUserId));
  return candidates[(previous + 1 + candidates.length) % candidates.length];
}

function chooseBackupAssignee(rule, eligible, currentUserId = null, seed = '') {
  const candidates = eligible.filter((userId) => Number(userId) !== Number(currentUserId));
  if (!candidates.length) return null;
  if (rule.chooser_backup_strategy === 'fixed') {
    const fixed = Number(rule.fallback_user_id) || null;
    if (fixed && candidates.includes(fixed)) return fixed;
    return nextEligible(candidates, currentUserId);
  }
  if (rule.chooser_backup_strategy === 'random_eligible') {
    return candidates[deterministicIndex(seed, candidates.length)];
  }
  return nextEligible(candidates, currentUserId);
}

function ruleChooserFallbackIds(rule) {
  const parsed = Array.isArray(rule?.chooser_fallback_user_ids)
    ? rule.chooser_fallback_user_ids
    : parseJson(rule?.chooser_fallback_user_ids_json, null);
  const ids = Array.isArray(parsed)
    ? parsed.map(Number).filter(Number.isInteger)
    : (Number(rule?.fallback_user_id) ? [Number(rule.fallback_user_id)] : []);
  return [...new Set(ids)];
}

function resolvedChooserDefaults(database, rule) {
  const defaults = getMealPlanDefaultSettings(database);
  return {
    chooser_fallback_user_ids: ruleChooserFallbackIds(rule),
    chooser_terminal_strategy: defaults.chooser_terminal_strategy,
    chooser_terminal_user_id: Number(defaults.chooser_terminal_user_id) || null,
    chooser_round_robin_user_ids: defaults.chooser_round_robin_user_ids,
    max_entree_choices: Number.isInteger(Number(rule?.max_entree_choices))
      ? Number(rule.max_entree_choices) : 1,
    max_side_choices: Number.isInteger(Number(rule?.max_side_choices))
      ? Number(rule.max_side_choices) : Math.min(9, Math.max(0, Number(rule?.choice_limit ?? 3))),
  };
}

function terminalChooserRotationKey(database, rule, contextId, configuredIds = []) {
  const cohortKey = configuredIds.length
    ? createHash('sha256').update(configuredIds.join(',')).digest('hex').slice(0, 16)
    : 'all-eligible';
  const planId = Number(rule?.meal_plan_id) || 'household';
  return `meal-plan-default:${planId}:terminal:${cohortKey}:context:${Number(contextId) || 'base'}`;
}

function roleRotationScope(rule, context, role) {
  const rotationGroup = rule[`${role}_rotation_group`]
    || rule.slot_group_key || rule.rule_key || `rule:${rule.id}`;
  const baseRotationKey = `meal-plan:${rule.meal_plan_id}:${rotationGroup}:role:${role}`;
  return {
    baseRotationKey,
    scopedRotationKey: context ? `${baseRotationKey}:context:${context.id}` : baseRotationKey,
  };
}

function chooseOccurrenceRole(database, rule, context, role, eligible, responsibilityEligible) {
  const strategy = rule[`${role}_strategy`] || (rule[`${role}_user_id`] ? 'fixed' : 'none');
  const scope = roleRotationScope(rule, context, role);
  if (strategy === 'none') return { role, strategy, selected: null, before: null, after: null, ...scope };
  if (strategy === 'fixed') {
    const fixed = Number(rule[`${role}_user_id`]) || null;
    return {
      role, strategy, selected: responsibilityEligible.includes(fixed) ? fixed : null,
      before: null, after: null, ...scope,
    };
  }
  const rotation = chooseRoundRobin(database, scope.scopedRotationKey, eligible);
  return { role, strategy, ...rotation, ...scope };
}

function occurrenceRotationScope(database, rule, context, dateKey) {
  const baseRotationKey = rule.legacy_schedule_slot_id
    ? `meal:${rule.rotation_group || `slot:${rule.legacy_schedule_slot_id}`}:chooser`
    : `meal-plan:${rule.meal_plan_id}:${rule.rotation_group || `rule:${rule.rule_key || rule.id}`}:chooser`;
  const splitContextIds = context ? [] : [...new Set(
    splitMembershipsAt(database, dateKey, rule).map((row) => Number(row.context_id)),
  )];
  return {
    baseRotationKey,
    splitContextIds,
    scopedRotationKey: context
      ? `${baseRotationKey}:context:${context.id}`
      : (splitContextIds.length
        ? `${baseRotationKey}:home-split:${splitContextIds.join('.')}`
        : baseRotationKey),
  };
}

function occurrenceCohort(database, rule, context, dateKey) {
  const defaults = ruleParticipants(database, rule.id);
  const allMemberIds = householdMembers(database).map((row) => Number(row.id));
  const chooserDefaults = resolvedChooserDefaults(database, rule);
  let pool = defaults.length ? defaults : allMemberIds;
  const fixedChooser = rule.policy === 'fixed' ? (Number(rule.fixed_user_id) || null) : null;
  if (fixedChooser && !pool.includes(fixedChooser)) pool = [...pool, fixedChooser];
  let responsibilityPool = [...new Set([
    ...pool,
    Number(rule.fixed_user_id) || null,
    ...chooserDefaults.chooser_fallback_user_ids,
    chooserDefaults.chooser_terminal_user_id,
    ...chooserDefaults.chooser_round_robin_user_ids,
    Number(rule.cook_user_id) || null,
    Number(rule.supervisor_user_id) || null,
  ].filter(Boolean))];
  if (context) {
    const scoped = new Set(contextMembers(database, context.id, dateKey, rule));
    pool = pool.filter((id) => scoped.has(id));
    responsibilityPool = responsibilityPool.filter((id) => scoped.has(id));
  } else {
    const away = travelersAt(database, dateKey, rule);
    pool = pool.filter((id) => !away.has(id));
    responsibilityPool = responsibilityPool.filter((id) => !away.has(id));
  }
  return {
    allMemberIds,
    pool,
    eligible: pool.filter((userId) => eligibleForPresence(database, rule, context, dateKey, userId)),
    responsibilityPool,
    responsibilityEligible: responsibilityPool
      .filter((userId) => eligibleForPresence(database, rule, context, dateKey, userId)),
  };
}

function chooseOccurrenceAssignee(
  database,
  rule,
  scopedRotationKey,
  eligible,
  responsibilityEligible = eligible,
  contextId = null,
) {
  let selected = Number(rule.fixed_user_id) || null;
  let before = null;
  let after = null;
  let policyOverride = null;
  let rotationKeyOverride = null;
  const defaults = resolvedChooserDefaults(database, rule);
  if (rule.policy === 'round_robin') {
    ({ selected, before, after } = chooseRoundRobin(database, scopedRotationKey, eligible));
  } else if (rule.policy === 'personal_choice') {
    selected = null;
  } else if (!responsibilityEligible.includes(selected)) {
    selected = defaults.chooser_fallback_user_ids
      .find((userId) => responsibilityEligible.includes(Number(userId))) || null;
  }
  if (rule.policy !== 'personal_choice' && !selected) {
    if (defaults.chooser_terminal_strategy === 'fixed' && defaults.chooser_terminal_user_id) {
      selected = defaults.chooser_terminal_user_id;
    } else if (defaults.chooser_terminal_strategy === 'personal_choice') {
      policyOverride = 'personal_choice';
    } else {
      const configured = defaults.chooser_round_robin_user_ids
        .filter((userId) => responsibilityEligible.includes(Number(userId)));
      const candidates = configured.length ? configured : responsibilityEligible;
      if (candidates.length) {
        rotationKeyOverride = terminalChooserRotationKey(
          database,
          rule,
          contextId,
          defaults.chooser_round_robin_user_ids,
        );
        ({ selected, before, after } = chooseRoundRobin(database, rotationKeyOverride, candidates));
      }
    }
  }
  return { selected, before, after, policyOverride, rotationKeyOverride, chooserDefaults: defaults };
}

function writeOccurrenceResponsibilities(database, {
  mealId, occurrenceKey, rule, contextId, dateKey, pool, eligible,
  responsibilityPool = pool, responsibilityEligible = eligible, selected,
  cookSelection = null, supervisorSelection = null, policyOverride = null,
  chooserDefaults = null,
}) {
  const resolvedDefaults = chooserDefaults || resolvedChooserDefaults(database, rule);
  const effectivePolicy = policyOverride || rule.policy;
  const forcedLastResort = effectivePolicy !== 'personal_choice'
    && resolvedDefaults.chooser_terminal_strategy === 'fixed'
    && Number(selected) === Number(resolvedDefaults.chooser_terminal_user_id);
  const insertParticipant = database.prepare(`
    INSERT OR IGNORE INTO meal_participants (meal_id, user_id, role, status, source)
    VALUES (?, ?, ?, ?, 'schedule')
  `);
  for (const userId of pool) {
    insertParticipant.run(mealId, userId, 'participant', eligible.includes(userId) ? 'participating' : 'away');
  }
  if (selected && (responsibilityEligible.includes(Number(selected)) || forcedLastResort)) {
    insertParticipant.run(mealId, Number(selected), 'participant', 'participating');
  }
  if (effectivePolicy === 'personal_choice') {
    for (const userId of eligible) insertParticipant.run(mealId, userId, 'chooser', 'participating');
  } else if (selected) {
    insertParticipant.run(mealId, selected, 'chooser', 'participating');
  }
  const fallbackRoleUser = (role, selection) => Number(
    selection?.selected
      ?? (((rule[`${role}_strategy`] || (rule[`${role}_user_id`] ? 'fixed' : 'none')) === 'fixed')
        ? rule[`${role}_user_id`]
        : null),
  ) || null;
  for (const [userId, role] of [
    [fallbackRoleUser('cook', cookSelection), 'cook'],
    [fallbackRoleUser('supervisor', supervisorSelection), 'supervisor'],
  ]) {
    if (userId && responsibilityPool.includes(userId)) {
      insertParticipant.run(mealId, userId, role, responsibilityEligible.includes(userId) ? 'participating' : 'away');
    }
  }

  const insertObligation = database.prepare(`
    INSERT OR IGNORE INTO planning_obligations (
      entity_type, entity_id, logical_key, role, responsible_user_id, due_at,
      response_deadline, reminder_at, fallback_source, metadata_json
    ) VALUES ('meal', ?, ?, 'chooser', ?, ?, ?, ?, ?, ?)
  `);
  const deadline = selectionDeadline(rule, dateKey);
  const reminder = shiftMinutes(deadline.slice(0, 10), deadline.slice(11, 16), rule.reminder_minutes);
  const obligationUsers = effectivePolicy === 'personal_choice' ? eligible : (selected ? [selected] : []);
  for (const userId of obligationUsers) {
    insertObligation.run(
      mealId, `${occurrenceKey}:chooser:${userId}`, userId, deadline, deadline, reminder,
      resolvedDefaults.chooser_fallback_user_ids.length
        ? `user:${resolvedDefaults.chooser_fallback_user_ids[0]}` : null,
      JSON.stringify({
        meal_plan_id: rule.meal_plan_id,
        meal_plan_rule_id: rule.id,
        planning_context_id: contextId,
        policy: effectivePolicy,
        chooser_backup_strategy: rule.chooser_backup_strategy || 'next_eligible',
        fallback_user_id: Number(rule.fallback_user_id) || null,
        chooser_fallback_user_ids: resolvedDefaults.chooser_fallback_user_ids,
        chooser_terminal_strategy: resolvedDefaults.chooser_terminal_strategy,
        chooser_terminal_user_id: resolvedDefaults.chooser_terminal_user_id,
        chooser_round_robin_user_ids: resolvedDefaults.chooser_round_robin_user_ids,
        terminal_rotation_key: terminalChooserRotationKey(
          database,
          rule,
          contextId,
          resolvedDefaults.chooser_round_robin_user_ids,
        ),
        backup_eligible_user_ids: responsibilityEligible,
        choice_limit: rule.choice_limit,
        max_entree_choices: resolvedDefaults.max_entree_choices,
        max_side_choices: resolvedDefaults.max_side_choices,
        participant_user_id: effectivePolicy === 'personal_choice' ? userId : null,
      }),
    );
  }
}

function pendingOccurrenceCanBeReconciled(database, row) {
  if (!row.meal_id || row.selection_status !== 'awaiting_choice' || Number(row.user_modified) !== 0
      || row.superseded_by_id || row.source !== 'schedule') return false;
  const mealId = Number(row.meal_id);
  const protectedOutput = database.prepare(`
    SELECT 1
      FROM meal_person_decisions
     WHERE meal_id = ?
    UNION ALL SELECT 1 FROM meal_menu_items WHERE meal_id = ?
    UNION ALL SELECT 1 FROM meal_ingredients WHERE meal_id = ?
    UNION ALL SELECT 1 FROM meal_execution_snapshots WHERE meal_id = ?
    UNION ALL SELECT 1 FROM meal_grocery_item_sources WHERE meal_id = ?
    UNION ALL SELECT 1 FROM meal_participants WHERE meal_id = ? AND source != 'schedule'
    LIMIT 1
  `).get(mealId, mealId, mealId, mealId, mealId, mealId);
  if (protectedOutput) return false;
  return !database.prepare(`
    SELECT 1
      FROM planning_obligations o
      LEFT JOIN planning_obligation_events e ON e.obligation_id = o.id
      LEFT JOIN meal_selection_responses r ON r.obligation_id = o.id
     WHERE o.entity_type = 'meal' AND o.entity_id = ?
       AND (o.status != 'pending' OR e.id IS NOT NULL OR r.obligation_id IS NOT NULL)
     LIMIT 1
  `).get(mealId);
}

function loadRuleForOccurrence(database, ruleId, revisionId = null) {
  const rule = database.prepare(`
    SELECT r.*, p.current_revision, p.created_by AS plan_created_by,
           p.legacy_schedule_slot_id,
           pr.id AS meal_plan_revision_id
      FROM meal_plan_rules r
      JOIN meal_plans p ON p.id = r.meal_plan_id
      LEFT JOIN meal_plan_revisions pr
        ON pr.meal_plan_id = p.id AND pr.revision = p.current_revision
     WHERE r.id = ?
  `).get(Number(ruleId));
  if (!rule || !revisionId) return rule;
  const revision = database.prepare(`
    SELECT id, revision, snapshot_json FROM meal_plan_revisions WHERE id = ? AND meal_plan_id = ?
  `).get(Number(revisionId), Number(rule.meal_plan_id));
  const snapshot = parseJson(revision?.snapshot_json, {});
  const historical = Array.isArray(snapshot?.rules)
    ? snapshot.rules.find((candidate) => (
      (rule.rule_key && candidate.rule_key === rule.rule_key)
      || Number(candidate.id) === Number(rule.id)
    ))
    : null;
  return historical ? {
    ...rule,
    ...historical,
    id: rule.id,
    rule_key: rule.rule_key,
    meal_plan_id: rule.meal_plan_id,
    current_revision: revision.revision,
    meal_plan_revision_id: revision.id,
    plan_created_by: rule.plan_created_by,
    legacy_schedule_slot_id: rule.legacy_schedule_slot_id,
  } : rule;
}

function rewindRotationChain(database, rows) {
  const tracked = rows.filter((row) => row.cursor_after_user_id != null);
  if (!tracked.length) return true;
  const key = tracked[0].scoped_rotation_key;
  if (!key || tracked.some((row) => row.scoped_rotation_key !== key)) return false;
  const state = database.prepare(`
    SELECT cursor_user_id, occurrence_count FROM assignment_rotation_state WHERE rotation_key = ?
  `).get(key);
  if (!state || Number(state.occurrence_count) < tracked.length) return false;
  let expectedCursor = Number(state.cursor_user_id) || null;
  for (const row of [...tracked].reverse()) {
    if ((Number(row.cursor_after_user_id) || null) !== expectedCursor) return false;
    expectedCursor = Number(row.cursor_before_user_id) || null;
  }
  if (Number(state.occurrence_count) === tracked.length && expectedCursor == null) {
    database.prepare('DELETE FROM assignment_rotation_state WHERE rotation_key = ?').run(key);
  } else {
    database.prepare(`
      UPDATE assignment_rotation_state
         SET cursor_user_id = ?, occurrence_count = occurrence_count - ?,
             updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
       WHERE rotation_key = ?
    `).run(expectedCursor, tracked.length, key);
  }
  return true;
}

function reconcilePendingBaseOccurrence(database, existing, rule, dateKey) {
  const desired = occurrenceRotationScope(database, rule, null, dateKey);
  if (existing.scoped_rotation_key === desired.scopedRotationKey) return existing;

  let rows;
  if (rule.policy === 'round_robin' && existing.cursor_after_user_id != null) {
    rows = database.prepare(`
      SELECT oa.*, m.date, m.selection_status, m.user_modified, m.superseded_by_id, m.source,
             m.meal_plan_revision_id
        FROM meal_occurrence_assignments oa
        JOIN meals m ON m.id = oa.meal_id
       WHERE oa.planning_context_id IS NULL AND oa.committed = 1
         AND oa.scoped_rotation_key = ? AND oa.id >= ?
         AND oa.cursor_after_user_id IS NOT NULL
       ORDER BY oa.id
    `).all(existing.scoped_rotation_key, existing.id);
  } else {
    const meal = database.prepare(`
      SELECT oa.*, m.date, m.selection_status, m.user_modified, m.superseded_by_id, m.source,
             m.meal_plan_revision_id
        FROM meal_occurrence_assignments oa
        JOIN meals m ON m.id = oa.meal_id
       WHERE oa.id = ?
    `).get(existing.id);
    rows = meal ? [meal] : [];
  }
  if (!rows.length || rows.some((row) => !pendingOccurrenceCanBeReconciled(database, row))) return existing;
  if (!rewindRotationChain(database, rows)) return existing;

  for (const row of rows) {
    const rowRule = loadRuleForOccurrence(database, row.meal_plan_rule_id, row.meal_plan_revision_id);
    if (!rowRule) throw mealPlanError('Meal Plan rule not found while reconciling a pending occurrence.', 409, 'MEAL_PLAN_RULE_NOT_FOUND');
    const scope = occurrenceRotationScope(database, rowRule, null, row.date);
    const cohort = occurrenceCohort(database, rowRule, null, row.date);
    const selection = chooseOccurrenceAssignee(
      database,
      rowRule,
      scope.scopedRotationKey,
      cohort.eligible,
      cohort.responsibilityEligible,
    );
    database.prepare("DELETE FROM meal_participants WHERE meal_id = ? AND source = 'schedule'").run(row.meal_id);
    database.prepare("DELETE FROM planning_obligations WHERE entity_type = 'meal' AND entity_id = ?").run(row.meal_id);
    writeOccurrenceResponsibilities(database, {
      mealId: Number(row.meal_id), occurrenceKey: row.occurrence_key, rule: rowRule,
      contextId: null, dateKey: row.date, pool: cohort.pool, eligible: cohort.eligible,
      responsibilityPool: cohort.responsibilityPool,
      responsibilityEligible: cohort.responsibilityEligible,
      selected: selection.selected,
      policyOverride: selection.policyOverride,
      chooserDefaults: selection.chooserDefaults,
    });
    database.prepare(`
      UPDATE meals SET selection_policy_override = ?,
        updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now') WHERE id = ?
    `).run(selection.policyOverride, row.meal_id);
    database.prepare(`
      UPDATE meal_occurrence_assignments
         SET assigned_user_id = ?, base_rotation_key = ?, scoped_rotation_key = ?,
             cursor_before_user_id = ?, cursor_after_user_id = ?,
             committed_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
       WHERE id = ?
    `).run(
      selection.selected,
      selection.rotationKeyOverride || scope.baseRotationKey,
      selection.rotationKeyOverride || scope.scopedRotationKey,
      selection.before, selection.after, row.id,
    );
  }
  return database.prepare('SELECT * FROM meal_occurrence_assignments WHERE id = ?').get(existing.id);
}

function reconciliationSelection(database, rule, assignment, cohort, context = null) {
  const current = Number(assignment.assigned_user_id) || null;
  if (rule.policy === 'personal_choice') return null;
  const defaults = resolvedChooserDefaults(database, rule);
  const currentPending = current && database.prepare(`
    SELECT 1 FROM planning_obligations
     WHERE entity_type = 'meal' AND entity_id = ? AND role = 'chooser'
       AND responsible_user_id = ? AND status IN ('pending', 'accepted')
     LIMIT 1
  `).get(assignment.meal_id, current);
  if (currentPending && (
    cohort.responsibilityEligible.includes(current)
    || (defaults.chooser_terminal_strategy === 'fixed'
      && current === Number(defaults.chooser_terminal_user_id))
  )) return current;
  if (rule.policy === 'round_robin') {
    if (current && cohort.eligible.includes(current)) return current;
    if (cohort.eligible.length) {
      const before = Number(assignment.cursor_before_user_id) || null;
      const previous = cohort.eligible.indexOf(before);
      return cohort.eligible[(previous + 1 + cohort.eligible.length) % cohort.eligible.length];
    }
  }
  const fixed = rule.policy === 'fixed' ? (Number(rule.fixed_user_id) || null) : null;
  if (fixed && cohort.responsibilityEligible.includes(fixed)) return fixed;
  const fallback = defaults.chooser_fallback_user_ids.find((userId) => (
    cohort.responsibilityEligible.includes(Number(userId))
  ));
  if (fallback) return Number(fallback);
  if (defaults.chooser_terminal_strategy === 'fixed') return defaults.chooser_terminal_user_id;
  if (defaults.chooser_terminal_strategy === 'eligible_round_robin') {
    const configured = defaults.chooser_round_robin_user_ids.filter((userId) => (
      cohort.responsibilityEligible.includes(Number(userId))
    ));
    const candidates = configured.length ? configured : cohort.responsibilityEligible;
    if (!candidates.length) return null;
    return chooseRoundRobin(
      database,
      terminalChooserRotationKey(database, rule, context?.id, defaults.chooser_round_robin_user_ids),
      candidates,
    ).selected;
  }
  return null;
}

function participantStatusForReconciliation(database, mealId, userId, fallback) {
  const decision = database.prepare(`
    SELECT participation FROM meal_person_decisions
     WHERE meal_id = ? AND beneficiary_user_id = ?
  `).get(mealId, userId);
  if (!decision) return fallback;
  return {
    participating: 'participating',
    not_participating: 'not_participating',
    away: 'away',
    pending: 'needs_confirmation',
  }[decision.participation] || fallback;
}

function occurrenceReconciliationEvent(database, obligationId, event, actorId, details) {
  database.prepare(`
    INSERT INTO planning_obligation_events (
      obligation_id, event, actor_user_id, details_json
    ) VALUES (?, ?, ?, ?)
  `).run(obligationId, event, actorId || null, JSON.stringify(details));
}

function latestContextSuspension(database, obligationId) {
  const event = database.prepare(`
    SELECT event, details_json FROM planning_obligation_events
     WHERE obligation_id = ?
     ORDER BY id DESC LIMIT 1
  `).get(obligationId);
  return event?.event === 'planning_context_suspended'
    ? parseJson(event.details_json, null)
    : null;
}

function reconcileContextOccurrence(database, assignment, context, actorId) {
  const rule = loadRuleForOccurrence(
    database,
    assignment.meal_plan_rule_id,
    assignment.meal_plan_revision_id,
  );
  if (!rule) return { changed: false, assignment };
  const cohort = occurrenceCohort(database, rule, context, assignment.date);
  const selected = reconciliationSelection(database, rule, assignment, cohort, context);
  const strictSharedChoice = ['fixed', 'round_robin'].includes(rule.policy);
  const desiredRoles = new Map();
  const addRole = (userId, role, status = 'participating') => {
    if (!userId) return;
    desiredRoles.set(`${Number(userId)}:${role}`, { userId: Number(userId), role, status });
  };
  for (const userId of cohort.pool) {
    const status = participantStatusForReconciliation(
      database,
      assignment.meal_id,
      userId,
      cohort.eligible.includes(userId) ? 'participating' : 'away',
    );
    addRole(userId, 'participant', status);
  }
  if (rule.policy === 'personal_choice') {
    for (const userId of cohort.eligible) addRole(userId, 'chooser');
  } else if (selected) {
    addRole(selected, 'participant');
    addRole(selected, 'chooser');
  }
  const delegatedRows = database.prepare(`
    SELECT role, assigned_user_id
      FROM meal_occurrence_role_assignments
     WHERE occurrence_assignment_id = ? AND committed = 1
  `).all(assignment.id);
  const delegatedByRole = new Map(delegatedRows.map((row) => [row.role, Number(row.assigned_user_id) || null]));
  for (const [rawUserId, role] of [
    [delegatedByRole.has('cook') ? delegatedByRole.get('cook') : rule.cook_user_id, 'cook'],
    [delegatedByRole.has('supervisor') ? delegatedByRole.get('supervisor') : rule.supervisor_user_id, 'supervisor'],
  ]) {
    const userId = Number(rawUserId) || null;
    if (userId && cohort.responsibilityPool.includes(userId)) {
      addRole(userId, role, cohort.responsibilityEligible.includes(userId) ? 'participating' : 'away');
    }
  }

  let changed = false;
  const existingRoles = database.prepare(`
    SELECT * FROM meal_participants WHERE meal_id = ?
  `).all(assignment.meal_id);
  const updateRole = database.prepare(`
    UPDATE meal_participants
       SET status = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
     WHERE meal_id = ? AND user_id = ? AND role = ? AND status != ?
  `);
  for (const existing of existingRoles) {
    const desired = desiredRoles.get(`${Number(existing.user_id)}:${existing.role}`);
    const status = desired?.status || 'away';
    if (updateRole.run(status, assignment.meal_id, existing.user_id, existing.role, status).changes) changed = true;
  }
  const upsertRole = database.prepare(`
    INSERT INTO meal_participants (meal_id, user_id, role, status, source)
    VALUES (?, ?, ?, ?, 'schedule')
    ON CONFLICT(meal_id, user_id, role) DO UPDATE SET
      status = excluded.status,
      updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
  `);
  const existingRoleKeys = new Set(existingRoles.map((row) => `${Number(row.user_id)}:${row.role}`));
  for (const desired of desiredRoles.values()) {
    upsertRole.run(assignment.meal_id, desired.userId, desired.role, desired.status);
    if (!existingRoleKeys.has(`${desired.userId}:${desired.role}`)) changed = true;
  }

  const desiredChooserIds = new Set(
    [...desiredRoles.values()].filter((role) => role.role === 'chooser' && role.status === 'participating')
      .map((role) => role.userId),
  );
  const obligations = database.prepare(`
    SELECT * FROM planning_obligations
     WHERE entity_type = 'meal' AND entity_id = ? AND role = 'chooser'
     ORDER BY id
  `).all(assignment.meal_id);
  for (const obligation of obligations) {
    const desired = desiredChooserIds.has(Number(obligation.responsible_user_id));
    const mustSuspend = ['pending', 'accepted'].includes(obligation.status)
      || (strictSharedChoice && obligation.status === 'fulfilled');
    if (!desired && mustSuspend) {
      occurrenceReconciliationEvent(database, obligation.id, 'planning_context_suspended', actorId, {
        planning_context_id: Number(context.id),
        previous_status: obligation.status,
        previous_responded_at: obligation.responded_at || null,
        responsible_user_id: Number(obligation.responsible_user_id) || null,
      });
      database.prepare(`
        UPDATE planning_obligations
           SET status = 'superseded', responded_at = COALESCE(responded_at, strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
               updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
         WHERE id = ?
      `).run(obligation.id);
      changed = true;
    } else if (desired && obligation.status === 'superseded') {
      const suspension = latestContextSuspension(database, obligation.id);
      if (suspension && ['pending', 'accepted'].includes(suspension.previous_status)) {
        database.prepare(`
          UPDATE planning_obligations
             SET status = ?, responded_at = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
           WHERE id = ?
        `).run(suspension.previous_status, suspension.previous_responded_at || null, obligation.id);
        occurrenceReconciliationEvent(database, obligation.id, 'planning_context_restored', actorId, {
          planning_context_id: Number(context.id),
          restored_status: suspension.previous_status,
          responsible_user_id: Number(obligation.responsible_user_id) || null,
        });
        changed = true;
      }
    }
  }

  const refreshedObligations = database.prepare(`
    SELECT * FROM planning_obligations
     WHERE entity_type = 'meal' AND entity_id = ? AND role = 'chooser'
     ORDER BY id
  `).all(assignment.meal_id);
  const currentByUser = new Map();
  for (const obligation of refreshedObligations) {
    if (!['pending', 'accepted', 'fulfilled'].includes(obligation.status)) continue;
    currentByUser.set(Number(obligation.responsible_user_id), obligation);
  }
  const historyByUser = new Map();
  for (const obligation of refreshedObligations) {
    const userId = Number(obligation.responsible_user_id);
    if (!historyByUser.has(userId)) historyByUser.set(userId, []);
    historyByUser.get(userId).push(obligation);
  }
  const deadline = selectionDeadline(rule, assignment.date);
  const reminder = shiftMinutes(deadline.slice(0, 10), deadline.slice(11, 16), rule.reminder_minutes);
  const chooserDefaults = resolvedChooserDefaults(database, rule);
  const insertObligation = database.prepare(`
    INSERT OR IGNORE INTO planning_obligations (
      entity_type, entity_id, logical_key, role, responsible_user_id, due_at,
      response_deadline, reminder_at, status, attempt, parent_obligation_id,
      fallback_source, metadata_json
    ) VALUES ('meal', ?, ?, 'chooser', ?, ?, ?, ?, 'pending', ?, ?, ?, ?)
  `);
  for (const userId of desiredChooserIds) {
    if (currentByUser.has(userId)) continue;
    const history = historyByUser.get(userId) || [];
    const parent = history.at(-1) || null;
    const attempt = Math.max(0, ...history.map((row) => Number(row.attempt) || 0)) + 1;
    const baseLogicalKey = `${assignment.occurrence_key}:chooser:${userId}`;
    let logicalKey = history.length
      ? `${baseLogicalKey}:reassigned:attempt:${attempt}`
      : baseLogicalKey;
    let suffix = attempt;
    while (database.prepare('SELECT 1 FROM planning_obligations WHERE logical_key = ?').get(logicalKey)) {
      suffix += 1;
      logicalKey = `${baseLogicalKey}:reassigned:attempt:${suffix}`;
    }
    const result = insertObligation.run(
      assignment.meal_id,
      logicalKey,
      userId,
      deadline,
      deadline,
      reminder,
      attempt,
      parent?.id || null,
      chooserDefaults.chooser_fallback_user_ids.length
        ? `user:${chooserDefaults.chooser_fallback_user_ids[0]}` : null,
      JSON.stringify({
        meal_plan_id: rule.meal_plan_id,
        meal_plan_rule_id: rule.id,
        planning_context_id: Number(context.id),
        policy: rule.policy,
        chooser_fallback_user_ids: chooserDefaults.chooser_fallback_user_ids,
        chooser_terminal_strategy: chooserDefaults.chooser_terminal_strategy,
        chooser_terminal_user_id: chooserDefaults.chooser_terminal_user_id,
        chooser_round_robin_user_ids: chooserDefaults.chooser_round_robin_user_ids,
        terminal_rotation_key: terminalChooserRotationKey(
          database,
          rule,
          context.id,
          chooserDefaults.chooser_round_robin_user_ids,
        ),
        choice_limit: rule.choice_limit,
        max_entree_choices: chooserDefaults.max_entree_choices,
        max_side_choices: chooserDefaults.max_side_choices,
        participant_user_id: rule.policy === 'personal_choice' ? userId : null,
      }),
    );
    if (result.changes) {
      occurrenceReconciliationEvent(
        database,
        Number(result.lastInsertRowid),
        'planning_context_reassigned',
        actorId,
        {
          planning_context_id: Number(context.id),
          previous_obligation_id: parent?.id || null,
          responsible_user_id: userId,
          requires_fresh_confirmation: true,
        },
      );
      changed = true;
    }
  }

  if ((Number(assignment.assigned_user_id) || null) !== selected) {
    synchronizeMealMenuGeneration(database, assignment.meal_id, {
      chooserId: selected,
      reason: selected ? 'chooser_reassigned' : 'chooser_unassigned',
    });
    database.prepare(`
      UPDATE meal_occurrence_assignments
         SET assigned_user_id = ?
       WHERE id = ?
    `).run(selected, assignment.id);
    changed = true;
  }
  if (changed) syncAutoPortions(database, assignment.meal_id);
  return {
    changed,
    assignment: database.prepare('SELECT * FROM meal_occurrence_assignments WHERE id = ?').get(assignment.id),
  };
}

/**
 * Rebuild schedule-owned context occurrences after context membership/conflict
 * changes. Rows and decision history are retained: roles become Away and
 * obligations are superseded with audit events. A pending request can be
 * restored; a previously fulfilled shared choice receives a fresh obligation
 * so stale food selections never silently become current after reassignment.
 */
export function reconcilePlanningContextMealOccurrences(database, {
  contextIds = [], actorId = null,
} = {}) {
  const ids = [...new Set(contextIds.map(Number).filter((id) => Number.isInteger(id) && id > 0))];
  if (!ids.length) return { reconciled: 0, changed: 0, assignments: [] };
  const work = () => {
    const rows = database.prepare(`
      SELECT oa.*, m.date, m.selection_status, m.user_modified, m.superseded_by_id,
             m.source, m.meal_plan_revision_id
        FROM meal_occurrence_assignments oa
        JOIN meals m ON m.id = oa.meal_id
       WHERE oa.planning_context_id IN (${ids.map(() => '?').join(',')})
         AND oa.committed = 1 AND m.user_modified = 0
         AND m.superseded_by_id IS NULL AND m.source = 'schedule'
       ORDER BY oa.id
    `).all(...ids);
    let changed = 0;
    const assignments = [];
    for (const row of rows) {
      const context = database.prepare('SELECT * FROM planning_contexts WHERE id = ?')
        .get(Number(row.planning_context_id));
      if (!context) continue;
      const result = reconcileContextOccurrence(database, row, context, actorId);
      if (result.changed) changed += 1;
      assignments.push(result.assignment);
    }
    return { reconciled: rows.length, changed, assignments };
  };
  return database.inTransaction ? work() : database.transaction(work)();
}

function occurrenceRules(database, context, dateKey) {
  if (context) {
    return database.prepare(`
      SELECT r.*, p.current_revision, p.created_by AS plan_created_by,
             p.legacy_schedule_slot_id,
             pr.id AS meal_plan_revision_id
        FROM planning_context_meal_plans cp
        JOIN meal_plans p ON p.id = cp.meal_plan_id AND p.status = 'active'
        JOIN meal_plan_rules r ON r.meal_plan_id = p.id AND r.active = 1
        LEFT JOIN meal_plan_revisions pr ON pr.meal_plan_id = p.id AND pr.revision = p.current_revision
       WHERE cp.planning_context_id = ?
         AND (cp.effective_from IS NULL OR cp.effective_from <= ?)
         AND (cp.effective_until IS NULL OR cp.effective_until >= ?)
         AND (p.effective_from IS NULL OR p.effective_from <= ?)
         AND (p.effective_until IS NULL OR p.effective_until >= ?)
       ORDER BY cp.is_primary DESC, r.weekday, r.sort_order, r.id
    `).all(context.id, dateKey, dateKey, dateKey, dateKey);
  }
  return database.prepare(`
    SELECT r.*, p.current_revision, p.created_by AS plan_created_by,
           p.legacy_schedule_slot_id,
           pr.id AS meal_plan_revision_id
      FROM meal_plans p
      JOIN meal_plan_rules r ON r.meal_plan_id = p.id AND r.active = 1
      LEFT JOIN meal_plan_revisions pr ON pr.meal_plan_id = p.id AND pr.revision = p.current_revision
     WHERE p.status = 'active'
       AND (p.effective_from IS NULL OR p.effective_from <= ?)
       AND (p.effective_until IS NULL OR p.effective_until >= ?)
     ORDER BY r.weekday, r.sort_order, r.id
  `).all(dateKey, dateKey);
}

function ruleParticipants(database, ruleId) {
  return database.prepare(`
    SELECT user_id FROM meal_plan_rule_participants WHERE meal_plan_rule_id = ? ORDER BY user_id
  `).all(ruleId).map((row) => Number(row.user_id));
}

function activeContexts(database, from, to, contextId = null) {
  const rangeStart = `${from}T00:00:00`;
  const rangeEnd = `${addDays(to, 1)}T00:00:00`;
  const rows = database.prepare(`
    SELECT * FROM planning_contexts
     WHERE status IN ('active', 'conflict', 'resolved')
       AND julianday(starts_at) < julianday(?) AND julianday(ends_at) > julianday(?)
       ${contextId ? 'AND id = ?' : ''}
     ORDER BY starts_at, id
  `).all(rangeEnd, rangeStart, ...(contextId ? [Number(contextId)] : []));
  if (contextId && !rows.length) throw mealPlanError('Planning context not found for this date range.', 404, 'PLANNING_CONTEXT_NOT_FOUND');
  return rows;
}

function insertOccurrence(database, rule, context, dateKey, actorId) {
  const contextId = context?.id || null;
  const stableRuleKey = rule.rule_key || `rule:${rule.id}`;
  const occurrenceKey = `meal-plan:${rule.meal_plan_id}:${stableRuleKey}:${dateKey}:context:${contextId || 'base'}`;
  const existing = database.prepare('SELECT * FROM meal_occurrence_assignments WHERE occurrence_key = ?').get(occurrenceKey);
  const { baseRotationKey, scopedRotationKey } = occurrenceRotationScope(database, rule, context, dateKey);
  if (existing) {
    return {
      created: 0,
      assignment: context
        ? reconcileContextOccurrence(database, {
            ...existing,
            date: dateKey,
            meal_plan_revision_id: database.prepare('SELECT meal_plan_revision_id FROM meals WHERE id = ?')
              .get(existing.meal_id)?.meal_plan_revision_id || null,
          }, context, actorId).assignment
        : reconcilePendingBaseOccurrence(database, existing, rule, dateKey),
    };
  }

  // Migration 10015 backfills each released schedule slot as a named plan. If
  // the compatibility materializer already created this dated meal, adopt it
  // into the immutable occurrence ledger without consuming its cursor twice.
  // Any other meal for the same period remains an intentional override.
  if (!context && rule.legacy_schedule_slot_id) {
    const legacyMeal = database.prepare(`
      SELECT id FROM meals
       WHERE schedule_slot_id = ? AND date = ? AND superseded_by_id IS NULL
       ORDER BY id LIMIT 1
    `).get(Number(rule.legacy_schedule_slot_id), dateKey);
    if (legacyMeal) {
      database.prepare(`
        UPDATE meals
           SET meal_plan_id = COALESCE(meal_plan_id, ?),
               meal_plan_revision_id = COALESCE(meal_plan_revision_id, ?),
               meal_plan_rule_id = COALESCE(meal_plan_rule_id, ?)
         WHERE id = ?
      `).run(rule.meal_plan_id, rule.meal_plan_revision_id || null, rule.id, legacyMeal.id);
      const chooser = database.prepare(`
        SELECT user_id FROM meal_participants
         WHERE meal_id = ? AND role = 'chooser' AND status = 'participating'
         ORDER BY user_id LIMIT 1
      `).get(legacyMeal.id);
      const info = database.prepare(`
        INSERT INTO meal_occurrence_assignments (
          occurrence_key, meal_plan_rule_id, meal_id, assigned_user_id,
          base_rotation_key, scoped_rotation_key, committed, committed_at
        ) VALUES (?, ?, ?, ?, ?, ?, 1, strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
      `).run(
        occurrenceKey, rule.id, legacyMeal.id, Number(chooser?.user_id) || null,
        baseRotationKey, scopedRotationKey,
      );
      return {
        created: 0,
        assignment: database.prepare('SELECT * FROM meal_occurrence_assignments WHERE id = ?')
          .get(Number(info.lastInsertRowid)),
      };
    }

    const override = database.prepare(`
      SELECT id FROM meals
       WHERE date = ? AND meal_type = ? AND superseded_by_id IS NULL
       ORDER BY id LIMIT 1
    `).get(dateKey, rule.meal_type);
    if (override) {
      const info = database.prepare(`
        INSERT INTO meal_occurrence_assignments (
          occurrence_key, meal_plan_rule_id, base_rotation_key,
          scoped_rotation_key, committed
        ) VALUES (?, ?, ?, ?, 0)
      `).run(occurrenceKey, rule.id, baseRotationKey, scopedRotationKey);
      return {
        created: 0,
        assignment: database.prepare('SELECT * FROM meal_occurrence_assignments WHERE id = ?')
          .get(Number(info.lastInsertRowid)),
      };
    }
  }

  const {
    allMemberIds, pool, eligible, responsibilityPool, responsibilityEligible,
  } = occurrenceCohort(database, rule, context, dateKey);
  const selection = chooseOccurrenceAssignee(
    database,
    rule,
    scopedRotationKey,
    eligible,
    responsibilityEligible,
    contextId,
  );
  const { selected, before, after, policyOverride, chooserDefaults } = selection;
  const assignmentBaseRotationKey = selection.rotationKeyOverride || baseRotationKey;
  const assignmentScopedRotationKey = selection.rotationKeyOverride || scopedRotationKey;
  const cookSelection = chooseOccurrenceRole(
    database, rule, context, 'cook', eligible, responsibilityEligible,
  );
  const supervisorSelection = chooseOccurrenceRole(
    database, rule, context, 'supervisor', eligible, responsibilityEligible,
  );

  const slotLabel = rule.custom_label || rule.label || rule.meal_type;
  const title = `Choose ${slotLabel}`;
  const sourceKey = occurrenceKey;
  const creator = Number(actorId || rule.plan_created_by || allMemberIds[0]);
  if (!creator) throw mealPlanError('A household member is required to generate Meal Plan occurrences.', 409, 'NO_HOUSEHOLD_MEMBER');
  const mealInfo = database.prepare(`
    INSERT INTO meals (
      date, meal_type, custom_label, title, scope, scheduled_time, earliest_time, preferred_time, latest_time,
      expected_duration_minutes, source, source_key, provenance_json, created_by, place_id,
      selection_status, schedule_slot_id, meal_plan_id, meal_plan_revision_id,
      meal_plan_rule_id, planning_context_id, selection_policy_override
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'schedule', ?, ?, ?, ?, 'awaiting_choice', ?, ?, ?, ?, ?, ?)
  `).run(
    dateKey, rule.meal_type, rule.custom_label || null, title,
    context?.context_type === 'travel' ? 'travel' : 'household',
    rule.preferred_time, rule.earliest_time, rule.preferred_time, rule.latest_time,
    rule.expected_duration_minutes, sourceKey,
    JSON.stringify({ source: 'meal_plan', meal_plan_id: rule.meal_plan_id, revision: rule.current_revision, rule_id: rule.id, planning_context_id: contextId }),
    creator, context?.place_id || rule.place_id || null,
    rule.legacy_schedule_slot_id || null, rule.meal_plan_id,
    rule.meal_plan_revision_id || null, rule.id, contextId, policyOverride,
  );
  const mealId = Number(mealInfo.lastInsertRowid);
  const assignmentInfo = database.prepare(`
    INSERT INTO meal_occurrence_assignments (
      occurrence_key, meal_plan_rule_id, planning_context_id, meal_id, assigned_user_id,
      base_rotation_key, scoped_rotation_key, cursor_before_user_id, cursor_after_user_id,
      committed, committed_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
  `).run(
    occurrenceKey, rule.id, contextId, mealId, selected,
    assignmentBaseRotationKey, assignmentScopedRotationKey, before, after,
  );

  const assignmentId = Number(assignmentInfo.lastInsertRowid);
  const insertRoleAssignment = database.prepare(`
    INSERT INTO meal_occurrence_role_assignments (
      occurrence_assignment_id, role, strategy, assigned_user_id,
      base_rotation_key, scoped_rotation_key, cursor_before_user_id,
      cursor_after_user_id, committed, committed_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
  `);
  for (const roleSelection of [cookSelection, supervisorSelection]) {
    insertRoleAssignment.run(
      assignmentId, roleSelection.role, roleSelection.strategy, roleSelection.selected,
      roleSelection.baseRotationKey, roleSelection.scopedRotationKey,
      roleSelection.before, roleSelection.after,
    );
  }

  writeOccurrenceResponsibilities(database, {
    mealId, occurrenceKey, rule, contextId, dateKey, pool, eligible, selected,
    responsibilityPool, responsibilityEligible, cookSelection, supervisorSelection,
    policyOverride, chooserDefaults,
  });
  return { created: 1, assignment: { id: assignmentId, occurrence_key: occurrenceKey, meal_id: mealId, assigned_user_id: selected } };
}

export function materializeMealPlanOccurrences(database, { from, to, contextId = null, actorId = null } = {}) {
  assertDate(from, 'Start date');
  assertDate(to, 'End date');
  if (to < from) throw mealPlanError('End date must not precede start date.');
  // Slots created after migration 10015 are lazily promoted into the canonical
  // named-plan engine before any occurrence can consume a legacy global cursor.
  syncLegacyMealSchedulePlans(database, { actorId });
  const contexts = activeContexts(database, from, to, contextId);
  let created = 0;
  const assignments = [];
  database.transaction(() => {
    for (let dateKey = from; dateKey <= to; dateKey = addDays(dateKey, 1)) {
      if (!contextId) {
        for (const rule of occurrenceRules(database, null, dateKey)) {
          if (Number(rule.weekday) !== mealWeekday(dateKey)) continue;
          const result = insertOccurrence(database, rule, null, dateKey, actorId);
          created += result.created;
          assignments.push(result.assignment);
        }
      }
      for (const rawContext of contexts) {
        const context = { ...rawContext };
        for (const rule of occurrenceRules(database, context, dateKey)) {
          if (Number(rule.weekday) !== mealWeekday(dateKey)) continue;
          if (!contextCoversRule(context, dateKey, rule)) continue;
          const result = insertOccurrence(database, rule, context, dateKey, actorId);
          created += result.created;
          assignments.push(result.assignment);
        }
      }
    }
  })();
  return { created, assignments };
}

function loadContexts(database, from, to) {
  const rangeStart = `${from}T00:00:00`;
  const rangeEnd = `${addDays(to, 1)}T00:00:00`;
  const contexts = database.prepare(`
    SELECT * FROM planning_contexts
     WHERE julianday(starts_at) < julianday(?) AND julianday(ends_at) > julianday(?)
       AND status NOT IN ('cancelled', 'completed')
     ORDER BY starts_at, id
  `).all(rangeEnd, rangeStart);
  const members = database.prepare(`
    SELECT pcm.*, u.display_name, u.avatar_color
      FROM planning_context_members pcm
      JOIN users u ON u.id = pcm.user_id
      JOIN planning_contexts pc ON pc.id = pcm.planning_context_id
     WHERE julianday(pc.starts_at) < julianday(?) AND julianday(pc.ends_at) > julianday(?)
     ORDER BY pcm.planning_context_id, u.display_name COLLATE NOCASE, u.id
  `).all(rangeEnd, rangeStart);
  const plans = database.prepare(`
    SELECT cp.*, p.name, p.current_revision, p.status
      FROM planning_context_meal_plans cp
      JOIN meal_plans p ON p.id = cp.meal_plan_id
      JOIN planning_contexts pc ON pc.id = cp.planning_context_id
     WHERE julianday(pc.starts_at) < julianday(?) AND julianday(pc.ends_at) > julianday(?)
     ORDER BY cp.planning_context_id, cp.is_primary DESC, p.name COLLATE NOCASE
  `).all(rangeEnd, rangeStart);
  return contexts.map((context) => ({
    ...context,
    members: members.filter((row) => Number(row.planning_context_id) === Number(context.id)),
    meal_plans: plans.filter((row) => Number(row.planning_context_id) === Number(context.id)),
  }));
}

function mealMenuPolicy(database, mealId) {
  return database.prepare(`
    SELECT COALESCE(
             m.selection_policy_override,
             r.policy,
             s.policy,
             json_extract(o.metadata_json, '$.policy')
           ) AS policy
      FROM meals m
      LEFT JOIN meal_plan_rules r ON r.id = m.meal_plan_rule_id
      LEFT JOIN meal_schedule_slots s ON s.id = m.schedule_slot_id
      LEFT JOIN planning_obligations o
        ON o.entity_type = 'meal' AND o.entity_id = m.id AND o.role = 'chooser'
     WHERE m.id = ?
     ORDER BY o.id DESC
     LIMIT 1
  `).get(Number(mealId))?.policy || null;
}

function canonicalMealChooser(database, mealId) {
  const assignment = database.prepare(`
    SELECT assigned_user_id FROM meal_occurrence_assignments WHERE meal_id = ?
  `).get(Number(mealId));
  if (assignment) return Number(assignment.assigned_user_id) || null;
  return Number(database.prepare(`
    SELECT user_id FROM meal_participants
     WHERE meal_id = ? AND role = 'chooser' AND status = 'participating'
     ORDER BY updated_at DESC, user_id DESC LIMIT 1
  `).get(Number(mealId))?.user_id) || null;
}

function chooserObligationForGeneration(database, mealId, chooserId) {
  if (!chooserId) return null;
  return database.prepare(`
    SELECT id, status, responded_at
      FROM planning_obligations
     WHERE entity_type = 'meal' AND entity_id = ? AND role = 'chooser'
       AND responsible_user_id = ?
       AND status NOT IN ('cancelled', 'superseded', 'declined', 'timed_out')
     ORDER BY id DESC LIMIT 1
  `).get(Number(mealId), Number(chooserId)) || null;
}

function ensureMealMenuGeneration(database, mealId) {
  const meal = database.prepare(`
    SELECT id, current_menu_generation FROM meals WHERE id = ?
  `).get(Number(mealId));
  if (!meal) throw mealPlanError('Meal not found.', 404, 'MEAL_NOT_FOUND');
  const generation = Math.max(1, Number(meal.current_menu_generation) || 1);
  let current = database.prepare(`
    SELECT * FROM meal_menu_generations WHERE meal_id = ? AND generation = ?
  `).get(Number(mealId), generation);
  if (current) return current;
  const chooserId = canonicalMealChooser(database, mealId);
  const obligation = chooserObligationForGeneration(database, mealId, chooserId);
  database.prepare(`
    INSERT OR IGNORE INTO meal_menu_generations (
      meal_id, generation, chooser_user_id, chooser_obligation_id, status,
      fulfilled_at
    ) VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    Number(mealId), generation, chooserId, obligation?.id || null,
    obligation?.status === 'fulfilled' ? 'fulfilled' : 'open',
    obligation?.status === 'fulfilled' ? (obligation.responded_at || new Date().toISOString()) : null,
  );
  current = database.prepare(`
    SELECT * FROM meal_menu_generations WHERE meal_id = ? AND generation = ?
  `).get(Number(mealId), generation);
  return current;
}

/**
 * Align the current editable menu generation with the canonical occurrence
 * chooser. Any authored draft or fulfilled menu stays owned by the chooser
 * responsibility that created it. A changed chooser or obligation releases
 * that generation as immutable history and receives a genuinely blank one;
 * only a truly empty generation may be reassigned in place.
 */
export function synchronizeMealMenuGeneration(database, mealId, {
  chooserId = undefined,
  reason = 'chooser_reassigned',
} = {}) {
  const numericMealId = Number(mealId);
  const policy = mealMenuPolicy(database, numericMealId);
  const strict = ['fixed', 'round_robin'].includes(policy);
  const canonical = chooserId === undefined
    ? canonicalMealChooser(database, numericMealId)
    : (Number(chooserId) || null);
  const current = ensureMealMenuGeneration(database, numericMealId);
  if (!strict) return { changed: false, released: false, generation: Number(current.generation), current };

  const owner = Number(current.chooser_user_id) || null;
  const obligation = chooserObligationForGeneration(database, numericMealId, canonical);
  const currentObligationId = Number(current.chooser_obligation_id) || null;
  const nextObligationId = Number(obligation?.id) || null;
  const fulfilledBySelection = Boolean(database.prepare(`
    SELECT 1
      FROM meal_person_decisions d
      JOIN meal_person_menu_selections pms ON pms.decision_id = d.id AND pms.selected = 1
      JOIN meal_menu_items mi ON mi.id = pms.menu_item_id
     WHERE d.meal_id = ? AND mi.meal_id = d.meal_id
       AND mi.menu_generation = ? AND mi.item_type = 'entree'
     LIMIT 1
  `).get(numericMealId, Number(current.generation)));
  const authoredSharedMenu = Boolean(database.prepare(`
    SELECT 1 FROM meal_menu_items
     WHERE meal_id = ? AND menu_generation = ? AND item_type IN ('entree', 'side')
     LIMIT 1
  `).get(numericMealId, Number(current.generation)));
  const mustRelease = current.status === 'fulfilled' || fulfilledBySelection || authoredSharedMenu;
  const responsibilityChanged = owner !== canonical
    || (currentObligationId != null && currentObligationId !== nextObligationId);
  if (!responsibilityChanged) {
    if (currentObligationId !== nextObligationId) {
      database.prepare(`
        UPDATE meal_menu_generations SET chooser_obligation_id = ? WHERE id = ?
      `).run(nextObligationId, current.id);
    }
    return { changed: false, released: false, generation: Number(current.generation), current };
  }

  if (!mustRelease) {
    database.prepare(`
      UPDATE meal_menu_generations
         SET chooser_user_id = ?, chooser_obligation_id = ?
       WHERE id = ?
    `).run(canonical, nextObligationId, current.id);
    const updated = database.prepare('SELECT * FROM meal_menu_generations WHERE id = ?').get(current.id);
    return { changed: true, released: false, generation: Number(current.generation), current: updated };
  }

  const nextGeneration = Number(current.generation) + 1;
  database.prepare(`
    UPDATE meal_menu_generations
       SET status = 'released', release_reason = ?,
            fulfilled_at = CASE WHEN status = 'fulfilled'
              THEN COALESCE(fulfilled_at, strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
              ELSE fulfilled_at END,
            released_at = COALESCE(released_at, strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
     WHERE id = ?
  `).run(reason, current.id);
  database.prepare(`
    INSERT OR IGNORE INTO meal_menu_generations (
      meal_id, generation, chooser_user_id, chooser_obligation_id, status
    ) VALUES (?, ?, ?, ?, 'open')
  `).run(numericMealId, nextGeneration, canonical, nextObligationId);
  database.prepare(`
    UPDATE meals
       SET current_menu_generation = ?, selection_status = 'awaiting_choice',
           updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
     WHERE id = ?
  `).run(nextGeneration, numericMealId);
  return {
    changed: true,
    released: true,
    generation: nextGeneration,
    current: database.prepare(`
      SELECT * FROM meal_menu_generations WHERE meal_id = ? AND generation = ?
    `).get(numericMealId, nextGeneration),
  };
}

function fulfillMealMenuGeneration(database, mealId, chooserId, obligationIds = []) {
  const synchronized = synchronizeMealMenuGeneration(database, mealId, { chooserId });
  const obligationId = obligationIds.map(Number).filter(Number.isInteger).at(-1) || null;
  database.prepare(`
    UPDATE meal_menu_generations
       SET chooser_user_id = ?, chooser_obligation_id = COALESCE(?, chooser_obligation_id),
           status = 'fulfilled', fulfilled_at = COALESCE(fulfilled_at, strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
     WHERE meal_id = ? AND generation = ?
  `).run(Number(chooserId) || null, obligationId, Number(mealId), synchronized.generation);
  return synchronized.generation;
}

function presentMenuItem(item) {
  return {
    ...item,
    storage_position: Number(item.position),
    position: Number(item.generation_position ?? item.position),
  };
}

function loadOccurrenceData(database, from, to, contextId = null) {
  let meals = database.prepare(`
    SELECT m.*, p.name AS meal_plan_name, p.status AS meal_plan_status,
           r.rule_key, r.label AS rule_label, r.policy, r.choice_limit, r.presence_required,
           r.cook_user_id, r.supervisor_user_id,
           r.generate_preparation, r.generate_cooking, r.generate_supervision,
           r.generate_serving, r.generate_cleanup, r.preparation_duration_minutes,
           r.cooking_duration_minutes, r.cleanup_duration_minutes,
           pr.snapshot_json AS plan_revision_snapshot,
           pc.context_key, pc.name AS context_name, pc.context_type, pc.place_id AS context_place_id,
           meal_place.name AS meal_place_name,
           oa.id AS assignment_id, oa.occurrence_key, oa.assigned_user_id,
           oa.base_rotation_key, oa.scoped_rotation_key, oa.cursor_before_user_id,
           oa.cursor_after_user_id, oa.committed
      FROM meals m
      LEFT JOIN meal_plans p ON p.id = m.meal_plan_id
      LEFT JOIN meal_plan_rules r ON r.id = m.meal_plan_rule_id
      LEFT JOIN meal_plan_revisions pr ON pr.id = m.meal_plan_revision_id
      LEFT JOIN planning_contexts pc ON pc.id = m.planning_context_id
      LEFT JOIN places meal_place ON meal_place.id = m.place_id
      LEFT JOIN meal_occurrence_assignments oa ON oa.meal_id = m.id
     WHERE m.date BETWEEN ? AND ? AND m.superseded_by_id IS NULL
       AND m.parent_meal_id IS NULL
       ${contextId == null ? '' : 'AND m.planning_context_id = ?'}
     ORDER BY m.date,
       CASE m.meal_type WHEN 'breakfast' THEN 0 WHEN 'lunch' THEN 1 WHEN 'dinner' THEN 2 ELSE 3 END,
       COALESCE(pc.name, ''), m.id
  `).all(from, to, ...(contextId == null ? [] : [Number(contextId)]));
  for (const meal of meals) synchronizeMealMenuGeneration(database, meal.id);
  // Synchronization can advance the generation and set the occurrence back to
  // awaiting choice, so refresh the persisted Meal columns before projecting.
  meals = meals.map((meal) => ({
    ...meal,
    ...database.prepare(`
      SELECT current_menu_generation, selection_status, title, recipe_id,
             updated_at
        FROM meals WHERE id = ?
    `).get(meal.id),
  }));
  const mealIds = meals.map((row) => Number(row.id));
  if (!mealIds.length) return [];
  const placeholders = mealIds.map(() => '?').join(',');

  const participantRows = database.prepare(`
    SELECT mp.*, u.display_name, u.avatar_color
      FROM meal_participants mp JOIN users u ON u.id = mp.user_id
     WHERE mp.meal_id IN (${placeholders})
     ORDER BY mp.meal_id, u.display_name COLLATE NOCASE, mp.role
  `).all(...mealIds);
  const decisionRows = database.prepare(`
    SELECT d.*, beneficiary.display_name AS beneficiary_name,
           beneficiary.avatar_color AS beneficiary_color,
           actor.display_name AS entered_by_name,
           selected.title AS selected_meal_title,
           selected.recipe_id AS selected_recipe_id
      FROM meal_person_decisions d
      JOIN users beneficiary ON beneficiary.id = d.beneficiary_user_id
      LEFT JOIN users actor ON actor.id = d.entered_by_user_id
      LEFT JOIN meals selected ON selected.id = d.selected_meal_id
     WHERE d.meal_id IN (${placeholders})
     ORDER BY d.meal_id, beneficiary.display_name COLLATE NOCASE, d.id
  `).all(...mealIds);
  const menuRows = database.prepare(`
    SELECT * FROM meal_menu_items WHERE meal_id IN (${placeholders})
     ORDER BY meal_id, CASE item_type WHEN 'entree' THEN 0 WHEN 'side' THEN 1 ELSE 2 END, position, id
  `).all(...mealIds);
  const decisionIds = decisionRows.map((row) => Number(row.id));
  const selectionRows = decisionIds.length ? database.prepare(`
    SELECT s.decision_id, i.*
      FROM meal_person_menu_selections s
      JOIN meal_menu_items i ON i.id = s.menu_item_id
     WHERE s.decision_id IN (${decisionIds.map(() => '?').join(',')}) AND s.selected = 1
     ORDER BY s.decision_id, i.item_type, i.position, i.id
  `).all(...decisionIds) : [];
  const obligationRows = database.prepare(`
    SELECT id, entity_id AS meal_id, responsible_user_id, status, response_deadline,
           responded_at, attempt, parent_obligation_id, created_at, updated_at
      FROM planning_obligations
     WHERE entity_type = 'meal' AND role = 'chooser' AND entity_id IN (${placeholders})
     ORDER BY entity_id, id
  `).all(...mealIds);

  return meals.map((meal) => {
    const planRevision = parseJson(meal.plan_revision_snapshot, {});
    const revisionRule = Array.isArray(planRevision?.rules)
      ? planRevision.rules.find((candidate) => (
        (meal.rule_key && candidate.rule_key === meal.rule_key)
        || Number(candidate.id) === Number(meal.meal_plan_rule_id)
      ))
      : null;
    const historicalRule = (name, fallback = null) => revisionRule?.[name] ?? meal[name] ?? fallback;
    const occurrencePolicy = meal.selection_policy_override || historicalRule('policy', meal.policy);
    // Read from the latest chooser-obligation snapshot first. This keeps a
    // dated occurrence's authoring/selection contract stable after the Meal
    // Plan is edited, while still covering legacy and one-off Meals.
    const courseLimits = mealMenuLimits(database, meal);
    const roles = participantRows.filter((row) => Number(row.meal_id) === Number(meal.id));
    const perUser = new Map();
    for (const role of roles) {
      if (!perUser.has(role.user_id)) {
        perUser.set(role.user_id, {
          id: role.user_id,
          user_id: role.user_id,
          display_name: role.display_name,
          avatar_color: role.avatar_color,
          roles: [],
          status: role.status,
        });
      }
      const person = perUser.get(role.user_id);
      person.roles.push(role.role);
      if (role.role === 'participant') person.status = role.status;
    }
    const rawDecisions = decisionRows
      .filter((row) => Number(row.meal_id) === Number(meal.id))
      .map((decision) => {
        const selectedItems = selectionRows
          .filter((row) => Number(row.decision_id) === Number(decision.id))
          .map(presentMenuItem);
        const legacyBackupItems = selectedItems.filter((row) => row.item_type === 'backup')
          .map((row) => ({ ...row, legacy_only: true }));
        return {
          ...decision,
          confirmed: Boolean(decision.confirmed),
          menu_items: occurrencePolicy === 'personal_choice'
            ? []
            : selectedItems.filter((row) => row.item_type !== 'backup'),
          legacy_menu_items: legacyBackupItems,
          legacy_backup_choice: decision.choice_kind === 'backup' && !decision.selected_meal_id,
        };
      });
    const participants = [...perUser.values()].map((person) => ({
      ...person,
      is_chooser: person.roles.includes('chooser'),
      is_cook: person.roles.includes('cook'),
      is_supervisor: person.roles.includes('supervisor'),
      decision: rawDecisions.find((row) => Number(row.beneficiary_user_id) === Number(person.user_id)) || null,
    }));
    if (!meal.planning_context_id) {
      const displaced = travelersAt(database, meal.date, meal);
      for (const participant of participants) {
        if (displaced.has(Number(participant.user_id))) {
          participant.status = 'away';
          participant.displaced_by_context = true;
        }
      }
    }
    const chooserObligations = obligationRows.filter((row) => Number(row.meal_id) === Number(meal.id));
    const strictSharedChoice = ['fixed', 'round_robin'].includes(occurrencePolicy);
    const assignedChooserId = Number(meal.assigned_user_id) || null;
    const choosers = participants.filter((person) => (
      person.is_chooser
      && (!strictSharedChoice || person.status === 'participating')
      && (!strictSharedChoice || !meal.assignment_id || Number(person.user_id) === assignedChooserId)
    ));
    const currentObligations = choosers.map((chooser) => chooserObligations
      .filter((row) => (
        Number(row.responsible_user_id) === Number(chooser.user_id)
        && !['cancelled', 'superseded', 'declined', 'timed_out'].includes(row.status)
      ))
      .sort((left, right) => Number(right.id) - Number(left.id))[0])
      .filter(Boolean);
    const sharedChoiceActive = !strictSharedChoice || Boolean(
      choosers.length && currentObligations.some((row) => row.status === 'fulfilled'),
    );
    const chooserStatuses = currentObligations.map((row) => row.status);
    const chooserStatus = strictSharedChoice
      ? (!choosers.length ? 'needs_fallback'
        : chooserStatuses.some((status) => status === 'fulfilled') ? 'fulfilled'
          : chooserStatuses.some((status) => ['pending', 'accepted'].includes(status)) ? 'pending'
            : 'needs_fallback')
      : (!chooserObligations.length
        ? meal.selection_status
        : chooserObligations.every((row) => row.status === 'fulfilled') ? 'fulfilled'
          : chooserObligations.some((row) => ['declined', 'timed_out'].includes(row.status)) ? 'needs_fallback'
            : 'pending');
    const decisions = rawDecisions.map((decision) => {
      const releasedSharedSelection = decision.menu_items.some((item) => (
        Number(item.menu_generation || 1) !== Number(meal.current_menu_generation || 1)
      ));
      const staleSharedChoice = strictSharedChoice
        && (!sharedChoiceActive || releasedSharedSelection)
        && decision.choice_kind === 'household';
      return staleSharedChoice ? {
        ...decision,
        historical_choice_kind: decision.choice_kind,
        historical_menu_items: decision.menu_items,
        choice_kind: 'pending',
        menu_items: [],
        is_current_choice: false,
      } : {
        ...decision,
        is_current_choice: !(decision.choice_kind === 'backup' && decision.legacy_backup_choice),
      };
    });
    for (const participant of participants) {
      participant.decision = decisions.find((row) => (
        Number(row.beneficiary_user_id) === Number(participant.user_id)
      )) || null;
    }
    const occurrenceMenuItems = menuRows
      .filter((row) => Number(row.meal_id) === Number(meal.id))
      .map(presentMenuItem);
    const currentGeneration = Number(meal.current_menu_generation) || 1;
    const authoredMenuItems = occurrencePolicy === 'personal_choice'
      ? []
      : occurrenceMenuItems.filter((row) => (
        row.item_type !== 'backup' && Number(row.menu_generation || 1) === currentGeneration
      ));
    const releasedMenuItems = occurrencePolicy === 'personal_choice'
      ? []
      : occurrenceMenuItems.filter((row) => (
        row.item_type !== 'backup' && Number(row.menu_generation || 1) !== currentGeneration
      ));
    const visibleMenuItems = strictSharedChoice && !sharedChoiceActive ? [] : authoredMenuItems;
    const legacyBackupMenuItems = occurrenceMenuItems.filter((row) => row.item_type === 'backup')
      .map((row) => ({ ...row, legacy_only: true }));
    const projectedMeal = strictSharedChoice && !sharedChoiceActive ? {
      ...meal,
      title: null,
      recipe_id: null,
      selection_status: 'awaiting_choice',
      historical_title: meal.title,
      historical_recipe_id: meal.recipe_id,
      historical_selection_status: meal.selection_status,
    } : meal;
    return {
      ...projectedMeal,
      max_entree_choices: courseLimits.max_entree_choices,
      max_side_choices: courseLimits.max_side_choices,
      menu_limits: { ...courseLimits },
      context: meal.planning_context_id ? {
        id: meal.planning_context_id,
        context_key: meal.context_key,
        name: meal.context_name,
        context_type: meal.context_type,
        place_id: meal.context_place_id,
      } : null,
      place: meal.place_id ? {
        id: meal.place_id,
        name: meal.meal_place_name,
      } : null,
      plan: meal.meal_plan_id ? {
        id: meal.meal_plan_id,
        name: meal.meal_plan_name,
        revision_id: meal.meal_plan_revision_id,
        status: meal.meal_plan_status,
      } : null,
      rule: meal.meal_plan_rule_id ? {
        id: meal.meal_plan_rule_id,
        rule_key: meal.rule_key,
        label: historicalRule('label', meal.rule_label),
        policy: occurrencePolicy,
        choice_limit: historicalRule('choice_limit', meal.choice_limit),
        max_entree_choices: courseLimits.max_entree_choices,
        max_side_choices: courseLimits.max_side_choices,
        presence_required: Boolean(historicalRule('presence_required', meal.presence_required)),
        cook_user_id: historicalRule('cook_user_id', meal.cook_user_id),
        supervisor_user_id: historicalRule('supervisor_user_id', meal.supervisor_user_id),
        generate_preparation: Boolean(historicalRule('generate_preparation', meal.generate_preparation)),
        generate_cooking: Boolean(historicalRule('generate_cooking', meal.generate_cooking)),
        generate_supervision: Boolean(historicalRule('generate_supervision', meal.generate_supervision)),
        generate_serving: Boolean(historicalRule('generate_serving', meal.generate_serving)),
        generate_cleanup: Boolean(historicalRule('generate_cleanup', meal.generate_cleanup)),
        preparation_duration_minutes: historicalRule('preparation_duration_minutes', meal.preparation_duration_minutes),
        cooking_duration_minutes: historicalRule('cooking_duration_minutes', meal.cooking_duration_minutes),
        cleanup_duration_minutes: historicalRule('cleanup_duration_minutes', meal.cleanup_duration_minutes),
      } : null,
      assignment: meal.assignment_id ? {
        id: meal.assignment_id,
        occurrence_key: meal.occurrence_key,
        assigned_user_id: meal.assigned_user_id,
        base_rotation_key: meal.base_rotation_key,
        scoped_rotation_key: meal.scoped_rotation_key,
        cursor_before_user_id: meal.cursor_before_user_id,
        cursor_after_user_id: meal.cursor_after_user_id,
        committed: Boolean(meal.committed),
      } : null,
      occurrence_id: meal.assignment_id || `meal:${meal.id}`,
      occurrence_key: meal.occurrence_key || `meal:${meal.id}`,
      participants,
      choosers,
      chooser: choosers[0] || null,
      chooser_status: chooserStatus,
      shared_choice_active: sharedChoiceActive,
      chooser_obligations: chooserObligations,
      decisions,
      menu_items: visibleMenuItems,
      draft_menu_items: authoredMenuItems,
      historical_menu_items: releasedMenuItems,
      legacy_backup_menu_items: legacyBackupMenuItems,
    };
  });
}

function withPersonalState(occurrence, memberId, canActFor) {
  const member = occurrence.participants.find((row) => Number(row.user_id) === Number(memberId)) || null;
  const decision = occurrence.decisions.find((row) => Number(row.beneficiary_user_id) === Number(memberId)) || null;
  const participant = Boolean(member?.roles.includes('participant'));
  const chooser = Boolean(member?.is_chooser);
  const unscopedHouseholdMeal = !occurrence.meal_plan_rule_id
    && !occurrence.planning_context_id
    && occurrence.scope === 'household'
    && occurrence.participants.length === 0;
  const applicable = Boolean((member && member.status !== 'away') || unscopedHouseholdMeal);
  const personalChoice = occurrence.rule?.policy === 'personal_choice';
  const chooserDraftItems = Boolean(
    canActFor && applicable && chooser && !personalChoice && !occurrence.shared_choice_active,
  ) ? (occurrence.draft_menu_items || []) : occurrence.menu_items;
  return {
    ...occurrence,
    // Only the current chooser (or an administrator explicitly acting for that
    // chooser) may see/select an unconfirmed current-generation draft. Status
    // and other participants continue to see the household Meal as Pending.
    menu_items: chooserDraftItems,
    my_participant: member,
    my_decision: decision,
    applicable,
    can_act_for: canActFor,
    controls: {
      choose_shared_meal: Boolean(canActFor && applicable && chooser && !personalChoice),
      choose_personal_meal: Boolean(canActFor && applicable && chooser && personalChoice),
      set_participation: Boolean(canActFor && participant),
      choose_backup: Boolean(
        canActFor && applicable && participant && !chooser && !personalChoice
      ),
      can_edit_shared_menu: Boolean(canActFor && applicable && chooser && !personalChoice),
      skip: Boolean(canActFor && participant),
      add_notes: Boolean(canActFor && (participant || chooser)),
    },
  };
}

export function buildMealWeekModel(database, {
  from, to, memberId, actorId, isAdmin = false, contextId = null,
} = {}) {
  assertDate(from, 'Start date');
  assertDate(to, 'End date');
  if (to < from) throw mealPlanError('End date must not precede start date.');
  const members = householdMembers(database).map((member) => ({
    ...member,
    can_act_for: Boolean(isAdmin || Number(member.id) === Number(actorId)),
  }));
  const selectedId = Number(memberId || actorId);
  const selectedMember = members.find((row) => Number(row.id) === selectedId);
  if (!selectedMember) throw mealPlanError('Household member not found.', 404, 'HOUSEHOLD_MEMBER_NOT_FOUND');
  const occurrences = loadOccurrenceData(database, from, to, contextId)
    .map((row) => withPersonalState(row, selectedId, selectedMember.can_act_for));
  return {
    start: from,
    end: to,
    member: selectedMember,
    members,
    contexts: loadContexts(database, from, to),
    occurrences,
  };
}

function optionForPerson(occurrence, participant) {
  const decision = participant.decision;
  if (participant.status === 'away' || decision?.participation === 'away') {
    return { key: 'away', type: 'away', title: 'Away / unavailable' };
  }
  if (participant.status === 'not_participating' || decision?.participation === 'not_participating') {
    return { key: 'skipped', type: 'skipped', title: 'Skipping this meal' };
  }
  if (!decision || decision.participation === 'pending' || decision.choice_kind === 'pending') {
    return { key: 'pending', type: 'pending', title: 'Pending' };
  }
  if (occurrence.rule?.policy === 'personal_choice' && decision.choice_kind === 'backup') {
    return { key: 'pending', type: 'pending', title: 'Pending' };
  }
  const selected = decision.menu_items.filter((item) => item.item_type !== 'side');
  const first = selected[0];
  if (first) return { key: `menu:${first.id}`, type: first.item_type, title: first.title, menu_item_id: first.id };
  if (decision.choice_kind === 'backup') {
    if (!decision.selected_meal_id) return { key: 'pending', type: 'pending', title: 'Pending' };
    const title = decision.selected_meal_title || decision.notes || 'Backup Meal';
    return { key: `backup:${decision.selected_meal_id}`, type: 'backup', title };
  }
  if (['personal', 'restaurant', 'takeout'].includes(decision.choice_kind)) {
    const title = decision.selected_meal_title || decision.notes || `${decision.choice_kind[0].toUpperCase()}${decision.choice_kind.slice(1)} meal`;
    return { key: `${decision.choice_kind}:${title}`, type: decision.choice_kind, title };
  }
  const entree = occurrence.menu_items.find((item) => item.item_type === 'entree');
  const selectedTitle = occurrence.shared_choice_active === false
    ? null
    : (entree?.title || (occurrence.selection_status === 'selected' ? occurrence.title : null));
  return selectedTitle
    ? { key: `household:${selectedTitle}`, type: 'household', title: selectedTitle }
    : { key: 'pending', type: 'pending', title: 'Pending' };
}

function aggregateOccurrence(occurrence) {
  const participants = occurrence.participants.filter((row) => row.roles.includes('participant'));
  const buckets = new Map();
  for (const participant of participants) {
    const option = optionForPerson(occurrence, participant);
    if (!buckets.has(option.key)) buckets.set(option.key, { ...option, people: [] });
    buckets.get(option.key).people.push({
      id: participant.user_id,
      user_id: participant.user_id,
      display_name: participant.display_name,
      avatar_color: participant.avatar_color,
    });
  }
  const choices = [...buckets.values()].map((bucket) => ({ ...bucket, count: bucket.people.length }));
  const pending = choices.find((choice) => choice.type === 'pending')?.people || [];
  const skipped = choices.find((choice) => choice.type === 'skipped')?.people || [];
  const unavailable = choices.find((choice) => choice.type === 'away')?.people || [];
  return {
    ...occurrence,
    choices,
    totals: {
      participants: participants.length,
      resolved: Math.max(0, participants.length - pending.length),
      pending: pending.length,
      skipped: skipped.length,
      unavailable: unavailable.length,
    },
    pending_people: pending,
    skipped_people: skipped,
    unavailable_people: unavailable,
  };
}

export function buildMealStatus(database, { from, to, contextId = null } = {}) {
  assertDate(from, 'Start date');
  assertDate(to, 'End date');
  if (to < from) throw mealPlanError('End date must not precede start date.');
  return {
    start: from,
    end: to,
    contexts: loadContexts(database, from, to),
    occurrences: loadOccurrenceData(database, from, to, contextId).map(aggregateOccurrence),
  };
}

function chooserFallbackContext(database, meal) {
  const assignment = database.prepare(`
    SELECT * FROM meal_occurrence_assignments WHERE meal_id = ?
  `).get(Number(meal.id));
  const obligation = database.prepare(`
    SELECT * FROM planning_obligations
     WHERE entity_type = 'meal' AND entity_id = ? AND role = 'chooser'
     ORDER BY id DESC LIMIT 1
  `).get(Number(meal.id));
  const metadata = parseJson(obligation?.metadata_json, {});
  const ruleId = Number(meal.meal_plan_rule_id || assignment?.meal_plan_rule_id) || null;
  const rule = ruleId
    ? loadRuleForOccurrence(database, ruleId, meal.meal_plan_revision_id)
    : null;
  const authoredDefaults = rule ? resolvedChooserDefaults(database, rule) : {
    chooser_fallback_user_ids: [],
    chooser_terminal_strategy: 'eligible_round_robin',
    chooser_terminal_user_id: null,
    chooser_round_robin_user_ids: [],
    max_entree_choices: 1,
    max_side_choices: 3,
  };
  const fallbackIds = Array.isArray(metadata.chooser_fallback_user_ids)
    ? metadata.chooser_fallback_user_ids.map(Number).filter(Number.isInteger)
    : authoredDefaults.chooser_fallback_user_ids;
  const terminalStrategy = TERMINAL_CHOOSER_STRATEGIES.has(metadata.chooser_terminal_strategy)
    ? metadata.chooser_terminal_strategy
    : authoredDefaults.chooser_terminal_strategy;
  const terminalUserId = Number(
    metadata.chooser_terminal_user_id ?? authoredDefaults.chooser_terminal_user_id,
  ) || null;
  const terminalRoundRobinIds = Array.isArray(metadata.chooser_round_robin_user_ids)
    ? metadata.chooser_round_robin_user_ids.map(Number).filter(Number.isInteger)
    : authoredDefaults.chooser_round_robin_user_ids;
  return {
    assignment,
    obligation,
    metadata: {
      ...metadata,
      meal_plan_id: metadata.meal_plan_id ?? meal.meal_plan_id ?? rule?.meal_plan_id ?? null,
      meal_plan_rule_id: metadata.meal_plan_rule_id ?? ruleId,
      planning_context_id: metadata.planning_context_id ?? meal.planning_context_id ?? null,
      policy: metadata.policy ?? rule?.policy ?? mealSelectionPolicy(database, meal),
      chooser_fallback_user_ids: [...new Set(fallbackIds)],
      chooser_terminal_strategy: terminalStrategy,
      chooser_terminal_user_id: terminalUserId,
      chooser_round_robin_user_ids: [...new Set(terminalRoundRobinIds)],
      terminal_rotation_key: metadata.terminal_rotation_key
        || (rule ? terminalChooserRotationKey(
          database,
          rule,
          meal.planning_context_id,
          terminalRoundRobinIds,
        ) : `meal:${meal.id}:terminal-chooser`),
      max_entree_choices: Number.isInteger(Number(metadata.max_entree_choices))
        ? Number(metadata.max_entree_choices) : authoredDefaults.max_entree_choices,
      max_side_choices: Number.isInteger(Number(metadata.max_side_choices))
        ? Number(metadata.max_side_choices) : authoredDefaults.max_side_choices,
    },
    rule,
  };
}

function fallbackEligibleUsers(database, meal, context) {
  let eligible = [];
  if (context.rule) {
    const planningContext = meal.planning_context_id
      ? database.prepare('SELECT * FROM planning_contexts WHERE id = ?').get(Number(meal.planning_context_id))
      : null;
    eligible = occurrenceCohort(
      database,
      context.rule,
      planningContext,
      meal.date,
    ).responsibilityEligible;
  }
  if (!eligible.length) {
    eligible = database.prepare(`
      SELECT DISTINCT user_id FROM meal_participants
       WHERE meal_id = ? AND role = 'participant' AND status = 'participating'
       ORDER BY user_id
    `).all(Number(meal.id)).map((row) => Number(row.user_id));
  }
  const declinedParticipation = new Set(database.prepare(`
    SELECT beneficiary_user_id FROM meal_person_decisions
     WHERE meal_id = ? AND participation IN ('not_participating', 'away')
  `).all(Number(meal.id)).map((row) => Number(row.beneficiary_user_id)));
  const household = new Set(householdMembers(database).map((row) => Number(row.id)));
  return [...new Set(eligible.map(Number))]
    .filter((userId) => household.has(userId) && !declinedParticipation.has(userId));
}

function fallbackLogicalKey(context, mealId, attempt, userId = null) {
  const base = context.obligation?.logical_key
    || context.assignment?.occurrence_key
    || `meal:${Number(mealId)}:chooser`;
  return `${base}:fallback:attempt:${attempt}${userId ? `:${Number(userId)}` : ''}`;
}

function addChooserObligationEvent(database, obligationId, event, actorId, details = null) {
  database.prepare(`
    INSERT INTO planning_obligation_events (
      obligation_id, event, actor_user_id, details_json
    ) VALUES (?, ?, ?, ?)
  `).run(
    Number(obligationId),
    event,
    actorId || null,
    details == null ? null : JSON.stringify(details),
  );
}

function setMealChooserRoles(database, mealId, chooserIds, {
  forceParticipantIds = [],
} = {}) {
  database.prepare("DELETE FROM meal_participants WHERE meal_id = ? AND role = 'chooser'")
    .run(Number(mealId));
  const ensureRole = database.prepare(`
    INSERT INTO meal_participants (meal_id, user_id, role, status, source)
    VALUES (?, ?, ?, 'participating', 'schedule')
    ON CONFLICT(meal_id, user_id, role) DO UPDATE SET
      status = 'participating', updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
  `);
  for (const userId of forceParticipantIds) {
    ensureRole.run(Number(mealId), Number(userId), 'participant');
  }
  for (const userId of chooserIds) {
    ensureRole.run(Number(mealId), Number(userId), 'chooser');
  }
}

function closeStaleChooserObligations(database, mealId, actorId, reason) {
  const active = database.prepare(`
    SELECT * FROM planning_obligations
     WHERE entity_type = 'meal' AND entity_id = ? AND role = 'chooser'
       AND status IN ('pending', 'accepted')
     ORDER BY id
  `).all(Number(mealId));
  for (const obligation of active) {
    database.prepare(`
      UPDATE planning_obligations SET status = 'superseded',
        responded_at = COALESCE(responded_at, strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
        response_note = COALESCE(response_note, ?),
        updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
       WHERE id = ?
    `).run(reason, obligation.id);
    addChooserObligationEvent(database, obligation.id, 'chooser_repair_superseded', actorId, { reason });
  }
  return active;
}

/**
 * Advance one Meal occurrence through its snapshotted chooser chain. This is
 * deliberately occurrence-local: editing household defaults later never
 * rewrites a released request or menu generation.
 */
export function advanceMealChooserFallback(database, mealId, {
  sourceObligationId = null,
  actorId = null,
  reason = 'chooser_repair',
} = {}) {
  return database.transaction(() => {
    const meal = database.prepare('SELECT * FROM meals WHERE id = ?').get(Number(mealId));
    if (!meal) throw mealPlanError('Meal not found.', 404, 'MEAL_NOT_FOUND');
    const context = chooserFallbackContext(database, meal);
    const active = database.prepare(`
      SELECT * FROM planning_obligations
       WHERE entity_type = 'meal' AND entity_id = ? AND role = 'chooser'
         AND status IN ('pending', 'accepted')
       ORDER BY id DESC
    `).all(Number(meal.id));
    if (active.length) {
      const assignedId = Number(context.assignment?.assigned_user_id) || null;
      const activeIds = new Set(active.map((row) => Number(row.responsible_user_id)).filter(Boolean));
      const activePolicy = mealSelectionPolicy(database, meal);
      const validPersonal = activePolicy === 'personal_choice';
      const validShared = assignedId && activeIds.has(assignedId) && Boolean(database.prepare(`
        SELECT 1 FROM meal_participants
         WHERE meal_id = ? AND user_id = ? AND role = 'participant'
           AND status = 'participating'
      `).get(Number(meal.id), assignedId));
      if (validPersonal || validShared) {
        return {
          status: 'pending',
          changed: false,
          fallback: assignedId ? { user_id: assignedId } : null,
          replacement_obligation_ids: active.map((row) => Number(row.id)),
        };
      }
      closeStaleChooserObligations(database, meal.id, actorId, reason);
    } else {
      const latest = database.prepare(`
        SELECT * FROM planning_obligations
         WHERE entity_type = 'meal' AND entity_id = ? AND role = 'chooser'
         ORDER BY id DESC LIMIT 1
      `).get(Number(meal.id));
      if (mealSelectionPolicy(database, meal) === 'personal_choice' && latest) {
        return {
          status: 'resolved', changed: false, fallback: null,
          replacement_obligation_ids: [],
        };
      }
      const assignedId = Number(context.assignment?.assigned_user_id) || null;
      const assignedStillValid = assignedId && latest?.status === 'fulfilled'
        && Number(latest.responsible_user_id) === assignedId
        && Boolean(database.prepare(`
          SELECT 1 FROM meal_participants
           WHERE meal_id = ? AND user_id = ? AND role = 'participant'
             AND status = 'participating'
        `).get(Number(meal.id), assignedId));
      if (assignedStillValid) {
        return {
          status: 'fulfilled', changed: false,
          fallback: { user_id: assignedId },
          replacement_obligation_ids: [Number(latest.id)],
        };
      }
    }

    const snapshot = context.metadata;
    const eligible = fallbackEligibleUsers(database, meal, context);
    const obligations = database.prepare(`
      SELECT * FROM planning_obligations
       WHERE entity_type = 'meal' AND entity_id = ? AND role = 'chooser'
       ORDER BY id
    `).all(Number(meal.id));
    const tried = new Set(obligations.map((row) => Number(row.responsible_user_id)).filter(Boolean));
    const source = sourceObligationId
      ? obligations.find((row) => Number(row.id) === Number(sourceObligationId))
      : obligations.at(-1);
    const attempt = Math.max(0, ...obligations.map((row) => Number(row.attempt) || 0)) + 1;
    const fixedFallback = snapshot.chooser_fallback_user_ids.find((userId) => (
      eligible.includes(Number(userId)) && !tried.has(Number(userId))
    ));
    let selected = Number(fixedFallback) || null;
    let stage = selected ? 'ordered_fixed_fallback' : snapshot.chooser_terminal_strategy;
    let forceParticipant = false;
    let rotation = null;

    if (!selected && snapshot.chooser_terminal_strategy === 'fixed') {
      selected = Number(snapshot.chooser_terminal_user_id) || null;
      forceParticipant = Boolean(selected);
      if (!selected) {
        throw mealPlanError(
          'The fixed last-resort chooser is no longer available. Update Meal Plan Default Settings or choose another repair strategy.',
          409,
          'MEAL_CHOOSER_DEFAULT_REPAIR_REQUIRED',
        );
      }
    } else if (!selected && snapshot.chooser_terminal_strategy === 'eligible_round_robin') {
      const configured = snapshot.chooser_round_robin_user_ids
        .filter((userId) => eligible.includes(Number(userId)));
      const baseCandidates = configured.length ? configured : eligible;
      const untried = baseCandidates.filter((userId) => !tried.has(Number(userId)));
      const candidates = untried.length ? untried : baseCandidates;
      if (candidates.length) {
        rotation = chooseRoundRobin(
          database,
          snapshot.terminal_rotation_key,
          candidates,
        );
        selected = Number(rotation.selected) || null;
      }
    }

    if (!selected && snapshot.chooser_terminal_strategy === 'personal_choice') {
      const participants = database.prepare(`
        SELECT DISTINCT user_id FROM meal_participants
         WHERE meal_id = ? AND role = 'participant' AND status = 'participating'
         ORDER BY user_id
      `).all(Number(meal.id)).map((row) => Number(row.user_id));
      const personalUsers = participants.length ? participants : eligible;
      synchronizeMealMenuGeneration(database, meal.id, {
        chooserId: null,
        reason: `${reason}:personal_choice`,
      });
      database.prepare(`
        UPDATE meals SET selection_policy_override = 'personal_choice',
          selection_status = 'awaiting_choice',
          updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
         WHERE id = ?
      `).run(Number(meal.id));
      if (context.assignment) {
        database.prepare(`
          UPDATE meal_occurrence_assignments SET assigned_user_id = NULL WHERE id = ?
        `).run(context.assignment.id);
      }
      setMealChooserRoles(database, meal.id, personalUsers);
      const insert = database.prepare(`
        INSERT OR IGNORE INTO planning_obligations (
          entity_type, entity_id, logical_key, role, responsible_user_id,
          due_at, response_deadline, reminder_at, status, attempt,
          parent_obligation_id, fallback_source, metadata_json
        ) VALUES ('meal', ?, ?, 'chooser', ?, ?, ?, ?, 'pending', ?, ?, ?, ?)
      `);
      const ids = [];
      for (const userId of personalUsers) {
        const personalMetadata = {
          ...snapshot,
          policy: 'personal_choice',
          participant_user_id: Number(userId),
          fallback_stage: 'personal_choice',
          previous_obligation_id: Number(source?.id) || null,
        };
        const result = insert.run(
          Number(meal.id), fallbackLogicalKey(context, meal.id, attempt, userId), Number(userId),
          source?.due_at || null, source?.response_deadline || null, source?.reminder_at || null,
          attempt, Number(source?.id) || null, `${reason}:${Number(source?.responsible_user_id) || 'unassigned'}`,
          JSON.stringify(personalMetadata),
        );
        if (result.changes) {
          const id = Number(result.lastInsertRowid);
          ids.push(id);
          addChooserObligationEvent(database, id, 'fallback_personal_choice_assigned', actorId, {
            previous_obligation_id: Number(source?.id) || null,
          });
        }
      }
      if (!ids.length && !personalUsers.length) {
        return {
          status: 'needs_repair', changed: true, fallback: null,
          code: 'MEAL_CHOOSER_NO_ELIGIBLE_MEMBERS',
          message: 'No participating household member is currently eligible. Update participation or availability, then repair the chooser.',
        };
      }
      return {
        status: 'pending', changed: true, policy: 'personal_choice', fallback: null,
        replacement_obligation_ids: ids,
      };
    }

    if (!selected) {
      database.prepare(`
        UPDATE meals SET selection_status = 'awaiting_choice',
          updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now') WHERE id = ?
      `).run(Number(meal.id));
      setMealChooserRoles(database, meal.id, []);
      if (context.assignment) {
        database.prepare('UPDATE meal_occurrence_assignments SET assigned_user_id = NULL WHERE id = ?')
          .run(context.assignment.id);
      }
      return {
        status: 'needs_repair', changed: true, fallback: null,
        code: 'MEAL_CHOOSER_NO_ELIGIBLE_MEMBERS',
        message: 'No eligible chooser is available. Update household availability or Meal Plan defaults, then use Repair chooser.',
      };
    }

    const replacementMetadata = {
      ...snapshot,
      policy: snapshot.policy === 'personal_choice' ? 'fixed' : snapshot.policy,
      participant_user_id: null,
      fallback_stage: stage,
      previous_obligation_id: Number(source?.id) || null,
      terminal_rotation_before_user_id: rotation?.before ?? null,
      terminal_rotation_after_user_id: rotation?.after ?? null,
    };
    const result = database.prepare(`
      INSERT INTO planning_obligations (
        entity_type, entity_id, logical_key, role, responsible_user_id,
        due_at, response_deadline, reminder_at, status, attempt,
        parent_obligation_id, fallback_source, metadata_json
      ) VALUES ('meal', ?, ?, 'chooser', ?, ?, ?, ?, 'pending', ?, ?, ?, ?)
    `).run(
      Number(meal.id), fallbackLogicalKey(context, meal.id, attempt), selected,
      source?.due_at || null, source?.response_deadline || null, source?.reminder_at || null,
      attempt, Number(source?.id) || null, `${reason}:${Number(source?.responsible_user_id) || 'unassigned'}`,
      JSON.stringify(replacementMetadata),
    );
    const replacementId = Number(result.lastInsertRowid);
    synchronizeMealMenuGeneration(database, meal.id, {
      chooserId: selected,
      reason: `${reason}:${stage}`,
    });
    database.prepare(`
      UPDATE meals SET selection_policy_override = NULL,
        selection_status = 'awaiting_choice',
        updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now') WHERE id = ?
    `).run(Number(meal.id));
    setMealChooserRoles(database, meal.id, [selected], {
      forceParticipantIds: forceParticipant ? [selected] : [],
    });
    if (context.assignment) {
      database.prepare(`
        UPDATE meal_occurrence_assignments SET assigned_user_id = ? WHERE id = ?
      `).run(selected, context.assignment.id);
    }
    addChooserObligationEvent(database, replacementId, 'fallback_assigned', actorId, {
      previous_obligation_id: Number(source?.id) || null,
      fallback_stage: stage,
    });
    return {
      status: 'pending', changed: true,
      fallback: { user_id: selected, stage },
      replacement_obligation_id: replacementId,
      replacement_obligation_ids: [replacementId],
    };
  })();
}

export function repairMealChooser(database, mealId, { actorId = null } = {}) {
  return advanceMealChooserFallback(database, mealId, {
    actorId,
    reason: 'manual_repair',
  });
}

function mealSelectionPolicy(database, meal) {
  return database.prepare(`
    SELECT COALESCE(
             m.selection_policy_override,
             r.policy,
             s.policy,
             json_extract(o.metadata_json, '$.policy')
           ) AS policy
      FROM meals m
      LEFT JOIN meal_plan_rules r ON r.id = m.meal_plan_rule_id
      LEFT JOIN meal_schedule_slots s ON s.id = m.schedule_slot_id
      LEFT JOIN planning_obligations o
        ON o.entity_type = 'meal' AND o.entity_id = m.id AND o.role = 'chooser'
     WHERE m.id = ?
     ORDER BY o.id
     LIMIT 1
  `).get(Number(meal.id))?.policy || null;
}

function mealMenuLimits(database, mealOrId) {
  const meal = typeof mealOrId === 'object' && mealOrId
    ? mealOrId
    : database.prepare('SELECT * FROM meals WHERE id = ?').get(Number(mealOrId));
  if (!meal) throw mealPlanError('Meal not found.', 404, 'MEAL_NOT_FOUND');
  const obligation = database.prepare(`
    SELECT metadata_json FROM planning_obligations
     WHERE entity_type = 'meal' AND entity_id = ? AND role = 'chooser'
     ORDER BY id DESC LIMIT 1
  `).get(Number(meal.id));
  const metadata = parseJson(obligation?.metadata_json, {});
  const assignment = database.prepare(`
    SELECT meal_plan_rule_id FROM meal_occurrence_assignments WHERE meal_id = ?
  `).get(Number(meal.id));
  const ruleId = Number(meal.meal_plan_rule_id || assignment?.meal_plan_rule_id) || null;
  const rule = ruleId
    ? loadRuleForOccurrence(database, ruleId, meal.meal_plan_revision_id)
    : null;
  const legacyLimit = Math.min(9, Math.max(0, Number(
    metadata.choice_limit ?? rule?.choice_limit ?? 3,
  ) || 0));
  return {
    max_entree_choices: integer(
      metadata.max_entree_choices ?? rule?.max_entree_choices,
      { fallback: 1, min: 0, max: 9, field: 'Maximum entree choices' },
    ),
    max_side_choices: integer(
      metadata.max_side_choices ?? rule?.max_side_choices,
      { fallback: legacyLimit, min: 0, max: 9, field: 'Maximum side choices' },
    ),
  };
}

function normalizeDecision(database, meal, body, current = null, {
  policy = null, isChooser = false,
} = {}) {
  let participation = body?.participation;
  if (participation == null && body?.participating != null) participation = bool(body.participating) ? 'participating' : 'not_participating';
  if (body?.choice === 'skip') participation = 'not_participating';
  participation = String(participation ?? current?.participation ?? 'participating');
  let choiceKind = body?.choice_kind ?? body?.choice ?? current?.choice_kind ?? 'household';
  if (choiceKind === 'assigned') choiceKind = 'household';
  if (choiceKind === 'skip') choiceKind = current?.choice_kind || 'household';
  choiceKind = String(choiceKind);
  if (!PARTICIPATION.has(participation)) throw mealPlanError('Choose a valid participation state.');
  if (!CHOICE_KINDS.has(choiceKind)) throw mealPlanError('Choose a valid meal choice.');
  const selectedMealTouched = Object.hasOwn(body || {}, 'selected_meal_id')
    || Object.hasOwn(body || {}, 'selectedMealId');
  const selectedMealId = selectedMealTouched
    ? integer(body?.selected_meal_id ?? body?.selectedMealId, { field: 'Selected meal' })
    : (current?.selected_meal_id ?? null);
  if (selectedMealId && !database.prepare('SELECT 1 FROM meals WHERE id = ?').get(selectedMealId)) {
    throw mealPlanError('Selected meal not found.', 404, 'SELECTED_MEAL_NOT_FOUND');
  }
  const selectedRecipeTouched = Object.hasOwn(body || {}, 'selected_recipe_id')
    || Object.hasOwn(body || {}, 'selectedRecipeId');
  const selectedRecipeId = selectedRecipeTouched
    ? integer(body?.selected_recipe_id ?? body?.selectedRecipeId, { field: 'Selected recipe' })
    : (current?.selected_recipe_id ?? null);
  let selectedMealTitle = text(
    body?.selected_meal_title ?? body?.selectedMealTitle ?? current?.selected_meal_title,
    { max: 300, field: 'Selected meal title' },
  );
  if (selectedRecipeId) {
    const recipe = database.prepare('SELECT id, title FROM recipes WHERE id = ?').get(selectedRecipeId);
    if (!recipe) throw mealPlanError('Selected recipe not found.', 404, 'SELECTED_RECIPE_NOT_FOUND');
    if (!selectedMealTitle) selectedMealTitle = recipe.title;
  }
  const menuTouched = Object.hasOwn(body || {}, 'menu_item_ids')
    || Object.hasOwn(body || {}, 'meal_menu_item_ids');
  const menuIds = [...new Set((menuTouched
    ? (body?.menu_item_ids ?? body?.meal_menu_item_ids ?? [])
    // Legacy Personal Choice decisions could retain selections from the old
    // shared-menu model. Preserve those rows as history, but never inherit
    // them into a modern Personal Choice update.
    : (policy === 'personal_choice' ? [] : (current?.menu_item_ids ?? [])))
    .map(Number).filter(Number.isInteger))];
  let selectedMenu = [];
  if (menuIds.length) {
    selectedMenu = database.prepare(`
      SELECT id, item_type, menu_generation FROM meal_menu_items
       WHERE meal_id = ? AND menu_generation = ?
         AND id IN (${menuIds.map(() => '?').join(',')})
    `).all(meal.id, Number(meal.current_menu_generation) || 1, ...menuIds);
    if (selectedMenu.length !== menuIds.length) {
      throw mealPlanError(
        'One or more menu items belong to a released chooser menu and cannot be selected.',
        409,
        'MEAL_MENU_GENERATION_RELEASED',
      );
    }
    const limits = mealMenuLimits(database, meal);
    const entreeCount = Number(database.prepare(`
      SELECT COUNT(*) AS count FROM meal_menu_items
       WHERE id IN (${menuIds.map(() => '?').join(',')}) AND item_type IN ('entree', 'backup')
    `).get(...menuIds).count);
    if (entreeCount > limits.max_entree_choices) {
      throw mealPlanError(
        `Choose no more than ${limits.max_entree_choices} entree option${limits.max_entree_choices === 1 ? '' : 's'}.`,
        409,
        'MEAL_ENTREE_LIMIT_EXCEEDED',
      );
    }
    if (selectedMenu.filter((item) => item.item_type === 'side').length > limits.max_side_choices) {
      throw mealPlanError(
        `Choose no more than ${limits.max_side_choices} side dish${limits.max_side_choices === 1 ? '' : 'es'}.`,
        409,
        'MEAL_SIDE_LIMIT_EXCEEDED',
      );
    }
  }
  const participating = participation === 'participating';
  const backups = selectedMenu.filter((item) => item.item_type === 'backup');
  const sharedItems = selectedMenu.filter((item) => item.item_type === 'entree' || item.item_type === 'side');
  if (policy === 'personal_choice') {
    if (choiceKind === 'backup' || backups.length) {
      throw mealPlanError('Backup Meals are not available for Personal Choice slots.', 409, 'PERSONAL_CHOICE_BACKUP_NOT_ALLOWED');
    }
    if (menuIds.length) {
      throw mealPlanError('Personal Choice uses an individual meal, not shared menu items.', 409, 'PERSONAL_CHOICE_MENU_NOT_ALLOWED');
    }
    if (participating && bool(body?.confirmed, Boolean(current?.confirmed))
        && !['personal', 'restaurant', 'takeout'].includes(choiceKind)) {
      throw mealPlanError('Choose a personal meal, restaurant, or takeout option.', 409, 'PERSONAL_CHOICE_REQUIRED');
    }
  } else if (['fixed', 'round_robin'].includes(policy)) {
    if (isChooser) {
      if (choiceKind === 'backup' || backups.length) {
        throw mealPlanError('The assigned chooser cannot select the Backup Meal.', 409, 'CHOOSER_BACKUP_NOT_ALLOWED');
      }
      if (participating && choiceKind !== 'household') {
        throw mealPlanError('The assigned chooser selects the shared household meal.', 409, 'CHOOSER_SHARED_SELECTION_REQUIRED');
      }
      const limits = mealMenuLimits(database, meal);
      const selectedEntrees = selectedMenu.filter((item) => item.item_type === 'entree').length;
      if (menuTouched && participating && bool(body?.confirmed, Boolean(current?.confirmed))
          && selectedEntrees !== (limits.max_entree_choices > 0 ? 1 : 0)) {
        throw mealPlanError('Choose exactly one shared entrée.', 409, 'SHARED_ENTREE_REQUIRED');
      }
    } else {
      if (choiceKind === 'backup' && menuIds.length) {
        throw mealPlanError(
          'A Backup Meal is an individual recipe or custom meal, not a shared menu item.',
          409,
          'BACKUP_MENU_IDS_NOT_ALLOWED',
        );
      }
      if (sharedItems.length) {
        throw mealPlanError('Only the assigned chooser may select the shared entrée or sides.', 403, 'SHARED_MENU_NOT_ALLOWED');
      }
      if (choiceKind === 'backup') {
        if (participating && bool(body?.confirmed, Boolean(current?.confirmed)) && !selectedMealTitle) {
          throw mealPlanError(
            'Choose a saved recipe or name the individual Backup Meal.',
            409,
            'BACKUP_CHOICE_REQUIRED',
          );
        }
      } else if (choiceKind === 'household') {
        if (menuIds.length) {
          throw mealPlanError('The shared household choice does not accept menu item IDs.', 409, 'HOUSEHOLD_MENU_IDS_NOT_ALLOWED');
        }
      } else if (participating) {
        throw mealPlanError('Choose the shared household meal or the Backup Meal.', 409, 'SHARED_OR_BACKUP_REQUIRED');
      }
    }
  } else if (choiceKind === 'backup') {
    if (menuIds.length || backups.length) {
      throw mealPlanError(
        'A Backup Meal is an individual recipe or custom meal, not a shared menu item.',
        409,
        'BACKUP_MENU_IDS_NOT_ALLOWED',
      );
    }
    if (participating && bool(body?.confirmed, Boolean(current?.confirmed)) && !selectedMealTitle) {
      throw mealPlanError(
        'Choose a saved recipe or name the individual Backup Meal.',
        409,
        'BACKUP_CHOICE_REQUIRED',
      );
    }
  }
  return {
    participation,
    choice_kind: choiceKind,
    selected_meal_id: selectedMealId,
    selected_meal_title: selectedMealTitle,
    selected_recipe_id: selectedRecipeId,
    notes: text(body?.notes ?? current?.notes, { max: 4000, field: 'Notes' }),
    confirmed: bool(body?.confirmed, Boolean(current?.confirmed)) ? 1 : 0,
    menu_item_ids: menuIds,
  };
}

export function saveMealDecision(database, mealId, body, {
  actorId, isAdmin = false, deviceKey = null,
} = {}) {
  synchronizeMealMenuGeneration(database, mealId);
  const meal = database.prepare('SELECT * FROM meals WHERE id = ?').get(Number(mealId));
  if (!meal) throw mealPlanError('Meal not found.', 404, 'MEAL_NOT_FOUND');
  const beneficiaryId = Number(body?.beneficiary_user_id || actorId);
  if (!Number.isInteger(beneficiaryId) || beneficiaryId <= 0) {
    throw mealPlanError('Choose a valid decision beneficiary.');
  }
  assertUserIds(database, [beneficiaryId]);
  if (Number(actorId) !== beneficiaryId && !isAdmin) {
    throw mealPlanError('Only an administrator can enter a meal decision for another household member.', 403, 'ACTING_FOR_NOT_ALLOWED');
  }
  const applicable = database.prepare(`
    SELECT role, status FROM meal_participants
     WHERE meal_id = ? AND user_id = ? AND role IN ('participant', 'chooser')
       AND status != 'away'
     ORDER BY CASE role WHEN 'participant' THEN 0 ELSE 1 END
     LIMIT 1
  `).get(meal.id, beneficiaryId);
  if (!applicable) {
    throw mealPlanError(
      'This household member is not part of this meal occurrence.',
      409,
      'MEAL_DECISION_NOT_APPLICABLE',
    );
  }
  const currentRow = database.prepare(`
    SELECT d.*, selected.title AS selected_meal_title,
           selected.recipe_id AS selected_recipe_id
      FROM meal_person_decisions d
      LEFT JOIN meals selected ON selected.id = d.selected_meal_id
     WHERE d.meal_id = ? AND d.beneficiary_user_id = ?
  `).get(meal.id, beneficiaryId);
  const current = currentRow ? {
    ...currentRow,
    menu_item_ids: database.prepare(`
      SELECT pms.menu_item_id
        FROM meal_person_menu_selections pms
        JOIN meal_menu_items mi ON mi.id = pms.menu_item_id
       WHERE pms.decision_id = ? AND pms.selected = 1
         AND mi.menu_generation = ?
       ORDER BY pms.menu_item_id
    `).all(currentRow.id, Number(meal.current_menu_generation) || 1)
      .map((row) => Number(row.menu_item_id)),
  } : null;
  const policy = mealSelectionPolicy(database, meal);
  const occurrenceAssignment = database.prepare(`
    SELECT id, assigned_user_id FROM meal_occurrence_assignments WHERE meal_id = ?
  `).get(meal.id);
  const hasChooserRole = Boolean(database.prepare(`
    SELECT 1 FROM meal_participants
     WHERE meal_id = ? AND user_id = ? AND role = 'chooser' AND status = 'participating'
  `).get(meal.id, beneficiaryId));
  const isChooser = hasChooserRole && (
    policy === 'personal_choice'
    || !occurrenceAssignment
    || Number(occurrenceAssignment.assigned_user_id) === beneficiaryId
  );
  const isParticipatingMember = Boolean(database.prepare(`
    SELECT 1 FROM meal_participants
     WHERE meal_id = ? AND user_id = ? AND role = 'participant' AND status = 'participating'
  `).get(meal.id, beneficiaryId));
  const attemptedSharedChoice = Object.hasOwn(body || {}, 'menu_item_ids')
    || Object.hasOwn(body || {}, 'meal_menu_item_ids');
  if (isAdmin && Number(actorId) !== beneficiaryId
      && ['fixed', 'round_robin'].includes(policy) && attemptedSharedChoice && !isChooser) {
    throw mealPlanError(
      'This person is no longer the active chooser. Refresh the Meal or use Repair chooser before acting for them.',
      409,
      'MEAL_CHOOSER_REPAIR_REQUIRED',
    );
  }
  const normalized = normalizeDecision(database, meal, body, current, { policy, isChooser });
  const chooserSkipping = ['fixed', 'round_robin'].includes(policy) && isChooser
    && (!isParticipatingMember || normalized.participation !== 'participating');
  let decisionId;
  let eventId;
  let chooserResult = null;
  database.transaction(() => {
    const enteredVia = Number(actorId) !== beneficiaryId ? 'administrator' : (deviceKey ? 'hub' : 'self');
    const isIndividualSelection = ['backup', 'personal', 'restaurant', 'takeout'].includes(normalized.choice_kind)
      && normalized.participation === 'participating';
    if (isIndividualSelection && normalized.confirmed) {
      if (!normalized.selected_meal_title) {
        throw mealPlanError(
          normalized.choice_kind === 'backup'
            ? 'Choose a saved recipe or name the individual Backup Meal.'
            : 'Name the personal meal, choose a recipe, or choose not to participate.',
        );
      }
      const sourceKey = `meal-person-decision:${meal.id}:${beneficiaryId}`;
      // `meals.scope` intentionally keeps the released persistence domain.
      // Backup is distinguished by the parent decision's choice_kind and the
      // child provenance, while the linked individual Meal uses `personal`.
      const individualScope = normalized.choice_kind === 'backup'
        ? 'personal'
        : (normalized.choice_kind === 'personal' ? 'personal' : normalized.choice_kind);
      const existingIndividualMeal = database.prepare(
        'SELECT id FROM meals WHERE source_key = ?',
      ).get(sourceKey);
      if (existingIndividualMeal) {
        database.prepare(`
          UPDATE meals SET title = ?, notes = ?, recipe_id = ?, scope = ?,
            scheduled_time = ?, earliest_time = ?, preferred_time = ?, latest_time = ?,
            expected_duration_minutes = ?, place_id = ?, planning_context_id = ?,
            provenance_json = ?,
            selection_status = 'selected', updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
           WHERE id = ?
        `).run(
          normalized.selected_meal_title, normalized.notes, normalized.selected_recipe_id,
          individualScope, meal.scheduled_time, meal.earliest_time, meal.preferred_time,
          meal.latest_time, meal.expected_duration_minutes, meal.place_id,
          meal.planning_context_id,
          JSON.stringify({
            source: 'meal_person_decision',
            parent_meal_id: meal.id,
            beneficiary_user_id: beneficiaryId,
            choice_kind: normalized.choice_kind,
          }),
          existingIndividualMeal.id,
        );
        normalized.selected_meal_id = Number(existingIndividualMeal.id);
      } else {
        const insertedIndividualMeal = database.prepare(`
          INSERT INTO meals (
          date, meal_type, custom_label, title, notes, created_by, recipe_id, scope,
          scheduled_time, earliest_time, preferred_time, latest_time,
          expected_duration_minutes, source, source_key, provenance_json,
          parent_meal_id, selection_status, place_id, planning_context_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'manual', ?, ?, ?,
          'selected', ?, ?)
        `).run(
          meal.date, meal.meal_type, meal.custom_label || null,
          normalized.selected_meal_title, normalized.notes,
          actorId || meal.created_by, normalized.selected_recipe_id, individualScope,
          meal.scheduled_time, meal.earliest_time, meal.preferred_time, meal.latest_time,
          meal.expected_duration_minutes, sourceKey,
          JSON.stringify({
            source: 'meal_person_decision',
            parent_meal_id: meal.id,
            beneficiary_user_id: beneficiaryId,
            choice_kind: normalized.choice_kind,
          }),
          meal.id, meal.place_id, meal.planning_context_id,
        );
        normalized.selected_meal_id = Number(insertedIndividualMeal.lastInsertRowid);
      }
      database.prepare(`
        INSERT INTO meal_participants (meal_id, user_id, role, status, source)
        VALUES (?, ?, 'participant', 'participating', 'manual')
        ON CONFLICT(meal_id, user_id, role) DO UPDATE SET
          status = 'participating', updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
      `).run(normalized.selected_meal_id, beneficiaryId);
    } else if (normalized.participation !== 'participating'
      || !['backup', 'personal', 'restaurant', 'takeout'].includes(normalized.choice_kind)) {
      normalized.selected_meal_id = null;
    }
    database.prepare(`
      INSERT INTO meal_person_decisions (
        meal_id, beneficiary_user_id, participation, choice_kind, selected_meal_id,
        notes, confirmed, entered_by_user_id, entered_by_device_key, entered_via, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
      ON CONFLICT(meal_id, beneficiary_user_id) DO UPDATE SET
        participation = excluded.participation, choice_kind = excluded.choice_kind,
        selected_meal_id = excluded.selected_meal_id, notes = excluded.notes,
        confirmed = excluded.confirmed, entered_by_user_id = excluded.entered_by_user_id,
        entered_by_device_key = excluded.entered_by_device_key, entered_via = excluded.entered_via,
        updated_at = excluded.updated_at
    `).run(
      meal.id, beneficiaryId, normalized.participation, normalized.choice_kind,
      normalized.selected_meal_id, normalized.notes, normalized.confirmed,
      actorId || null, text(deviceKey, { max: 500, field: 'Device key' }), enteredVia,
    );
    const decision = database.prepare(`
      SELECT * FROM meal_person_decisions WHERE meal_id = ? AND beneficiary_user_id = ?
    `).get(meal.id, beneficiaryId);
    decisionId = Number(decision.id);
    if (policy !== 'personal_choice') {
      // Keep selections from released chooser generations as immutable audit
      // history. A decision update replaces only the current generation.
      database.prepare(`
        DELETE FROM meal_person_menu_selections
         WHERE decision_id = ? AND menu_item_id IN (
           SELECT id FROM meal_menu_items
            WHERE meal_id = ? AND menu_generation = ?
         )
      `).run(decisionId, meal.id, Number(meal.current_menu_generation) || 1);
      const insertSelection = database.prepare(`
        INSERT INTO meal_person_menu_selections (decision_id, menu_item_id, selected) VALUES (?, ?, 1)
      `);
      for (const menuId of normalized.menu_item_ids) insertSelection.run(decisionId, menuId);
    }

    const participantStatus = {
      participating: 'participating',
      not_participating: 'not_participating',
      away: 'away',
      pending: 'needs_confirmation',
    }[normalized.participation];
    database.prepare(`
      INSERT INTO meal_participants (meal_id, user_id, role, status, source)
      VALUES (?, ?, 'participant', ?, 'manual')
      ON CONFLICT(meal_id, user_id, role) DO UPDATE SET status = excluded.status,
        updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
    `).run(meal.id, beneficiaryId, participantStatus);

    if (chooserSkipping) {
      const obligations = database.prepare(`
        SELECT id FROM planning_obligations
         WHERE entity_type = 'meal' AND entity_id = ? AND role = 'chooser'
           AND responsible_user_id = ? AND status IN ('pending', 'accepted')
         ORDER BY id
      `).all(meal.id, beneficiaryId);
      for (const obligation of obligations) {
        database.prepare(`
          UPDATE planning_obligations SET status = 'declined',
            responded_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now'),
            response_note = COALESCE(response_note, 'Chooser skipped this Meal.'),
            updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
           WHERE id = ?
        `).run(obligation.id);
        addChooserObligationEvent(database, obligation.id, 'chooser_skipped', actorId, {
          beneficiary_user_id: beneficiaryId,
          participation: normalized.participation,
        });
      }
      chooserResult = advanceMealChooserFallback(database, meal.id, {
        sourceObligationId: obligations.at(-1)?.id || null,
        actorId,
        reason: 'chooser_skipped',
      });
    }

    // Choosing the shared entrée fulfills chooser responsibility. Participation,
    // Backup Meal and skip updates deliberately never touch the chooser role or
    // its obligation, so those concepts cannot be conflated again.
    const sharedEntree = normalized.choice_kind === 'household'
      ? database.prepare(`
          SELECT * FROM meal_menu_items
           WHERE meal_id = ? AND menu_generation = ? AND item_type = 'entree'
             AND id IN (${normalized.menu_item_ids.length ? normalized.menu_item_ids.map(() => '?').join(',') : 'NULL'})
           ORDER BY position, id LIMIT 1
        `).get(meal.id, Number(meal.current_menu_generation) || 1, ...normalized.menu_item_ids)
      : null;
    if (isChooser && policy !== 'personal_choice' && sharedEntree) {
      database.prepare(`
        UPDATE meals SET title = ?, recipe_id = ?, selection_status = 'selected',
          updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now') WHERE id = ?
      `).run(sharedEntree.title, sharedEntree.recipe_id || null, meal.id);
      const obligations = database.prepare(`
        SELECT id FROM planning_obligations
         WHERE entity_type = 'meal' AND entity_id = ? AND role = 'chooser'
           AND responsible_user_id = ? AND status IN ('pending', 'accepted')
      `).all(meal.id, beneficiaryId);
      for (const obligation of obligations) {
        database.prepare(`
          UPDATE planning_obligations SET status = 'fulfilled',
            responded_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now'),
            updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now') WHERE id = ?
        `).run(obligation.id);
        database.prepare(`
          INSERT INTO planning_obligation_events (obligation_id, event, actor_user_id, details_json)
          VALUES (?, 'meal_selected', ?, ?)
        `).run(obligation.id, actorId || null, JSON.stringify({ menu_item_id: sharedEntree.id, decision_id: decisionId }));
      }
      chooserResult = {
        status: 'fulfilled',
        menu_item_id: sharedEntree.id,
        obligation_ids: obligations.map((row) => Number(row.id)),
      };
      fulfillMealMenuGeneration(
        database,
        meal.id,
        beneficiaryId,
        obligations.map((row) => Number(row.id)),
      );
    } else if (isChooser && policy === 'personal_choice' && normalized.confirmed
      && (normalized.participation !== 'participating' || normalized.selected_meal_id)) {
      const obligations = database.prepare(`
        SELECT id FROM planning_obligations
         WHERE entity_type = 'meal' AND entity_id = ? AND role = 'chooser'
           AND responsible_user_id = ? AND status IN ('pending', 'accepted')
      `).all(meal.id, beneficiaryId);
      for (const obligation of obligations) {
        database.prepare(`
          UPDATE planning_obligations SET status = 'fulfilled',
            responded_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now'),
            updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now') WHERE id = ?
        `).run(obligation.id);
        database.prepare(`
          INSERT INTO planning_obligation_events (obligation_id, event, actor_user_id, details_json)
          VALUES (?, 'personal_meal_resolved', ?, ?)
        `).run(obligation.id, actorId || null, JSON.stringify({
          decision_id: decisionId,
          beneficiary_user_id: beneficiaryId,
          selected_meal_id: normalized.selected_meal_id,
          participation: normalized.participation,
        }));
      }
      chooserResult = {
        status: 'fulfilled',
        selected_meal_id: normalized.selected_meal_id,
        obligation_ids: obligations.map((row) => Number(row.id)),
      };
    }

    syncAutoPortions(database, meal.id);

    const after = database.prepare('SELECT * FROM meal_person_decisions WHERE id = ?').get(decisionId);
    const info = database.prepare(`
      INSERT INTO meal_person_decision_events (
        decision_id, event, beneficiary_user_id, actor_user_id, actor_device_key,
        before_json, after_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      decisionId, current ? 'updated' : 'created', beneficiaryId, actorId || null,
      text(deviceKey, { max: 500, field: 'Device key' }), current ? JSON.stringify(current) : null,
      JSON.stringify({
        ...after,
        menu_item_ids: normalized.menu_item_ids,
        selected_meal_title: normalized.selected_meal_title,
        selected_recipe_id: normalized.selected_recipe_id,
      }),
    );
    eventId = Number(info.lastInsertRowid);
  })();
  const decision = database.prepare(`
    SELECT d.*, b.display_name AS beneficiary_name, a.display_name AS entered_by_name,
           selected.title AS selected_meal_title, selected.recipe_id AS selected_recipe_id
      FROM meal_person_decisions d
      JOIN users b ON b.id = d.beneficiary_user_id
      LEFT JOIN users a ON a.id = d.entered_by_user_id
      LEFT JOIN meals selected ON selected.id = d.selected_meal_id
     WHERE d.id = ?
  `).get(decisionId);
  decision.menu_items = database.prepare(`
    SELECT i.* FROM meal_person_menu_selections s
    JOIN meal_menu_items i ON i.id = s.menu_item_id
    WHERE s.decision_id = ? AND s.selected = 1 AND i.menu_generation = ?
    ORDER BY i.item_type, i.generation_position, i.id
  `).all(decisionId, Number(meal.current_menu_generation) || 1).map(presentMenuItem);
  if (policy === 'personal_choice' || decision.choice_kind === 'backup') decision.menu_items = [];
  return {
    ...decision,
    confirmed: Boolean(decision.confirmed),
    audit_event_id: eventId,
    chooser_result: chooserResult,
  };
}

function normalizeMenuItem(database, mealId, body, current = null) {
  const itemType = String(body?.item_type ?? body?.kind ?? current?.item_type ?? 'entree');
  if (!MENU_ITEM_TYPES.has(itemType)) throw mealPlanError('Choose entree, side, or backup for the menu item type.');
  const dish = normalizeDishSelection(database, body, current);
  return {
    meal_id: Number(mealId),
    item_type: itemType,
    position: integer(body?.position ?? current?.position, { fallback: 0, min: 0, max: 1000, field: 'Position' }),
    title: dish.title,
    recipe_id: dish.recipe_id,
    notes: text(body?.notes ?? current?.notes, { max: 4000, field: 'Notes' }),
  };
}

function nextPhysicalMenuPosition(database, mealId, itemType, reserved = new Set()) {
  const used = new Set(database.prepare(`
    SELECT position FROM meal_menu_items WHERE meal_id = ? AND item_type = ?
  `).all(Number(mealId), itemType).map((row) => Number(row.position)));
  for (const value of reserved) used.add(Number(value));
  let position = 0;
  while (used.has(position)) position += 1;
  reserved.add(position);
  return position;
}

function releasedMenuItemError() {
  return mealPlanError(
    'That menu item belongs to a released chooser menu and is retained as history.',
    409,
    'MEAL_MENU_GENERATION_RELEASED',
  );
}

function assertCanManageMenu(database, mealId, actorId, isAdmin, requestedBeneficiaryId = null) {
  synchronizeMealMenuGeneration(database, mealId);
  const meal = database.prepare('SELECT * FROM meals WHERE id = ?').get(Number(mealId));
  const policy = mealSelectionPolicy(database, meal);
  if (policy === 'personal_choice') {
    throw mealPlanError(
      'Personal Choice uses individual decisions and has no shared menu to edit.',
      403,
      'MEAL_MENU_PERSONAL_CHOICE_NOT_ALLOWED',
    );
  }
  const activeChoosers = database.prepare(`
    SELECT DISTINCT user_id
      FROM meal_participants
     WHERE meal_id = ? AND role = 'chooser' AND status = 'participating'
    UNION ALL
    SELECT DISTINCT responsible_user_id AS user_id
      FROM planning_obligations
     WHERE entity_type = 'meal' AND entity_id = ? AND role = 'chooser'
       AND status IN ('pending', 'accepted')
  `).all(Number(mealId), Number(mealId)).map((row) => Number(row.user_id)).filter(Boolean);
  const occurrenceAssignment = database.prepare(`
    SELECT id, assigned_user_id FROM meal_occurrence_assignments WHERE meal_id = ?
  `).get(Number(mealId));
  const canonicalChooserId = Number(occurrenceAssignment?.assigned_user_id) || null;
  const active = new Set(
    ['fixed', 'round_robin'].includes(policy) && occurrenceAssignment
      ? activeChoosers.filter((userId) => userId === canonicalChooserId)
      : activeChoosers,
  );
  const requested = Number(requestedBeneficiaryId) || null;
  const actorIsChooser = active.has(Number(actorId));
  const actorCreatedMeal = Number(meal.created_by) === Number(actorId);
  if (!policy && !active.size && (isAdmin || actorCreatedMeal)) {
    return {
      beneficiaryId: Number(actorId) || null,
      policy: null,
      generation: Number(meal.current_menu_generation) || 1,
    };
  }
  if (['fixed', 'round_robin'].includes(policy) && !active.size) {
    throw mealPlanError(
      'This Meal currently has no active chooser. Use Repair chooser, then reopen the menu.',
      409,
      'MEAL_CHOOSER_REPAIR_REQUIRED',
    );
  }
  if (!isAdmin && !actorIsChooser) {
    throw mealPlanError('Only an administrator or this occurrence\'s assigned chooser may edit its menu.', 403, 'MEAL_MENU_NOT_ALLOWED');
  }
  if (!isAdmin && requested && requested !== Number(actorId)) {
    throw mealPlanError('Only an administrator may act for another chooser.', 403, 'ACTING_FOR_NOT_ALLOWED');
  }
  if (isAdmin && !actorIsChooser && !requested) {
    throw mealPlanError('Choose the active chooser you are acting for.', 400, 'ACTING_FOR_CHOOSER_REQUIRED');
  }
  const beneficiaryId = requested || (actorIsChooser ? Number(actorId) : null);
  if (!beneficiaryId || !active.has(beneficiaryId)) {
    throw mealPlanError(
      'This person is no longer the active chooser. Refresh the Meal or use Repair chooser before acting for them.',
      409,
      'MEAL_CHOOSER_REPAIR_REQUIRED',
    );
  }
  return {
    beneficiaryId,
    policy,
    generation: Number(meal.current_menu_generation) || 1,
  };
}

export function listMealMenuItems(database, mealId) {
  synchronizeMealMenuGeneration(database, mealId);
  const meal = database.prepare('SELECT * FROM meals WHERE id = ?').get(Number(mealId));
  if (!meal) {
    throw mealPlanError('Meal not found.', 404, 'MEAL_NOT_FOUND');
  }
  const personalChoice = mealSelectionPolicy(database, meal) === 'personal_choice';
  if (personalChoice) return [];
  return database.prepare(`
    SELECT * FROM meal_menu_items
     WHERE meal_id = ?
       AND (menu_generation = ? OR item_type = 'backup')
     ORDER BY CASE item_type WHEN 'entree' THEN 0 WHEN 'side' THEN 1 ELSE 2 END,
              menu_generation DESC, COALESCE(generation_position, position), id
  `).all(Number(mealId), Number(meal.current_menu_generation) || 1).map((raw) => ({
    ...presentMenuItem(raw),
    legacy_only: raw.item_type === 'backup',
  }));
}

function recordMenuEvent(database, mealId, event, {
  itemId = null, beneficiaryId = null, actorId = null, deviceKey = null,
  before = null, after = null,
} = {}) {
  database.prepare(`
    INSERT INTO meal_menu_item_events (
      meal_id, menu_item_id, event, beneficiary_user_id, actor_user_id,
      actor_device_key, before_json, after_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    Number(mealId), itemId || null, event, beneficiaryId || null, actorId || null,
    text(deviceKey, { max: 500, field: 'Device key' }),
    before == null ? null : JSON.stringify(before),
    after == null ? null : JSON.stringify(after),
  );
}

function normalizeCompleteMenu(database, mealId, body, currentItems) {
  const rawItems = Array.isArray(body) ? body : (body?.items ?? body?.menu_items);
  if (!Array.isArray(rawItems)) {
    throw mealPlanError(
      'Provide the complete desired menu as an items array.',
      400,
      'MEAL_MENU_ITEMS_REQUIRED',
    );
  }

  const currentById = new Map(currentItems.map((item) => [Number(item.id), item]));
  const referencedIds = new Set();
  const staged = rawItems.map((raw, index) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw mealPlanError(`Menu item ${index + 1} is invalid.`, 400, 'INVALID_MEAL_MENU_ITEM');
    }
    const hasId = Object.hasOwn(raw, 'id') && raw.id != null && raw.id !== '';
    const requestedType = String(raw.item_type ?? raw.kind ?? 'entree');
    const requestedPosition = Object.hasOwn(raw, 'position') && raw.position != null && raw.position !== ''
      ? integer(raw.position, { min: 0, max: 1000, field: 'Position' })
      : null;
    // Add/Edit Meal intentionally sends the complete canonical slots without
    // leaking database IDs. Reuse the current row at the same type/position so
    // retries update in place and reconciliation Tasks remain deduplicated.
    const slotMatch = !hasId && requestedPosition != null
      ? currentItems.find((item) => item.item_type === requestedType && Number(item.position) === requestedPosition)
      : null;
    const id = hasId
      ? integer(raw.id, { min: 1, field: 'Menu item ID' })
      : (slotMatch ? Number(slotMatch.id) : null);
    if (id != null && referencedIds.has(id)) {
      throw mealPlanError('Each existing menu item may appear only once.', 400, 'DUPLICATE_MEAL_MENU_ITEM');
    }
    if (id != null) referencedIds.add(id);
    const current = id == null ? null : currentById.get(id);
    if (id != null && !current) {
      if (database.prepare(`
        SELECT 1 FROM meal_menu_items
         WHERE id = ? AND meal_id = ? AND menu_generation != (
           SELECT current_menu_generation FROM meals WHERE id = ?
         )
      `).get(id, Number(mealId), Number(mealId))) {
        throw releasedMenuItemError();
      }
      throw mealPlanError('Menu item not found for this Meal.', 404, 'MENU_ITEM_NOT_FOUND');
    }
    const itemType = String(raw.item_type ?? raw.kind ?? current?.item_type ?? 'entree');
    if (!MENU_ITEM_TYPES.has(itemType)) {
      throw mealPlanError('Choose entree, side, or backup for the menu item type.');
    }
    return {
      raw,
      id,
      current,
      itemType,
      hasPosition: Object.hasOwn(raw, 'position') && raw.position != null && raw.position !== '',
    };
  });

  const counts = staged.reduce((result, item) => {
    result[item.itemType] += 1;
    return result;
  }, { entree: 0, side: 0, backup: 0 });
  const limits = mealMenuLimits(database, mealId);
  if (counts.entree > limits.max_entree_choices
      || counts.side > limits.max_side_choices || counts.backup > 1) {
    throw mealPlanError(
      `Use at most ${limits.max_entree_choices} entree option${limits.max_entree_choices === 1 ? '' : 's'} and ${limits.max_side_choices} side${limits.max_side_choices === 1 ? '' : 's'}. Backup Meals are saved per person.`,
      400,
      'MEAL_MENU_LIMIT_EXCEEDED',
    );
  }

  // Existing rows retain their position unless the caller explicitly supplies a
  // new one. New rows without a position take the first free slot for their type.
  // This keeps gaps around immutable historical selections valid.
  const usedPositions = new Map([...MENU_ITEM_TYPES].map((type) => [type, new Set()]));
  for (const candidate of staged) {
    if (!candidate.hasPosition && candidate.current) {
      const position = Number(candidate.current.position);
      if (usedPositions.get(candidate.itemType).has(position)) {
        throw mealPlanError('Menu item positions must be unique within each type.', 409, 'MENU_POSITION_CONFLICT');
      }
      usedPositions.get(candidate.itemType).add(position);
    } else if (candidate.hasPosition) {
      const position = integer(candidate.raw.position, {
        min: 0, max: 1000, field: 'Position',
      });
      if (usedPositions.get(candidate.itemType).has(position)) {
        throw mealPlanError('Menu item positions must be unique within each type.', 409, 'MENU_POSITION_CONFLICT');
      }
      usedPositions.get(candidate.itemType).add(position);
    }
  }

  const items = staged.map((candidate) => {
    let position;
    if (candidate.hasPosition) position = Number(candidate.raw.position);
    else if (candidate.current) position = Number(candidate.current.position);
    else {
      position = 0;
      const reserved = usedPositions.get(candidate.itemType);
      while (reserved.has(position)) position += 1;
      reserved.add(position);
    }
    const normalized = normalizeMenuItem(
      database,
      mealId,
      { ...candidate.raw, item_type: candidate.itemType, position },
      candidate.current,
    );
    return { ...normalized, id: candidate.id, current: candidate.current };
  });

  for (const item of items) {
    if (item.item_type !== 'backup' && item.current?.item_type !== 'backup') continue;
    const unchangedLegacyBackup = item.current?.item_type === 'backup'
      && item.item_type === 'backup'
      && Number(item.position) === Number(item.current.position)
      && item.title === item.current.title
      && (item.recipe_id ?? null) === (item.current.recipe_id ?? null)
      && (item.notes ?? null) === (item.current.notes ?? null);
    if (!unchangedLegacyBackup) {
      throw mealPlanError(
        'Legacy Backup menu items are retained for audit only. Save a member Backup choice instead.',
        409,
        'BACKUP_MENU_ITEM_LEGACY_ONLY',
      );
    }
  }

  // Changing an existing item's type can make a retained position collide with
  // another desired row, so perform one final uniqueness check after normalization.
  const desiredPositions = new Set();
  for (const item of items) {
    const key = `${item.item_type}:${item.position}`;
    if (desiredPositions.has(key)) {
      throw mealPlanError('Menu item positions must be unique within each type.', 409, 'MENU_POSITION_CONFLICT');
    }
    desiredPositions.add(key);
  }

  const selectedRows = database.prepare(`
    SELECT DISTINCT i.*
      FROM meal_menu_items i
      JOIN meal_person_menu_selections s ON s.menu_item_id = i.id
     WHERE i.meal_id = ? AND i.menu_generation = (
       SELECT current_menu_generation FROM meals WHERE id = ?
     )
  `).all(Number(mealId), Number(mealId)).map(presentMenuItem);
  const desiredById = new Map(items.filter((item) => item.id != null).map((item) => [Number(item.id), item]));
  for (const selected of selectedRows) {
    const desired = desiredById.get(Number(selected.id));
    if (!desired && selected.item_type === 'backup') {
      // Modern clients correctly omit legacy Backup rows. The replacement
      // transaction preserves them separately, including their selection
      // history, so omission is not a destructive edit.
      continue;
    }
    if (!desired) {
      throw mealPlanError(
        'A selected menu item cannot be removed from meal history.',
        409,
        'MENU_ITEM_IN_USE',
      );
    }
    const unchanged = desired.item_type === selected.item_type
      && Number(desired.position) === Number(selected.position)
      && desired.title === selected.title
      && (desired.recipe_id ?? null) === (selected.recipe_id ?? null)
      && (desired.notes ?? null) === (selected.notes ?? null);
    if (!unchanged) {
      throw mealPlanError(
        'A selected menu item cannot be changed in meal history.',
        409,
        'MENU_ITEM_IN_USE',
      );
    }
  }

  return items;
}

export function replaceMealMenuItems(database, mealId, body, actorId, {
  isAdmin = false, beneficiaryId = null, deviceKey = null,
} = {}) {
  const numericMealId = Number(mealId);
  if (!database.prepare('SELECT 1 FROM meals WHERE id = ?').get(numericMealId)) {
    throw mealPlanError('Meal not found.', 404, 'MEAL_NOT_FOUND');
  }
  const authorization = assertCanManageMenu(database, numericMealId, actorId, isAdmin, beneficiaryId);

  const currentItems = database.prepare(`
    SELECT * FROM meal_menu_items
     WHERE meal_id = ? AND menu_generation = ? ORDER BY id
  `).all(numericMealId, authorization.generation).map(presentMenuItem);
  const items = normalizeCompleteMenu(database, numericMealId, body, currentItems);
  if (authorization.policy === 'personal_choice' && items.some((item) => item.item_type === 'backup')) {
    throw mealPlanError('Backup Meals are not available for Personal Choice slots.', 409, 'PERSONAL_CHOICE_BACKUP_NOT_ALLOWED');
  }
  const desiredIds = new Set(items.filter((item) => item.id != null).map((item) => Number(item.id)));
  // Backup is now a per-person Meal decision rather than a shared-menu row.
  // Preserve every released backup row as immutable history when a modern
  // client replaces only the current entrée/side menu.
  for (const item of currentItems.filter((row) => row.item_type === 'backup')) {
    desiredIds.add(Number(item.id));
  }
  const currentById = new Map(currentItems.map((item) => [Number(item.id), item]));
  const selectedIds = new Set(database.prepare(`
    SELECT DISTINCT menu_item_id AS id
      FROM meal_person_menu_selections
     WHERE menu_item_id IN (
       SELECT id FROM meal_menu_items WHERE meal_id = ? AND menu_generation = ?
     )
  `).all(numericMealId, authorization.generation).map((row) => Number(row.id)));

  try {
    database.transaction(() => {
      const deleteItem = database.prepare(`
        DELETE FROM meal_menu_items
         WHERE id = ? AND meal_id = ? AND menu_generation = ?
      `);
      for (const current of currentItems) {
        if (!desiredIds.has(Number(current.id))) {
          deleteItem.run(current.id, numericMealId, authorization.generation);
        }
      }

      // Free the chooser-facing positions before applying the complete desired
      // layout. Released physical positions and item IDs remain untouched.
      const parkItem = database.prepare(`
        UPDATE meal_menu_items SET generation_position = ?
         WHERE id = ? AND meal_id = ? AND menu_generation = ?
      `);
      let parkedPosition = 10000;
      for (const item of items) {
        if (item.id != null && !selectedIds.has(Number(item.id))) {
          parkItem.run(parkedPosition, item.id, numericMealId, authorization.generation);
          parkedPosition += 1;
        }
      }

      const updateItem = database.prepare(`
        UPDATE meal_menu_items
           SET item_type = ?, position = ?, generation_position = ?,
               title = ?, recipe_id = ?, notes = ?,
               updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
         WHERE id = ? AND meal_id = ? AND menu_generation = ?
      `);
      const insertItem = database.prepare(`
        INSERT INTO meal_menu_items (
          meal_id, menu_generation, item_type, position, generation_position,
          title, recipe_id, notes, created_by
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const item of items) {
        if (item.id != null) {
          const current = currentById.get(Number(item.id));
          if (!current) throw mealPlanError('Menu item not found for this Meal.', 404, 'MENU_ITEM_NOT_FOUND');
          if (!selectedIds.has(Number(item.id))) {
            const physicalPosition = current.item_type === item.item_type
              ? Number(current.storage_position)
              : nextPhysicalMenuPosition(database, numericMealId, item.item_type);
            updateItem.run(
              item.item_type, physicalPosition, item.position,
              item.title, item.recipe_id, item.notes,
              item.id, numericMealId, authorization.generation,
            );
          }
        } else {
          const physicalPosition = nextPhysicalMenuPosition(database, numericMealId, item.item_type);
          insertItem.run(
            numericMealId, authorization.generation, item.item_type,
            physicalPosition, item.position, item.title,
            item.recipe_id, item.notes, actorId || null,
          );
        }
      }
      const afterItems = database.prepare(`
        SELECT * FROM meal_menu_items
         WHERE meal_id = ? AND menu_generation = ? ORDER BY id
      `).all(numericMealId, authorization.generation).map(presentMenuItem);
      recordMenuEvent(database, numericMealId, 'replaced', {
        beneficiaryId: authorization.beneficiaryId,
        actorId,
        deviceKey,
        before: currentItems,
        after: afterItems,
      });
    })();
  } catch (error) {
    if (/UNIQUE constraint/i.test(error.message)) {
      throw mealPlanError('Menu item positions must be unique within each type.', 409, 'MENU_POSITION_CONFLICT');
    }
    throw error;
  }

  return listMealMenuItems(database, numericMealId);
}

export function createMealMenuItem(database, mealId, body, actorId, {
  isAdmin = false, beneficiaryId = null, deviceKey = null,
} = {}) {
  if (!database.prepare('SELECT 1 FROM meals WHERE id = ?').get(Number(mealId))) {
    throw mealPlanError('Meal not found.', 404, 'MEAL_NOT_FOUND');
  }
  const authorization = assertCanManageMenu(database, mealId, actorId, isAdmin, beneficiaryId);
  const item = normalizeMenuItem(database, mealId, body);
  if (item.item_type === 'backup') {
    throw mealPlanError(
      'Save a Backup Meal as the individual member\'s meal decision.',
      409,
      'BACKUP_MENU_ITEM_LEGACY_ONLY',
    );
  }
  if (authorization.policy === 'personal_choice' && item.item_type === 'backup') {
    throw mealPlanError('Backup Meals are not available for Personal Choice slots.', 409, 'PERSONAL_CHOICE_BACKUP_NOT_ALLOWED');
  }
  const limits = mealMenuLimits(database, mealId);
  const typeLimit = item.item_type === 'entree'
    ? limits.max_entree_choices : limits.max_side_choices;
  const currentTypeCount = Number(database.prepare(`
    SELECT COUNT(*) AS count FROM meal_menu_items
     WHERE meal_id = ? AND menu_generation = ? AND item_type = ?
  `).get(Number(mealId), authorization.generation, item.item_type).count);
  if (currentTypeCount >= typeLimit) {
    throw mealPlanError(
      `This Meal Plan allows up to ${typeLimit} ${item.item_type} choice${typeLimit === 1 ? '' : 's'} in the current chooser menu.`,
      409,
      item.item_type === 'entree' ? 'MEAL_ENTREE_LIMIT_EXCEEDED' : 'MEAL_SIDE_LIMIT_EXCEEDED',
    );
  }
  let created;
  try {
    database.transaction(() => {
      const physicalPosition = nextPhysicalMenuPosition(database, mealId, item.item_type);
      const info = database.prepare(`
        INSERT INTO meal_menu_items (
          meal_id, menu_generation, item_type, position, generation_position,
          title, recipe_id, notes, created_by
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        item.meal_id, authorization.generation, item.item_type,
        physicalPosition, item.position, item.title, item.recipe_id,
        item.notes, actorId || null,
      );
      created = presentMenuItem(database.prepare('SELECT * FROM meal_menu_items WHERE id = ?')
        .get(Number(info.lastInsertRowid)));
      recordMenuEvent(database, mealId, 'created', {
        itemId: created.id, beneficiaryId: authorization.beneficiaryId, actorId, deviceKey, after: created,
      });
    })();
  } catch (error) {
    if (/UNIQUE constraint/i.test(error.message)) throw mealPlanError('That menu item position is already in use.', 409, 'MENU_POSITION_CONFLICT');
    throw error;
  }
  return created;
}

export function updateMealMenuItem(database, mealId, itemId, body, actorId, {
  isAdmin = false, beneficiaryId = null, deviceKey = null,
} = {}) {
  const authorization = assertCanManageMenu(database, mealId, actorId, isAdmin, beneficiaryId);
  const currentRaw = database.prepare(`
    SELECT * FROM meal_menu_items
     WHERE id = ? AND meal_id = ? AND menu_generation = ?
  `).get(Number(itemId), Number(mealId), authorization.generation);
  if (!currentRaw) {
    if (database.prepare('SELECT 1 FROM meal_menu_items WHERE id = ? AND meal_id = ?')
      .get(Number(itemId), Number(mealId))) throw releasedMenuItemError();
    throw mealPlanError('Menu item not found.', 404, 'MENU_ITEM_NOT_FOUND');
  }
  const current = presentMenuItem(currentRaw);
  if (current.item_type === 'backup' || String(body?.item_type ?? body?.kind ?? current.item_type) === 'backup') {
    throw mealPlanError(
      'Legacy Backup menu items are retained for audit only and cannot be edited.',
      409,
      'BACKUP_MENU_ITEM_LEGACY_ONLY',
    );
  }
  if (database.prepare('SELECT 1 FROM meal_person_menu_selections WHERE menu_item_id = ? LIMIT 1').get(current.id)) {
    throw mealPlanError('A selected menu item cannot be changed in meal history.', 409, 'MENU_ITEM_IN_USE');
  }
  const item = normalizeMenuItem(database, mealId, body, current);
  if (authorization.policy === 'personal_choice' && item.item_type === 'backup') {
    throw mealPlanError('Backup Meals are not available for Personal Choice slots.', 409, 'PERSONAL_CHOICE_BACKUP_NOT_ALLOWED');
  }
  if (item.item_type !== current.item_type) {
    const limits = mealMenuLimits(database, mealId);
    const typeLimit = item.item_type === 'entree'
      ? limits.max_entree_choices : limits.max_side_choices;
    const count = Number(database.prepare(`
      SELECT COUNT(*) AS count FROM meal_menu_items
       WHERE meal_id = ? AND menu_generation = ? AND item_type = ? AND id != ?
    `).get(Number(mealId), authorization.generation, item.item_type, current.id).count);
    if (count >= typeLimit) {
      throw mealPlanError(
        `This Meal Plan allows up to ${typeLimit} ${item.item_type} choice${typeLimit === 1 ? '' : 's'} in the current chooser menu.`,
        409,
        item.item_type === 'entree' ? 'MEAL_ENTREE_LIMIT_EXCEEDED' : 'MEAL_SIDE_LIMIT_EXCEEDED',
      );
    }
  }
  let updated;
  try {
    database.transaction(() => {
      const physicalPosition = item.item_type === current.item_type
        ? Number(current.storage_position)
        : nextPhysicalMenuPosition(database, mealId, item.item_type);
      database.prepare(`
        UPDATE meal_menu_items
           SET item_type = ?, position = ?, generation_position = ?,
               title = ?, recipe_id = ?, notes = ?,
               updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
         WHERE id = ? AND menu_generation = ?
      `).run(
        item.item_type, physicalPosition, item.position,
        item.title, item.recipe_id, item.notes,
        current.id, authorization.generation,
      );
      updated = presentMenuItem(database.prepare('SELECT * FROM meal_menu_items WHERE id = ?').get(current.id));
      recordMenuEvent(database, mealId, 'updated', {
        itemId: current.id, beneficiaryId: authorization.beneficiaryId, actorId, deviceKey,
        before: current, after: updated,
      });
    })();
  } catch (error) {
    if (/UNIQUE constraint/i.test(error.message)) throw mealPlanError('That menu item position is already in use.', 409, 'MENU_POSITION_CONFLICT');
    throw error;
  }
  return updated;
}

export function deleteMealMenuItem(database, mealId, itemId, actorId, {
  isAdmin = false, beneficiaryId = null, deviceKey = null,
} = {}) {
  const authorization = assertCanManageMenu(database, mealId, actorId, isAdmin, beneficiaryId);
  const currentRaw = database.prepare(`
    SELECT * FROM meal_menu_items
     WHERE id = ? AND meal_id = ? AND menu_generation = ?
  `).get(Number(itemId), Number(mealId), authorization.generation);
  if (!currentRaw) {
    if (database.prepare('SELECT 1 FROM meal_menu_items WHERE id = ? AND meal_id = ?')
      .get(Number(itemId), Number(mealId))) throw releasedMenuItemError();
    throw mealPlanError('Menu item not found.', 404, 'MENU_ITEM_NOT_FOUND');
  }
  const current = presentMenuItem(currentRaw);
  if (current.item_type === 'backup') {
    throw mealPlanError(
      'Legacy Backup menu items are retained for audit only and cannot be deleted.',
      409,
      'BACKUP_MENU_ITEM_LEGACY_ONLY',
    );
  }
  if (database.prepare('SELECT 1 FROM meal_person_menu_selections WHERE menu_item_id = ? LIMIT 1').get(current.id)) {
    throw mealPlanError('A selected menu item cannot be deleted from meal history.', 409, 'MENU_ITEM_IN_USE');
  }
  database.transaction(() => {
    database.prepare('DELETE FROM meal_menu_items WHERE id = ?').run(current.id);
    recordMenuEvent(database, mealId, 'deleted', {
      beneficiaryId: authorization.beneficiaryId, actorId, deviceKey, before: current,
    });
  })();
  return current;
}

export function getGrocerySettings(database) {
  return database.prepare('SELECT * FROM meal_grocery_settings WHERE id = 1').get();
}

export function saveGrocerySettings(database, body, actorId) {
  const current = getGrocerySettings(database);
  if (!current) throw mealPlanError('Meal grocery settings are unavailable.', 500, 'MEAL_GROCERY_SETTINGS_MISSING');
  const hasListId = Object.prototype.hasOwnProperty.call(body || {}, 'default_shopping_list_id');
  const listId = !hasListId
    ? (Number(current.default_shopping_list_id) || null)
    : body.default_shopping_list_id == null || body.default_shopping_list_id === ''
      ? null : Number(body.default_shopping_list_id);
  if (listId && !database.prepare('SELECT 1 FROM shopping_lists WHERE id = ?').get(listId)) {
    throw mealPlanError('Default Shopping list not found.', 404, 'SHOPPING_LIST_NOT_FOUND');
  }
  const lead = integer(body?.grocery_lead_minutes, {
    fallback: Number(current.grocery_lead_minutes), min: 0, max: 10080, field: 'Grocery lead time',
  });
  const aggregation = String(body?.aggregation_mode ?? current.aggregation_mode);
  if (!['ingredient', 'meal', 'recipe'].includes(aggregation)) throw mealPlanError('Choose a valid grocery aggregation mode.');
  const values = {
    enabled: bool(body?.enabled, Boolean(current.enabled)) ? 1 : 0,
    default_shopping_list_id: listId,
    auto_create_grocery_draft: bool(body?.auto_create_grocery_draft, Boolean(current.auto_create_grocery_draft)) ? 1 : 0,
    auto_finalize_grocery: bool(body?.auto_finalize_grocery, Boolean(current.auto_finalize_grocery)) ? 1 : 0,
    grocery_lead_minutes: lead,
    aggregation_mode: aggregation,
  };
  database.transaction(() => {
    database.prepare(`
      UPDATE meal_grocery_settings SET enabled = ?, default_shopping_list_id = ?,
        auto_create_grocery_draft = ?, auto_finalize_grocery = ?, grocery_lead_minutes = ?,
        aggregation_mode = ?, updated_by = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
      WHERE id = 1
    `).run(
      values.enabled, values.default_shopping_list_id, values.auto_create_grocery_draft,
      values.auto_finalize_grocery, values.grocery_lead_minutes, values.aggregation_mode,
      actorId || null,
    );
    // Keep the legacy mixed settings surface working during the transition.
    database.prepare(`
      UPDATE meal_execution_settings SET default_shopping_list_id = ?,
        auto_create_grocery_draft = ?, auto_finalize_grocery = ?, updated_by = ?,
        updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now') WHERE id = 1
    `).run(
      values.default_shopping_list_id, values.auto_create_grocery_draft,
      values.auto_finalize_grocery, actorId || null,
    );
  })();
  return getGrocerySettings(database);
}

export function syncGrocerySettingsFromLegacy(database, legacy, actorId) {
  if (!legacy || !getGrocerySettings(database)) return null;
  database.prepare(`
    UPDATE meal_grocery_settings SET enabled = ?, default_shopping_list_id = ?,
      auto_create_grocery_draft = ?, auto_finalize_grocery = ?, updated_by = ?,
      updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now') WHERE id = 1
  `).run(
    legacy.enabled ? 1 : 0, legacy.default_shopping_list_id || null,
    legacy.auto_create_grocery_draft ? 1 : 0, legacy.auto_finalize_grocery ? 1 : 0,
    actorId || null,
  );
  return getGrocerySettings(database);
}

export { mealPlanError };
