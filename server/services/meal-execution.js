import { createHash } from 'node:crypto';
import {
  createOrRefreshGroceryRun,
  finalizeGroceryRun,
  publishGroceryRun,
} from './meal-grocery-runs.js';

const ROLE_ORDER = ['preparation', 'cooking', 'supervision', 'serving', 'cleanup'];
const ROLE_TITLES = {
  preparation: (title) => `Prepare for ${title}`,
  cooking: (title) => `Cook ${title}`,
  supervision: (title) => `Supervise ${title}`,
  serving: (title) => `Serve ${title}`,
  cleanup: (title) => `Clean up after ${title}`,
};
const DEFAULT_TIMES = { breakfast: '07:30', lunch: '12:30', dinner: '18:00', snack: '15:00' };

function hash(value) {
  return createHash('sha256').update(value).digest('hex');
}

function serviceError(message, status = 400, code = 'INVALID_MEAL_EXECUTION') {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  return error;
}

function bool(value) {
  return value === true || value === 1 || value === '1';
}

function pad(number) {
  return String(number).padStart(2, '0');
}

function shiftLocal(date, time, deltaMinutes) {
  const [year, month, day] = date.split('-').map(Number);
  const [hour, minute] = String(time || '00:00').split(':').map(Number);
  const shifted = new Date(Date.UTC(year, month - 1, day, hour, minute + deltaMinutes));
  return {
    date: `${shifted.getUTCFullYear()}-${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())}`,
    time: `${pad(shifted.getUTCHours())}:${pad(shifted.getUTCMinutes())}`,
  };
}

function loadMeal(database, mealId) {
  const meal = database.prepare(`
    SELECT m.*, r.title AS recipe_title
    FROM meals m LEFT JOIN recipes r ON r.id = m.recipe_id
    WHERE m.id = ?
  `).get(mealId);
  if (!meal) return null;
  meal.ingredients = database.prepare(`
    SELECT id, name, quantity, category FROM meal_ingredients WHERE meal_id = ? ORDER BY id
  `).all(meal.id);
  if (!meal.ingredients.length && meal.recipe_id) {
    meal.ingredients = database.prepare(`
      SELECT id, name, quantity, category FROM recipe_ingredients WHERE recipe_id = ? ORDER BY id
    `).all(meal.recipe_id);
  }
  meal.participants = database.prepare(`
    SELECT mp.*, u.display_name
    FROM meal_participants mp JOIN users u ON u.id = mp.user_id
    WHERE mp.meal_id = ? ORDER BY mp.role, u.display_name, u.id
  `).all(meal.id);
  return meal;
}

function snapshotPayload(meal) {
  return {
    meal: {
      id: meal.id,
      date: meal.date,
      meal_type: meal.meal_type,
      title: meal.title,
      notes: meal.notes,
      scheduled_time: meal.scheduled_time,
      preferred_time: meal.preferred_time,
      expected_duration_minutes: meal.expected_duration_minutes,
      scope: meal.scope,
      source: meal.source,
      source_key: meal.source_key,
      schedule_slot_id: meal.schedule_slot_id,
      schedule_revision: meal.schedule_revision,
    },
    recipe: meal.recipe_id ? { id: meal.recipe_id, title: meal.recipe_title } : null,
    ingredients: meal.ingredients.map((row) => ({
      id: row.id, name: row.name, quantity: row.quantity, category: row.category,
    })),
    participants: meal.participants.map((row) => ({
      user_id: row.user_id, display_name: row.display_name, role: row.role,
      status: row.status, source: row.source,
    })),
  };
}

function getSettings(database) {
  return database.prepare('SELECT * FROM meal_execution_settings WHERE id = 1').get();
}

function saveSettings(database, body, actorId) {
  const current = getSettings(database);
  if (!current) throw serviceError('Meal execution settings are unavailable.', 500, 'MEAL_EXECUTION_SETTINGS_MISSING');
  const listId = body.default_shopping_list_id == null || body.default_shopping_list_id === ''
    ? null : Number(body.default_shopping_list_id);
  if (listId && !database.prepare('SELECT 1 FROM shopping_lists WHERE id = ?').get(listId)) {
    throw serviceError('Default Shopping list not found.', 404, 'SHOPPING_LIST_NOT_FOUND');
  }
  const numberInRange = (value, fallback) => {
    const number = value == null || value === '' ? Number(fallback) : Number(value);
    if (!Number.isInteger(number) || number < 0 || number > 1440) {
      throw serviceError('Task timing offsets must be whole minutes from 0 to 1440.');
    }
    return number;
  };
  database.prepare(`
    UPDATE meal_execution_settings SET
      enabled = ?, default_shopping_list_id = ?, auto_create_grocery_draft = ?, auto_finalize_grocery = ?,
      generate_preparation = ?, generate_cooking = ?, generate_supervision = ?, generate_serving = ?, generate_cleanup = ?,
      preparation_lead_minutes = ?, cooking_lead_minutes = ?, cleanup_delay_minutes = ?,
      updated_by = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
    WHERE id = 1
  `).run(
    bool(body.enabled ?? current.enabled) ? 1 : 0,
    listId,
    bool(body.auto_create_grocery_draft ?? current.auto_create_grocery_draft) ? 1 : 0,
    bool(body.auto_finalize_grocery ?? current.auto_finalize_grocery) ? 1 : 0,
    bool(body.generate_preparation ?? current.generate_preparation) ? 1 : 0,
    bool(body.generate_cooking ?? current.generate_cooking) ? 1 : 0,
    bool(body.generate_supervision ?? current.generate_supervision) ? 1 : 0,
    bool(body.generate_serving ?? current.generate_serving) ? 1 : 0,
    bool(body.generate_cleanup ?? current.generate_cleanup) ? 1 : 0,
    numberInRange(body.preparation_lead_minutes, current.preparation_lead_minutes),
    numberInRange(body.cooking_lead_minutes, current.cooking_lead_minutes),
    numberInRange(body.cleanup_delay_minutes, current.cleanup_delay_minutes),
    actorId || null,
  );
  return getSettings(database);
}

function roleAssignments(meal) {
  const participating = meal.participants.filter((row) => row.status === 'participating');
  const cook = participating.find((row) => row.role === 'cook') || participating.find((row) => row.role === 'participant') || null;
  const supervisor = participating.find((row) => row.role === 'supervisor') || null;
  const participants = participating.filter((row) => row.role === 'participant');
  return {
    preparation: cook,
    cooking: cook,
    supervision: supervisor,
    serving: participants[0] || cook,
    cleanup: participants[1] || participants[0] || cook,
  };
}

function roleTiming(meal, settings, role) {
  const time = meal.scheduled_time || meal.preferred_time || DEFAULT_TIMES[meal.meal_type] || '18:00';
  if (role === 'preparation') return shiftLocal(meal.date, time, -Number(settings.preparation_lead_minutes));
  if (role === 'cooking' || role === 'supervision') return shiftLocal(meal.date, time, -Number(settings.cooking_lead_minutes));
  if (role === 'cleanup') {
    const duration = Number(meal.expected_duration_minutes) || Number(settings.cleanup_delay_minutes);
    return shiftLocal(meal.date, time, duration);
  }
  return { date: meal.date, time };
}

function roleEnabled(settings, role, assignment) {
  if (!bool(settings[`generate_${role}`])) return false;
  if (role === 'supervision' && !assignment) return false;
  return true;
}

function taskDescription(meal, role) {
  const ingredients = meal.ingredients
    .map((row) => `${row.quantity ? `${row.quantity} ` : ''}${row.name}`)
    .join(', ');
  return [
    `Meal execution: ${role}`,
    meal.recipe_title ? `Recipe: ${meal.recipe_title}` : null,
    ingredients ? `Ingredients: ${ingredients}` : null,
    meal.notes || null,
  ].filter(Boolean).join('\n\n');
}

function setTaskAssignment(database, taskId, assignment, role) {
  database.prepare('DELETE FROM task_assignments WHERE task_id = ?').run(taskId);
  database.prepare("DELETE FROM task_responsibilities WHERE task_id = ? AND source = 'meal_execution'").run(taskId);
  if (!assignment?.user_id) return;
  database.prepare('INSERT OR IGNORE INTO task_assignments (task_id, user_id) VALUES (?, ?)').run(taskId, assignment.user_id);
  database.prepare(`
    INSERT OR REPLACE INTO task_responsibilities (task_id, user_id, role, status, source, updated_at)
    VALUES (?, ?, ?, 'active', 'meal_execution', strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
  `).run(taskId, assignment.user_id, role);
}

function loadExecution(database, mealId) {
  const snapshot = database.prepare(`
    SELECT * FROM meal_execution_snapshots WHERE meal_id = ? ORDER BY id DESC LIMIT 1
  `).get(mealId);
  if (!snapshot) return null;
  snapshot.snapshot = JSON.parse(snapshot.snapshot_json);
  snapshot.tasks = database.prepare(`
    SELECT met.*, t.status AS task_status, t.archived_at, t.assigned_to,
           u.display_name AS assigned_name
    FROM meal_execution_tasks met
    LEFT JOIN tasks t ON t.id = met.task_id
    LEFT JOIN users u ON u.id = t.assigned_to
    WHERE met.meal_snapshot_id = ?
    ORDER BY CASE met.role
      WHEN 'preparation' THEN 1 WHEN 'cooking' THEN 2 WHEN 'supervision' THEN 3
      WHEN 'serving' THEN 4 WHEN 'cleanup' THEN 5 ELSE 6 END
  `).all(snapshot.id);
  snapshot.movements = database.prepare(`
    SELECT pm.*, pi.name AS pantry_item_name
    FROM pantry_movements pm LEFT JOIN pantry_items pi ON pi.id = pm.pantry_item_id
    WHERE pm.meal_snapshot_id = ? ORDER BY pm.created_at, pm.id
  `).all(snapshot.id);
  return snapshot;
}

function refreshExecutionStatus(database, mealId) {
  const execution = loadExecution(database, mealId);
  if (!execution) return null;
  const existing = execution.tasks.filter((row) => row.task_id && row.task_status);
  const done = existing.filter((row) => row.task_status === 'done');
  if (existing.length && done.length === existing.length) {
    database.prepare(`
      UPDATE meal_execution_snapshots
      SET status = 'completed', completed_at = COALESCE(completed_at, strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
          frozen_at = COALESCE(frozen_at, strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
          updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
      WHERE id = ?
    `).run(execution.id);
  } else if (done.length || existing.some((row) => row.task_status === 'in_progress')) {
    database.prepare(`
      UPDATE meal_execution_snapshots SET status = 'in_progress',
        frozen_at = COALESCE(frozen_at, strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
        updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now') WHERE id = ?
    `).run(execution.id);
  }
  return loadExecution(database, mealId);
}

function ensureMealExecution(database, mealId, actorId, settings = getSettings(database)) {
  const meal = loadMeal(database, mealId);
  if (!meal) throw serviceError('Meal not found.', 404, 'MEAL_NOT_FOUND');
  if (meal.scope === 'skipped' || meal.selection_status !== 'selected') {
    throw serviceError('Choose the meal before creating its execution Tasks.', 409, 'MEAL_NOT_EXECUTABLE');
  }
  const payload = snapshotPayload(meal);
  const payloadJson = JSON.stringify(payload);
  const fingerprint = hash(payloadJson);
  const logicalKey = `meal:${meal.id}:execution`;

  database.transaction(() => {
    let snapshot = database.prepare('SELECT * FROM meal_execution_snapshots WHERE logical_key = ?').get(logicalKey);
    const execution = snapshot ? loadExecution(database, meal.id) : null;
    const frozen = Boolean(snapshot?.frozen_at || execution?.tasks?.some((row) => row.task_status === 'done'));
    if (!snapshot) {
      const info = database.prepare(`
        INSERT INTO meal_execution_snapshots (
          logical_key, meal_id, source_fingerprint, meal_date_snapshot, meal_type_snapshot,
          meal_title_snapshot, scheduled_time_snapshot, recipe_id, recipe_title_snapshot,
          snapshot_json, created_by
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        logicalKey, meal.id, fingerprint, meal.date, meal.meal_type, meal.title,
        meal.scheduled_time || meal.preferred_time || null, meal.recipe_id || null,
        meal.recipe_title || null, payloadJson, actorId || meal.created_by || null,
      );
      snapshot = database.prepare('SELECT * FROM meal_execution_snapshots WHERE id = ?').get(info.lastInsertRowid);
    } else if (!frozen && snapshot.source_fingerprint !== fingerprint) {
      database.prepare(`
        UPDATE meal_execution_snapshots SET source_fingerprint = ?, revision = revision + 1,
          meal_date_snapshot = ?, meal_type_snapshot = ?, meal_title_snapshot = ?,
          scheduled_time_snapshot = ?, recipe_id = ?, recipe_title_snapshot = ?, snapshot_json = ?,
          updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now') WHERE id = ?
      `).run(
        fingerprint, meal.date, meal.meal_type, meal.title, meal.scheduled_time || meal.preferred_time || null,
        meal.recipe_id || null, meal.recipe_title || null, payloadJson, snapshot.id,
      );
      snapshot = database.prepare('SELECT * FROM meal_execution_snapshots WHERE id = ?').get(snapshot.id);
    }

    const assignments = roleAssignments(meal);
    const findOutput = database.prepare('SELECT * FROM meal_execution_tasks WHERE logical_key = ?');
    const insertTask = database.prepare(`
      INSERT INTO tasks (
        title, description, category, priority, status, start_date, due_date, due_time,
        assigned_to, created_by, is_recurring, assignment_mode, points, visibility, countdown, locked
      ) VALUES (?, ?, 'household', 'none', 'open', ?, ?, ?, ?, ?, 0, 'fixed', 0, 'all', 0, 0)
    `);
    const insertOutput = database.prepare(`
      INSERT INTO meal_execution_tasks (
        meal_snapshot_id, meal_id, role, logical_key, task_id, assigned_user_id_snapshot,
        title_snapshot, due_date_snapshot, due_time_snapshot
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const role of ROLE_ORDER) {
      const assignment = assignments[role];
      if (!roleEnabled(settings, role, assignment)) continue;
      const outputKey = `meal:${meal.id}:task:${role}`;
      const title = ROLE_TITLES[role](meal.title);
      const timing = roleTiming(meal, settings, role);
      let output = findOutput.get(outputKey);
      if (!output) {
        const taskInfo = insertTask.run(
          title, taskDescription(meal, role), timing.date, timing.date, timing.time,
          assignment?.user_id || null, actorId || meal.created_by,
        );
        const taskId = Number(taskInfo.lastInsertRowid);
        setTaskAssignment(database, taskId, assignment, role);
        insertOutput.run(
          snapshot.id, meal.id, role, outputKey, taskId, assignment?.user_id || null,
          title, timing.date, timing.time,
        );
        continue;
      }
      // A deleted generated Task stays deleted, and completed/frozen work keeps
      // the exact definition the household acted on.
      if (!output.task_id || frozen) continue;
      const task = database.prepare('SELECT status, archived_at FROM tasks WHERE id = ?').get(output.task_id);
      if (!task || task.status === 'done' || task.archived_at) continue;
      database.prepare(`
        UPDATE tasks SET title = ?, description = ?, start_date = ?, due_date = ?, due_time = ?, assigned_to = ?,
          updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now') WHERE id = ?
      `).run(
        title, taskDescription(meal, role), timing.date, timing.date, timing.time,
        assignment?.user_id || null, output.task_id,
      );
      setTaskAssignment(database, output.task_id, assignment, role);
      database.prepare(`
        UPDATE meal_execution_tasks SET assigned_user_id_snapshot = ?, title_snapshot = ?,
          due_date_snapshot = ?, due_time_snapshot = ?,
          updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now') WHERE id = ?
      `).run(assignment?.user_id || null, title, timing.date, timing.time, output.id);
    }
  })();
  return refreshExecutionStatus(database, mealId);
}

function prepareMealExecutionRange(database, { from, to, actorId, listId = null, logicalKey = null } = {}) {
  const settings = getSettings(database);
  if (!settings?.enabled) throw serviceError('Meal execution automation is disabled.', 409, 'MEAL_EXECUTION_DISABLED');
  const meals = database.prepare(`
    SELECT id FROM meals
    WHERE date BETWEEN ? AND ? AND scope != 'skipped'
      AND selection_status = 'selected'
      AND superseded_by_id IS NULL
    ORDER BY date, COALESCE(scheduled_time, preferred_time), id
  `).all(from, to);
  const executions = [];
  for (const meal of meals) executions.push(ensureMealExecution(database, meal.id, actorId, settings));

  const targetListId = Number(listId || settings.default_shopping_list_id) || null;
  let grocery = null;
  if (targetListId && bool(settings.auto_create_grocery_draft)) {
    grocery = createOrRefreshGroceryRun(database, {
      listId: targetListId,
      from,
      to,
      userId: actorId,
      logicalKey: logicalKey || null,
    }).run;
    if (bool(settings.auto_finalize_grocery) && grocery.status === 'draft') {
      grocery = finalizeGroceryRun(database, grocery.id);
      grocery = publishGroceryRun(database, grocery.id).run;
    }
  }
  return { settings, meals: executions, grocery_run: grocery };
}

export {
  ROLE_ORDER,
  ensureMealExecution,
  getSettings,
  loadExecution,
  prepareMealExecutionRange,
  refreshExecutionStatus,
  saveSettings,
};
