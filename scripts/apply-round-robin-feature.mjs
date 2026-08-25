import fs from 'node:fs';

function read(path) { return fs.readFileSync(path, 'utf8'); }
function write(path, value) { fs.writeFileSync(path, value); }
function replaceOnce(source, needle, replacement, label) {
  const count = source.split(needle).length - 1;
  if (count !== 1) throw new Error(`${label}: expected exactly one match, found ${count}`);
  return source.replace(needle, replacement);
}

// ---------------------------------------------------------------------------
// Database migration
// ---------------------------------------------------------------------------
{
  const path = 'server/db.js';
  let source = read(path);
  if (!source.includes('version: 160')) {
    const marker = `  },\n];\n\n/**\n * Führt alle ausstehenden Migrations`;
    const migration = `  },\n  {\n    version: 160,\n    description: 'Tasks: ordered round-robin assignment for recurring tasks',\n    up: \`\n      ALTER TABLE tasks ADD COLUMN assignment_mode TEXT NOT NULL DEFAULT 'fixed'\n        CHECK(assignment_mode IN ('fixed', 'round_robin'));\n      ALTER TABLE tasks ADD COLUMN rotation_index INTEGER NOT NULL DEFAULT 0;\n\n      CREATE TABLE IF NOT EXISTS task_rotation_members (\n        task_id    INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,\n        user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,\n        sort_order INTEGER NOT NULL CHECK(sort_order >= 0),\n        PRIMARY KEY (task_id, user_id),\n        UNIQUE (task_id, sort_order)\n      );\n      CREATE INDEX idx_task_rotation_members_user ON task_rotation_members(user_id);\n    \`,\n  },\n];\n\n/**\n * Führt alle ausstehenden Migrations`;
    source = replaceOnce(source, marker, migration, 'db migration insertion');
    write(path, source);
  }
}

// ---------------------------------------------------------------------------
// Task API and recurrence engine
// ---------------------------------------------------------------------------
{
  const path = 'server/routes/tasks.js';
  let source = read(path);

  if (!source.includes("const VALID_ASSIGNMENT_MODES = ['fixed', 'round_robin'];")) {
    source = replaceOnce(
      source,
      `const VALID_PRIORITIES = ['none', 'low', 'medium', 'high', 'urgent'];`,
      `const VALID_PRIORITIES = ['none', 'low', 'medium', 'high', 'urgent'];\nconst VALID_ASSIGNMENT_MODES = ['fixed', 'round_robin'];`,
      'assignment mode constant',
    );

    source = replaceOnce(
      source,
`function addAssignedUsers(task) {\n  task.assigned_users = task.assigned_users_json ? JSON.parse(task.assigned_users_json) : [];\n  delete task.assigned_users_json;\n  return task;\n}`,
`function addAssignedUsers(task) {\n  task.assigned_users = task.assigned_users_json ? JSON.parse(task.assigned_users_json) : [];\n  delete task.assigned_users_json;\n  task.rotation_user_ids = task.assignment_mode === 'round_robin'\n    ? loadRotationUserIds(db.get(), task.id)\n    : [];\n  return task;\n}`,
      'task response rotation metadata',
    );

    source = replaceOnce(
      source,
`function setAssignments(d, taskId, userIds) {\n  d.prepare('DELETE FROM task_assignments WHERE task_id = ?').run(taskId);\n  const ins = d.prepare('INSERT OR IGNORE INTO task_assignments (task_id, user_id) VALUES (?, ?)');\n  for (const uid of userIds) ins.run(taskId, uid);\n}`,
`function setAssignments(d, taskId, userIds) {\n  d.prepare('DELETE FROM task_assignments WHERE task_id = ?').run(taskId);\n  const ins = d.prepare('INSERT OR IGNORE INTO task_assignments (task_id, user_id) VALUES (?, ?)');\n  for (const uid of userIds) ins.run(taskId, uid);\n}\n\nfunction parseRotationUserIds(value) {\n  if (!Array.isArray(value)) return [];\n  const seen = new Set();\n  const out = [];\n  for (const raw of value) {\n    const id = Number(raw);\n    if (!Number.isInteger(id) || id <= 0 || seen.has(id)) continue;\n    seen.add(id);\n    out.push(id);\n  }\n  return out;\n}\n\nfunction loadRotationUserIds(d, taskId) {\n  return d.prepare(\n    'SELECT user_id FROM task_rotation_members WHERE task_id = ? ORDER BY sort_order ASC'\n  ).all(taskId).map((row) => row.user_id);\n}\n\nfunction setRotationMembers(d, taskId, userIds) {\n  d.prepare('DELETE FROM task_rotation_members WHERE task_id = ?').run(taskId);\n  const insert = d.prepare(\n    'INSERT INTO task_rotation_members (task_id, user_id, sort_order) VALUES (?, ?, ?)'\n  );\n  userIds.forEach((userId, index) => insert.run(taskId, userId, index));\n}\n\nfunction sameIdOrder(a, b) {\n  return a.length === b.length && a.every((id, index) => id === b[index]);\n}\n\nfunction roundRobinConfigError(d, { assignmentMode, isRecurring, recurrenceRule, parentTaskId, rotationUserIds }) {\n  if (assignmentMode !== 'round_robin') return null;\n  if (parentTaskId) return 'Round-robin assignment is only available for top-level tasks.';\n  if (!isRecurring || !recurrenceRule) return 'Round-robin assignment requires a recurring task.';\n  if (rotationUserIds.length < 2) return 'Round-robin assignment requires at least two household members.';\n  const placeholders = rotationUserIds.map(() => '?').join(',');\n  const found = d.prepare(\`SELECT COUNT(*) AS n FROM users WHERE id IN (\${placeholders})\`).get(...rotationUserIds).n;\n  if (found !== rotationUserIds.length) return 'Round-robin assignment contains an unknown household member.';\n  return null;\n}`,
      'round robin helpers',
    );

    source = replaceOnce(
      source,
`    v.oneOf(body.priority,  VALID_PRIORITIES, 'priority'),\n    v.oneOf(body.status,    VALID_STATUSES,   'status'),`,
`    v.oneOf(body.priority,  VALID_PRIORITIES, 'priority'),\n    v.oneOf(body.status,    VALID_STATUSES,   'status'),\n    v.oneOf(body.assignment_mode, VALID_ASSIGNMENT_MODES, 'assignment_mode'),`,
      'assignment mode validation',
    );

    source = replaceOnce(
      source,
`    const visibility = normalizeVisibility(req.body.visibility);\n\n    const userIds  = parseAssignedTo(req.body.assigned_to);\n    const firstUid = userIds[0] ?? null;`,
`    const visibility = normalizeVisibility(req.body.visibility);\n\n    const assignmentMode = req.body.assignment_mode ?? 'fixed';\n    const rotationUserIds = parseRotationUserIds(req.body.rotation_user_ids);\n    const rotationError = roundRobinConfigError(db.get(), {\n      assignmentMode, isRecurring: !!is_recurring, recurrenceRule: recurrence_rule,\n      parentTaskId: parent_task_id, rotationUserIds,\n    });\n    if (rotationError) return res.status(400).json({ error: rotationError, code: 400 });\n\n    const requestedUserIds = parseAssignedTo(req.body.assigned_to);\n    const userIds = assignmentMode === 'round_robin' ? [rotationUserIds[0]] : requestedUserIds;\n    const firstUid = userIds[0] ?? null;\n    const rotationIndex = 0;`,
      'POST assignment resolution',
    );

    source = replaceOnce(
      source,
`           assigned_to, created_by, parent_task_id, is_recurring, recurrence_rule,\n           recurrence_from_completion, points, visibility, countdown, locked)\n        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
`           assigned_to, created_by, parent_task_id, is_recurring, recurrence_rule,\n           recurrence_from_completion, assignment_mode, rotation_index, points, visibility, countdown, locked)\n        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      'POST insert columns',
    );

    source = replaceOnce(
      source,
`        is_recurring ? 1 : 0, recurrence_rule, recurrence_from_completion ? 1 : 0, points, visibility,\n        countdown ? 1 : 0, req.body.locked ? 1 : 0\n      );\n      setAssignments(db.get(), result.lastInsertRowid, userIds);`,
`        is_recurring ? 1 : 0, recurrence_rule, recurrence_from_completion ? 1 : 0,\n        assignmentMode, rotationIndex, points, visibility, countdown ? 1 : 0, req.body.locked ? 1 : 0\n      );\n      setAssignments(db.get(), result.lastInsertRowid, userIds);\n      setRotationMembers(db.get(), result.lastInsertRowid, assignmentMode === 'round_robin' ? rotationUserIds : []);`,
      'POST insert values and rotation',
    );

    source = replaceOnce(
      source,
`    const assignedBefore = db.get().prepare('SELECT user_id FROM task_assignments WHERE task_id = ?')\n      .all(task.id).map((r) => r.user_id);\n    const userIds  = req.body.assigned_to !== undefined\n      ? parseAssignedTo(req.body.assigned_to)\n      : assignedBefore;\n    const firstUid = userIds[0] ?? null;`,
`    const assignedBefore = db.get().prepare('SELECT user_id FROM task_assignments WHERE task_id = ?')\n      .all(task.id).map((r) => r.user_id);\n    const rotationBefore = loadRotationUserIds(db.get(), task.id);\n    const assignmentMode = req.body.assignment_mode !== undefined\n      ? req.body.assignment_mode\n      : (task.assignment_mode || 'fixed');\n    const rotationUserIds = req.body.rotation_user_ids !== undefined\n      ? parseRotationUserIds(req.body.rotation_user_ids)\n      : rotationBefore;\n    const rotationError = roundRobinConfigError(db.get(), {\n      assignmentMode, isRecurring: !!is_recurring, recurrenceRule: recurrence_rule,\n      parentTaskId: task.parent_task_id, rotationUserIds,\n    });\n    if (rotationError) return res.status(400).json({ error: rotationError, code: 400 });\n\n    const requestedUserIds = req.body.assigned_to !== undefined\n      ? parseAssignedTo(req.body.assigned_to)\n      : assignedBefore;\n    let rotationIndex = 0;\n    let userIds;\n    if (assignmentMode === 'round_robin') {\n      const oldCurrent = Number(task.assigned_to);\n      const oldPosition = rotationUserIds.indexOf(oldCurrent);\n      rotationIndex = task.assignment_mode === 'round_robin' && oldPosition >= 0 ? oldPosition : 0;\n      userIds = [rotationUserIds[rotationIndex]];\n    } else {\n      userIds = requestedUserIds;\n    }\n    const firstUid = userIds[0] ?? null;`,
      'PUT assignment resolution',
    );

    source = replaceOnce(
      source,
`        recurrence_from_completion: recurrence_from_completion ? 1 : 0,\n        countdown: countdown ? 1 : 0, points, visibility,`,
`        recurrence_from_completion: recurrence_from_completion ? 1 : 0,\n        assignment_mode: assignmentMode,\n        countdown: countdown ? 1 : 0, points, visibility,`,
      'locked definition assignment mode',
    );

    source = replaceOnce(
      source,
`      if (req.body.tags !== undefined\n          && tagsKey(normalizeTags(req.body.tags)) !== tagsKey(tagsBefore)) touchesDefinition = true;`,
`      if (req.body.tags !== undefined\n          && tagsKey(normalizeTags(req.body.tags)) !== tagsKey(tagsBefore)) touchesDefinition = true;\n      if (!sameIdOrder(rotationUserIds, rotationBefore)) touchesDefinition = true;`,
      'locked definition rotation order',
    );

    source = replaceOnce(
      source,
`          status = ?, start_date = ?, due_date = ?, due_time = ?, assigned_to = ?,\n          is_recurring = ?, recurrence_rule = ?, recurrence_from_completion = ?,\n          points = ?, visibility = ?, countdown = ?, locked = ?`,
`          status = ?, start_date = ?, due_date = ?, due_time = ?, assigned_to = ?,\n          is_recurring = ?, recurrence_rule = ?, recurrence_from_completion = ?,\n          assignment_mode = ?, rotation_index = ?, points = ?, visibility = ?, countdown = ?, locked = ?`,
      'PUT update columns',
    );

    source = replaceOnce(
      source,
`             is_recurring ? 1 : 0, recurrence_rule, recurrence_from_completion ? 1 : 0,\n             points, visibility, countdown ? 1 : 0, locked, req.params.id);\n      setAssignments(db.get(), task.id, userIds);`,
`             is_recurring ? 1 : 0, recurrence_rule, recurrence_from_completion ? 1 : 0,\n             assignmentMode, rotationIndex, points, visibility, countdown ? 1 : 0, locked, req.params.id);\n      setAssignments(db.get(), task.id, userIds);\n      setRotationMembers(db.get(), task.id, assignmentMode === 'round_robin' ? rotationUserIds : []);`,
      'PUT update values and rotation',
    );

    source = replaceOnce(
      source,
`  const existingAssignments = db.get()\n    .prepare('SELECT user_id FROM task_assignments WHERE task_id = ?')\n    .all(task.id).map((r) => r.user_id);`,
`  const existingAssignments = db.get()\n    .prepare('SELECT user_id FROM task_assignments WHERE task_id = ?')\n    .all(task.id).map((r) => r.user_id);\n  const rotationUserIds = loadRotationUserIds(db.get(), task.id);\n  const roundRobin = task.assignment_mode === 'round_robin' && rotationUserIds.length > 0;\n  const nextRotationIndex = roundRobin\n    ? (Number(task.rotation_index || 0) + 1) % rotationUserIds.length\n    : Number(task.rotation_index || 0);\n  const nextAssignedTo = roundRobin\n    ? rotationUserIds[nextRotationIndex]\n    : (task.assigned_to ?? existingAssignments[0] ?? null);\n  const followupAssignments = roundRobin ? [nextAssignedTo] : existingAssignments;`,
      'recurrence next assignee',
    );

    source = replaceOnce(
      source,
`        start_date, due_date, due_time, assigned_to, created_by, is_recurring, recurrence_rule,\n        points, visibility, recurrence_from_completion, countdown, recurrence_origin_id)\n      VALUES (?, ?, ?, ?, 'open', ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?)`,
`        start_date, due_date, due_time, assigned_to, created_by, is_recurring, recurrence_rule,\n        assignment_mode, rotation_index, points, visibility, recurrence_from_completion, countdown, recurrence_origin_id)\n      VALUES (?, ?, ?, ?, 'open', ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?)`,
      'recurrence insert columns',
    );

    source = replaceOnce(
      source,
`      nextDate, task.due_time, task.assigned_to, task.created_by,\n      task.recurrence_rule, task.points, task.visibility,`,
`      nextDate, task.due_time, nextAssignedTo, task.created_by,\n      task.recurrence_rule, task.assignment_mode || 'fixed', nextRotationIndex, task.points, task.visibility,`,
      'recurrence insert values',
    );

    source = replaceOnce(
      source,
`    setAssignments(db.get(), newTask.lastInsertRowid, existingAssignments);\n    setTags(db.get(), newTask.lastInsertRowid, existingTags);`,
`    setAssignments(db.get(), newTask.lastInsertRowid, followupAssignments);\n    setRotationMembers(db.get(), newTask.lastInsertRowid, task.assignment_mode === 'round_robin' ? rotationUserIds : []);\n    setTags(db.get(), newTask.lastInsertRowid, existingTags);`,
      'recurrence copy rotation',
    );

    write(path, source);
  }
}

// ---------------------------------------------------------------------------
// Task editor UI
// ---------------------------------------------------------------------------
{
  const path = 'public/pages/tasks.js';
  let source = read(path);
  if (!source.includes("from '/components/user-rotation-order.js'")) {
    source = replaceOnce(
      source,
`import { renderUserMultiSelect, getSelectedUserIds, bindUserMultiSelect, renderAvatarStack } from '/components/user-multi-select.js';`,
`import { renderUserMultiSelect, getSelectedUserIds, bindUserMultiSelect, renderAvatarStack } from '/components/user-multi-select.js';\nimport { renderUserRotationOrder, getRotationUserIds } from '/components/user-rotation-order.js';`,
      'rotation component import',
    );

    source = replaceOnce(
      source,
`  const selectedIds = task?.assigned_users?.map((u) => u.id) ?? (task?.assigned_to ? [task.assigned_to] : []);\n  const visibility  = task?.visibility || 'all';`,
`  const selectedIds = task?.assigned_users?.map((u) => u.id) ?? (task?.assigned_to ? [task.assigned_to] : []);\n  const rotationIds = task?.rotation_user_ids ?? [];\n  const assignmentMode = task?.assignment_mode || 'fixed';\n  const visibility  = task?.visibility || 'all';`,
      'modal rotation state',
    );

    source = replaceOnce(
      source,
`      <div class="form-group" style="margin-top:var(--space-4)"\${isSoloHousehold() ? ' hidden' : ''}>\n        \${renderUserMultiSelect(users, selectedIds, 'task_assigned', 'tasks.assignedLabel')}\n      </div>`,
`      <div class="form-group" style="margin-top:var(--space-4)"\${isSoloHousehold() ? ' hidden' : ''}>\n        <label class="label" for="task-assignment-mode">Assignment mode</label>\n        <select class="input" id="task-assignment-mode" name="assignment_mode">\n          <option value="fixed" \${assignmentMode === 'fixed' ? 'selected' : ''}>Fixed</option>\n          <option value="round_robin" \${assignmentMode === 'round_robin' ? 'selected' : ''}>Round robin</option>\n        </select>\n        <p class="task-field-hint">Round robin assigns each recurring occurrence to the next person in the ordered list.</p>\n      </div>\n\n      <div id="task-fixed-assignment" class="form-group" style="margin-top:var(--space-4)"\${isSoloHousehold() ? ' hidden' : ''}>\n        \${renderUserMultiSelect(users, selectedIds, 'task_assigned', 'tasks.assignedLabel')}\n      </div>\n\n      <div id="task-round-robin-assignment" class="form-group" style="margin-top:var(--space-4)"\${assignmentMode === 'round_robin' && !isSoloHousehold() ? '' : ' hidden'}>\n        \${renderUserRotationOrder(users, rotationIds)}\n      </div>`,
      'assignment editor fields',
    );

    source = replaceOnce(
      source,
`function wireVisibilityWarning(panel, selectSel, msName, warnSel) {\n  const select = panel.querySelector(selectSel);\n  const warn   = panel.querySelector(warnSel);\n  if (!select || !warn) return;\n  const ms = panel.querySelector(\`.user-ms[data-ms-name="\${msName}"]\`);\n  const update = () => {\n    const count = getSelectedUserIds(panel, msName).length;\n    warn.hidden = !(select.value === 'assignees' && count === 0);\n  };\n  select.addEventListener('change', update);\n  ms?.addEventListener('click', () => setTimeout(update, 0));\n  update();\n}`,
`function wireVisibilityWarning(panel, selectSel, msName, warnSel) {\n  const select = panel.querySelector(selectSel);\n  const warn   = panel.querySelector(warnSel);\n  if (!select || !warn) return;\n  const ms = panel.querySelector(\`.user-ms[data-ms-name="\${msName}"]\`);\n  const rotation = panel.querySelector('#task-round-robin-assignment');\n  const mode = panel.querySelector('#task-assignment-mode');\n  const update = () => {\n    const count = mode?.value === 'round_robin'\n      ? getRotationUserIds(panel).length\n      : getSelectedUserIds(panel, msName).length;\n    warn.hidden = !(select.value === 'assignees' && count === 0);\n  };\n  select.addEventListener('change', update);\n  mode?.addEventListener('change', update);\n  ms?.addEventListener('click', () => setTimeout(update, 0));\n  rotation?.addEventListener('input', update);\n  update();\n}\n\nfunction wireAssignmentMode(panel) {\n  const mode = panel.querySelector('#task-assignment-mode');\n  const fixed = panel.querySelector('#task-fixed-assignment');\n  const rotation = panel.querySelector('#task-round-robin-assignment');\n  if (!mode || !fixed || !rotation) return;\n  const update = () => {\n    const roundRobin = mode.value === 'round_robin';\n    fixed.hidden = roundRobin;\n    rotation.hidden = !roundRobin;\n  };\n  mode.addEventListener('change', update);\n  update();\n}`,
      'assignment mode wiring',
    );

    source = replaceOnce(
      source,
`  bindRRuleEvents(document, 'task');\n  bindUserMultiSelect(panel, 'task_assigned');\n  wireVisibilityWarning(panel, '#task-visibility', 'task_assigned', '#task-visibility-warning');`,
`  bindRRuleEvents(document, 'task');\n  bindUserMultiSelect(panel, 'task_assigned');\n  wireAssignmentMode(panel);\n  wireVisibilityWarning(panel, '#task-visibility', 'task_assigned', '#task-visibility-warning');`,
      'wire assignment mode',
    );

    source = replaceOnce(
      source,
`    allowedMemberIds: () => {\n      const ids = getSelectedUserIds(panel, 'task_assigned').map(Number);\n      const creator = Number(task?.created_by ?? state.currentUserId);`,
`    allowedMemberIds: () => {\n      const ids = (panel.querySelector('#task-assignment-mode')?.value === 'round_robin'\n        ? getRotationUserIds(panel).slice(0, 1)\n        : getSelectedUserIds(panel, 'task_assigned')).map(Number);\n      const creator = Number(task?.created_by ?? state.currentUserId);`,
      'document assignment visibility',
    );

    source = replaceOnce(
      source,
`  const pendingTag = form.querySelector('#task-tag-input')?.value ?? '';\n  const tags = normalizeTagList([...modalTags, ...pendingTag.split(',')]);\n\n  const body = {`,
`  const pendingTag = form.querySelector('#task-tag-input')?.value ?? '';\n  const tags = normalizeTagList([...modalTags, ...pendingTag.split(',')]);\n  const assignmentMode = form.querySelector('#task-assignment-mode')?.value || 'fixed';\n  const rotationUserIds = getRotationUserIds(form);\n\n  const body = {`,
      'submit assignment state',
    );

    source = replaceOnce(
      source,
`    assigned_to:     getSelectedUserIds(form, 'task_assigned'),\n    visibility:      form.querySelector('#task-visibility')?.value || 'all',`,
`    assigned_to:     assignmentMode === 'fixed' ? getSelectedUserIds(form, 'task_assigned') : [],\n    assignment_mode: assignmentMode,\n    rotation_user_ids: assignmentMode === 'round_robin' ? rotationUserIds : [],\n    visibility:      form.querySelector('#task-visibility')?.value || 'all',`,
      'submit assignment payload',
    );

    source = replaceOnce(
      source,
`  if (dueTimeRaw && !dueTime) { resetSubmit(t('calendar.invalidDate')); return; }\n  body.due_time = dueTime || null;\n  if (form.status) body.status = form.status.value;`,
`  if (dueTimeRaw && !dueTime) { resetSubmit(t('calendar.invalidDate')); return; }\n  body.due_time = dueTime || null;\n  if (form.status) body.status = form.status.value;\n  if (assignmentMode === 'round_robin') {\n    if (!rrule.is_recurring) { resetSubmit('Round robin requires a recurring task.'); return; }\n    if (rotationUserIds.length < 2) { resetSubmit('Choose at least two members for the round-robin rotation.'); return; }\n  }`,
      'submit round robin validation',
    );

    write(path, source);
  }
}

console.log('Round-robin task feature applied successfully.');
