import { taskStartMs } from './task-window.js';
import { householdTimeZone } from '../utils/timezone.js';
import { actionableSubtasks } from '../../public/utils/task-progress.js';

/**
 * Modul: Aufgaben-Auswahl (geteilte Abfrage-Logik)
 * Zweck: Welche Aufgaben überhaupt in eine Liste gehören - zentral, damit
 *        Aufgaben-Route und Dashboard exakt dieselbe Auswahl treffen.
 * Abhängigkeiten: keine
 *
 * WARUM ALS SERVICE: `GET /api/v1/tasks` und `GET /api/v1/dashboard` beantworten
 * dieselbe Frage („welche Aufgaben stehen an?") und hatten dafür zwei Kopien der
 * Regeln, die auseinandergelaufen sind. Das Modul schloss Unteraufgaben und noch
 * nicht begonnene Aufgaben aus, das Dashboard nicht - eine Unteraufgabe stand
 * dort als kontextlose eigene Zeile, und eine Aufgabe mit Startdatum nächste
 * Woche stand heute schon da (Discussion #825). Dieselbe Sorte Divergenz hat
 * schon #467 (Modulrechte) und #769 (Sichtbarkeit beim Ablegen) verursacht.
 * Vorbild ist `calendar-events.js`, das Kalender-Route und Dashboard seit jeher
 * teilen.
 *
 * WAS HIER NICHT HINEINGEHÖRT: die Filter, die nur eine Seite kennt - Status,
 * Priorität, Person, Tags und die Archiv-Achse (#688) mit ihrer Verschränkung
 * von `?archived` und `?status=archived`. Das sind Wünsche des Betrachters an
 * eine Liste, keine Aussage darüber, was eine Liste überhaupt enthalten darf.
 *
 * DIE KATEGORIE HAT DIESE GRENZE MIT #814 GEWECHSELT, und zwar aus genau dem
 * Grund, der oben steht: seit die Übersicht ihre Kategorien einschränken kann,
 * ist sie ein Wunsch, den BEIDE Seiten kennen - und damit eine Regel, die zwei
 * Fassungen haben könnte. Sie steht deshalb hier, als Fragment wie das Scope
 * darüber, statt ein zweites Mal in der Dashboard-Route.
 *
 * Guards: test/test-task-scope.js
 */

/**
 * WHERE-Fragment für die Grundauswahl einer Aufgabenliste.
 *
 * Gebaut wie `visibilityWhere()`: ein Fragment ohne führendes AND, mit
 * konfigurierbarem Platzhalter. WER `includeFuture` NICHT SETZT, MUSS DEN
 * TAGESSCHLÜSSEL BINDEN - bei `bind: '?'` an genau der Stelle, an der das
 * Fragment in die Anweisung eingesetzt wird.
 *
 * Der Tag kommt bewusst als Parameter und nicht als `date('now')` aus SQLite:
 * das wäre der UTC-Tag, während `start_date` ein lokal eingegebener Kalendertag
 * ist. Westlich von UTC hätte eine Aufgabe damit am Abend vor ihrem Startdatum
 * schon angefangen, östlich davon am Morgen danach noch nicht. Die CI läuft in
 * UTC, wo beide Tage gleich sind - genau deshalb fällt so etwas dort nie auf
 * (CLAUDE.md führt diese Falle, `dashboard.js` erklärt sie an `todayLocalKey`).
 *
 * @param {string} alias  Tabellen-Alias der Aufgaben (z. B. 't')
 * @param {object} [opts]
 * @param {boolean} [opts.includeFuture]   true = auch Aufgaben, die erst später
 *                                         beginnen (kein Bind nötig)
 * @param {boolean} [opts.includeSubtasks] true = auch Unteraufgaben als eigene Zeilen
 * @param {string}  [opts.bind]            Platzhalter des lokalen Tagesschlüssels:
 *                                         '?' (positional) oder benannt wie '@today'
 * @returns {string} SQL-Fragment (ohne führendes AND), nie leer
 */
// This legacy fragment supplies structural scope and an optional coarse day
// boundary. Operational board callers opt out of that day check and apply
// taskStartProjection, including household-local times and source ancestry.
export function taskScopeWhere(alias, { includeFuture = false, includeSubtasks = false, includeSupervision = false, bind = '?' } = {}) {
  const parts = [];

  // Eine Unteraufgabe ist ein Punkt ihrer Elternaufgabe, kein eigener
  // Listeneintrag: allein gezeigt fehlt ihr der Satz, zu dem sie gehört.
  if (!includeSubtasks) parts.push(includeSupervision
    ? `(${alias}.parent_task_id IS NULL OR EXISTS (SELECT 1 FROM task_activity_support_tasks tsupport WHERE tsupport.task_id=${alias}.id))`
    : `${alias}.parent_task_id IS NULL`);

  // `start_date` ist Yuvomis „ab wann taucht das auf" - eine Aufgabe ohne
  // Startdatum gilt als sofort begonnen.
  if (!includeFuture) parts.push(`(${alias}.start_date IS NULL OR ${alias}.start_date <= ${bind})`);

  // Beide Schalter zugleich gesetzt: das Fragment ist dann bedingungslos wahr.
  // Ein leerer String würde beim Aufrufer zu `AND ` und damit zu einem
  // Syntaxfehler - `1=1` hält die Verkettung an jeder Aufrufstelle gültig.
  return parts.length ? parts.join(' AND ') : '1=1';
}

/**
 * Braucht diese Konfiguration einen gebundenen Tagesschlüssel?
 * Für Aufrufer mit positionalen Platzhaltern, die ihre Parameterliste selbst
 * führen und sonst raten müssten, ob sie einen Wert nachschieben.
 *
 * @param {object} [opts] dieselben Optionen wie `taskScopeWhere`
 * @returns {boolean}
 */
export function taskScopeNeedsToday({ includeFuture = false } = {}) {
  return !includeFuture;
}

/** A read-only, request-local scheduling projection. The graph includes the
 * structural ancestors and canonical learner sources of generated helper work.
 * Resolve wall times once per distinct window using the lifecycle's DST policy;
 * lexical wall-clock comparisons would hide work again during a DST overlap.
 * Callers still enforce privacy independently, before returning rows/metadata. */
export function taskStartProjection(d, { now = new Date(), tasks = null } = {}) {
  const serverNow = Number(now), timeZone = householdTimeZone(d);
  const tables = new Set(d.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('task_activity_support_tasks','task_supervision_actions')").all().map(row=>row.name));
  const columns = new Set(d.prepare('PRAGMA table_info(tasks)').all().map(row=>row.name));
  const links = ['SELECT id AS child_id,parent_task_id AS parent_id FROM tasks WHERE parent_task_id IS NOT NULL'];
  if (tables.has('task_activity_support_tasks')) links.push('SELECT task_id,source_task_id FROM task_activity_support_tasks');
  if (tables.has('task_supervision_actions')) links.push('SELECT action_task_id,source_task_id FROM task_supervision_actions',
    'SELECT counterpart_task_id,source_task_id FROM task_supervision_actions WHERE counterpart_task_id IS NOT NULL',
    'SELECT counterpart_task_id,action_task_id FROM task_supervision_actions WHERE counterpart_task_id IS NOT NULL');
  const seeds = tasks == null ? 'SELECT id FROM tasks' : 'SELECT CAST(value AS INTEGER) FROM json_each(?)';
  const graph = d.prepare(`WITH RECURSIVE edges(child_id,parent_id) AS (${links.join(' UNION ')}),
    descendants(id) AS (${seeds} UNION SELECT t.id FROM tasks t JOIN descendants s ON t.parent_task_id=s.id),
    scope(id) AS (SELECT id FROM descendants UNION SELECT e.parent_id FROM edges e JOIN scope s ON e.child_id=s.id)
    SELECT t.id,t.start_date,${columns.has('start_time') ? 't.start_time' : 'NULL AS start_time'},
      (SELECT json_group_array(parent_id) FROM edges WHERE child_id=t.id) AS parents
    FROM tasks t JOIN scope s ON t.id=s.id`).all(...(tasks == null ? [] : [JSON.stringify(tasks.map(row=>Number(row.id ?? row)))]));
  const nodes = new Map(graph.map(row=>[row.id,{...row,parents:JSON.parse(row.parents)}])), instants = new Map(), effective = new Map();
  function start(id, seen = new Set()) {
    id = Number(id);
    if (effective.has(id)) return effective.get(id);
    const row = nodes.get(id);
    if (!row || seen.has(id)) return null;
    const visiting = new Set(seen); visiting.add(id);
    const key = `${row.start_date || ''}T${row.start_time || ''}`;
    if (!instants.has(key)) instants.set(key,taskStartMs(d,row,timeZone));
    let value = instants.get(key);
    for (const parent of row.parents) {
      const inherited = start(parent,visiting);
      if (inherited != null) value = value == null ? inherited : Math.max(value,inherited);
    }
    effective.set(id,value); return value;
  }
  const visible = row => (start(row?.id ?? row) ?? -Infinity) <= serverNow;
  function metadata(rows, { includeFuture = false } = {}) {
    let next = null;
    const visit = row => {
      if (row.archived_at) return;
      const at = start(row.id);
      if (at > serverNow) next = next == null ? at : Math.min(next,at);
      for (const child of row.subtasks || []) visit(child);
    };
    if (!includeFuture) for (const row of rows) visit(row);
    return {server_now:serverNow,next_start_at:next};
  }
  function project(row) {
    if (!visible(row)) return null;
    const children = row.subtasks || [], hidden = children.filter(child=>!visible(child));
    const actionable = actionableSubtasks({...row,subtasks:hidden});
    const required = actionable.filter(child=>!child.is_optional);
    const optional = actionable.filter(child=>child.is_optional);
    return {...row,subtasks:children.filter(visible).map(project),
      scheduled_action_count:hidden.length,
      scheduled_completed_action_count:hidden.filter(child=>child.status==='done').length,
      scheduled_subtask_total:required.length,scheduled_subtask_done:required.filter(child=>child.status==='done').length,
      scheduled_subtask_points:required.reduce((sum,child)=>sum+(Number(child.points)||0),0),
      scheduled_subtask_earned_points:required.filter(child=>child.status==='done').reduce((sum,child)=>sum+(Number(child.points)||0),0),
      scheduled_optional_subtask_total:optional.length,scheduled_optional_subtask_done:optional.filter(child=>child.status==='done').length};
  }
  // Internal IDs only. Useful where SQL aggregates/limits must use precisely
  // the same projection before counting, without registering global SQL state.
  function where(alias = 't') {
    const hidden = graph.filter(row=>!visible(row)).map(row=>row.id);
    return hidden.length ? `${alias}.id NOT IN (SELECT CAST(value AS INTEGER) FROM json_each('${JSON.stringify(hidden)}'))` : '1=1';
  }
  return {visible,project,metadata,where,start};
}

/**
 * WHERE-Fragment für eine Einschränkung auf bestimmte Kategorien.
 *
 * Mehrere Werte verbinden sich ODER, aus demselben Grund wie bei Status und
 * Priorität (#671): eine Aufgabe trägt genau EINE Kategorie, ein UND über zwei
 * Werte wäre garantiert leer. Zwischen den Achsen bleibt es UND.
 *
 * Leere Liste = keine Einschränkung, und das ist die wichtigere Hälfte: ein
 * Filter, der ohne Auswahl alles wegschneidet, macht aus „ich habe nichts
 * gewählt" ein leeres Dashboard.
 *
 * BENANNTE ODER POSITIONALE PLATZHALTER, nicht beides gemischt: die Aufrufer
 * sind sich darin uneinig, und node:sqlite lässt eine Mischung in einer
 * Anweisung nicht zu. Die Aufgabenroute zählt ihre Parameter selbst durch, die
 * Übersicht bindet @today und @me namentlich - mit `named` bekommt sie
 * `@cat0, @cat1, …` und dazu das passende Objekt aus `categoryBindings()`.
 *
 * @param {string} alias        Tabellen-Alias der Aufgaben
 * @param {string[]} categories Kategorie-Schlüssel (normalisiert)
 * @param {object} [opts]
 * @param {string} [opts.named] Präfix für benannte Platzhalter, z. B. 'cat'
 * @returns {string|null} Fragment ohne führendes AND, oder null wenn nichts einzuschränken ist
 */
export function taskCategoryWhere(alias, categories, { named = null } = {}) {
  if (!Array.isArray(categories) || categories.length === 0) return null;
  const holes = categories.map((_, i) => (named ? `@${named}${i}` : '?'));
  return `${alias}.category IN (${holes.join(', ')})`;
}

/**
 * Die benannten Werte zum Fragment oben - dieselbe Reihenfolge, dieselben Namen.
 *
 * @param {string[]} categories
 * @param {string} [named]
 * @returns {Record<string, string>}
 */
export function categoryBindings(categories, named = 'cat') {
  return Object.fromEntries(categories.map((value, i) => [`${named}${i}`, value]));
}

/**
 * Kategorie-Parameter einer Anfrage auf eine saubere Liste bringen.
 *
 * Express liefert `?category=a` als String und `?category=a&category=b` als
 * Array - wer den Rohwert bindet, schiebt im zweiten Fall ein Array in einen
 * Platzhalter, und die Anweisung kommt gar nicht erst durch. Doppelte fliegen
 * raus, damit die Platzhalterzahl der Wertezahl entspricht, und die Obergrenze
 * verhindert, dass eine Anfrage mit tausend Werten eine Anweisung baut, die
 * SQLite nicht mehr vorbereitet.
 *
 * @param {unknown} raw   req.query.<name>
 * @param {number} [max]  Obergrenze (default 50)
 * @returns {string[]}
 */
export function normalizeCategoryFilter(raw, max = 50) {
  if (raw === undefined || raw === null) return [];
  const list = [raw].flat().filter((v) => typeof v === 'string' && v !== '');
  return [...new Set(list)].slice(0, max);
}
