/**
 * Modul: Schnellzugriff-Adressen (#469)
 * Zweck: Aus dem, was jemand in ein Adressfeld tippt, eine Adresse machen, die
 *        gefahrlos als `href` einer Kachel stehen darf - oder eine Absage.
 * Abhängigkeiten: keine
 *
 * WARUM DIESE DATEI UNTER public/utils/ LIEGT UND NICHT IM SERVER. Sie ist die
 * EINE Definition, an die sich beide Seiten halten: der Browser, damit das
 * Formular sofort widerspricht statt nach dem Absenden, und die Route, weil
 * eine Client-Prüfung keine Prüfung ist. Zwei Schreibweisen derselben Regel
 * wären hier besonders teuer - sie laufen nicht bei einem Tippfehler
 * auseinander, sondern bei genau dem Eingabewert, den ein Angreifer sucht.
 * Der Server importiert sie wie `markdown-checklist.js`; die Datei hat deshalb
 * bewusst keine Importe und kein DOM.
 *
 * DAS FEHLENDE SCHEMA IST DER NORMALFALL, NICHT DIE AUSNAHME. Wer einen
 * Heimserver verlinkt, tippt `192.168.1.5:8096` oder `jellyfin.local`, und ein
 * Formular, das darauf „ungültige Adresse" sagt, ist schlicht falsch. Ergänzt
 * wird deshalb `https://`.
 *
 * DIE GRENZE IST DIE ERLAUBNISLISTE, NICHT DAS ERGÄNZEN. Was diese Funktion
 * sicher macht, ist die Prüfung von `parsed.protocol` NACH dem Parsen: dort
 * fällt `javascript:` heraus, und es fällt auch dann heraus, wenn es in der
 * Form `javascript://` mit eingebettetem Zeilenumbruch daherkommt. Wer hier
 * etwas ändert, ändert es an dieser Zeile - nicht am Ergänzen.
 *
 * ERGÄNZT WIRD TROTZDEM NUR, WO GAR KEIN SCHEMA STEHT, und der Grund ist ein
 * anderer als der, der sich hier zuerst aufdrängt: es geht um die AUSKUNFT.
 * Ein naives „kein `://` gefunden, also voranstellen" macht aus
 * aus einem `javascript:`-Wert die Zeichenkette `https://javascript:…`, an der
 * `new URL` scheitert - abgelehnt wird der Wert also auch dann (gemessen), aber
 * mit der Begründung „unlesbare Adresse" statt „dieses Protokoll nicht". Wer
 * `vbscript:1` eintippt, bekäme sogar ein stilles `https://vbscript:1/`
 * gespeichert: eine gültige Adresse, die niemand gemeint hat.
 * Die Schema-Form (RFC 3986: Buchstabe, dann Buchstabe/Ziffer/`+`/`-`/`.`,
 * dann `:`) trennt deshalb vorher: steht dort ein Schema, bleibt es stehen und
 * muss die Erlaubnisliste passieren - und der Nutzer erfährt, woran es lag.
 *
 * Guards: test/test-quick-links.js, Abschnitt „Adressen".
 */

/** Nur diese beiden Schemata dürfen in ein `href`. */
export const ALLOWED_QUICK_LINK_PROTOCOLS = ['http:', 'https:'];

/** Deckel, damit eine Adresse keine Datenablage wird. */
export const MAX_QUICK_LINK_URL_LENGTH = 2000;

// Ein Schema nach RFC 3986 §3.1. Bewusst am Anfang verankert und ohne `://`:
// genau daran hängt, dass `javascript:` als Schema gilt und nicht als Hostname.
const SCHEME_RE = /^[a-z][a-z0-9+.-]*:/i;

/**
 * Normalisiert eine eingetippte Adresse und prüft sie.
 *
 * @param {unknown} raw
 * @returns {{ ok: true, url: string } | { ok: false, reason: 'empty'|'too-long'|'malformed'|'protocol' }}
 *   `reason` ist ein Schlüssel, kein Text: die Seite übersetzt ihn, der Server
 *   macht eine Fehlermeldung daraus.
 */
export function normalizeQuickLinkUrl(raw) {
  const input = typeof raw === 'string' ? raw.trim() : '';
  if (!input) return { ok: false, reason: 'empty' };
  if (input.length > MAX_QUICK_LINK_URL_LENGTH) return { ok: false, reason: 'too-long' };

  const candidate = SCHEME_RE.test(input) ? input : `https://${input}`;

  let parsed;
  try {
    parsed = new URL(candidate);
  } catch {
    return { ok: false, reason: 'malformed' };
  }
  if (!ALLOWED_QUICK_LINK_PROTOCOLS.includes(parsed.protocol)) {
    return { ok: false, reason: 'protocol' };
  }
  // Ein Host ist Pflicht: `http:///pfad` parst, zeigt aber nirgendwohin.
  if (!parsed.host) return { ok: false, reason: 'malformed' };

  // Zurück kommt die geparste Form, nicht die eingetippte: damit steht in der
  // Datenbank eine Adresse und keine Abschrift. Der Deckel gilt auch danach -
  // die Normalisierung kann verlängern (ergänztes Schema, Punycode).
  const normalized = parsed.href;
  if (normalized.length > MAX_QUICK_LINK_URL_LENGTH) return { ok: false, reason: 'too-long' };
  return { ok: true, url: normalized };
}

/**
 * Der Hostname einer bereits normalisierten Adresse - das, was unter dem Namen
 * einer Kachel steht, damit sichtbar ist, wohin sie führt.
 * @param {string} url
 * @returns {string} Hostname oder '' wenn nicht parsebar
 */
export function quickLinkHost(url) {
  try {
    return new URL(String(url)).host;
  } catch {
    return '';
  }
}
