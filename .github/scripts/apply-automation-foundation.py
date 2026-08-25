from pathlib import Path


def replace_once(path, old, new):
    p = Path(path)
    text = p.read_text()
    if old not in text:
        raise SystemExit(f"anchor not found in {path}: {old[:120]!r}")
    p.write_text(text.replace(old, new, 1))


# ---------------------------------------------------------------------------
# Database migration 162
# ---------------------------------------------------------------------------
db_path = Path('server/db.js')
db_text = db_path.read_text()
anchor = """  {\n    version: 161,\n    description: 'Tasks: synchronized rotation groups for recurring round-robin cohorts',\n    up: `\n      ALTER TABLE tasks ADD COLUMN rotation_group TEXT;\n      ALTER TABLE tasks ADD COLUMN rotation_slot INTEGER NOT NULL DEFAULT 0 CHECK(rotation_slot >= 0);\n      ALTER TABLE tasks ADD COLUMN rotation_cycle INTEGER NOT NULL DEFAULT 0 CHECK(rotation_cycle >= 0);\n      CREATE INDEX idx_tasks_rotation_group_cycle\n        ON tasks(rotation_group COLLATE NOCASE, rotation_cycle)\n        WHERE rotation_group IS NOT NULL;\n    `,\n  },\n];\n"""
replacement = """  {\n    version: 161,\n    description: 'Tasks: synchronized rotation groups for recurring round-robin cohorts',\n    up: `\n      ALTER TABLE tasks ADD COLUMN rotation_group TEXT;\n      ALTER TABLE tasks ADD COLUMN rotation_slot INTEGER NOT NULL DEFAULT 0 CHECK(rotation_slot >= 0);\n      ALTER TABLE tasks ADD COLUMN rotation_cycle INTEGER NOT NULL DEFAULT 0 CHECK(rotation_cycle >= 0);\n      CREATE INDEX idx_tasks_rotation_group_cycle\n        ON tasks(rotation_group COLLATE NOCASE, rotation_cycle)\n        WHERE rotation_group IS NOT NULL;\n    `,\n  },\n  {\n    version: 162,\n    description: 'Household automation: skills, activity templates, workflows and Quick Add',\n    up: `\n      CREATE TABLE IF NOT EXISTS skills (\n        id            INTEGER PRIMARY KEY AUTOINCREMENT,\n        name          TEXT    NOT NULL UNIQUE COLLATE NOCASE,\n        description   TEXT,\n        minimum_age   INTEGER CHECK(minimum_age IS NULL OR minimum_age >= 0),\n        age_promotion TEXT    NOT NULL DEFAULT 'supervised'\n                              CHECK(age_promotion IN ('supervised', 'normal')),\n        adult_only    INTEGER NOT NULL DEFAULT 0 CHECK(adult_only IN (0, 1)),\n        active        INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0, 1)),\n        created_by    INTEGER REFERENCES users(id) ON DELETE SET NULL,\n        created_at    TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),\n        updated_at    TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))\n      );\n\n      CREATE TABLE IF NOT EXISTS user_skill_proficiency (\n        user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,\n        skill_id      INTEGER NOT NULL REFERENCES skills(id) ON DELETE CASCADE,\n        proficiency   TEXT    NOT NULL CHECK(proficiency IN ('excluded', 'supervised', 'normal')),\n        source        TEXT    NOT NULL DEFAULT 'manual' CHECK(source IN ('automatic', 'manual')),\n        updated_by    INTEGER REFERENCES users(id) ON DELETE SET NULL,\n        updated_at    TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),\n        PRIMARY KEY (user_id, skill_id)\n      );\n      CREATE INDEX idx_user_skill_proficiency_skill ON user_skill_proficiency(skill_id);\n\n      CREATE TABLE IF NOT EXISTS activity_templates (\n        id                         INTEGER PRIMARY KEY AUTOINCREMENT,\n        name                       TEXT    NOT NULL,\n        title_template             TEXT    NOT NULL,\n        description                TEXT,\n        category                   TEXT    NOT NULL DEFAULT 'misc',\n        assignment_strategy        TEXT    NOT NULL DEFAULT 'subject_skill'\n                                           CHECK(assignment_strategy IN ('subject_skill', 'eligible_round_robin', 'fixed')),\n        subject_required           INTEGER NOT NULL DEFAULT 1 CHECK(subject_required IN (0, 1)),\n        fixed_user_id              INTEGER REFERENCES users(id) ON DELETE SET NULL,\n        supervision_title_template TEXT,\n        active                     INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0, 1)),\n        created_by                 INTEGER REFERENCES users(id) ON DELETE SET NULL,\n        created_at                 TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),\n        updated_at                 TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))\n      );\n      CREATE INDEX idx_activity_templates_active ON activity_templates(active);\n\n      CREATE TABLE IF NOT EXISTS activity_template_skills (\n        activity_template_id INTEGER NOT NULL REFERENCES activity_templates(id) ON DELETE CASCADE,\n        skill_id              INTEGER NOT NULL REFERENCES skills(id) ON DELETE RESTRICT,\n        sort_order            INTEGER NOT NULL DEFAULT 0 CHECK(sort_order >= 0),\n        PRIMARY KEY (activity_template_id, skill_id),\n        UNIQUE (activity_template_id, sort_order)\n      );\n      CREATE INDEX idx_activity_template_skills_skill ON activity_template_skills(skill_id);\n\n      CREATE TABLE IF NOT EXISTS activity_rotation_state (\n        activity_template_id INTEGER NOT NULL REFERENCES activity_templates(id) ON DELETE CASCADE,\n        purpose              TEXT    NOT NULL CHECK(purpose IN ('primary', 'supervisor')),\n        last_user_id         INTEGER REFERENCES users(id) ON DELETE SET NULL,\n        updated_at           TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),\n        PRIMARY KEY (activity_template_id, purpose)\n      );\n\n      CREATE TABLE IF NOT EXISTS workflow_templates (\n        id                INTEGER PRIMARY KEY AUTOINCREMENT,\n        name              TEXT    NOT NULL,\n        description       TEXT,\n        category          TEXT    NOT NULL DEFAULT 'misc',\n        quick_add_enabled INTEGER NOT NULL DEFAULT 1 CHECK(quick_add_enabled IN (0, 1)),\n        subject_required  INTEGER NOT NULL DEFAULT 1 CHECK(subject_required IN (0, 1)),\n        input_schema_json TEXT,\n        active            INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0, 1)),\n        created_by        INTEGER REFERENCES users(id) ON DELETE SET NULL,\n        created_at        TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),\n        updated_at        TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))\n      );\n      CREATE INDEX idx_workflow_templates_quick_add\n        ON workflow_templates(quick_add_enabled, active);\n\n      CREATE TABLE IF NOT EXISTS workflow_template_steps (\n        id                   INTEGER PRIMARY KEY AUTOINCREMENT,\n        workflow_template_id INTEGER NOT NULL REFERENCES workflow_templates(id) ON DELETE CASCADE,\n        activity_template_id INTEGER NOT NULL REFERENCES activity_templates(id) ON DELETE RESTRICT,\n        step_key             TEXT    NOT NULL,\n        sort_order           INTEGER NOT NULL DEFAULT 0 CHECK(sort_order >= 0),\n        title_override       TEXT,\n        condition_json       TEXT,\n        UNIQUE (workflow_template_id, step_key),\n        UNIQUE (workflow_template_id, sort_order)\n      );\n      CREATE INDEX idx_workflow_steps_activity ON workflow_template_steps(activity_template_id);\n\n      CREATE TABLE IF NOT EXISTS workflow_step_dependencies (\n        step_id            INTEGER NOT NULL REFERENCES workflow_template_steps(id) ON DELETE CASCADE,\n        depends_on_step_id INTEGER NOT NULL REFERENCES workflow_template_steps(id) ON DELETE CASCADE,\n        PRIMARY KEY (step_id, depends_on_step_id),\n        CHECK(step_id != depends_on_step_id)\n      );\n\n      CREATE TABLE IF NOT EXISTS workflow_instances (\n        id                   INTEGER PRIMARY KEY AUTOINCREMENT,\n        workflow_template_id INTEGER REFERENCES workflow_templates(id) ON DELETE SET NULL,\n        subject_user_id      INTEGER REFERENCES users(id) ON DELETE SET NULL,\n        parent_task_id       INTEGER REFERENCES tasks(id) ON DELETE SET NULL,\n        status               TEXT    NOT NULL DEFAULT 'open' CHECK(status IN ('open', 'done', 'cancelled')),\n        input_json           TEXT,\n        created_by           INTEGER REFERENCES users(id) ON DELETE SET NULL,\n        created_at           TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),\n        updated_at           TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))\n      );\n      CREATE INDEX idx_workflow_instances_subject ON workflow_instances(subject_user_id);\n      CREATE INDEX idx_workflow_instances_parent ON workflow_instances(parent_task_id);\n\n      CREATE TABLE IF NOT EXISTS workflow_instance_tasks (\n        workflow_instance_id INTEGER NOT NULL REFERENCES workflow_instances(id) ON DELETE CASCADE,\n        workflow_step_id     INTEGER REFERENCES workflow_template_steps(id) ON DELETE SET NULL,\n        task_id              INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,\n        role                 TEXT    NOT NULL DEFAULT 'primary' CHECK(role IN ('primary', 'supervisor')),\n        PRIMARY KEY (workflow_instance_id, task_id),\n        UNIQUE (task_id)\n      );\n      CREATE INDEX idx_workflow_instance_tasks_step ON workflow_instance_tasks(workflow_step_id);\n\n      CREATE TABLE IF NOT EXISTS workflow_task_dependencies (\n        task_id            INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,\n        depends_on_task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,\n        PRIMARY KEY (task_id, depends_on_task_id),\n        CHECK(task_id != depends_on_task_id)\n      );\n      CREATE INDEX idx_workflow_task_dependencies_predecessor\n        ON workflow_task_dependencies(depends_on_task_id);\n    `,\n  },\n];\n"""
if anchor not in db_text:
    raise SystemExit('migration 161 anchor not found')
db_path.write_text(db_text.replace(anchor, replacement, 1))


# ---------------------------------------------------------------------------
# Server route mount
# ---------------------------------------------------------------------------
replace_once(
    'server/index.js',
    "import rewardsRouter from './routes/rewards.js';\nimport permissionsRouter from './routes/permissions.js';",
    "import rewardsRouter from './routes/rewards.js';\nimport automationRouter from './routes/automation.js';\nimport permissionsRouter from './routes/permissions.js';",
)
replace_once(
    'server/index.js',
    "app.use('/api/v1/rewards', rewardsRouter);\napp.use('/api/v1/permissions', permissionsRouter);",
    "app.use('/api/v1/rewards', rewardsRouter);\napp.use('/api/v1/automation', automationRouter);\napp.use('/api/v1/permissions', permissionsRouter);",
)


# ---------------------------------------------------------------------------
# Workflow dependency enforcement on task completion
# ---------------------------------------------------------------------------
replace_once(
    'server/routes/tasks.js',
    "import { syncTaskRewards } from '../services/rewards.js';",
    "import { syncTaskRewards } from '../services/rewards.js';\nimport { unresolvedDependencies, syncWorkflowInstanceForTask } from '../services/activity-workflows.js';",
)

# PUT /:id, after target status is known but before the transaction.
replace_once(
    'server/routes/tasks.js',
    """    const status = (req.body.status === undefined || archiveRequested)\n      ? task.status\n      : req.body.status;\n\n    const assignedBefore = db.get().prepare('SELECT user_id FROM task_assignments WHERE task_id = ?')""",
    """    const status = (req.body.status === undefined || archiveRequested)\n      ? task.status\n      : req.body.status;\n\n    if (status === 'done' && task.status !== 'done') {\n      const blockedBy = unresolvedDependencies(db.get(), task.id);\n      if (blockedBy.length) {\n        return res.status(409).json({\n          error: 'Complete required earlier activities first.', code: 409, dependencies: blockedBy,\n        });\n      }\n    }\n\n    const assignedBefore = db.get().prepare('SELECT user_id FROM task_assignments WHERE task_id = ?')""",
)
replace_once(
    'server/routes/tasks.js',
    """      syncTaskRewards(db.get(), task.id, task.status, status, req.authUserId || req.session.userId);\n\n      // Auch über das Bearbeiten-Formular lässt sich ein Abhaken zurücknehmen""",
    """      syncTaskRewards(db.get(), task.id, task.status, status, req.authUserId || req.session.userId);\n      syncWorkflowInstanceForTask(db.get(), task.id);\n\n      // Auch über das Bearbeiten-Formular lässt sich ein Abhaken zurücknehmen""",
)

# PATCH /:id/status
replace_once(
    'server/routes/tasks.js',
    """    if (status === ARCHIVE_STATUS) {\n      const archivedAt = setArchived(req.params.id, true);\n      return res.json({ data: { id: Number(req.params.id), status: prev.status, archived_at: archivedAt } });\n    }\n\n    // Statuswechsel und die Serien-Bewegung""",
    """    if (status === ARCHIVE_STATUS) {\n      const archivedAt = setArchived(req.params.id, true);\n      return res.json({ data: { id: Number(req.params.id), status: prev.status, archived_at: archivedAt } });\n    }\n\n    if (status === 'done' && prev.status !== 'done') {\n      const blockedBy = unresolvedDependencies(db.get(), Number(req.params.id));\n      if (blockedBy.length) {\n        return res.status(409).json({\n          error: 'Complete required earlier activities first.', code: 409, dependencies: blockedBy,\n        });\n      }\n    }\n\n    // Statuswechsel und die Serien-Bewegung""",
)
replace_once(
    'server/routes/tasks.js',
    """      syncTaskRewards(db.get(), Number(req.params.id), prev.status, status, req.authUserId || req.session.userId);\n\n      // Zurückgenommenes Abhaken macht auch die Folgeinstanz rückgängig""",
    """      syncTaskRewards(db.get(), Number(req.params.id), prev.status, status, req.authUserId || req.session.userId);\n      syncWorkflowInstanceForTask(db.get(), Number(req.params.id));\n\n      // Zurückgenommenes Abhaken macht auch die Folgeinstanz rückgängig""",
)


# ---------------------------------------------------------------------------
# Tasks UI: Quick Add + mobile subtask affordance
# ---------------------------------------------------------------------------
replace_once(
    'public/pages/tasks.js',
    "import { renderUserRotationOrder, getRotationUserIds } from '/components/user-rotation-order.js';",
    "import { renderUserRotationOrder, getRotationUserIds } from '/components/user-rotation-order.js';\nimport { openQuickAdd } from '/components/activity-automation.js';",
)
replace_once(
    'public/pages/tasks.js',
    """<button class=\"btn btn--ghost btn--icon btn--icon-sm task-card__inline-action\" data-action=\"add-subtask\" data-parent=\"${task.id}\"""",
    """<button class=\"btn btn--ghost btn--icon btn--icon-sm task-card__inline-action task-card__add-subtask\" data-action=\"add-subtask\" data-parent=\"${task.id}\"""",
)
replace_once(
    'public/pages/tasks.js',
    """          <button class=\"btn btn--icon btn--ghost\" id=\"btn-manage-tags\"\n                  aria-label=\"${t('tasks.manageTags')}\" title=\"${t('tasks.manageTags')}\">\n            <i data-lucide=\"tags\" class=\"icon-lg\" aria-hidden=\"true\"></i>\n          </button>\n          <button class=\"btn btn--primary toolbar-new-btn\" id=\"btn-new-task\"""",
    """          <button class=\"btn btn--icon btn--ghost\" id=\"btn-manage-tags\"\n                  aria-label=\"${t('tasks.manageTags')}\" title=\"${t('tasks.manageTags')}\">\n            <i data-lucide=\"tags\" class=\"icon-lg\" aria-hidden=\"true\"></i>\n          </button>\n          <button class=\"btn btn--icon btn--ghost\" id=\"btn-quick-add\"\n                  aria-label=\"Quick Add\" title=\"Quick Add\">\n            <i data-lucide=\"zap\" class=\"icon-lg\" aria-hidden=\"true\"></i>\n          </button>\n          <button class=\"btn btn--primary toolbar-new-btn\" id=\"btn-new-task\"""",
)
replace_once(
    'public/pages/tasks.js',
    """function wireNewTaskBtn(container) {\n  const handler = () => {\n    openTaskModal({ users: state.users }, container);\n  };\n  container.querySelector('#btn-new-task')?.addEventListener('click', handler);\n  findPageFab('fab-new-task')?.addEventListener('click', handler);\n}\n\nfunction updateBulkActionsBar(container) {""",
    """function wireNewTaskBtn(container) {\n  const handler = () => {\n    openTaskModal({ users: state.users }, container);\n  };\n  container.querySelector('#btn-new-task')?.addEventListener('click', handler);\n  findPageFab('fab-new-task')?.addEventListener('click', handler);\n}\n\nfunction wireQuickAddBtn(container) {\n  container.querySelector('#btn-quick-add')?.addEventListener('click', () => {\n    openQuickAdd({\n      isAdmin: state.isAdmin,\n      onCreated: async () => loadTasks(container),\n    });\n  });\n}\n\nfunction updateBulkActionsBar(container) {""",
)
replace_once(
    'public/pages/tasks.js',
    """  wireGroupToggle(container);\n  wireNewTaskBtn(container);\n  wireTaskList(container);""",
    """  wireGroupToggle(container);\n  wireNewTaskBtn(container);\n  wireQuickAddBtn(container);\n  wireTaskList(container);""",
)

# Keep only the Add Subtask inline action visible on compact mobile task cards.
replace_once(
    'public/styles/tasks.css',
    """  .task-card__inline-action {\n    display: none;\n  }\n}""",
    """  .task-card__inline-action {\n    display: none;\n  }\n\n  /* Adding checklist work is a content action, not card chrome. Keep it\n   * reachable on touch while edit/archive stay behind the detail/swipe UI. */\n  .task-card__inline-action.task-card__add-subtask {\n    display: inline-flex;\n  }\n}""",
)

# Service worker must precache the shared component imported by tasks.js.
replace_once(
    'public/sw.js',
    """  '/permissions.js',\n  '/components/detail-view.js',""",
    """  '/permissions.js',\n  '/components/activity-automation.js',\n  '/components/detail-view.js',""",
)

print('automation foundation patch applied')
