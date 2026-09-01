/**
 * Focused frontend tests for the additive Kitchen -> Meals read models.
 * Run: node --test test/test-meal-week-model.js
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  decisionForMember,
  finalizedMealParticipantIds,
  mealCourseLimits,
  mealDisplayTitle,
  mealDecisionPayload,
  mealEditorRolePayload,
  mealEditorRoleState,
  mealMenuOptionLimitState,
  normalizeMealStatusModel,
  normalizeMealWeekModel,
  occurrencesByDate,
  scaleMealIngredientQuantity,
  selectedMenuItems,
} from '../public/utils/meal-week-model.js';

const addDays = (date, offset) => {
  const value = new Date(`${date}T12:00:00Z`);
  value.setUTCDate(value.getUTCDate() + offset);
  return value.toISOString().slice(0, 10);
};

test('week model preserves member authority without turning acting-for into authentication', () => {
  const model = normalizeMealWeekModel({ data: {
    start: '2026-08-31',
    end: '2026-09-06',
    member: { id: 2, display_name: 'Sam', can_act_for: true },
    members: [
      { id: 1, display_name: 'Alex', can_act_for: true },
      { id: 2, display_name: 'Sam', can_act_for: true },
      { id: 3, display_name: 'Mina', can_act_for: false },
    ],
    occurrences: [],
  } }, { currentUserId: 1, selectedMemberId: 2 });

  assert.equal(model.selected_member_id, 2);
  assert.equal(model.can_act_for, true);
  assert.equal(model.members.find((member) => member.id === 2).is_current_user, false);
  assert.equal(model.members.find((member) => member.id === 3).can_act_for, false);
});

test('meal editor preserves non-final participation until the user deliberately changes it', () => {
  const participants = [
    { user_id: 1, role: 'participant', status: 'participating' },
    { user_id: 2, role: 'participant', status: 'away' },
    { user_id: 3, role: 'participant', status: 'not_participating' },
    { user_id: 4, role: 'participant', status: 'needs_confirmation' },
    { user_id: 2, role: 'cook', status: 'away' },
  ];

  assert.deepEqual(finalizedMealParticipantIds(participants), [1]);
  assert.deepEqual(mealEditorRoleState(participants, 1, 'participant'), {
    present: true, status: 'participating', checked: true,
  });
  assert.deepEqual(mealEditorRoleState(participants, 2, 'participant'), {
    present: true, status: 'away', checked: false,
  });
  assert.deepEqual(mealEditorRoleState(participants, 3, 'participant'), {
    present: true, status: 'not_participating', checked: false,
  });
  assert.deepEqual(mealEditorRoleState(participants, 4, 'participant'), {
    present: true, status: 'needs_confirmation', checked: false,
  });
  assert.deepEqual(mealEditorRoleState(participants, 2, 'cook'), {
    present: true, status: 'away', checked: true,
  });

  for (const status of ['away', 'not_participating', 'needs_confirmation']) {
    assert.deepEqual(mealEditorRolePayload({
      userId: 9,
      role: 'participant',
      checked: false,
      touched: false,
      originalPresent: true,
      originalStatus: status,
    }), { user_id: 9, role: 'participant', status });
  }

  assert.deepEqual(mealEditorRolePayload({
    userId: 2,
    role: 'participant',
    checked: true,
    touched: true,
    originalPresent: true,
    originalStatus: 'away',
  }), { user_id: 2, role: 'participant', status: 'participating' });
  assert.equal(mealEditorRolePayload({
    userId: 1,
    role: 'participant',
    checked: false,
    touched: true,
    originalPresent: true,
    originalStatus: 'participating',
  }), null);
});

test('ingredient scaling preserves units and custom text while scaling numeric quantities', () => {
  assert.equal(scaleMealIngredientQuantity('2 cups', 1.5), '3 cups');
  assert.equal(scaleMealIngredientQuantity('1 1/2 tbsp', 2), '3 tbsp');
  assert.equal(scaleMealIngredientQuantity('1/2 tsp', 3), '1.5 tsp');
  assert.equal(scaleMealIngredientQuantity('1,5 kg', 2), '3 kg');
  assert.equal(scaleMealIngredientQuantity('to taste', 4), 'to taste');
  assert.equal(scaleMealIngredientQuantity('2 cups', 0), '2 cups');
});

test('direct backend occurrence shape normalizes policy, context, responsibilities and menu choices', () => {
  const model = normalizeMealWeekModel({ data: {
    member: { id: 2, display_name: 'Sam', can_act_for: true },
    members: [{ id: 2, display_name: 'Sam', can_act_for: true }],
    occurrences: [{
      id: 41,
      occurrence_id: 91,
      occurrence_key: 'ctx:7:2026-09-01:dinner',
      date: '2026-09-01',
      meal_type: 'dinner',
      title: 'Taco night',
      selection_status: 'selected',
      context: { id: 7, name: 'Beach trip', context_type: 'travel' },
      plan: { id: 8, name: 'Trip meals' },
      rule: { label: 'Dinner', policy: 'round_robin' },
      menu_limits: { max_entree_choices: 4, max_side_choices: 0 },
      chooser: { user_id: 2, display_name: 'Sam', status: 'pending' },
      participants: [
        { user_id: 2, display_name: 'Sam', roles: ['participant', 'chooser'], status: 'participating', is_chooser: true },
        { user_id: 3, display_name: 'Mina', roles: ['participant', 'cook'], status: 'participating', is_cook: true },
      ],
      decisions: [{
        id: 15,
        beneficiary_user_id: 2,
        participation: 'participating',
        choice_kind: 'backup',
        menu_items: [{ id: 103, item_type: 'backup', title: 'Soup' }],
      }],
      menu_items: [
        { id: 101, item_type: 'entree', title: 'Tacos', position: 0 },
        { id: 102, item_type: 'side', title: 'Corn', position: 1 },
        { id: 103, item_type: 'backup', title: 'Soup', position: 2 },
      ],
      controls: { set_participation: true, choose_backup: true, skip: true },
      can_act_for: true,
      applicable: true,
    }],
  } }, { currentUserId: 1, selectedMemberId: 2 });

  const [occurrence] = model.occurrences;
  assert.equal(occurrence.id, 41);
  assert.equal(occurrence.key, 'ctx:7:2026-09-01:dinner');
  assert.equal(occurrence.context.type, 'travel');
  assert.equal(occurrence.plan.policy, 'round_robin');
  assert.equal(occurrence.chooser.id, 2);
  assert.deepEqual(occurrence.menu_limits, { max_entree_choices: 4, max_side_choices: 0 });
  assert.equal(occurrence.max_side_choices, 0);
  assert.deepEqual(occurrence.cooks.map((person) => person.id), [3]);
  assert.deepEqual(occurrence.menu_items.map((item) => item.kind), ['entree', 'side', 'backup']);

  const decision = decisionForMember(occurrence, 2);
  assert.equal(decision.choice_kind, 'backup');
  assert.deepEqual(decision.selected_menu_item_ids, [103]);
  assert.deepEqual(selectedMenuItems(occurrence, decision).map((item) => item.id), [103]);
});

test('week model keeps published, draft and historical menu projections separate', () => {
  const [occurrence] = normalizeMealWeekModel({ data: { occurrences: [{
    id: 42,
    date: '2026-09-01',
    meal_type: 'dinner',
    menu_status: 'editing',
    published_menu_status: 'fulfilled',
    menu_items: [
      { id: 201, item_type: 'entree', title: 'Published curry', position: 0 },
      { id: 202, item_type: 'side', title: 'Published rice', position: 1 },
    ],
    published_menu_items: [
      { id: 202, item_type: 'side', title: 'Published rice', position: 1 },
      { id: 201, item_type: 'entree', title: 'Published curry', position: 0 },
    ],
    draft_menu_items: [
      { id: 302, item_type: 'side', title: 'Draft salad', position: 1 },
      { id: 301, item_type: 'entree', title: 'Draft pasta', position: 0 },
    ],
    historical_menu_items: [
      { id: 101, item_type: 'entree', title: 'Older soup', position: 0 },
    ],
  }] } }).occurrences;

  assert.equal(occurrence.menu_status, 'editing');
  assert.equal(occurrence.published_menu_status, 'fulfilled');
  assert.deepEqual(occurrence.menu_items.map((item) => item.label), ['Published curry', 'Published rice']);
  assert.deepEqual(occurrence.published_menu_items.map((item) => item.label), ['Published curry', 'Published rice']);
  assert.deepEqual(occurrence.draft_menu_items.map((item) => item.label), ['Draft pasta', 'Draft salad']);
  assert.deepEqual(occurrence.historical_menu_items.map((item) => item.label), ['Older soup']);
  assert.notStrictEqual(occurrence.published_menu_items[0], occurrence.draft_menu_items[0]);
});

test('course limits preserve explicit zeroes and separate menu authoring from diner selection', () => {
  const occurrence = {
    menu_limits: { max_entree_choices: 2, max_side_choices: 0 },
    rule: { choice_limit: 3 },
  };
  assert.deepEqual(mealCourseLimits(occurrence), {
    max_entree_choices: 2,
    max_side_choices: 0,
  });
  assert.deepEqual(mealMenuOptionLimitState([
    { item_type: 'entree' },
    { kind: 'entree' },
  ], occurrence), {
    max_entree_choices: 2,
    max_side_choices: 0,
    entree_count: 2,
    side_count: 0,
    can_add_entree: false,
    can_add_side: false,
    valid: true,
  });
  assert.equal(mealMenuOptionLimitState([
    { item_type: 'entree' },
    { item_type: 'side' },
  ], occurrence).valid, false);
  assert.deepEqual(mealCourseLimits({ rule: { choice_limit: 8 } }), {
    max_entree_choices: 1,
    max_side_choices: 8,
  }, 'legacy cached occurrences continue to use choice_limit for sides');
});

test('status choices keep exact people/count aggregates and separate non-meal states', () => {
  const model = normalizeMealStatusModel({ data: {
    occurrences: [{
      id: 50,
      date: '2026-09-02',
      meal_type: 'lunch',
      title: 'Picnic',
      choices: [
        { key: 'menu:1', type: 'household', title: 'Sandwiches', count: 2, people: [{ user_id: 1, display_name: 'Alex' }, { user_id: 2, display_name: 'Sam' }] },
        { key: 'pending', type: 'pending', title: 'Pending', count: 1, people: [{ user_id: 3, display_name: 'Mina' }] },
      ],
      pending_people: [{ user_id: 3, display_name: 'Mina' }],
      skipped_people: [],
      unavailable_people: [],
      totals: { participants: 3, resolved: 2, pending: 1 },
    }],
  } });

  const [occurrence] = model.occurrences;
  assert.equal(occurrence.menu_items[0].label, 'Sandwiches');
  assert.equal(occurrence.menu_items[0].count, 2);
  assert.deepEqual(occurrence.menu_items[0].people.map((person) => person.display_name), ['Alex', 'Sam']);
  assert.equal(occurrence.menu_items[1].kind, 'pending');
  assert.deepEqual(occurrence.pending_people.map((person) => person.display_name), ['Mina']);
  assert.equal(occurrence.totals.resolved, 2);
});

test('date grouping keeps simultaneous contexts distinct and orders by meal time', () => {
  const model = normalizeMealWeekModel({ data: { occurrences: [
    { id: 1, date: '2026-09-01', meal_type: 'dinner', preferred_time: '18:00', context: { id: 1, name: 'Home' } },
    { id: 2, date: '2026-09-01', meal_type: 'lunch', preferred_time: '12:00', context: { id: 2, name: 'Trip', context_type: 'travel' } },
  ] } });
  const grouped = occurrencesByDate(model.occurrences, '2026-08-31', addDays);
  assert.deepEqual(grouped.get('2026-09-01').map((occurrence) => occurrence.id), [2, 1]);
  assert.deepEqual(grouped.get('2026-09-01').map((occurrence) => occurrence.context.id), [2, 1]);
  assert.equal(grouped.size, 7);
});

test('decision payload keeps participation and food choice independent and records notification opt-in', () => {
  const payload = mealDecisionPayload({
    occurrence: { id: 31, context: { id: 7 } },
    memberId: 2,
    participating: false,
    choice: 'assigned',
    menuItemIds: [9, '10', null],
    notes: '  Use the shelf-stable option.  ',
    deviceKey: 'wall-kitchen-01',
    notifyOnMenuChange: true,
  });
  assert.deepEqual(payload, {
    beneficiary_user_id: 2,
    occurrence_id: 31,
    context_id: 7,
    participating: false,
    choice: 'assigned',
    menu_item_ids: [9, 10],
    notes: 'Use the shelf-stable option.',
    notify_on_menu_change: true,
    device_key: 'wall-kitchen-01',
  });
});

test('personal decision payload carries a named choice and optional saved recipe', () => {
  const payload = mealDecisionPayload({
    occurrence: { id: 41, context: { id: 8 } },
    memberId: 3,
    participating: true,
    choice: 'restaurant',
    menuItemIds: [],
    selectedMealTitle: '  Corner Cafe  ',
    selectedRecipeId: '12',
    notes: 'Window table',
    deviceKey: 'wall-kitchen-02',
  });
  assert.deepEqual(payload, {
    beneficiary_user_id: 3,
    occurrence_id: 41,
    context_id: 8,
    participating: true,
    choice: 'restaurant',
    menu_item_ids: [],
    selected_meal_title: 'Corner Cafe',
    selected_recipe_id: 12,
    notes: 'Window table',
    notify_on_menu_change: false,
    device_key: 'wall-kitchen-02',
  });
});

test('Backup Meal payload carries an individual saved recipe or custom name without shared menu IDs', () => {
  const payload = mealDecisionPayload({
    occurrence: { id: 42, context: { id: 8 } },
    memberId: 4,
    participating: true,
    choice: 'backup',
    menuItemIds: [],
    selectedMealTitle: '  Tomato soup  ',
    selectedRecipeId: '19',
    notes: 'Individual fallback',
    deviceKey: 'wall-kitchen-02',
  });
  assert.deepEqual(payload, {
    beneficiary_user_id: 4,
    occurrence_id: 42,
    context_id: 8,
    participating: true,
    choice: 'backup',
    menu_item_ids: [],
    selected_meal_title: 'Tomato soup',
    selected_recipe_id: 19,
    notes: 'Individual fallback',
    notify_on_menu_change: false,
    device_key: 'wall-kitchen-02',
  });
});

test('pending generated meals never present their internal Choose title as a selection', () => {
  const [occurrence] = normalizeMealWeekModel({ data: { occurrences: [{
    id: 88,
    date: '2026-09-03',
    meal_type: 'dinner',
    title: 'Choose dinner',
    selection_status: 'awaiting_choice',
  }] } }).occurrences;

  assert.equal(mealDisplayTitle(occurrence), 'Pending');
  occurrence.meal.title = 'Vegetable curry';
  occurrence.meal.selection_status = 'selected';
  assert.equal(mealDisplayTitle(occurrence), 'Vegetable curry');
});
