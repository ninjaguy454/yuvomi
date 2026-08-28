/**
 * Modul: Ordnerbaum - die Regeln, die Browser und Server teilen (#785)
 * Zweck: Aus einer flachen Ordnerliste den Baum lesen: was liegt unter einem
 *        Ordner, wo liegt er selbst, und darf er dorthin.
 * Abhängigkeiten: keine
 *
 * WARUM DIESE DATEI UNTER public/ LIEGT UND DER SERVER SIE IMPORTIERT. Dasselbe
 * Muster wie `quick-link-url.js`: dort prüft das Formular die Adresse mit
 * derselben Funktion wie die Route, und die Begründung gilt hier wörtlich.
 *
 * Die Seitenleiste beantwortet "was liegt in diesem Ordner" für ihre Zähler,
 * die Route beantwortet dieselbe Frage für ihre Abfrage. Zwei Formulierungen
 * derselben Regel laufen genau dann auseinander, wenn eine sich ändert - und
 * das Ergebnis wäre die unangenehmste Sorte Fehler: eine Zahl in der Leiste,
 * die nicht zur Liste daneben passt, ohne dass eine von beiden falsch aussieht.
 *
 * ALLE FUNKTIONEN NEHMEN DIE ORDNERLISTE ALS ARGUMENT und lesen nichts selbst.
 * Der Server holt sie mit einem `SELECT` (ein paar Dutzend Zeilen, gedeckelt
 * durch die Tiefengrenze), der Browser hat sie ohnehin im Zustand.
 *
 * Guards: test/test-folder-tree.js
 */

/**
 * So tief darf der Baum werden.
 *
 * NICHT AUS VORSICHT, SONDERN AUS DER OBERFLAECHE HERAUS. Jede Ebene rückt die
 * Zeilen in der Seitenleiste ein; sie ist auf dem Telefon rund 280px breit, und
 * ab der sechsten Einrückung bleibt für den Namen weniger Platz als für den
 * Rand davor. Eine Ablage, die tiefer will, will in Wahrheit andere Namen.
 */
export const MAX_FOLDER_DEPTH = 5;

/**
 * Ein Schutz gegen Ringe, die es nicht geben dürfte.
 *
 * `folderMoveError()` schliesst Zyklen aus, und die Datenbank kennt keinen
 * zweiten Schreibweg. Trotzdem hat jede Schleife hier eine Abbruchgrenze: liefe
 * je ein Ring ein - durch einen Fehler dort, durch einen Schreibzugriff an der
 * API vorbei, durch eine Antwort aus einer älteren Version -, wäre die Folge
 * ein stehender Server oder ein eingefrorener Browser statt einer falschen
 * Zeile. Ein Fehler in den Daten darf kein Fehler im Ablauf werden.
 */
const MAX_HOPS = 64;

/** @typedef {{id: number, name?: string, parent_id?: number|null}} Folder */

/**
 * Kinder je Elternteil - die eine Vorbereitung, auf der alles andere steht.
 * @param {Folder[]} folders
 * @returns {Map<number, Folder[]>}
 */
function childrenByParent(folders) {
  const map = new Map();
  for (const folder of folders) {
    if (folder.parent_id == null) continue;
    if (!map.has(folder.parent_id)) map.set(folder.parent_id, []);
    map.get(folder.parent_id).push(folder);
  }
  return map;
}

/**
 * Dieser Ordner und alles darunter.
 *
 * DAS IST DIE ANTWORT AUF "WAS LIEGT IN DIESEM ORDNER". In einer flachen Ablage
 * waren Ordner und Filter dasselbe: ein Ordner zeigte genau die Dokumente mit
 * seiner id. In einem Baum ist das die falsche Antwort - wer "Wohnung" öffnet
 * und darunter "Wohnung/Miete" mit zwölf Dokumenten hat, bekäme eine leere
 * Ansicht und müsste raten, wo die Dokumente sind.
 *
 * @param {Folder[]} folders
 * @param {number} folderId
 * @returns {Set<number>} immer mindestens `{folderId}`, auch wenn es ihn nicht gibt
 */
export function subtreeIds(folders, folderId) {
  const children = childrenByParent(folders);
  const seen = new Set([folderId]);
  const queue = [folderId];
  while (queue.length) {
    for (const child of children.get(queue.shift()) ?? []) {
      if (seen.has(child.id)) continue;
      seen.add(child.id);
      queue.push(child.id);
    }
  }
  return seen;
}

/**
 * Die Kette von der Wurzel bis zu diesem Ordner, Wurzel zuerst.
 * @param {Folder[]} folders
 * @param {number} folderId
 * @returns {Folder[]} leer, wenn es den Ordner nicht gibt
 */
export function folderPath(folders, folderId) {
  const byId = new Map(folders.map((f) => [f.id, f]));
  const chain = [];
  let current = folderId;
  for (let hops = 0; byId.has(current) && hops < MAX_HOPS; hops += 1) {
    const folder = byId.get(current);
    chain.unshift(folder);
    current = folder.parent_id;
  }
  return chain;
}

/**
 * Wie viele Ebenen der Teilbaum unter (und mit) diesem Ordner hoch ist.
 *
 * GEZAEHLT WIRD DER GANZE TEILBAUM, nicht nur der Ordner selbst: wer einen
 * dreistufigen Zweig zwei Ebenen tief einhängt, hat fünf - die Grenze muss das
 * mitzählen, sonst hält sie nur beim Verschieben einzelner Blätter.
 *
 * @param {Folder[]} folders
 * @param {number} folderId
 * @returns {number} mindestens 1
 */
export function subtreeHeight(folders, folderId) {
  const children = childrenByParent(folders);
  let height = 0;
  let level = [folderId];
  const seen = new Set(level);
  while (level.length && height < MAX_HOPS) {
    height += 1;
    const next = [];
    for (const id of level) {
      for (const child of children.get(id) ?? []) {
        if (seen.has(child.id)) continue;
        seen.add(child.id);
        next.push(child.id);
      }
    }
    level = next;
  }
  return Math.max(height, 1);
}

/**
 * Darf `folderId` unter `parentId` hängen?
 *
 * Die erste Absage ist die, die ohne Prüfung eine Tabelle zerlegt: einen Ordner
 * in seinen eigenen Nachfahren zu schieben schneidet den ganzen Teilbaum vom
 * Rest ab. Er wäre in keiner Ansicht mehr erreichbar, aber weiter da - ein Ring
 * aus Zeilen, den nur ein Datenbankwerkzeug wieder aufmacht.
 *
 * GIBT EINEN GRUND ZURUECK UND KEINEN WAHRHEITSWERT: der Server macht daraus
 * eine Meldung, die Oberfläche eine Auswahl, die den Fall gar nicht erst
 * anbietet. Beide brauchen zu wissen, WARUM.
 *
 * @param {Folder[]} folders
 * @param {number|null} folderId  null = ein neuer Ordner, der noch nirgends hängt
 * @param {number|null} parentId  null = Wurzelebene, immer erlaubt
 * @returns {'self'|'descendant'|'missing-parent'|'too-deep'|null}
 */
export function folderMoveIssue(folders, folderId, parentId) {
  if (parentId == null) return null;
  if (folderId != null && parentId === folderId) return 'self';
  if (!folders.some((f) => f.id === parentId)) return 'missing-parent';

  if (folderId != null && folderPath(folders, parentId).some((f) => f.id === folderId)) {
    return 'descendant';
  }

  const parentDepth = folderPath(folders, parentId).length;
  const height = folderId == null ? 1 : subtreeHeight(folders, folderId);
  if (parentDepth + height > MAX_FOLDER_DEPTH) return 'too-deep';
  return null;
}

/**
 * Die Ordner als Baum, Geschwister in der Reihenfolge der Eingabeliste.
 *
 * EIN ORDNER, DESSEN ELTERNTEIL FEHLT, WIRD ZUR WURZEL statt zu verschwinden.
 * Das kann eine Antwort sein, die zwischen zwei Ladevorgängen entstanden ist,
 * oder eine Zeile, die an der API vorbei geschrieben wurde - in beiden Fällen
 * ist ein sichtbarer Ordner an der falschen Stelle besser als ein unsichtbarer
 * an der richtigen.
 *
 * @param {Folder[]} folders
 * @returns {Array<{folder: Folder, children: Array}>}
 */
export function buildFolderTree(folders) {
  const byId = new Map(folders.map((f) => [f.id, { folder: f, children: [] }]));
  const roots = [];
  for (const node of byId.values()) {
    const parent = node.folder.parent_id != null ? byId.get(node.folder.parent_id) : null;
    if (parent && parent !== node) parent.children.push(node);
    else roots.push(node);
  }
  return roots;
}

/**
 * Der Baum als flache Liste in Anzeigereihenfolge, mit Tiefe je Zeile.
 *
 * @param {Folder[]} folders
 * @param {{expanded?: Set<number>|null}} [opts]  `null` = alles aufgeklappt
 * @returns {Array<{folder: Folder, children: Array, depth: number}>}
 */
export function flattenFolderTree(folders, { expanded = null } = {}) {
  const rows = [];
  const walk = (nodes, depth) => {
    if (depth > MAX_HOPS) return;
    for (const node of nodes) {
      rows.push({ ...node, depth });
      if (expanded === null || expanded.has(node.folder.id)) walk(node.children, depth + 1);
    }
  };
  walk(buildFolderTree(folders), 0);
  return rows;
}
