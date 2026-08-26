from pathlib import Path

ROOT = Path('.')

def read(path):
    return (ROOT / path).read_text()

def write(path, text):
    (ROOT / path).write_text(text)

def replace_once(text, old, new, label):
    count = text.count(old)
    if count != 1:
        raise SystemExit(f'{label}: expected exactly 1 match, found {count}')
    return text.replace(old, new, 1)

# ---------------------------------------------------------------------------
# Migration 163
# ---------------------------------------------------------------------------
p = 'server/db.js'
s = read(p)
anchor = """  },
];

/**
 * Führt alle ausstehenden Migrations in einer Transaktion aus.
 */
"""
migration = """  },
  {
    version: 163,
    description: 'Tasks: bind scheduled and recurring work to Activity Templates',
    up: `
      CREATE TABLE IF NOT EXISTS task_activity_bindings (
        task_id              INTEGER PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,
        activity_template_id INTEGER NOT NULL REFERENCES activity_templates(id) ON DELETE RESTRICT,
        subject_user_id      INTEGER REFERENCES users(id) ON DELETE SET NULL,
        created_at           TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
        updated_at           TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
      );
      CREATE INDEX idx_task_activity_bindings_activity
        ON task_activity_bindings(activity_template_id);
      CREATE INDEX idx_task_activity_bindings_subject
        ON task_activity_bindings(subject_user_id);

      CREATE TABLE IF NOT EXISTS task_activity_support_tasks (
        source_task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        task_id        INTEGER PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,
        role           TEXT NOT NULL DEFAULT 'supervisor' CHECK(role IN ('supervisor')),
        UNIQUE(source_task_id, role)
      );
      CREATE INDEX idx_task_activity_support_source
        ON task_activity_support_tasks(source_task_id);
    `,
  },
];

/**
 * Führt alle ausstehenden Migrations in einer Transaktion aus.
 */
"""
s = replace_once(s, anchor, migration, 'db migration anchor')
write(p, s)

# ---------------------------------------------------------------------------
# Automation runtime activity options
# ---------------------------------------------------------------------------
p = 'server/routes/automation.js'
s = read(p)
anchor = """// ---------------------------------------------------------------------------
// Runtime endpoints
// ---------------------------------------------------------------------------

router.get('/quick-add', (req, res) => {
"""
insert = """// ---------------------------------------------------------------------------
// Runtime endpoints
// ---------------------------------------------------------------------------

// Minimal reusable Activity Template catalogue for ordinary Task scheduling.
// Assignment still resolves server-side; the client only chooses the reusable
// definition and, when required, its subject.
router.get('/activity-options', (_req, res) => {
  try {
    const activities = listActivityTemplates(db.get(), { activeOnly: true }).map((activity) => ({
      id: activity.id,
      name: activity.name,
      assignment_strategy: activity.assignment_strategy,
      subject_required: activity.subject_required,
    }));
    res.json({ data: { activities } });
  } catch (err) {
    log.error('GET /activity-options:', err);
    res.status(500).json({ error: 'Could not load activity templates.', code: 500 });
  }
});

router.get('/quick-add', (req, res) => {
"""
s = replace_once(s, anchor, insert, 'automation activity options')
write(p, s)

# ---------------------------------------------------------------------------
# Tasks route integration
# ---------------------------------------------------------------------------
p = 'server/routes/tasks.js'
s = read(p)
old = """import { unresolvedDependencies, syncWorkflowInstanceForTask } from '../services/activity-workflows.js';
"""
new = """import { unresolvedDependencies, syncWorkflowInstanceForTask } from '../services/activity-workflows.js';
import {
  TaskActivityBindingError,
  activitySupportTasks,
  applyTaskActivityBinding,
  attachTaskActivityBindings,
  clearTaskActivityBinding,
  copyTaskActivityBinding,
  getTaskActivityBinding,
  ordinaryActivitySubtasks,
  previewTaskActivityBinding,
} from '../services/task-activity-bindings.js';
"""
s = replace_once(s, old, new, 'tasks binding imports')

old = """function setAssignments(d, taskId, userIds) {
  d.prepare('DELETE FROM task_assignments WHERE task_id = ?').run(taskId);
  const ins = d.prepare('INSERT OR IGNORE INTO task_assignments (task_id, user_id) VALUES (?, ?)');
  for (const uid of userIds) ins.run(taskId, uid);
}

function parseRotationUserIds(value) {
"""
new = """function setAssignments(d, taskId, userIds) {
  d.prepare('DELETE FROM task_assignments WHERE task_id = ?').run(taskId);
  const ins = d.prepare('INSERT OR IGNORE INTO task_assignments (task_id, user_id) VALUES (?, ?)');
  for (const uid of userIds) ins.run(taskId, uid);
}

function parseTaskActivityBinding(body, existing = null) {
  const hasTemplate = Object.prototype.hasOwnProperty.call(body, 'activity_template_id');
  const hasSubject = Object.prototype.hasOwnProperty.call(body, 'activity_subject_user_id');
  if (!hasTemplate && !hasSubject) {
    return {
      specified: false,
      binding: existing ? {
        activityTemplateId: Number(existing.activity_template_id),
        subjectUserId: existing.subject_user_id == null ? null : Number(existing.subject_user_id),
      } : null,
    };
  }

  const rawTemplate = hasTemplate ? body.activity_template_id : existing?.activity_template_id;
  if (rawTemplate === null || rawTemplate === undefined || rawTemplate === '') {
    return { specified: true, binding: null };
  }
  const activityTemplateId = Number(rawTemplate);
  if (!Number.isInteger(activityTemplateId) || activityTemplateId <= 0) {
    return { specified: true, error: 'activity_template_id must be a positive integer or null.' };
  }

  const rawSubject = hasSubject ? body.activity_subject_user_id : existing?.subject_user_id;
  let subjectUserId = null;
  if (rawSubject !== null && rawSubject !== undefined && rawSubject !== '') {
    subjectUserId = Number(rawSubject);
    if (!Number.isInteger(subjectUserId) || subjectUserId <= 0) {
      return { specified: true, error: 'activity_subject_user_id must be a positive integer or null.' };
    }
  }
  return { specified: true, binding: { activityTemplateId, subjectUserId } };
}

function sameTaskActivityBinding(a, b) {
  if (!a && !b) return true;
  if (!a || !b) return false;
  return Number(a.activityTemplateId ?? a.activity_template_id) === Number(b.activityTemplateId ?? b.activity_template_id)
    && Number(a.subjectUserId ?? a.subject_user_id ?? 0) === Number(b.subjectUserId ?? b.subject_user_id ?? 0);
}

function validateTaskActivityBindingRequest(binding, dateKey, { allowInactive = false } = {}) {
  if (!binding) return null;
  try {
    previewTaskActivityBinding(db.get(), {
      activityTemplateId: binding.activityTemplateId,
      subjectUserId: binding.subjectUserId,
      dateKey,
      allowInactive,
    });
    return null;
  } catch (err) {
    return err.message;
  }
}

function parseRotationUserIds(value) {
"""
s = replace_once(s, old, new, 'tasks binding helpers')

old = """    const points = req.body.points === undefined && !parent_task_id
      ? defaultTaskPoints()
      : clampPoints(req.body.points);
    const visibility = normalizeVisibility(req.body.visibility);

    const assignmentMode = req.body.assignment_mode ?? 'fixed';
    const rotationUserIds = parseRotationUserIds(req.body.rotation_user_ids);
"""
new = """    const points = req.body.points === undefined && !parent_task_id
      ? defaultTaskPoints()
      : clampPoints(req.body.points);
    const visibility = normalizeVisibility(req.body.visibility);

    const bindingRequest = parseTaskActivityBinding(req.body);
    if (bindingRequest.error) return res.status(400).json({ error: bindingRequest.error, code: 400 });
    const activityBinding = bindingRequest.binding;
    if (activityBinding && parent_task_id) {
      return res.status(400).json({ error: 'Activity templates can only be attached to top-level tasks.', code: 400 });
    }
    const bindingError = validateTaskActivityBindingRequest(activityBinding, due_date || todayInHouseholdZone());
    if (bindingError) return res.status(400).json({ error: bindingError, code: 400 });

    const assignmentMode = activityBinding ? 'fixed' : (req.body.assignment_mode ?? 'fixed');
    const rotationUserIds = activityBinding ? [] : parseRotationUserIds(req.body.rotation_user_ids);
"""
s = replace_once(s, old, new, 'tasks POST binding setup')

old = """    const requestedUserIds = parseAssignedTo(req.body.assigned_to);
"""
new = """    const requestedUserIds = activityBinding ? [] : parseAssignedTo(req.body.assigned_to);
"""
s = replace_once(s, old, new, 'tasks POST requested assignees')

old = """      setAssignments(db.get(), result.lastInsertRowid, userIds);
      setRotationMembers(db.get(), result.lastInsertRowid, assignmentMode === 'round_robin' ? rotationUserIds : []);
      if (req.body.tags !== undefined) setTags(db.get(), result.lastInsertRowid, req.body.tags);
      if (syncTarget) {
"""
new = """      setAssignments(db.get(), result.lastInsertRowid, userIds);
      setRotationMembers(db.get(), result.lastInsertRowid, assignmentMode === 'round_robin' ? rotationUserIds : []);
      if (req.body.tags !== undefined) setTags(db.get(), result.lastInsertRowid, req.body.tags);
      if (activityBinding) {
        applyTaskActivityBinding(db.get(), Number(result.lastInsertRowid), {
          activityTemplateId: activityBinding.activityTemplateId,
          subjectUserId: activityBinding.subjectUserId,
          commitRotation: true,
          dateKey: due_date || todayInHouseholdZone(),
        });
      }
      if (syncTarget) {
"""
s = replace_once(s, old, new, 'tasks POST apply binding')

old = """    addAssignedUsers(task);
    attachTags([task]);
    res.status(201).json({ data: task });
"""
new = """    addAssignedUsers(task);
    attachTaskActivityBindings(db.get(), [task]);
    attachTags([task]);
    res.status(201).json({ data: task });
"""
s = replace_once(s, old, new, 'tasks POST response binding')

old = """  } catch (err) {
    log.error('POST / error:', err);
    res.status(500).json({ error: 'Internal server error.', code: 500 });
  }
});

// --------------------------------------------------------
// PUT /api/v1/tasks/:id
"""
new = """  } catch (err) {
    if (err instanceof TaskActivityBindingError) {
      return res.status(400).json({ error: err.message, code: 400 });
    }
    log.error('POST / error:', err);
    res.status(500).json({ error: 'Internal server error.', code: 500 });
  }
});

// --------------------------------------------------------
// PUT /api/v1/tasks/:id
"""
s = replace_once(s, old, new, 'tasks POST binding error')

old = """    if (status === 'done' && task.status !== 'done') {
      const blockedBy = unresolvedDependencies(db.get(), task.id);
      if (blockedBy.length) {
        return res.status(409).json({
          error: 'Complete required earlier activities first.', code: 409, dependencies: blockedBy,
        });
      }
    }

    const assignedBefore = db.get().prepare('SELECT user_id FROM task_assignments WHERE task_id = ?')
"""
new = """    if (status === 'done' && task.status !== 'done') {
      const blockedBy = unresolvedDependencies(db.get(), task.id);
      if (blockedBy.length) {
        return res.status(409).json({
          error: 'Complete required earlier activities first.', code: 409, dependencies: blockedBy,
        });
      }
    }

    const existingActivityBinding = getTaskActivityBinding(db.get(), task.id);
    const bindingRequest = parseTaskActivityBinding(req.body, existingActivityBinding);
    if (bindingRequest.error) return res.status(400).json({ error: bindingRequest.error, code: 400 });
    const desiredActivityBinding = bindingRequest.binding;
    const bindingChanged = !sameTaskActivityBinding(desiredActivityBinding, existingActivityBinding);
    if (bindingChanged && desiredActivityBinding && task.rotation_group) {
      return res.status(409).json({
        error: 'Remove this task from its rotation group before attaching an Activity Template.', code: 409,
      });
    }
    if (bindingChanged && desiredActivityBinding) {
      const bindingError = validateTaskActivityBindingRequest(desiredActivityBinding, due_date || todayInHouseholdZone());
      if (bindingError) return res.status(400).json({ error: bindingError, code: 400 });
    }

    const assignedBefore = db.get().prepare('SELECT user_id FROM task_assignments WHERE task_id = ?')
"""
s = replace_once(s, old, new, 'tasks PUT binding setup')

old = """    const assignmentMode = req.body.assignment_mode !== undefined
      ? req.body.assignment_mode
      : (task.assignment_mode || 'fixed');
    const rotationUserIds = req.body.rotation_user_ids !== undefined
      ? parseRotationUserIds(req.body.rotation_user_ids)
      : rotationBefore;
"""
new = """    const assignmentMode = desiredActivityBinding
      ? 'fixed'
      : (req.body.assignment_mode !== undefined ? req.body.assignment_mode : (task.assignment_mode || 'fixed'));
    const rotationUserIds = desiredActivityBinding
      ? []
      : (req.body.rotation_user_ids !== undefined ? parseRotationUserIds(req.body.rotation_user_ids) : rotationBefore);
"""
s = replace_once(s, old, new, 'tasks PUT manual mode override')

old = """    const requestedUserIds = req.body.assigned_to !== undefined
      ? parseAssignedTo(req.body.assigned_to)
      : assignedBefore;
    let rotationIndex = 0;
    let rotationCycle = 0;
    let userIds;
    if (assignmentMode === 'round_robin') {
"""
new = """    const requestedUserIds = desiredActivityBinding
      ? assignedBefore
      : (req.body.assigned_to !== undefined ? parseAssignedTo(req.body.assigned_to) : assignedBefore);
    let rotationIndex = 0;
    let rotationCycle = 0;
    let userIds;
    if (desiredActivityBinding) {
      userIds = assignedBefore;
    } else if (assignmentMode === 'round_robin') {
"""
s = replace_once(s, old, new, 'tasks PUT binding assignee preservation')

old = """      if (req.body.tags !== undefined
          && tagsKey(normalizeTags(req.body.tags)) !== tagsKey(tagsBefore)) touchesDefinition = true;
      if (!sameIdOrder(rotationUserIds, rotationBefore)) touchesDefinition = true;
"""
new = """      if (req.body.tags !== undefined
          && tagsKey(normalizeTags(req.body.tags)) !== tagsKey(tagsBefore)) touchesDefinition = true;
      if (!sameIdOrder(rotationUserIds, rotationBefore)) touchesDefinition = true;
      if (bindingChanged) touchesDefinition = true;
"""
s = replace_once(s, old, new, 'tasks PUT locked binding definition')

old = """      setAssignments(db.get(), task.id, userIds);
      setRotationMembers(db.get(), task.id, assignmentMode === 'round_robin' ? rotationUserIds : []);
      if (req.body.tags !== undefined) setTags(db.get(), task.id, req.body.tags);
      if (syncTarget !== undefined) {
"""
new = """      setAssignments(db.get(), task.id, userIds);
      setRotationMembers(db.get(), task.id, assignmentMode === 'round_robin' ? rotationUserIds : []);
      if (req.body.tags !== undefined) setTags(db.get(), task.id, req.body.tags);
      if (bindingChanged) {
        if (desiredActivityBinding) {
          applyTaskActivityBinding(db.get(), task.id, {
            activityTemplateId: desiredActivityBinding.activityTemplateId,
            subjectUserId: desiredActivityBinding.subjectUserId,
            commitRotation: true,
            dateKey: due_date || todayInHouseholdZone(),
          });
        } else {
          clearTaskActivityBinding(db.get(), task.id);
        }
      }
      if (syncTarget !== undefined) {
"""
s = replace_once(s, old, new, 'tasks PUT apply binding')

old = """    addAssignedUsers(updated);
    updated.subtasks = loadSubtasks(updated.id, req.authUserId || req.session.userId);

    res.json({ data: updated });
"""
new = """    addAssignedUsers(updated);
    attachTaskActivityBindings(db.get(), [updated]);
    updated.subtasks = loadSubtasks(updated.id, req.authUserId || req.session.userId);

    res.json({ data: updated });
"""
s = replace_once(s, old, new, 'tasks PUT response binding')

old = """  } catch (err) {
    log.error('PUT /:id error:', err);
    res.status(500).json({ error: 'Internal server error.', code: 500 });
  }
});

/**
 * Die Folgeinstanz, die beim Erledigen dieser Aufgabe entstanden ist (#650) -
"""
new = """  } catch (err) {
    if (err instanceof TaskActivityBindingError) {
      return res.status(400).json({ error: err.message, code: 400 });
    }
    log.error('PUT /:id error:', err);
    res.status(500).json({ error: 'Internal server error.', code: 500 });
  }
});

/**
 * Die Folgeinstanz, die beim Erledigen dieser Aufgabe entstanden ist (#650) -
"""
s = replace_once(s, old, new, 'tasks PUT binding error')

old = """  const originTaskId = followup.recurrence_origin_id;
  const originSubtasks = originTaskId
    ? db.get().prepare('SELECT * FROM tasks WHERE parent_task_id = ?').all(originTaskId)
    : [];
  const currentSubtasks = db.get()
    .prepare('SELECT * FROM tasks WHERE parent_task_id = ?')
    .all(followup.id);

  if (currentSubtasks.length !== originSubtasks.length) return true;
"""
new = """  const originTaskId = followup.recurrence_origin_id;
  const originSubtasks = originTaskId ? ordinaryActivitySubtasks(db.get(), originTaskId) : [];
  const currentSubtasks = ordinaryActivitySubtasks(db.get(), followup.id);

  if (currentSubtasks.length !== originSubtasks.length) return true;

  // Supervision is regenerated from current proficiency for each occurrence.
  // It therefore must not be compared by assignee against the previous cycle,
  // but completed/edited generated work still makes undo conservative.
  for (const support of activitySupportTasks(db.get(), followup.id)) {
    if (support.status !== 'open') return true;
    if (!support.recurrence_origin_id) continue;
    const origin = db.get().prepare('SELECT * FROM tasks WHERE id = ?').get(support.recurrence_origin_id);
    if (!origin) return true;
    if (
      support.title !== origin.title ||
      (support.description || '') !== (origin.description || '') ||
      support.category !== origin.category ||
      support.priority !== origin.priority ||
      support.points !== origin.points ||
      support.visibility !== origin.visibility ||
      support.due_time !== origin.due_time
    ) return true;
  }
"""
s = replace_once(s, old, new, 'recurrence support touched handling')

old = """  const existingSubtasks = db.get()
    .prepare('SELECT * FROM tasks WHERE parent_task_id = ? ORDER BY id ASC')
    .all(task.id);
"""
new = """  const taskActivityBinding = getTaskActivityBinding(db.get(), task.id);
  const existingSubtasks = ordinaryActivitySubtasks(db.get(), task.id);
"""
s = replace_once(s, old, new, 'recurrence ordinary subtasks')

old = """      setAssignments(db.get(), newSub.lastInsertRowid, subAssignments);
      setTags(db.get(), newSub.lastInsertRowid, subTags);
    }
  })();
}

function spawnRecurrenceFollowup(task) {
"""
new = """      setAssignments(db.get(), newSub.lastInsertRowid, subAssignments);
      setTags(db.get(), newSub.lastInsertRowid, subTags);
    }

    if (taskActivityBinding) {
      copyTaskActivityBinding(db.get(), task.id, Number(newTask.lastInsertRowid), {
        commitRotation: true,
        dateKey: nextDate,
      });
    }
  })();
}

function spawnRecurrenceFollowup(task) {
"""
s = replace_once(s, old, new, 'recurrence copy binding')

old = """    const rows = db.get().prepare(sql).all(...params).map(task => ({ ...task, subtasks: JSON.parse(task.subtasks || '[]') })).map(addAssignedUsers);
    res.json({ data: attachTags(attachDocumentCounts(rows, me)) });
"""
new = """    const rows = db.get().prepare(sql).all(...params).map(task => ({ ...task, subtasks: JSON.parse(task.subtasks || '[]') })).map(addAssignedUsers);
    attachTaskActivityBindings(db.get(), rows);
    res.json({ data: attachTags(attachDocumentCounts(rows, me)) });
"""
s = replace_once(s, old, new, 'tasks list binding metadata')

old = """    task.documents = loadTaskDocuments(task.id, me);
    attachTags([task]);
    res.json({ data: task });
"""
new = """    task.documents = loadTaskDocuments(task.id, me);
    attachTaskActivityBindings(db.get(), [task]);
    attachTags([task]);
    res.json({ data: task });
"""
s = replace_once(s, old, new, 'tasks detail binding metadata')
write(p, s)

# ---------------------------------------------------------------------------
# Tasks UI: Activity Template selector + manual mode gate
# ---------------------------------------------------------------------------
p = 'public/pages/tasks.js'
s = read(p)
old = """  const rotationGroup = task?.rotation_group || '';
  const rotationPosition = Number(task?.rotation_slot ?? 0) + 1;
  const visibility  = task?.visibility || 'all';

  const selectedCat = task?.category ?? FALLBACK_CATEGORY;
"""
new = """  const rotationGroup = task?.rotation_group || '';
  const rotationPosition = Number(task?.rotation_slot ?? 0) + 1;
  const visibility  = task?.visibility || 'all';
  const activityTemplateId = task?.activity_template_id ? Number(task.activity_template_id) : null;
  const activitySubjectUserId = task?.activity_subject_user_id ? Number(task.activity_subject_user_id) : null;
  const activityTemplates = [...(state.activityTemplates ?? [])];
  if (activityTemplateId && !activityTemplates.some((item) => Number(item.id) === activityTemplateId)) {
    activityTemplates.push({
      id: activityTemplateId,
      name: task?.activity_template_name || `Activity ${activityTemplateId}`,
      subject_required: task?.activity_subject_required ? 1 : 0,
      inactive: true,
    });
  }
  const activityOptions = activityTemplates.map((activity) =>
    `<option value="${activity.id}" data-subject-required="${activity.subject_required ? '1' : '0'}" ${activityTemplateId === Number(activity.id) ? 'selected' : ''}>${esc(activity.name)}${activity.inactive ? ' (inactive)' : ''}</option>`
  ).join('');
  const activitySubjectOptions = users.map((user) =>
    `<option value="${user.id}" ${activitySubjectUserId === Number(user.id) ? 'selected' : ''}>${esc(user.display_name)}</option>`
  ).join('');

  const selectedCat = task?.category ?? FALLBACK_CATEGORY;
"""
s = replace_once(s, old, new, 'tasks UI activity option setup')

old = """      <div class="form-group" style="margin-top:var(--space-4)"${isSoloHousehold() ? ' hidden' : ''}>
        <label class="label" for="task-assignment-mode">Assignment mode</label>
        <select class="input" id="task-assignment-mode" name="assignment_mode">
"""
new = """      <div class="form-group" style="margin-top:var(--space-4)">
        <label class="label" for="task-activity-template">Activity template</label>
        <select class="input" id="task-activity-template" name="activity_template_id">
          <option value="">Manual assignment</option>
          ${activityOptions}
        </select>
        <p class="task-field-hint">When selected, skills and proficiency determine who owns each occurrence. Manual fixed and round-robin assignment are bypassed.</p>
      </div>

      <div class="form-group" id="task-activity-subject" style="margin-top:var(--space-4)" hidden>
        <label class="label" for="task-activity-subject-user">Activity subject</label>
        <select class="input" id="task-activity-subject-user" name="activity_subject_user_id">
          <option value="">Choose a household member</option>
          ${activitySubjectOptions}
        </select>
        <p class="task-field-hint">The subject is the household member this activity is being performed for or by.</p>
      </div>

      <div class="form-group" id="task-manual-assignment-mode" style="margin-top:var(--space-4)"${isSoloHousehold() ? ' hidden' : ''}>
        <label class="label" for="task-assignment-mode">Assignment mode</label>
        <select class="input" id="task-assignment-mode" name="assignment_mode">
"""
s = replace_once(s, old, new, 'tasks UI activity selector')

old = """function wireVisibilityWarning(panel, selectSel, msName, warnSel) {
  const select = panel.querySelector(selectSel);
  const warn   = panel.querySelector(warnSel);
  if (!select || !warn) return;
  const ms = panel.querySelector(`.user-ms[data-ms-name="${msName}"]`);
  const rotation = panel.querySelector('#task-round-robin-assignment');
  const mode = panel.querySelector('#task-assignment-mode');
  const update = () => {
    const count = mode?.value === 'round_robin'
      ? getRotationUserIds(panel).length
      : getSelectedUserIds(panel, msName).length;
    warn.hidden = !(select.value === 'assignees' && count === 0);
  };
  select.addEventListener('change', update);
  mode?.addEventListener('change', update);
  ms?.addEventListener('click', () => setTimeout(update, 0));
  rotation?.addEventListener('input', update);
  update();
}

function wireAssignmentMode(panel) {
  const mode = panel.querySelector('#task-assignment-mode');
  const fixed = panel.querySelector('#task-fixed-assignment');
  const rotation = panel.querySelector('#task-round-robin-assignment');
  if (!mode || !fixed || !rotation) return;
  const update = () => {
    const roundRobin = mode.value === 'round_robin';
    fixed.hidden = roundRobin;
    rotation.hidden = !roundRobin;
  };
  mode.addEventListener('change', update);
  update();
}
"""
new = """function wireVisibilityWarning(panel, selectSel, msName, warnSel) {
  const select = panel.querySelector(selectSel);
  const warn   = panel.querySelector(warnSel);
  if (!select || !warn) return;
  const ms = panel.querySelector(`.user-ms[data-ms-name="${msName}"]`);
  const rotation = panel.querySelector('#task-round-robin-assignment');
  const mode = panel.querySelector('#task-assignment-mode');
  const activity = panel.querySelector('#task-activity-template');
  const update = () => {
    const count = activity?.value
      ? 1
      : (mode?.value === 'round_robin'
        ? getRotationUserIds(panel).length
        : getSelectedUserIds(panel, msName).length);
    warn.hidden = !(select.value === 'assignees' && count === 0);
  };
  select.addEventListener('change', update);
  mode?.addEventListener('change', update);
  activity?.addEventListener('change', update);
  ms?.addEventListener('click', () => setTimeout(update, 0));
  rotation?.addEventListener('input', update);
  update();
}

function wireAssignmentMode(panel) {
  const activity = panel.querySelector('#task-activity-template');
  const subject = panel.querySelector('#task-activity-subject');
  const modeWrap = panel.querySelector('#task-manual-assignment-mode');
  const mode = panel.querySelector('#task-assignment-mode');
  const fixed = panel.querySelector('#task-fixed-assignment');
  const rotation = panel.querySelector('#task-round-robin-assignment');
  if (!mode || !fixed || !rotation) return;
  const update = () => {
    const managed = !!activity?.value;
    const requiresSubject = managed
      && activity.selectedOptions?.[0]?.dataset.subjectRequired === '1';
    const manualVisible = !managed && !isSoloHousehold();
    if (subject) subject.hidden = !requiresSubject;
    if (modeWrap) modeWrap.hidden = !manualVisible;
    const roundRobin = manualVisible && mode.value === 'round_robin';
    fixed.hidden = !manualVisible || roundRobin;
    rotation.hidden = !roundRobin;
  };
  activity?.addEventListener('change', update);
  mode.addEventListener('change', update);
  update();
}
"""
s = replace_once(s, old, new, 'tasks UI assignment gate')

old = """    allowedMemberIds: () => {
      let ids;
      if (panel.querySelector('#task-assignment-mode')?.value === 'round_robin') {
        const rotationIds = getRotationUserIds(panel).map(Number);
"""
new = """    allowedMemberIds: () => {
      let ids;
      if (panel.querySelector('#task-activity-template')?.value) {
        const persistedAssignee = Number(task?.assigned_to);
        ids = Number.isInteger(persistedAssignee) && persistedAssignee > 0 ? [persistedAssignee] : [];
      } else if (panel.querySelector('#task-assignment-mode')?.value === 'round_robin') {
        const rotationIds = getRotationUserIds(panel).map(Number);
"""
s = replace_once(s, old, new, 'tasks UI attachment activity assignee')

old = """  const assignmentMode = form.querySelector('#task-assignment-mode')?.value || 'fixed';
  const rotationUserIds = getRotationUserIds(form);
  const rotationGroup = form.querySelector('#task-rotation-group')?.value.trim() || '';
  const rotationPosition = Number(form.querySelector('#task-rotation-position')?.value || 1);

  const body = {
"""
new = """  const activitySelect = form.querySelector('#task-activity-template');
  const activityTemplateId = activitySelect?.value ? Number(activitySelect.value) : null;
  const activityRequiresSubject = !!activityTemplateId
    && activitySelect?.selectedOptions?.[0]?.dataset.subjectRequired === '1';
  const activitySubjectUserId = activityRequiresSubject
    ? Number(form.querySelector('#task-activity-subject-user')?.value || 0) || null
    : null;
  const managedActivity = Number.isInteger(activityTemplateId) && activityTemplateId > 0;
  const assignmentMode = managedActivity ? 'fixed' : (form.querySelector('#task-assignment-mode')?.value || 'fixed');
  const rotationUserIds = managedActivity ? [] : getRotationUserIds(form);
  const rotationGroup = managedActivity ? '' : (form.querySelector('#task-rotation-group')?.value.trim() || '');
  const rotationPosition = Number(form.querySelector('#task-rotation-position')?.value || 1);

  const body = {
"""
s = replace_once(s, old, new, 'tasks UI submit activity setup')

old = """    assigned_to:     assignmentMode === 'fixed' ? getSelectedUserIds(form, 'task_assigned') : [],
    assignment_mode: assignmentMode,
    rotation_user_ids: assignmentMode === 'round_robin' ? rotationUserIds : [],
"""
new = """    assigned_to:     !managedActivity && assignmentMode === 'fixed' ? getSelectedUserIds(form, 'task_assigned') : [],
    activity_template_id: managedActivity ? activityTemplateId : null,
    activity_subject_user_id: managedActivity ? activitySubjectUserId : null,
    assignment_mode: assignmentMode,
    rotation_user_ids: !managedActivity && assignmentMode === 'round_robin' ? rotationUserIds : [],
"""
s = replace_once(s, old, new, 'tasks UI submit activity body')

old = """  if (form.status) body.status = form.status.value;
  if (assignmentMode === 'round_robin') {
"""
new = """  if (form.status) body.status = form.status.value;
  if (managedActivity && activityRequiresSubject && !activitySubjectUserId) {
    resetSubmit('Choose a household member for this Activity Template.'); return;
  }
  if (!managedActivity && assignmentMode === 'round_robin') {
"""
s = replace_once(s, old, new, 'tasks UI submit validation')

old = """    { icon: 'folder', label: t('tasks.categoryLabel'), value: task.category && task.category !== FALLBACK_CATEGORY ? catLabel(task.category) : '' },
    assignedRow(task.assigned_users, t('tasks.assignedLabel')),
"""
new = """    { icon: 'folder', label: t('tasks.categoryLabel'), value: task.category && task.category !== FALLBACK_CATEGORY ? catLabel(task.category) : '' },
    { icon: 'sparkles', label: 'Activity template', value: task.activity_template_name
      ? `${task.activity_template_name}${task.activity_subject_name ? ` · ${task.activity_subject_name}` : ''}`
      : '' },
    assignedRow(task.assigned_users, t('tasks.assignedLabel')),
"""
s = replace_once(s, old, new, 'tasks detail activity row')

old = """    const [tasksData, metaData, preferencesData] = await Promise.all([
      api.get(`/tasks${taskQuery()}`),
      api.get('/tasks/meta/options'),
      // Reine Anzeigepräferenz: ein Fehler hier darf die Aufgabenliste nicht
      // mit in den Ladefehler ziehen, deshalb eigener Fallback.
      api.get('/preferences').catch(() => ({ data: {} })),
    ]);
"""
new = """    const [tasksData, metaData, preferencesData, activityData] = await Promise.all([
      api.get(`/tasks${taskQuery()}`),
      api.get('/tasks/meta/options'),
      // Reine Anzeigepräferenz: ein Fehler hier darf die Aufgabenliste nicht
      // mit in den Ladefehler ziehen, deshalb eigener Fallback.
      api.get('/preferences').catch(() => ({ data: {} })),
      // Activity Templates augment assignment; a catalogue failure must not
      // make the ordinary task list look unavailable.
      api.get('/automation/activity-options').catch(() => ({ data: { activities: [] } })),
    ]);
"""
s = replace_once(s, old, new, 'tasks UI load activity options')

old = """    state.defaultPoints = Number(metaData.default_points) || 0;
    state.subtasksExpandedByDefault = preferencesData.data?.tasks_subtasks_expanded === true;
"""
new = """    state.defaultPoints = Number(metaData.default_points) || 0;
    state.activityTemplates = activityData.data?.activities ?? [];
    state.subtasksExpandedByDefault = preferencesData.data?.tasks_subtasks_expanded === true;
"""
s = replace_once(s, old, new, 'tasks UI store activity options')

old = """    state.defaultPoints = 0;
    state.subtasksExpandedByDefault = false;
"""
new = """    state.defaultPoints = 0;
    state.activityTemplates = [];
    state.subtasksExpandedByDefault = false;
"""
s = replace_once(s, old, new, 'tasks UI activity load fallback')
write(p, s)

# ---------------------------------------------------------------------------
# Package scripts and full test chain
# ---------------------------------------------------------------------------
p = 'package.json'
s = read(p)
s = replace_once(
    s,
    'npm run test:activity-automation-routes && npm run test:tasks-routes',
    'npm run test:activity-automation-routes && npm run test:task-activity-bindings && npm run test:tasks-routes',
    'package full test chain',
)
s = replace_once(
    s,
    '    "test:activity-automation-routes": "node --experimental-sqlite --test test/test-activity-automation-routes.js",\n    "test:task-round-robin":',
    '    "test:activity-automation-routes": "node --experimental-sqlite --test test/test-activity-automation-routes.js",\n    "test:task-activity-bindings": "node --experimental-sqlite --test test/test-task-activity-bindings.js",\n    "test:task-round-robin":',
    'package binding test script',
)
write(p, s)
