/**
 * Shared Place invariants.
 *
 * A household always needs one active Home Place so presence policies and
 * meal/location pickers have a stable, address-optional home destination.
 * The migration backfills existing databases; this helper keeps the invariant
 * true after an administrator archives, retypes, or removes the last Home.
 */

export function ensureDefaultHomePlace(database) {
  const existing = database.prepare(`
    SELECT * FROM places
     WHERE active = 1 AND type = 'home'
     ORDER BY CASE WHEN parent_place_id IS NULL THEN 0 ELSE 1 END, id
     LIMIT 1
  `).get();
  if (existing) return existing;

  const result = database.prepare(`
    INSERT INTO places (name, type, active)
    VALUES ('Home', 'home', 1)
  `).run();
  return database.prepare('SELECT * FROM places WHERE id = ?').get(result.lastInsertRowid);
}
