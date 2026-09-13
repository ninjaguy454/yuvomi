/**
 * Modul: Zugriffsrechte (Client-Store)
 * Zweck: Hält die vom Server aufgelösten Modul-/Widget-Rechte des angemeldeten
 *        Nutzers (aus /auth/me bzw. /auth/login) und stellt Helfer bereit, mit
 *        denen Router-Nav, Routen-Guard und Dashboard gesperrte Elemente
 *        ausblenden. Die VERBINDLICHE Durchsetzung bleibt serverseitig — dies ist
 *        reine UX (nichts anzeigen, was ohnehin 403 liefern würde). Siehe #467.
 *
 * Legacy module/widget maps remain sparse. Operational capabilities and Task
 * actions require an explicit resolved allow from the server.
 */

// Navigations-/Widget-Modul → Permissions-Modulschlüssel. Muss zu
// server/permissions.js (PERMISSION_MODULES.navIds) passen. Nicht gelistete
// Nav-Module (settings, third-party) sind nie gesperrt.
const NAV_TO_MODULE = Object.freeze({
  dashboard: 'dashboard',
  calendar: 'calendar',
  schedule: 'schedule',
  birthdays: 'calendar',
  tasks: 'tasks',
  notes: 'notes',
  contacts: 'contacts',
  meals: 'meals',
  recipes: 'meals',
  shopping: 'shopping',
  pantry: 'pantry',
  budget: 'budget',
  inventory: 'inventory',
  documents: 'documents',
  housekeeping: 'housekeeping',
  rewards: 'rewards',
  health: 'health',
});

let _perms = { admin: false, modules: {}, widgets: {}, capabilities: {} };

/** Übernimmt die Rechte-Payload aus einer Auth-Antwort (/me, /login). */
export function setPermissions(payload) {
  if (payload && typeof payload === 'object') {
    _perms = {
      admin: payload.admin === true,
      modules: payload.modules && typeof payload.modules === 'object' ? payload.modules : {},
      widgets: payload.widgets && typeof payload.widgets === 'object' ? payload.widgets : {},
      capabilities: payload.capabilities && typeof payload.capabilities === 'object' ? payload.capabilities : {},
    };
  }
}

/** Setzt den Store zurück (Logout). */
export function clearPermissions() {
  _perms = { admin: false, modules: {}, widgets: {}, capabilities: {} };
}

export function getPermissions() {
  return _perms;
}

export function isPermAdmin() {
  return _perms.admin === true;
}

/** Effektiver Zugriff auf ein Permissions-Modul: 'none' | 'read' | 'write'. */
export function moduleAccess(moduleKey) {
  if (_perms.admin) return 'write';
  return _perms.modules?.[moduleKey] ?? 'write';
}

/** Darf ein Navigations-Modul (nav id) überhaupt geöffnet werden? */
export function canAccessNavModule(navModule) {
  if (_perms.admin) return true;
  const key = NAV_TO_MODULE[navModule];
  if (!key) return true; // nicht gated
  return (_perms.modules?.[key] ?? 'write') !== 'none';
}

/** Effektiver Zugriff für ein Navigations-Modul (write, wenn nicht gated). */
export function navModuleAccess(navModule) {
  const key = NAV_TO_MODULE[navModule];
  if (!key) return 'write';
  return moduleAccess(key);
}

/** Ist ein Nav-Modul nur lesend? (steuert z. B. FAB/Anlege-Aktionen) */
export function isNavModuleReadOnly(navModule) {
  return navModuleAccess(navModule) === 'read';
}

/** Darf ein Dashboard-Widget angezeigt werden? */
export function canSeeWidget(widgetId) {
  if (_perms.admin) return true;
  return (_perms.widgets?.[widgetId] ?? 'allow') !== 'none';
}

/** Server-supplied capabilities; sensitive or unknown capabilities fail closed. */
export function canCapability(key) {
  if (_perms.admin) return true;
  if (_perms.capabilities[key] != null) return _perms.capabilities[key] === 'allow';
  return false;
}
export function canTask(task, action) { return task?.permissions?.[action] === true; }
