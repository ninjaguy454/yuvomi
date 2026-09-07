/**
 * Modul: Test-Infrastruktur - der EINE Regelscanner fuer Stylesheets.
 * Zweck: `eachRule()` an genau einer Stelle halten. Er stand bis 2026-08-08 in
 *        test-frontend-audit.js und war damit fuer jede zweite Guard-Suite
 *        unerreichbar - die naechste Kopie waere die fuenfte gewesen.
 * Ausfuehren: keine eigene Suite - Helfer, importiert von test-frontend-audit.js
 *        und test-typography.js.
 *
 * Liefert `{ selector, body, at }` fuer jede Regel einer Stylesheet-Quelle -
 * Kommentare gestrippt, At-Bloecke aufgeloest, und `at` traegt die Kette der
 * At-Praeambeln, in denen die Regel steht (leer auf der Basisebene).
 *
 * DREI FALLEN STECKEN IN SEINER GESCHICHTE, alle drei in Runde 6 bezahlt, und
 * alle drei mit einem gruenen Guard darueber:
 *
 * 1. (Phase 0) `(?:^|[}])\s*([^{}]*)\{([^}]*)\}` verschluckt die ERSTE Regel
 *    jedes At-Blocks - `[^}]*` im Rumpf erlaubt `{`, also frisst der Match der
 *    `@media`-Praeambel die Regel dahinter mit. Jeder Guard auf diesem Muster
 *    war in Media-Queries blind, also genau dort, wo responsive Verstoesse
 *    leben.
 * 2. (Phase 3a) `(?:^|[}])` KONSUMIERT sein Trennzeichen: nach einem Treffer
 *    steht `lastIndex` hinter dem `}` der gefundenen Regel, und die naechste
 *    findet keines mehr vor sich - **jede zweite Regel blieb ungesehen**.
 *    Gegenprobe: `.a{} .b{} .c{} .d{}` liefert mit dem alten Muster `.a, .c`.
 * 3. (Phase 3b) Das Muster kannte den KONTEXT einer Regel nicht. Das Flachmachen
 *    der At-Bloecke war der Preis fuer Falle 1 - es macht die Regeln darin
 *    sichtbar und wirft dabei die Angabe weg, die eine responsive Regel
 *    braucht: in welchem Block sie steht.
 *
 * Deshalb laeuft er ueber die Klammern statt ueber ein Regex: er steigt in
 * `@media`, `@supports`, `@container` und `@layer` hinab und merkt sich die
 * Praeambel. `@keyframes` wird uebersprungen - seine Prozentmarken sind
 * Animationsstufen, keine Selektoren, und das alte Muster lieferte dort ohnehin
 * nur die Praeambel mit angebrochenem Rumpf.
 *
 * Wer CSS parst, nimmt IHN - vier Kopien des alten Musters waren vier
 * Gelegenheiten, dieselbe Falle wieder einzubauen.
 */
const AT_RULES_WITH_RULES = /^@(?:media|supports|container|layer|scope)\b/;

export function* eachRule(css) {
  const src = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const at = [];
  let index = 0;
  let start = 0;
  let parentheses = 0;

  while (index < src.length) {
    const char = src[index];

    // Statement at-rules (@import, @charset, @layer ...) end at a semicolon,
    // not at the next rule's opening brace. URL/string semicolons are content.
    if (char === '"' || char === "'") {
      const quote = char;
      index += 1;
      while (index < src.length && src[index] !== quote) {
        if (src[index] === '\\') index += 1;
        index += 1;
      }
      index += 1;
      continue;
    }
    if (char === '(') parentheses += 1;
    if (char === ')') parentheses = Math.max(0, parentheses - 1);
    if (parentheses > 0) {
      index += 1;
      continue;
    }
    if (char === ';' && src.slice(start, index).trimStart().startsWith('@')) {
      index += 1;
      start = index;
      continue;
    }

    if (char === '}') {
      at.pop();
      index += 1;
      start = index;
      continue;
    }

    if (char !== '{') {
      index += 1;
      continue;
    }

    const preamble = src.slice(start, index).trim().replace(/\s+/g, ' ');

    if (AT_RULES_WITH_RULES.test(preamble)) {
      at.push(preamble);
      index += 1;
      start = index;
      continue;
    }

    // Alles andere ist ein Block mit Deklarationen (oder @keyframes). Bis zur
    // passenden schliessenden Klammer springen, damit verschachtelte
    // Keyframe-Stufen nicht als eigene Regeln durchgehen.
    let depth = 1;
    let end = index + 1;
    while (end < src.length && depth > 0) {
      if (src[end] === '{') depth += 1;
      else if (src[end] === '}') depth -= 1;
      end += 1;
    }
    if (preamble && !preamble.startsWith('@keyframes')) {
      yield { selector: preamble, body: src.slice(index + 1, end - 1), at: [...at] };
    }
    index = end;
    start = index;
  }
}
