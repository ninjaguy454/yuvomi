/** Capabilities extend the existing role/member permission profiles. */
const task = (key, label, access = 'write') => ({ key: `tasks.${key}`, label, group: 'Tasks', module: 'tasks', access, default: 'allow' });
const template = (key, label, defaultAccess = 'none') => ({ key, label, group: 'Templates and workflows', module: 'tasks', access: key.endsWith('.view') ? 'read' : 'write', default: defaultAccess });
export const PERMISSION_CAPABILITIES = Object.freeze([
  task('view_own', 'View own Tasks', 'read'), task('view_household', 'View household Tasks', 'read'),
  task('create', 'Create Tasks'), task('edit_own', 'Edit own Tasks'), task('edit_others', 'Edit other members’ Tasks'),
  task('delete_archive', 'Delete or archive Tasks'), task('change_assignment', 'Choose Task assignments'), task('reassign', 'Reassign existing Tasks'),
  task('change_priority', 'Change priority'), task('change_points', 'Change points'), task('change_category_tags', 'Change category and tags'),
  task('change_dates', 'Change dates and recurrence'), task('change_required_skills', 'Change required skills'),
  task('complete_own', 'Complete or reopen own Tasks'), task('complete_others', 'Complete or reopen other members’ Tasks'),
  task('claim', 'Claim Tasks'), task('comment', 'Write Task comments'),
  template('activities.view', 'View Activity Templates', 'allow'), template('activities.create', 'Create Activity Templates'), template('activities.edit', 'Edit Activity Templates'),
  template('workflows.view', 'View Task Workflows', 'allow'), template('workflows.run', 'Run Task Workflows', 'allow'),
  template('workflows.create', 'Create Task Workflows'), template('workflows.edit', 'Edit Task Workflows'),
  { key: 'settings.personal', label: 'Personal settings and appearance', group: 'Settings', module: null, access: 'write', default: 'allow' },
  { key: 'skills.manage', label: 'Manage Skills and proficiency', group: 'Household management', module: null, access: 'write', default: 'none' },
  { key: 'places.manage', label: 'Manage Places', group: 'Household management', module: 'calendar', access: 'write', default: 'none' },
  { key: 'availability.manage_own', label: 'Manage own rotating routines', group: 'Household management', module: 'schedule', access: 'write', default: 'allow' },
  { key: 'availability.manage', label: 'Manage Availability', group: 'Household management', module: 'calendar', access: 'write', default: 'none' },
  ...['household_settings', 'members', 'integrations', 'permissions'].map(key => ({
    key: `admin.${key}`, label: ({ household_settings: 'Household settings', members: 'Manage members', integrations: 'Manage integrations', permissions: 'Manage permissions' })[key],
    group: 'Administration', module: null, access: 'write', default: 'none', adminOnly: true,
  })),
]);

export const CAPABILITY_BY_KEY = new Map(PERMISSION_CAPABILITIES.map(item => [item.key, item]));
export const RESTRICTED_MEMBER_CAPABILITIES = Object.freeze(Object.fromEntries(PERMISSION_CAPABILITIES
  .filter(item => !item.adminOnly).map(item => [item.key,
    ['tasks.view_own', 'tasks.complete_own', 'tasks.claim', 'tasks.comment', 'settings.personal'].includes(item.key) ? 'allow' : 'none'])));

export class PermissionError extends Error {
  constructor(message = 'Your household permissions do not allow this action.', status = 403) { super(message); this.status = status; this.code = status; }
}
