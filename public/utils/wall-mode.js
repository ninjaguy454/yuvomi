/**
 * Device-local Wall display preference. The server session lock is authoritative
 * for privacy; this flag controls routing and shell presentation and informs the
 * service worker to discard private API caches. Wall layout/appearance is stored
 * separately from personal Dashboard settings. Protected actions use a verified
 * member proof; leaving Wall Mode requires administrator verification.
 * Fully Kiosk owns device brightness, sleep, and kiosk lockdown.
 */
import { nowFields } from './timezone.js';

const WALL_KEY = 'yuvomi-wall-mode';
const THEME_KEY = 'yuvomi-theme';

/** Ab dieser Stunde (einschliesslich) ist Nacht. */
export const WALL_NIGHT_FROM = 22;
/** Ab dieser Stunde (einschliesslich) ist wieder Tag. */
export const WALL_NIGHT_TO = 6;

function safeGet(key) {
  try {
    return localStorage.getItem(key);
  } catch {
    // Privatmodus/Quota: der Modus gilt dann fuer diese Sitzung nicht.
    return null;
  }
}

function safeSet(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Siehe safeGet - ein nicht schreibbarer Storage darf nichts abbrechen.
  }
}

function safeRemove(key) {
  try {
    localStorage.removeItem(key);
  } catch {
    // Siehe safeGet.
  }
}

/** Ist der Modus auf DIESEM Geraet eingeschaltet? */
export function isWallModeEnabled() {
  return safeGet(WALL_KEY) === '1';
}

/** Schaltet den Modus auf diesem Geraet ein oder aus. */
export function setWallModeEnabled(enabled) {
  const wasEnabled = isWallModeEnabled();
  if (enabled) safeSet(WALL_KEY, '1');
  else safeRemove(WALL_KEY);
  try { navigator.serviceWorker?.controller?.postMessage({type:'WALL_MODE',enabled:!!enabled}); } catch { /* no worker */ }
  if (wasEnabled === !!enabled) return;
  window.dispatchEvent(new CustomEvent('yuvomi:wall-mode-change', { detail: { enabled: !!enabled } }));
}

/**
 * Die eine Stelle, an der steht, wo der Modus gilt.
 *
 * Er ist ein Zustand des Dashboards, also genau dessen Route. Ein Vergleich
 * ohne diesen Namen waere die Sorte Bedingung, die beim naechsten Routen-Umbau
 * still stehen bleibt.
 */
export function isWallRoute(path) {
  return path === '/';
}

/**
 * Nachtfenster. Ueber Mitternacht hinweg, deshalb ODER statt UND - dieselbe
 * Falle, die das Tagesprogramm beim Mitternachts-Ausblick schon einmal hatte.
 */
export function isWallNight(now = new Date()) {
  // Die Uhr des Haushalts, nicht die des Geraets: ein Wandbildschirm, dessen
  // Browser in einer anderen Zone steht, ginge sonst zur falschen Stunde in den
  // Nachtmodus (#829 Teil 3).
  const hour = nowFields(now).hour;
  return hour >= WALL_NIGHT_FROM || hour < WALL_NIGHT_TO;
}

/** Laeuft die Flaeche gerade als Wand? Liest den Zustand, den `syncWallMode` setzt. */
export function isWallActive() {
  return document.documentElement.hasAttribute('data-wall-mode');
}

/**
 * Stellt das Theme auf die WAHL DES NUTZERS zurueck.
 *
 * Dieselbe Drei-Wege-Logik steht in `theme-init.js` (Erstzustand vor dem
 * Rendern) und in `router.js` (`applyTheme`, mit Persistenz). Hier steht sie
 * ein drittes Mal, weil dieser Pfad genau das NICHT tun darf, was die anderen
 * beiden tun: `applyTheme` schriebe den erzwungenen Nachtwert nach
 * `yuvomi-theme` und loeschte damit die Wahl, die wir gerade
 * wiederherstellen wollen.
 */
function restoreUserTheme() {
  const stored = safeGet(THEME_KEY);
  if (stored === 'dark' || stored === 'light') {
    document.documentElement.setAttribute('data-theme', stored);
  } else {
    document.documentElement.removeAttribute('data-theme');
  }
}

/**
 * Bringt die Wurzel-Attribute auf den Stand von Route, Schalter und Uhrzeit.
 *
 * Idempotent und billig: der Minutentakt der Uhr ruft sie mit, damit der
 * Wechsel um 22:00 und um 06:00 passiert, wenn er passiert - und nicht erst
 * beim naechsten Laden. Sie ist die EINZIGE Stelle, die diese Attribute setzt.
 *
 * @param {string} path Der aktive Pfad.
 * @returns {boolean} Ob die Wand danach laeuft.
 */
export function syncWallMode(path = location.pathname) {
  const root = document.documentElement;
  const active = isWallModeEnabled() && isWallRoute(path);
  // The configurable Wall owns its own appearance; Fully owns device dimming.
  const night = false;
  const wasNight = root.hasAttribute('data-wall-night');

  root.toggleAttribute('data-wall-mode', active);
  root.toggleAttribute('data-wall-night', night);

  if (night && !wasNight) {
    // Erzwungen, nicht gespeichert: `yuvomi-theme` bleibt, wie der Nutzer es
    // gewaehlt hat.
    root.setAttribute('data-theme', 'dark');
  } else if (!night && wasNight) {
    restoreUserTheme();
  }

  // Die Statusbar der installierten PWA haengt am `data-theme` der Wurzel
  // (router.js: setThemeColor liest es). Ohne dieses Nachziehen stuende ueber
  // der abgedunkelten Nachtflaeche eine helle Leiste.
  if (night !== wasNight) window.yuvomi?.restoreThemeColor?.();

  return active;
}

/** Schaltet den Modus aus und raeumt die Wurzel sofort auf. */
export function exitWallMode() {
  setWallModeEnabled(false);
  syncWallMode(location.pathname);
}
