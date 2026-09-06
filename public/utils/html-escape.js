/**
 * Modul: HTML-Escaping (isomorph)
 * Zweck: Die eine Stelle, die aus einem beliebigen Wert sicheren HTML-Text macht.
 * Abhaengigkeiten: keine
 *
 * EIGENES MODUL, WEIL DER SERVER ES MITBENUTZT. `esc()` sass in
 * `utils/html.js` und wird von dort weiterhin re-exportiert - kein Aufrufer im
 * Frontend aendert sich. Aber jene Datei traegt auch `renderMarkdownLight()`
 * mit den CSS-Klassennamen des Notiz-Renderers; sie ist Frontend-Code, der
 * zufaellig ohne DOM auskommt, und kein geteiltes Util. Der Mail-Versand
 * (#944) muss Nutzerdaten escapen, soll dafuer aber nicht den Notiz-Renderer
 * an sich binden - sonst kann ein Umbau an der Notizanzeige den Mailversand
 * treffen. Eine zweite Escape-Funktion im Backend waere die schlechtere
 * Antwort: zwei Fassungen laufen genau bei dem Zeichen auseinander, an dem es
 * darauf ankommt.
 */

const ESCAPE_MAP = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

const ESCAPE_RE = /[&<>"']/g;

/**
 * Escapet einen String fuer die sichere Einbettung in HTML.
 * Gibt fuer null/undefined einen Leerstring zurueck.
 *
 * @param {*} str - Beliebiger Wert (wird zu String konvertiert)
 * @returns {string} HTML-sicherer String
 */
export function esc(str) {
  if (str == null) return '';
  return String(str).replace(ESCAPE_RE, (ch) => ESCAPE_MAP[ch]);
}
