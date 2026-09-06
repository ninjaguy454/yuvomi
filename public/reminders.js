/** Reminder UI compatibility; durable history and polling live in notification-center.js. */
import { moduleIconEl } from '/nav-icons.js';
export { init, stop, refresh } from '/notification-center.js';

function notificationStatus() {
  if (!('Notification' in window)) return 'unsupported';
  return Notification.permission;
}

/**
 * Browser-Benachrichtigung anfordern.
 * @returns {Promise<'granted'|'denied'|'default'>}
 */
async function requestPermission() {
  if (!('Notification' in window)) return 'unsupported';
  if (Notification.permission === 'granted') return 'granted';
  return Notification.requestPermission();
}


function createBellSvg() {
  const NS  = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '2');
  svg.setAttribute('width', '16');
  svg.setAttribute('height', '16');
  svg.setAttribute('aria-hidden', 'true');

  const path1 = document.createElementNS(NS, 'path');
  path1.setAttribute('d', 'M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9');
  const path2 = document.createElementNS(NS, 'path');
  path2.setAttribute('d', 'M13.73 21a2 2 0 0 1-3.46 0');

  svg.appendChild(path1);
  svg.appendChild(path2);
  return svg;
}

// --------------------------------------------------------
// Herkunft einer Erinnerung (Markensiegel, Block 2)
// --------------------------------------------------------

/**
 * DIE ERINNERUNGEN SIND EINE MISCHSTELLE, und zwar die einzige, die den Nutzer
 * von sich aus anspricht: eine Meldung erscheint, ohne dass man den Raum
 * betreten hat, in dem sie entstanden ist. Genau dort ist die Herkunft nicht
 * selbstverstaendlich - also traegt jede Meldung ihr Siegel (Herkunfts-Regel,
 * .impeccable/block2-brief.md).
 *
 * ERHOBEN, NICHT GERATEN: durch `/reminders/pending` laufen genau die
 * `entity_type`-Werte aus `VALID_ENTITY_TYPES` (server/routes/reminders.js),
 * und jeder ist an seiner Schreibstelle im Server belegt. Zwei setzt der
 * Nutzer selbst (`task`, `event`), die uebrigen leitet ihr Modul ab:
 * subscriptions.js, inventory/items.js, inventory/item-dates.js und
 * services/pantry-reminders.js. Medikamente laufen NICHT hierueber.
 *
 * KEINE ZAHL MEHR AN DIESER STELLE: hier stand "exakt drei", waehrend die
 * Tabelle unten laengst mehr trug - dieselbe Drift, gegen die die Modulliste
 * in CLAUDE.md bewusst keine Zahl nennt. Die Vollstaendigkeit haelt ein Guard
 * in test/test-frontend-audit.js, nicht dieser Satz.
 *
 * GEBURTSTAGE SPRECHEN MIT DER STIMME DES KALENDERS, und das ist richtig:
 * `syncBirthdayReminder` (server/services/birthdays.js) haengt die Erinnerung an
 * den KALENDEREINTRAG des Geburtstags, nicht an den Geburtstag selbst. Die
 * Meldung zeigt damit die Herkunft, die die Zeile wirklich hat. Sie am `icon`
 * des Termins ('cake') zu erkennen waere ein Marker, der ungenauer schluesselt
 * als das Markierte - jeder Termin darf dieses Icon tragen.
 *
 * WER HIER FEHLT, FAELLT AUF DIE GLOCKE ZURUECK statt zu verschwinden: ein
 * kuenftiger `entity_type` zeigt den Erinnerungs-Ton und das Glocken-Zeichen,
 * bis er hier eingetragen ist.
 */
const REMINDER_ORIGINS = {
  task:                   { accent: 'var(--module-tasks)',     icon: 'check-square', labelKey: 'nav.tasks' },
  event:                  { accent: 'var(--module-calendar)',  icon: 'calendar',     labelKey: 'nav.calendar' },
  subscription:           { accent: 'var(--module-budget)',    icon: 'wallet',       labelKey: 'subscriptions.tabLabel' },
  inventory_item:         { accent: 'var(--module-inventory)', icon: 'package',      labelKey: 'nav.inventory' },
  inventory_tracked_date: { accent: 'var(--module-inventory)', icon: 'package',      labelKey: 'nav.inventory' },
  pantry_item:            { accent: 'var(--module-pantry)',    icon: 'archive',      labelKey: 'nav.pantry' },
  meal:                   { accent: 'var(--module-meals)',     icon: 'utensils',     labelKey: 'nav.meals' },
};

function createOriginSeal(entityType, override = null) {
  const origin = override || REMINDER_ORIGINS[entityType];
  const seal = document.createElement('span');
  // Hier stand zusaetzlich `module-seal--vivid`: der Toast ist die eine
  // umgekehrte Flaeche der App und brauchte deshalb das Vollton-Gesicht. Es
  // ist seit 2026-08-17 das einzige, also steht es in der Basisregel.
  seal.className = 'module-seal module-seal--sm';
  seal.setAttribute('aria-hidden', 'true');
  seal.style.setProperty('--seal-accent', origin?.accent ?? 'var(--module-reminders)');
  // Der Fallback oben deckt einen unbekannten entity_type ab; ein Icon-Name
  // ohne eigenes Zeichen faellt in moduleIconEl still auf Lucide zurueck.
  seal.appendChild(origin?.icon ? moduleIconEl(origin.icon) : createBellSvg());
  return seal;
}


export { requestPermission, notificationStatus, createOriginSeal };
