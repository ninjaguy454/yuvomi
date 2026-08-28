/**
 * Modul: Dokumentordner der Module (geteilte Auflösung)
 * Zweck: Den Ordner finden, in dem ein Modul seine Belege ablegt - über einen
 *        stabilen Schlüssel statt über seinen übersetzten Anzeigenamen.
 * Abhängigkeiten: keine
 *
 * WARUM ALS SERVICE: Sechs Module legen Belege in einem eigenen Ordner ab
 * (Budget, Aufgaben, Gemeinsame Ausgaben, Inventar, Haushaltshilfe,
 * Kalender-Anhänge). Bis Migration v157 war die IDENTITÄT dieses Ordners sein
 * Anzeigename, und den schickte der Client in seiner Sprache mit. Zwei
 * Personen mit verschiedener Spracheinstellung im selben Haushalt legten damit
 * zwei Ordner an, jeder mit der Hälfte der Belege; und jede Korrektur an einer
 * Übersetzung spaltete den Ordner erneut - v146 musste genau das einmal
 * aufräumen.
 *
 * Der Schlüssel trägt die Identität, der Name ist reine Anzeige und darf sich
 * frei ändern. Die Auflösung stand außerdem in zwei Kopien (Dokumenten-Route
 * und Kalender-Helfer), die schon leicht auseinanderliefen.
 *
 * Guards: test/test-document-folders.js
 */

/**
 * Die Schlüssel, die ein Client anfordern darf. Bewusst eine geschlossene
 * Liste: ein freier Schlüssel wäre wieder ein vom Client bestimmter
 * Identitätsbegriff, nur mit weniger Buchstaben. Die Namen daneben sind die
 * i18n-Schlüssel, unter denen die Oberfläche den Ordner beschriftet.
 */
export const MODULE_FOLDER_KEYS = Object.freeze([
  'budget',
  'tasks',
  'splitExpenses',
  'inventory',
  'housekeeping',
  'calendarItems',
]);

export function isModuleFolderKey(value) {
  return typeof value === 'string' && MODULE_FOLDER_KEYS.includes(value);
}

/**
 * Liefert die id des Ordners für `key`, legt ihn bei Bedarf mit `name` an.
 *
 * Ohne `key` verhält sich die Funktion wie früher und sucht über den Namen -
 * das ist der Weg für Ordner, die eine Person selbst angelegt hat.
 *
 * @param {object} database  - offene better-sqlite3-Verbindung
 * @param {{key?: string, name?: string}} folder
 * @param {number} actorId   - wer den Ordner anlegt, falls er entsteht
 * @returns {number|null}
 */
export function ensureModuleFolder(database, { key = null, name = '' } = {}, actorId) {
  const folderName = typeof name === 'string' ? name.trim() : '';
  const moduleKey = isModuleFolderKey(key) ? key : null;

  if (!moduleKey) {
    if (!folderName) return null;
    return findOrCreateByName(database, folderName, actorId);
  }

  const byKey = database
    .prepare('SELECT id FROM family_document_folders WHERE module_key = ?')
    .get(moduleKey);
  if (byKey) return byKey.id;

  // Der Schlüssel ist noch frei. Trägt bereits ein Ordner den Namen, den das
  // Modul vorschlägt, wird DIESER beansprucht statt ein zweiter angelegt: er
  // ist entweder der Ordner aus der Zeit vor v157 oder einer, den jemand von
  // Hand unter demselben Namen angelegt hat. In beiden Fällen ist er gemeint.
  // (`name` trägt ein UNIQUE seit Migration 60 - ohne diesen Zweig liefe das
  // Anlegen in eine Constraint-Verletzung statt in den richtigen Ordner.)
  if (folderName) {
    const byName = database
      // Auf der Wurzelebene, aus demselben Grund wie in findOrCreateByName:
      // seit dem Baum (v164) traegt ein Name allein keine Identitaet mehr.
      // Ein Modulordner, der vor v157 ueber seinen Namen gefunden wurde, ist
      // ohnehin ein Wurzelordner.
      .prepare('SELECT id, module_key FROM family_document_folders WHERE name = ? COLLATE NOCASE AND parent_id IS NULL')
      .get(folderName);
    if (byName) {
      // Gehört er schon einem anderen Modul, bleibt er unangetastet: einen
      // fremden Schlüssel zu überschreiben verlöre den Ordner des anderen
      // Moduls. Dann lieber denselben Ordner mitbenutzen, wie bisher auch.
      if (!byName.module_key) {
        database.prepare('UPDATE family_document_folders SET module_key = ? WHERE id = ?')
          .run(moduleKey, byName.id);
      }
      return byName.id;
    }
  }

  const result = database
    .prepare('INSERT INTO family_document_folders (name, module_key, created_by) VALUES (?, ?, ?)')
    .run(folderName || moduleKey, moduleKey, actorId);
  return result.lastInsertRowid;
}

/**
 * Ordner mit diesem Namen auf der WURZELEBENE, sonst angelegt.
 *
 * `parent_id IS NULL` ist seit dem Baum (Migration v164) Pflicht und nicht
 * Geschmack: ein Name ist nur noch unter seinen Geschwistern eindeutig. Ohne
 * die Einschraenkung faende diese Abfrage ein "Rechnungen" irgendwo tief im
 * Baum - welches, entschiede die Zeilenreihenfolge -, und ein Beleg landete
 * je nach Datenbankzustand woanders.
 *
 * Auf der Wurzel und nicht anderswo, weil hier keine Angabe ueber einen
 * Elternteil vorliegt: der Aufrufer schickt einen blossen Namen. Alle Ordner
 * aus der Zeit vor v164 sind Wurzelordner, der bisherige Weg bleibt damit
 * genau derselbe.
 */
function findOrCreateByName(database, folderName, actorId) {
  const existing = database
    .prepare('SELECT id FROM family_document_folders WHERE name = ? COLLATE NOCASE AND parent_id IS NULL')
    .get(folderName);
  if (existing) return existing.id;
  const result = database
    .prepare('INSERT INTO family_document_folders (name, created_by) VALUES (?, ?)')
    .run(folderName, actorId);
  return result.lastInsertRowid;
}
