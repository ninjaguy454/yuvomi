/** Existing templates retain their historical runtime policy until reviewed.
 * This migration never rewrites Tasks, recurrence snapshots or reward history. */
export function addActivityTemplateScoringSchema(d) {
  if(!d.prepare('PRAGMA table_info(activity_templates)').all().some(column=>column.name==='scoring_mode'))
    d.exec("ALTER TABLE activity_templates ADD COLUMN scoring_mode TEXT CHECK(scoring_mode IS NULL OR scoring_mode IN ('whole_task','subtasks'))");
  if(!d.prepare('PRAGMA table_info(activity_template_checklist_items)').all().some(column=>column.name==='points'))
    d.exec('ALTER TABLE activity_template_checklist_items ADD COLUMN points INTEGER NOT NULL DEFAULT 0 CHECK(points BETWEEN 0 AND 10000 AND typeof(points)=\'integer\')');
}
