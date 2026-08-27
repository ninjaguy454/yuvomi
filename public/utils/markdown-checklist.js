/**
 * Modul: Markdown-Checklisten
 * Zweck: Die eine Regel, was eine Checklisten-Zeile ist - und wie man genau
 *        eine davon umschaltet, ohne den Rest des Textes anzufassen.
 * Abhaengigkeiten: keine (isomorph: Browser und Server importieren dieselbe Datei)
 *
 * Warum das hier liegt und nicht zweimal woanders: der Renderer im Browser
 * entscheidet, welche Zeile ein Kaestchen bekommt, und die Route auf dem Server
 * entscheidet, welche Zeile ein Haken aendern darf. Waeren das zwei Regexe,
 * gaebe es eine Zeile, die als Kaestchen gezeichnet, aber nicht geschrieben
 * wird - oder umgekehrt. Es ist eine Regel, also eine Datei; das Muster ist
 * dasselbe wie bei pantry-units.js und contact-name.js.
 */

/**
 * Eine Checklisten-Zeile: bis zu drei Leerzeichen Einzug, ein Listenzeichen,
 * das Kaestchen, dann der Text. Die drei Gruppen sind so geschnitten, dass
 * sich der Zustand austauschen laesst, ohne den Rest der Zeile neu zu bauen.
 */
const CHECKLIST_RE = /^( {0,3}[-*+]\s+\[)([ xX])(\]\s+.*)$/;

/**
 * Zerlegt eine Zeile, wenn sie ein Checklisten-Eintrag ist.
 *
 * @param {string} line
 * @returns {{ checked: boolean, prefix: string, suffix: string, text: string }|null}
 */
export function matchChecklistLine(line) {
  const m = String(line ?? '').match(CHECKLIST_RE);
  if (!m) return null;
  return {
    checked: m[2].toLowerCase() === 'x',
    prefix:  m[1],
    suffix:  m[3],
    // Der reine Eintragstext, also alles hinter "] " - das ist, was der
    // Renderer durch inlineMarkdown() schickt.
    text: m[3].replace(/^\]\s+/, ''),
  };
}

/**
 * Zerlegt einen Text in Zeilen UND ihre Trenner.
 *
 * `split('\n')` waere einfacher, aber `join('\n')` schriebe danach jedes
 * `\r\n` der Notiz in ein `\n` um - eine Aenderung an jeder Zeile, die niemand
 * angefasst hat. Mit dem Trenner in der Capture-Gruppe steht er im Array, und
 * `parts.join('')` gibt den Ausgangstext zeichengetreu zurueck.
 *
 * Zeile i liegt auf `parts[i * 2]`; das entspricht genau der Zaehlung des
 * Renderers, der vorher auf `\n` normalisiert.
 *
 * @param {string} content
 * @returns {string[]} Wechselnd Zeile, Trenner, Zeile, ...
 */
export function splitKeepingLineEndings(content) {
  return String(content ?? '').split(/(\r\n|\n|\r)/);
}

/**
 * Setzt den Haken genau einer Zeile.
 *
 * `expect` ist die optimistische Sperre: der Aufrufer schickt die Zeile mit,
 * die er gesehen hat. Hat inzwischen jemand anders den Text bearbeitet, zeigt
 * `line` woanders hin - dann lieber ein Konflikt als ein Haken in der falschen
 * Zeile. Genau deshalb wird ueber den Index geschrieben und nicht ueber den
 * Text gesucht: zwei Eintraege "Milch" sind sonst nicht auseinanderzuhalten.
 *
 * @param {string} content Der vollstaendige Notiztext
 * @param {number} line Nullbasierter Zeilenindex aus dem Renderer
 * @param {boolean} checked Zielzustand
 * @param {string} [expect] Erwarteter Zeileninhalt (roh, ohne Trenner)
 * @returns {{ ok: true, content: string, changed: boolean }
 *          |{ ok: false, reason: 'out_of_range'|'not_a_checklist_line'|'stale' }}
 */
export function toggleChecklistLine(content, line, checked, expect) {
  if (!Number.isInteger(line) || line < 0) return { ok: false, reason: 'out_of_range' };

  const parts = splitKeepingLineEndings(content);
  const at    = line * 2;
  if (at >= parts.length) return { ok: false, reason: 'out_of_range' };

  const current = parts[at];
  if (expect !== undefined && expect !== null && current !== expect) {
    return { ok: false, reason: 'stale' };
  }

  const item = matchChecklistLine(current);
  if (!item) return { ok: false, reason: 'not_a_checklist_line' };

  // Schon im Zielzustand: kein Schreibvorgang, aber auch kein Fehler. Zwei
  // Leute, die dasselbe abhaken, sollen sich nicht gegenseitig eine Meldung
  // ausloesen - sie sind sich ja einig.
  if (item.checked === checked) return { ok: true, content: String(content ?? ''), changed: false };

  parts[at] = `${item.prefix}${checked ? 'x' : ' '}${item.suffix}`;
  return { ok: true, content: parts.join(''), changed: true };
}
