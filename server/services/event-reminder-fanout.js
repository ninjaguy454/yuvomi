/**
 * Modul: Erinnerungen an geteilten Terminen (#921)
 * Zweck: Die eine Stelle, die entscheidet, WER eine Erinnerung eines Termins
 *        bekommt - und wessen bestehende dabei unangetastet bleibt.
 * Abhaengigkeiten: keine (die Datenbank kommt als Argument)
 *
 * WARUM DAS HIER LIEGT UND NICHT ZWEIMAL IN DEN ROUTEN. Ausgeloest wird die
 * Verteilung an zwei Enden, die nichts voneinander wissen: beim Setzen einer
 * Erinnerung (routes/reminders.js) und beim Zuweisen einer Person zu einem
 * Termin (routes/calendar.js). Beide meinen dieselbe Regel. Waeren es zwei
 * Umsetzungen, ginge eine der beiden Richtungen frueher oder spaeter anders
 * aus, und das faellt niemandem auf - eine Erinnerung, die NICHT kommt, meldet
 * sich nicht.
 */

/**
 * Die Erinnerungen, die als Vorlage dienen: die des Termin-Erstellers.
 *
 * NUR DER ERSTELLER VERTEILT. Wer sonst sich eine Erinnerung an einem geteilten
 * Termin setzt, setzt sie fuer sich - sonst bekaeme der halbe Haushalt eine
 * Meldung, weil ein Einzelner sich einen Merker gelegt hat. Der gemeldete Fall
 * ist genau der andere: wer den Termin anlegt, zuweist und eine Erinnerung
 * setzt, meint sie fuer die, denen er ihn zuweist.
 */
function templateReminders(database, eventId, authorId) {
  // OHNE FILTER AUF `dismissed`. Verwerfen ist ein Zustellungsmerker, keine
  // Abbestellung: hat die Erstellerin ihre eigene Meldung weggeklickt, ist die
  // Erinnerung damit nicht abgeschafft, und den anderen ihre wegzunehmen waere
  // eine Folge, die niemand angeordnet hat.
  return database.prepare(`
    SELECT remind_at FROM reminders
    WHERE entity_type = 'event' AND entity_id = ? AND created_by = ?
      AND assigned_from IS NULL
    ORDER BY remind_at ASC
  `).all(eventId, authorId).map((r) => r.remind_at);
}

/** Wer diesen Termin zugewiesen bekommen hat - ohne die angegebene Person. */
function assigneesOf(database, eventId, exceptUserId) {
  return database.prepare(`
    SELECT user_id FROM event_assignments WHERE event_id = ? AND user_id != ?
  `).all(eventId, exceptUserId).map((r) => r.user_id);
}

/**
 * Legt die Erinnerungen des Erstellers fuer die genannten Personen an.
 *
 * WESSEN ZEILEN ANGEFASST WERDEN, IST DIE GANZE FRAGE. Ersetzt werden nur
 * Zeilen mit `assigned_from = <Ersteller>` - also die, die aus einer frueheren
 * Verteilung desselben Menschen stammen. Eine Erinnerung, die sich jemand
 * SELBST gesetzt hat (`assigned_from IS NULL`), bleibt stehen und unterbindet
 * die Verteilung an ihn ganz: er hat fuer diesen Termin bereits entschieden,
 * wann er erinnert werden will, und ein Speichern des Erstellers darf diese
 * Entscheidung nicht ueberschreiben.
 *
 * NEU GESCHRIEBEN WIRD NUR, WENN SICH DIE MENGE AENDERT - und daran haengt der
 * Umgang mit verworfenen Meldungen. Wer eine Erinnerung weggewischt hat, hat
 * sie gesehen; sie ihm erneut hinzulegen, nur weil die Erstellerin den Termin
 * noch einmal gespeichert hat, waere die zweite Meldung fuer dasselbe. Steht in
 * seiner geerbten Menge dagegen eine ANDERE Uhrzeit als in der Vorlage, ist das
 * neue Auskunft und er bekommt sie - auch wenn er die alte weggeklickt hatte.
 *
 * @returns {number} Anzahl der angelegten Zeilen (fuer Tests und Protokoll)
 */
export function fanOutEventReminders(database, eventId, authorId) {
  const remindAts = [...new Set(templateReminders(database, eventId, authorId))];
  const targets   = assigneesOf(database, eventId, authorId);
  if (!targets.length) return 0;

  const ownRow = database.prepare(`
    SELECT 1 FROM reminders
    WHERE entity_type = 'event' AND entity_id = ? AND created_by = ? AND assigned_from IS NULL
  `);
  const derivedOf = database.prepare(`
    SELECT id, remind_at, dismissed, pushed_at FROM reminders
    WHERE entity_type = 'event' AND entity_id = ? AND created_by = ? AND assigned_from = ?
    ORDER BY remind_at ASC, dismissed DESC, pushed_at DESC, id ASC
  `);
  const dropDerived = database.prepare(`
    DELETE FROM reminders
    WHERE entity_type = 'event' AND entity_id = ? AND created_by = ? AND assigned_from = ?
  `);
  const insert = database.prepare(`
    INSERT INTO reminders (entity_type, entity_id, remind_at, created_by, assigned_from)
    VALUES ('event', ?, ?, ?, ?)
  `);
  const dropById = database.prepare('DELETE FROM reminders WHERE id = ?');

  const wanted = new Set(remindAts);
  let written = 0;
  for (const userId of targets) {
    if (ownRow.get(eventId, userId)) {
      // A personal reminder is the assignee's complete override. Normally the
      // reminder routes remove the inherited rows before inserting it, but the
      // fan-out invariant must also heal mixed legacy/racing state instead of
      // leaving a stale inherited reminder beside the personal one.
      dropDerived.run(eventId, userId, authorId);
      continue;
    }
    // Keep one existing row for every unchanged timestamp. Besides avoiding
    // needless writes, this is what preserves delivery state (`dismissed`,
    // `pushed_at`, and the per-channel delivery columns) when the author adds or
    // removes a *different* reminder. Replacing the whole set would resurrect a
    // notification the assignee had already dismissed.
    const kept = new Set();
    for (const row of derivedOf.all(eventId, userId, authorId)) {
      if (!wanted.has(row.remind_at) || kept.has(row.remind_at)) {
        dropById.run(row.id);
      } else {
        kept.add(row.remind_at);
      }
    }
    for (const remindAt of remindAts) {
      if (kept.has(remindAt)) continue;
      insert.run(eventId, remindAt, userId, authorId);
      written++;
    }
  }
  return written;
}

/**
 * Nimmt einer Person die geerbten Erinnerungen eines Termins wieder ab.
 *
 * Zu rufen, wenn sie nicht mehr zugewiesen ist: eine Erinnerung an einen
 * Termin, mit dem man nichts mehr zu tun hat, ist keine Hilfe, sondern eine
 * Meldung ohne Anlass. Selbst gesetzte Erinnerungen bleiben - wer sich eine
 * eigene gestellt hat, hat einen eigenen Grund, und den kennt der Termin nicht.
 *
 * @returns {number} Anzahl der entfernten Zeilen
 */
export function dropInheritedEventReminders(database, eventId, userIds) {
  if (!userIds?.length) return 0;
  const stmt = database.prepare(`
    DELETE FROM reminders
    WHERE entity_type = 'event' AND entity_id = ? AND created_by = ? AND assigned_from IS NOT NULL
  `);
  let removed = 0;
  for (const userId of userIds) removed += stmt.run(eventId, userId).changes;
  return removed;
}

/** Remove every reminder row owned by an Event before/with deleting that Event. */
export function dropEventReminders(database, eventIds) {
  const ids = [...new Set((Array.isArray(eventIds) ? eventIds : [eventIds])
    .map(Number)
    .filter((id) => Number.isInteger(id) && id > 0))];
  if (!ids.length) return 0;
  // Some provider service adapters intentionally expose only the subset of the
  // schema they need (for example discovery/unit-test databases). Production
  // always has `reminders`, but cleanup must remain a harmless no-op for those
  // reduced handles rather than preventing the Event cleanup itself.
  if (!database.prepare(
    "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'reminders'"
  ).get()) return 0;
  const placeholders = ids.map(() => '?').join(',');
  return database.prepare(`
    DELETE FROM reminders
     WHERE entity_type = 'event' AND entity_id IN (${placeholders})
  `).run(...ids).changes;
}

/**
 * Wer diesen Termin angelegt hat - null, wenn es ihn nicht (mehr) gibt.
 *
 * Steht hier statt in den Routen, weil beide Aufrufer dieselbe Frage stellen
 * und die Antwort entscheidet, ob ueberhaupt verteilt wird.
 */
export function eventAuthorId(database, eventId) {
  return database.prepare('SELECT created_by FROM calendar_events WHERE id = ?')
    .get(eventId)?.created_by ?? null;
}
