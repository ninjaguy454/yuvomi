/**
 * Pure adapters for the additive Meals week-model/status APIs.
 *
 * The planning API deliberately returns a richer occurrence than the legacy
 * dated-meal endpoint. Keeping the defensive shape handling here gives the UI
 * one vocabulary while the compatibility routes continue to exist.
 */

function numberOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

const FINALIZED_PARTICIPATION_STATUS = 'participating';

/**
 * A participant role may remain attached while the person is away, declined,
 * or still needs to confirm. Only an explicit participating state represents
 * a finalized diner and may drive ingredient scaling.
 */
export function finalizedMealParticipantIds(participants = []) {
  return [...new Set(asArray(participants)
    .filter((row) => row?.role === 'participant'
      && String(row?.status || '') === FINALIZED_PARTICIPATION_STATUS)
    .map((row) => numberOrNull(row?.user_id ?? row?.id))
    .filter((value) => value !== null))];
}

/**
 * Translate persisted role/status rows into the checkbox state used by the
 * dated Meal editor. Non-final participant states intentionally appear
 * unchecked, while their original row remains available for lossless save.
 */
export function mealEditorRoleState(participants, userId, role) {
  const row = asArray(participants).find((candidate) => (
    Number(candidate?.user_id ?? candidate?.id) === Number(userId)
      && String(candidate?.role || '') === String(role)
  )) || null;
  const status = String(row?.status || FINALIZED_PARTICIPATION_STATUS);
  return {
    present: Boolean(row),
    status,
    checked: Boolean(row) && (role !== 'participant' || status === FINALIZED_PARTICIPATION_STATUS),
  };
}

/**
 * Serialize one role control without promoting an untouched away/declined/
 * pending participant to participating. Checking an inactive participant is
 * the explicit opt-in that changes the status; unchecking an active one is the
 * explicit removal.
 */
export function mealEditorRolePayload({
  userId,
  role,
  checked,
  touched = false,
  originalPresent = false,
  originalStatus = FINALIZED_PARTICIPATION_STATUS,
}) {
  const normalizedUserId = numberOrNull(userId);
  if (normalizedUserId === null || !role) return null;
  if (checked) {
    return {
      user_id: normalizedUserId,
      role: String(role),
      status: touched ? FINALIZED_PARTICIPATION_STATUS : String(originalStatus || FINALIZED_PARTICIPATION_STATUS),
    };
  }
  if (role === 'participant' && originalPresent && !touched) {
    return {
      user_id: normalizedUserId,
      role: String(role),
      status: String(originalStatus || FINALIZED_PARTICIPATION_STATUS),
    };
  }
  return null;
}

/** Scale the numeric prefix of an ingredient quantity while preserving units. */
export function scaleMealIngredientQuantity(quantity, factor) {
  if (!quantity || factor === 1) return quantity;
  const multiplier = Number(factor);
  if (!Number.isFinite(multiplier) || multiplier <= 0) return quantity;

  const formatNumber = (num, useComma = false) => {
    const rounded = Math.round(num * 100) / 100;
    if (Number.isInteger(rounded)) return String(rounded);
    const text = String(rounded);
    return useComma ? text.replace('.', ',') : text;
  };

  const mixed = String(quantity).match(/^(\d+)\s+(\d+)\/(\d+)(.*)$/);
  if (mixed) {
    const whole = Number(mixed[1]);
    const numerator = Number(mixed[2]);
    const denominator = Number(mixed[3]);
    if (denominator > 0) {
      return `${formatNumber((whole + (numerator / denominator)) * multiplier)}${mixed[4]}`;
    }
  }

  const fraction = String(quantity).match(/^(\d+)\/(\d+)(.*)$/);
  if (fraction) {
    const numerator = Number(fraction[1]);
    const denominator = Number(fraction[2]);
    if (denominator > 0) {
      return `${formatNumber((numerator / denominator) * multiplier)}${fraction[3]}`;
    }
  }

  const decimal = String(quantity).match(/^(\d+(?:[.,]\d+)?)(.*)$/);
  if (decimal) {
    const useComma = decimal[1].includes(',');
    const base = Number(decimal[1].replace(',', '.'));
    if (Number.isFinite(base)) {
      return `${formatNumber(base * multiplier, useComma)}${decimal[2]}`;
    }
  }

  return quantity;
}

function first(...values) {
  return values.find((value) => value !== undefined && value !== null);
}

function boundedCourseLimit(value, fallback) {
  const number = Number(value);
  if (!Number.isInteger(number)) return fallback;
  return Math.min(9, Math.max(0, number));
}

/**
 * Resolve the immutable limits projected for one dated occurrence. New APIs
 * expose them at the top level and in `menu_limits`; rule/choice_limit
 * fallbacks keep older cached responses usable during a service-worker
 * upgrade.
 */
export function mealCourseLimits(occurrence = {}) {
  const explicit = occurrence.menu_limits || {};
  const rule = occurrence.rule || occurrence.slot || {};
  return {
    max_entree_choices: boundedCourseLimit(first(
      explicit.max_entree_choices,
      occurrence.max_entree_choices,
      rule.max_entree_choices,
    ), 1),
    max_side_choices: boundedCourseLimit(first(
      explicit.max_side_choices,
      occurrence.max_side_choices,
      rule.max_side_choices,
      rule.choice_limit,
      occurrence.choice_limit,
    ), 3),
  };
}

/** Shared option-authoring limits. Diner selection remains one entrée. */
export function mealMenuOptionLimitState(items = [], occurrence = {}) {
  const limits = mealCourseLimits(occurrence);
  const counts = asArray(items).reduce((result, item) => {
    const type = String(item?.item_type ?? item?.kind ?? '');
    if (type === 'entree' || type === 'side') result[type] += 1;
    return result;
  }, { entree: 0, side: 0 });
  return {
    ...limits,
    entree_count: counts.entree,
    side_count: counts.side,
    can_add_entree: counts.entree < limits.max_entree_choices,
    can_add_side: counts.side < limits.max_side_choices,
    valid: counts.entree <= limits.max_entree_choices
      && counts.side <= limits.max_side_choices,
  };
}

function normalizedPerson(raw = {}) {
  const source = raw.user || raw.member || raw.person || raw;
  return {
    ...source,
    id: numberOrNull(first(source.id, source.user_id, raw.user_id, raw.member_id)),
    display_name: String(first(source.display_name, source.name, source.title, 'Household member')),
    avatar_data: first(source.avatar_data, source.avatar, null),
    status: first(raw.status, raw.participation, source.status, null),
  };
}

export function normalizeMealMember(raw = {}, currentUserId = null) {
  const member = normalizedPerson(raw);
  const id = member.id;
  return {
    ...member,
    can_act_for: Boolean(first(raw.can_act_for, raw.canActFor, id !== null && Number(id) === Number(currentUserId))),
    is_current_user: id !== null && Number(id) === Number(currentUserId),
  };
}

function normalizeMenuItem(raw = {}, index = 0) {
  const people = asArray(first(raw.people, raw.members, raw.participants, raw.users)).map(normalizedPerson);
  const kind = String(first(raw.kind, raw.item_type, raw.type, 'entree'));
  return {
    ...raw,
    id: numberOrNull(first(raw.id, raw.menu_item_id)),
    kind,
    label: String(first(raw.label, raw.title, raw.name, kind === 'backup' ? 'Backup Meal' : 'Meal option')),
    position: Number(first(raw.position, index, 0)),
    recipe_id: numberOrNull(raw.recipe_id),
    people,
    count: Number(first(raw.count, raw.participant_count, people.length, 0)),
    selected: Boolean(first(raw.selected, raw.is_selected, false)),
  };
}

function normalizeDecision(raw = {}) {
  const selectedIds = asArray(first(raw.menu_item_ids, raw.selected_menu_item_ids, raw.menu_items, raw.selections))
    .map((value) => numberOrNull(value?.id ?? value?.menu_item_id ?? value))
    .filter((value) => value !== null);
  return {
    ...raw,
    beneficiary_user_id: numberOrNull(first(raw.beneficiary_user_id, raw.user_id, raw.member_id)),
    participation: String(first(raw.participation, raw.participating === false ? 'not_participating' : null, 'pending')),
    choice_kind: String(first(raw.choice_kind, raw.choice, 'pending')),
    selected_menu_item_ids: selectedIds,
    notes: String(first(raw.notes, '')),
    confirmed: Boolean(first(raw.confirmed, raw.is_confirmed, false)),
  };
}

function normalizeRole(raw, fallbackRole = null) {
  if (!raw) return null;
  if (typeof raw === 'string') return { id: null, display_name: raw, status: null, role: fallbackRole };
  return { ...normalizedPerson(raw), role: first(raw.role, fallbackRole) };
}

export function normalizeMealOccurrence(raw = {}, index = 0) {
  const meal = raw.meal || raw.dated_meal || (raw.meal_type || raw.title ? raw : {});
  const slot = raw.slot || raw.rule || {};
  const context = raw.context || raw.planning_context || {};
  const plan = raw.plan || raw.meal_plan || {};
  const menu = asArray(first(raw.choices, raw.menu_items, meal.menu_items, raw.options)).map(normalizeMenuItem);
  const decisions = asArray(first(raw.decisions, raw.person_decisions)).map(normalizeDecision);
  if (raw.my_decision && !decisions.some((decision) =>
    Number(decision.id) === Number(raw.my_decision.id))) {
    decisions.push(normalizeDecision(raw.my_decision));
  }
  const participants = asArray(first(raw.participants, meal.participants)).map(normalizedPerson);
  const chooser = normalizeRole(first(raw.chooser, raw.assigned_chooser, participants.find((person) => person.role === 'chooser')), 'chooser');
  const cooks = asArray(first(raw.cooks, raw.cooking?.cooks, participants.filter((person) => person.role === 'cook' || person.is_cook || person.roles?.includes('cook')))).map((person) => normalizeRole(person, 'cook'));
  const supervisors = asArray(first(raw.supervisors, raw.cooking?.supervisors, participants.filter((person) => person.role === 'supervisor' || person.is_supervisor || person.roles?.includes('supervisor')))).map((person) => normalizeRole(person, 'supervisor'));
  const date = String(first(raw.date, raw.occurrence_date, meal.date, ''));
  const mealType = String(first(raw.meal_type, raw.type, slot.meal_type, meal.meal_type, 'meal'));
  const id = numberOrNull(first(raw.id, raw.occurrence_id, meal.id));
  const contextId = numberOrNull(first(raw.context_id, raw.planning_context_id, context.id));
  const key = String(first(raw.occurrence_key, raw.key, `${date}:${mealType}:${contextId ?? 'home'}:${id ?? index}`));
  const selectedTitle = first(raw.selected_meal, meal.selected_meal, meal.title, raw.title, null);
  const place = raw.place || meal.place || {};
  const courseLimits = mealCourseLimits(raw);
  return {
    ...raw,
    id,
    key,
    date,
    meal_type: mealType,
    slot_label: String(first(raw.slot_label, slot.label, meal.label, mealType)),
    scheduled_time: first(raw.scheduled_time, meal.scheduled_time, slot.preferred_time, meal.preferred_time, null),
    earliest_time: first(raw.earliest_time, meal.earliest_time, slot.earliest_time, null),
    latest_time: first(raw.latest_time, meal.latest_time, slot.latest_time, null),
    meal: {
      ...meal,
      id: numberOrNull(first(meal.id, id)),
      title: selectedTitle ? String(selectedTitle) : '',
      selection_status: String(first(meal.selection_status, raw.selection_status, selectedTitle ? 'selected' : 'pending')),
    },
    context: {
      ...context,
      id: contextId,
      name: String(first(context.name, raw.context_name, 'Home')),
      type: String(first(context.type, context.context_type, raw.context_type, 'home')),
      place_name: first(context.place_name, raw.place_name, meal.place_name, null),
    },
    place: {
      ...place,
      id: numberOrNull(first(place.id, raw.place_id, meal.place_id)),
      name: String(first(place.name, raw.meal_place_name, meal.place_name, '')),
    },
    plan: {
      ...plan,
      id: numberOrNull(first(plan.id, raw.meal_plan_id)),
      name: String(first(plan.name, raw.plan_name, '')),
      policy: String(first(raw.policy, slot.policy, plan.policy, 'fixed')),
    },
    chooser,
    chooser_status: String(first(raw.chooser_status, raw.obligation_status, chooser?.status, 'pending')),
    max_entree_choices: courseLimits.max_entree_choices,
    max_side_choices: courseLimits.max_side_choices,
    menu_limits: courseLimits,
    participants,
    cooks: cooks.filter(Boolean),
    supervisors: supervisors.filter(Boolean),
    decisions,
    menu_items: menu.sort((a, b) => a.position - b.position),
    applicable: first(raw.applicable, true) !== false,
    unavailable_reason: first(raw.unavailable_reason, raw.availability?.reason, null),
    pending_people: asArray(first(raw.pending_people, raw.missing_responders)).map(normalizedPerson),
    skipped_people: asArray(first(raw.skipped_people, raw.skipped)).map(normalizedPerson),
    unavailable_people: asArray(first(raw.unavailable_people, raw.away_people, raw.unavailable)).map(normalizedPerson),
  };
}

function unwrap(payload) {
  return payload?.data ?? payload ?? {};
}

export function normalizeMealWeekModel(payload, { currentUserId = null, selectedMemberId = null } = {}) {
  const source = unwrap(payload);
  const members = asArray(source.members).map((member) => normalizeMealMember(member, currentUserId));
  const selectedId = numberOrNull(first(source.selected_member_id, source.member?.id, selectedMemberId, currentUserId));
  const selectedMember = members.find((member) => Number(member.id) === Number(selectedId)) || null;
  return {
    ...source,
    week_start: first(source.week_start, source.start, null),
    week_end: first(source.week_end, source.end, null),
    members,
    selected_member_id: selectedId,
    can_act_for: Boolean(first(source.can_act_for, selectedMember?.can_act_for, Number(selectedId) === Number(currentUserId))),
    occurrences: asArray(first(source.occurrences, source.items)).map(normalizeMealOccurrence),
    contexts: asArray(source.contexts),
  };
}

export function normalizeMealStatusModel(payload, options = {}) {
  return normalizeMealWeekModel(payload, options);
}

export function decisionForMember(occurrence, memberId) {
  return asArray(occurrence?.decisions).find((decision) =>
    Number(decision.beneficiary_user_id) === Number(memberId)) || null;
}

export function occurrencesByDate(occurrences, weekStart, addDays) {
  const result = new Map(Array.from({ length: 7 }, (_, offset) => [addDays(weekStart, offset), []]));
  asArray(occurrences).forEach((occurrence) => {
    if (!result.has(occurrence.date)) result.set(occurrence.date, []);
    result.get(occurrence.date).push(occurrence);
  });
  for (const values of result.values()) {
    values.sort((a, b) => {
      const time = String(a.scheduled_time || a.earliest_time || '99:99')
        .localeCompare(String(b.scheduled_time || b.earliest_time || '99:99'));
      if (time) return time;
      const rank = { breakfast: 0, lunch: 1, dinner: 2, snack: 3 };
      const typeOrder = (rank[a.meal_type] ?? 99) - (rank[b.meal_type] ?? 99);
      return typeOrder || String(a.slot_label).localeCompare(String(b.slot_label));
    });
  }
  return result;
}

export function selectedMenuItems(occurrence, decision) {
  const selected = new Set(asArray(decision?.selected_menu_item_ids).map(Number));
  return asArray(occurrence?.menu_items).filter((item) => selected.has(Number(item.id)) || item.selected);
}

export function mealDisplayTitle(occurrence, pendingLabel = 'Pending') {
  const title = String(first(occurrence?.meal?.title, occurrence?.title, '')).trim();
  const status = String(first(occurrence?.meal?.selection_status, occurrence?.selection_status, '')).toLowerCase();
  const isPlaceholder = /^choose\s+(breakfast|lunch|dinner|snack|meal)\b/i.test(title);
  if (!title || isPlaceholder || ['pending', 'awaiting_choice', 'unselected'].includes(status)) {
    return pendingLabel;
  }
  return title;
}

export function mealDecisionPayload({
  occurrence,
  memberId,
  participating,
  choice,
  menuItemIds,
  selectedMealTitle = null,
  selectedRecipeId = null,
  notes,
  deviceKey = null,
}) {
  const payload = {
    beneficiary_user_id: numberOrNull(memberId),
    occurrence_id: numberOrNull(first(occurrence?.id, occurrence?.occurrence_id)),
    context_id: numberOrNull(first(occurrence?.context?.id, occurrence?.context_id)),
    participating: Boolean(participating),
    choice: String(choice || 'assigned'),
    menu_item_ids: asArray(menuItemIds).map(numberOrNull).filter((id) => id !== null),
    notes: String(notes || '').trim(),
  };
  if (['personal', 'restaurant', 'takeout', 'backup'].includes(payload.choice)) {
    payload.selected_meal_title = selectedMealTitle == null ? null : String(selectedMealTitle).trim();
    payload.selected_recipe_id = numberOrNull(selectedRecipeId);
  }
  if (deviceKey) payload.device_key = String(deviceKey);
  return payload;
}
