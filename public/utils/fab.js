/**
 * Modul: Page-FAB — geteilte Primäraktion (Floating Action Button)
 *
 * EINE Quelle für die „Neu erstellen"-Schaltfläche unten rechts. Ersetzt die
 * zuvor pro Seite handgeschriebene `<button class="page-fab">`-Markup und gibt
 * Tab-Modulen einen Kontext-FAB, dessen Aktion dem aktiven Tab folgt.
 *
 * Vier Wege:
 *   - pageFabHtml()      → HTML-String für Template-Literal-Seiten (eigene Klick-Verdrahtung).
 *   - createPageFab()    → DOM-Element mit onClick, für DOM-basierte / dynamische Seiten.
 *   - findPageFab()      → den FAB der aktuellen Seite finden (dokumentweit, siehe dort).
 *   - setPageFabAction() → Aktion/Label/Sichtbarkeit eines Kontext-FAB je Tab aktualisieren.
 *
 * WO DER FAB LEBT: Eine Seite legt ihn in ihrem Page-Root an, aber dort bleibt er
 * nicht - der Router hebt ihn nach dem Rendern in die Shell-Layer neben dem
 * Scrollport (adoptPageFab(), #634). Deshalb sucht man ihn dokumentweit und
 * niemals im Seiten-Container, und deshalb kommt seine Farbe aus
 * `--active-module-accent` statt aus dem `--module-accent` des Page-Roots.
 * Styling lebt in layout.css (.page-fab). Icon-Default: plus (Lucide rendert
 * 24px). Nach dem Einfügen einmal `lucide.createIcons({ el })` aufrufen.
 */

/**
 * ZWEI BESCHRIFTUNGEN, ZWEI ROLLEN. `label` ist das ausführliche `aria-label`
 * („Dokument hinzufügen"); `dockLabel` ist das kurze Nomen aus `newLabel.*`
 * („Dokument"), das der Knopf zeigt, sobald ihn der Router am Zeigergerät in
 * den Modulkopf holt (dockFabIntoToolbar in router.js). Ohne `dockLabel` dockt
 * er nicht an und schwebt weiter - das ist der Zustand der drei Kontext-FABs
 * (Gesundheit, Haushaltshilfe, Belohnungen), deren Aktion dem aktiven Tab
 * folgt und die deshalb pro Tab ein eigenes Nomen bräuchten.
 */

/** Gemeinsame FAB-Markup als HTML-String (Label kommt aus t(), keine Nutzdaten). */
export function pageFabHtml({ id = 'page-fab', label = '', icon = 'plus', dockLabel = '' } = {}) {
  return `<button type="button" class="page-fab" id="${id}"${label ? ` aria-label="${label}"` : ''}${dockLabel ? ` data-dock-label="${dockLabel}"` : ''}>
      <i data-lucide="${icon}" aria-hidden="true"></i>
    </button>`;
}

/** Gemeinsamer FAB als DOM-Element, optional an onClick gebunden. */
export function createPageFab({ id = 'page-fab', label = '', icon = 'plus', onClick, dockLabel = '' } = {}) {
  const fab = document.createElement('button');
  fab.type = 'button';
  fab.className = 'page-fab';
  fab.id = id;
  if (label) fab.setAttribute('aria-label', label);
  if (dockLabel) fab.dataset.dockLabel = dockLabel;
  const glyph = document.createElement('i');
  glyph.dataset.lucide = icon;
  glyph.setAttribute('aria-hidden', 'true');
  fab.appendChild(glyph);
  if (onClick) fab.addEventListener('click', onClick);
  return fab;
}

/**
 * Den FAB einer Seite finden - dokumentweit, nicht im Seiten-Container.
 *
 * Ein `container.querySelector('#fab-…')` fand ihn, solange er im Page-Root hing.
 * Seit er in der Shell lebt (#634), liefert dieselbe Zeile still `null`, und die
 * Verdrahtung entfällt lautlos: der Knopf ist sichtbar und tut nichts. Diese
 * Funktion ist die eine Stelle, an der der Ort steht.
 */
export function findPageFab(id) {
  return document.getElementById(id);
}

/**
 * Kontext-FAB aktualisieren: Aktion, Label und Sichtbarkeit je aktivem Tab.
 * `hidden: true` blendet den FAB auf Tabs ohne Erstellen-Aktion aus und entfernt
 * die Aktion, sodass auch der `n`-Shortcut (klickt `.page-fab`) dort ins Leere läuft.
 */
export function setPageFabAction(fab, { label = '', onClick = null, hidden = false, dockLabel = '' } = {}) {
  if (!fab) return;
  // `.page-fab { display: flex }` überschreibt das HTML-[hidden]-Attribut, daher
  // zusätzlich inline display togglen. `hidden` bleibt gesetzt (Screenreader).
  fab.hidden = hidden;
  fab.style.display = hidden ? 'none' : '';
  if (label) fab.setAttribute('aria-label', label);
  // Das Nomen wechselt mit dem Tab wie die Aktion: gesetzt heißt gesetzt,
  // leer heißt entfernt. Ein Nomen des vorigen Tabs stehen zu lassen wäre
  // schlimmer als keines - der Knopf trüge dann einen falschen Namen.
  if (dockLabel) fab.dataset.dockLabel = dockLabel;
  else delete fab.dataset.dockLabel;
  // Ein bereits angedockter Knopf trägt sein Nomen als eigenes Textelement
  // (dockFabIntoToolbar in router.js schreibt es NUR beim Andocken selbst).
  // Ein Kontext-FAB, dessen Nomen mit dem Tab wechselt, muss dieses Element
  // hier nachziehen - sonst bliebe der sichtbare Text auf dem ersten Tab
  // stehen, während `dataset.dockLabel` (und damit z. B. ein Tooltip) schon
  // weitergezogen ist.
  const dockedLabel = fab.querySelector('.toolbar-new-btn__label');
  if (dockedLabel && dockLabel) dockedLabel.textContent = dockLabel;
  fab.onclick = hidden ? null : onClick;
}
