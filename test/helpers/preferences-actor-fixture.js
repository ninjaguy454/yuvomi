// Preference route fixtures bypass login, but canonical permission checks still
// resolve a real household account. Keep that persisted identity in step with
// each test's simulated request actor, including role changes between requests.
export function persistPreferenceActor(database, request) {
  const userId = Number(request.authUserId);
  if (!Number.isSafeInteger(userId) || userId <= 0) return;
  database.prepare(`
    INSERT INTO users (id, username, display_name, password_hash, role)
    VALUES (?, ?, ?, 'test', ?)
    ON CONFLICT(id) DO UPDATE SET role = excluded.role
  `).run(userId, `preferences-${userId}`, `Preference member ${userId}`,
    request.authRole === 'admin' ? 'admin' : 'member');
}
