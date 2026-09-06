/**
 * Modul: Service Worker Registrierung
 * Zweck: Ausgelagert aus index.html um CSP-Inline-Script-Verletzung zu vermeiden.
 *        Handhabt nahtlose Updates via controllerchange.
 * Abhängigkeiten: keine
 */

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js', { updateViaCache: 'none' })
      .then((registration) => registration.update())
      .catch((err) => {
        console.warn('[SW] Registrierung fehlgeschlagen:', err);
      });
  });

  // SW-Update: Auf iOS-PWA fuehrt ein sofortiger Reload bei controllerchange
  // zu Timing-Problemen (leere Seite, verlorene Cookies). Stattdessen nur
  // nachladen wenn die Seite gerade nicht mitten im Initialisieren ist.
  let refreshing = false;
  let hadController = Boolean(navigator.serviceWorker.controller);
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    // The first takeover controls the already network-loaded page. Reloading
    // it can erase a login or form draft. Later worker upgrades still reload.
    if (!hadController && navigator.serviceWorker.controller) {
      hadController = true;
      return;
    }
    if (!navigator.serviceWorker.controller || refreshing) return;
    refreshing = true;
    // Kurz warten damit der neue SW vollstaendig aktiviert ist und
    // clients.claim() abgeschlossen hat, bevor die Seite neu laedt.
    // Auf iOS-Standalone verhindert das den "leere Seite"-Bug.
    setTimeout(() => window.location.reload(), 200);
  });

  const refreshSw = () => {
    navigator.serviceWorker.getRegistration()
      .then((registration) => registration?.update())
      .catch(() => {});
  };

  window.addEventListener('focus', refreshSw);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') refreshSw();
  });
}

/**
 * Weist den aktiven Service Worker an, den Read-only-Offline-API-Cache zu leeren.
 * Aufgerufen bei Logout und Session-Ende, um Daten-Leaks bei Nutzerwechsel am
 * selben Gerät zu verhindern. Defensive Guards: kein SW / kein Controller → No-Op.
 */
export function clearApiCache() {
  try {
    if ('serviceWorker' in navigator && navigator.serviceWorker.controller) {
      navigator.serviceWorker.controller.postMessage({ type: 'CLEAR_API_CACHE' });
    }
  } catch (err) {
    console.warn('[SW] clearApiCache fehlgeschlagen:', err);
  }
}
