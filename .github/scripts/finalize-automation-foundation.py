from pathlib import Path


def replace_once(path, old, new):
    p = Path(path)
    text = p.read_text()
    if old not in text:
        raise SystemExit(f"anchor not found in {path}: {old[:120]!r}")
    p.write_text(text.replace(old, new, 1))


# Make the route test self-contained and cross-platform instead of relying on a
# shell-style environment assignment in package.json.
replace_once(
    'test/test-activity-automation-routes.js',
    "process.env.DB_PATH = ':memory:';\nprocess.env.TZ = 'UTC';",
    "process.env.DB_PATH = ':memory:';\nprocess.env.TZ = 'UTC';\nprocess.env.SESSION_SECRET ??= 'test-session-secret-at-least-32-characters-long';",
)

# Put the new suites in the ordinary repository test chain so PR CI cannot pass
# while skipping the automation feature.
replace_once(
    'package.json',
    '    "test:task-round-robin": "node --experimental-sqlite --test test/test-task-round-robin.js"',
    '    "test:activity-automation": "node --experimental-sqlite --test test/test-activity-automation.js",\n'
    '    "test:activity-automation-routes": "node --experimental-sqlite --test test/test-activity-automation-routes.js",\n'
    '    "test:task-round-robin": "node --experimental-sqlite --test test/test-task-round-robin.js"',
)
replace_once(
    'package.json',
    'npm run test:tasks-recurrence && npm run test:task-round-robin && npm run test:tasks-routes',
    'npm run test:tasks-recurrence && npm run test:task-round-robin && npm run test:activity-automation && npm run test:activity-automation-routes && npm run test:tasks-routes',
)

# Workflow-generated subtasks are individually assigned. Surface that assignment
# in the compact task list rather than making the user open every subtask to
# discover who owns it.
replace_once(
    'server/routes/tasks.js',
    """(SELECT json_group_array(json_object('id', s.id, 'title', s.title, 'status', s.status))
           FROM (SELECT s.id, s.title, s.status FROM tasks s WHERE s.parent_task_id = t.id
                   AND ${visibilityWhere('s', 'task_assignments', 'task_id')}
                 ORDER BY s.created_at ASC) s) AS subtasks""",
    """(SELECT json_group_array(json_object(
                  'id', s.id, 'title', s.title, 'status', s.status,
                  'assigned_to', s.assigned_to, 'assigned_name', s.assigned_name
                ))
           FROM (SELECT s.id, s.title, s.status, s.assigned_to, su.display_name AS assigned_name
                   FROM tasks s
                   LEFT JOIN users su ON su.id = s.assigned_to
                  WHERE s.parent_task_id = t.id
                    AND ${visibilityWhere('s', 'task_assignments', 'task_id')}
                  ORDER BY s.created_at ASC) s) AS subtasks""",
)
replace_once(
    'public/pages/tasks.js',
    """          <span class=\"subtask-item__title\">${esc(s.title)}</span>
          ${canEditTaskDefinition(s, task) ? `""",
    """          <span class=\"subtask-item__title\">${esc(s.title)}</span>
          ${s.assigned_name ? `<span class=\"subtask-item__assignee\">${esc(s.assigned_name)}</span>` : ''}
          ${canEditTaskDefinition(s, task) ? `""",
)
replace_once(
    'public/styles/tasks.css',
    """.subtask-item--done .subtask-item__title {
  text-decoration: line-through;
  color: var(--color-text-secondary);
}
""",
    """.subtask-item--done .subtask-item__title {
  text-decoration: line-through;
  color: var(--color-text-secondary);
}

.subtask-item__assignee {
  flex-shrink: 0;
  max-width: 8rem;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: var(--text-xs);
  color: var(--color-text-secondary);
}
""",
)

print('automation foundation finalization patch applied')
