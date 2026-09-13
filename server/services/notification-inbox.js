import { taskVisibilityWhere } from './task-access.js';
/** User-owned notification receipts. Domain records remain the source of truth. */
import { resolvePermissions } from '../permissions.js';
import { visibilityWhere } from './visibility.js';
import { isHouseholdMember } from './member-email.js';

export const NOTIFICATION_CATEGORIES = Object.freeze(['tasks', 'meals', 'calendar', 'shopping', 'automation']);
const categories = new Set([...NOTIFICATION_CATEGORIES, 'other']);

export function getNotificationPreferences(database, userId) {
  const result = Object.fromEntries(NOTIFICATION_CATEGORIES.map((key) => [key, true]));
  for (const row of database.prepare('SELECT category, enabled FROM notification_preferences WHERE user_id = ?').all(userId)) {
    if (NOTIFICATION_CATEGORIES.includes(row.category)) result[row.category] = Boolean(row.enabled);
  }
  return result;
}

export function setNotificationPreferences(database, userId, changes) {
  if (!changes || typeof changes !== 'object' || Array.isArray(changes)
    || Object.entries(changes).some(([key, value]) => !NOTIFICATION_CATEGORIES.includes(key) || typeof value !== 'boolean')) {
    const error = new Error('Choose a true or false value for each notification category.');
    error.status = 400;
    throw error;
  }
  const save = database.prepare(`INSERT INTO notification_preferences (user_id, category, enabled) VALUES (?, ?, ?)
    ON CONFLICT(user_id, category) DO UPDATE SET enabled = excluded.enabled`);
  database.transaction(() => {
    for (const [key, value] of Object.entries(changes)) save.run(userId, key, value ? 1 : 0);
  })();
  return getNotificationPreferences(database, userId);
}

// Build one indexed query for a user's history/count; do not run one permissions
// lookup per old notification. The same predicate also protects outbound sends.
function accessWhere(database, userId) {
  if (!isHouseholdMember(userId, { db: database })) return '0';
  const user = database.prepare('SELECT id, role, family_role FROM users WHERE id = ?').get(userId);
  const { modules } = resolvePermissions(database, user);
  const clauses = [];
  if (modules.tasks !== 'none') clauses.push(`(n.entity_type = 'task' AND EXISTS (
    SELECT 1 FROM tasks t WHERE t.id = n.entity_id AND ${taskVisibilityWhere(database, userId, 't', '@me')}))`);
  if (modules.calendar !== 'none') {
    clauses.push(`(n.entity_type = 'event' AND EXISTS (SELECT 1 FROM calendar_events e
      WHERE e.id = n.entity_id AND ${visibilityWhere('e', 'event_assignments', 'event_id', '@me')}
      AND (COALESCE(e.external_source, 'local') != 'ics' OR EXISTS (
        SELECT 1 FROM ics_subscriptions s WHERE s.id = e.subscription_id AND (s.shared = 1 OR s.created_by = @me)))))`);
    clauses.push(`(n.entity_type = 'planning_context' AND EXISTS (SELECT 1 FROM planning_contexts p WHERE p.id = n.entity_id))`);
  }
  const shared = [
    ['meals', 'meal', 'meals'], ['shopping', 'grocery_run', 'meal_grocery_runs'],
    ['shopping', 'shopping_list', 'shopping_lists'], ['budget', 'subscription', 'budget_subscriptions'],
    ['inventory', 'inventory_item', 'inventory_items'], ['inventory', 'inventory_tracked_date', 'inventory_item_dates'],
    ['pantry', 'pantry_item', 'pantry_items'],
  ];
  for (const [module, type, table] of shared) {
    if (modules[module] !== 'none') clauses.push(`(n.entity_type = '${type}' AND EXISTS (SELECT 1 FROM ${table} s WHERE s.id = n.entity_id))`);
  }
  return clauses.length ? `(${clauses.join(' OR ')})` : '0';
}

export function canReceiveNotification(database, notification) {
  const userId = Number(notification?.user_id);
  if (!Number.isSafeInteger(userId) || userId <= 0) return false;
  const where = accessWhere(database, userId);
  if (where === '0') return false;
  return Boolean(database.prepare(`SELECT 1 FROM (
    SELECT @type AS entity_type, @entity AS entity_id, @me AS user_id
  ) n WHERE ${where}`).get({ me: userId, type: notification.entity_type, entity: notification.entity_id ?? null }));
}

export function notificationUrl(database, entityType, entityId, userId = null) {
  const id = Number(entityId);
  if (!Number.isSafeInteger(id) || id <= 0) return '/';
  if (entityType === 'task') {
    const task = database.prepare('SELECT parent_task_id FROM tasks WHERE id = ?').get(id);
    const visibleParent = task?.parent_task_id && userId && database.prepare(`SELECT 1 FROM tasks p
      WHERE p.id = @id AND ${taskVisibilityWhere(database, userId, 'p', '@me')}`)
      .get({ id: task.parent_task_id, me: userId });
    return visibleParent ? `/tasks?open=${task.parent_task_id}&section=subtasks` : `/tasks?open=${id}`;
  }
  if (entityType === 'event') {
    const event = database.prepare('SELECT start_datetime FROM calendar_events WHERE id = ?').get(id);
    return `/calendar?open=${id}${event?.start_datetime ? `&date=${encodeURIComponent(event.start_datetime.slice(0, 10))}` : ''}`;
  }
  if (entityType === 'meal') {
    const meal = database.prepare('SELECT date, planning_context_id FROM meals WHERE id = ?').get(id);
    return `/meals?open=${id}${meal?.date ? `&date=${meal.date}&context=${meal.planning_context_id || 'home'}` : ''}`;
  }
  if (entityType === 'grocery_run') {
    const run = database.prepare('SELECT shopping_list_id FROM meal_grocery_runs WHERE id = ?').get(id);
    return run?.shopping_list_id ? `/shopping?list=${run.shopping_list_id}` : '/shopping';
  }
  if (entityType === 'shopping_list') return `/shopping?list=${id}`;
  if (entityType === 'planning_context') {
    const trip = database.prepare('SELECT id FROM trip_plans WHERE planning_context_id = ? ORDER BY id LIMIT 1').get(id);
    return trip ? `/calendar?section=trips&open=${trip.id}` : '/calendar?section=trips';
  }
  return ({ subscription: '/budget', inventory_item: '/inventory', inventory_tracked_date: '/inventory', pantry_item: '/pantry' })[entityType] || '/';
}

export function enqueueNotification(database, {
  userId, sourceKey, category, entityType, entityId, title, body = '', url,
  reminderId = null, deliveryScope = 'user', suppressDelivery = false,
}) {
  if (!categories.has(category) || !sourceKey || !title) throw new Error('Invalid notification source.');
  const candidate = { user_id: Number(userId), category, entity_type: entityType, entity_id: entityId };
  if (!canReceiveNotification(database, candidate) || getNotificationPreferences(database, userId)[category] === false) return null;
  const target = url || notificationUrl(database, entityType, entityId, Number(userId));
  if (!target.startsWith('/') || target.startsWith('//') || /[\r\n\\]/.test(target)) throw new Error('Notification links must stay in Vidamia.');
  database.prepare(`INSERT INTO notification_inbox
    (user_id, source_key, category, entity_type, entity_id, title, body, url, reminder_id, delivery_scope, dispatched_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(user_id, source_key) DO NOTHING`).run(
    Number(userId), String(sourceKey), category, entityType, entityId ?? null,
    String(title).slice(0, 200), String(body).slice(0, 1000), target,
    reminderId, deliveryScope === 'household' ? 'household' : 'user', suppressDelivery ? new Date().toISOString() : null,
  );
  return database.prepare('SELECT * FROM notification_inbox WHERE user_id = ? AND source_key = ?').get(Number(userId), String(sourceKey));
}

const publicFields = 'n.id, n.title, n.body, n.url, n.category, n.created_at, n.read_at';

export function listNotificationInbox(database, userId, { limit = 50 } = {}) {
  const where = accessWhere(database, userId);
  const scope = `n.user_id = @me AND n.dismissed_at IS NULL AND ${where}`;
  const count = database.prepare(`SELECT COUNT(*) AS count FROM notification_inbox n WHERE ${scope} AND n.read_at IS NULL`).get({ me: userId }).count;
  const items = database.prepare(`SELECT ${publicFields} FROM notification_inbox n WHERE ${scope} ORDER BY n.id DESC LIMIT @limit`)
    .all({ me: userId, limit: Math.min(100, Math.max(1, Math.floor(Number(limit) || 50))) });
  return { items, unreadCount: count };
}

export function getInboxNotification(database, userId, id) {
  return database.prepare(`SELECT ${publicFields} FROM notification_inbox n
    WHERE n.id = @id AND n.user_id = @me AND n.dismissed_at IS NULL AND ${accessWhere(database, userId)}`)
    .get({ id, me: userId }) || null;
}

export function markNotificationRead(database, userId, id, { dismiss = false } = {}) {
  const row = database.prepare('SELECT * FROM notification_inbox WHERE id = ? AND user_id = ? AND dismissed_at IS NULL').get(id, userId);
  if (!row || !canReceiveNotification(database, row)) return false;
  database.prepare(`UPDATE notification_inbox SET read_at = COALESCE(read_at, ?),
    dismissed_at = CASE WHEN ? THEN COALESCE(dismissed_at, ?) ELSE dismissed_at END WHERE id = ? AND user_id = ?`)
    .run(new Date().toISOString(), dismiss ? 1 : 0, new Date().toISOString(), id, userId);
  return true;
}

export function markAllNotificationsRead(database, userId) {
  database.prepare(`UPDATE notification_inbox AS n SET read_at = @now
    WHERE n.user_id = @me AND n.read_at IS NULL AND n.dismissed_at IS NULL AND ${accessWhere(database, userId)}`)
    .run({ me: userId, now: new Date().toISOString() });
}
