import {
  getLocale,
  getSupportedLocales,
  setLocale,
  t,
} from '/i18n.js';
import { esc } from '/utils/html.js';
import { appendCurrencyOptions, persistCurrencySelection } from '/settings/currency.js';
import { getPreferences, savePreferences } from '/settings/preferences-cache.js';
import { toggleRowHtml } from '/settings/components.js';
import { isWallModeEnabled, setWallModeEnabled } from '/utils/wall-mode.js';
import { setDisplayTimeZone } from '/utils/timezone.js';
import { applyAppearancePreferences, normalizeAppearancePreferences, appearanceRevision } from '/utils/appearance-preferences.js';
import {
  CUSTOM_REGION,
  REGION_CODES,
  REGION_PRESETS,
  detectRegion,
  resolveRegion,
  regionLabel,
  numberLocaleFor,
} from '/settings/region-presets.js';

const DATE_FORMATS = [
  ['mdy', 'MM/DD/YYYY'],
  ['dmy', 'DD.MM.YYYY'],
  ['dmy_slash', 'DD/MM/YYYY'],
  ['ymd', 'YYYY-MM-DD'],
  ['mdy_dot', 'MM.DD.YYYY'],
  ['ymd_dot', 'YYYY.MM.DD'],
  ['ymd_slash', 'YYYY/MM/DD'],
];

function safeStorageGet(key, fallback = null) {
  try {
    return localStorage.getItem(key) ?? fallback;
  } catch {
    return fallback;
  }
}

function safeStorageSet(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Storage can be unavailable in private or restricted browser contexts.
  }
}

function safeStorageRemove(key) {
  try {
    localStorage.removeItem(key);
  } catch {
    // Storage can be unavailable in private or restricted browser contexts.
  }
}

function currentTheme() {
  return safeStorageGet('yuvomi-theme', 'system') || 'system';
}

function formatOptions(selected) {
  return DATE_FORMATS.map(([value, label]) => (
    `<option value="${value}"${selected === value ? ' selected' : ''}>${label}</option>`
  )).join('');
}

/**
 * Die Zeitzonen-Optionen: "Automatisch" plus alle IANA-Zonen, nach Region
 * gruppiert.
 *
 * Die Liste kommt aus dem ICU des BROWSERS und nicht vom Server - sie hat
 * einige hundert Einträge, und sie über die Preferences-Antwort zu schicken
 * hiesse, diesen Ballast in jeden Settings-Aufruf zu legen, obwohl jeder
 * Browser sie selbst besitzt. Der Server prüft den gewählten Wert trotzdem
 * gegen sein eigenes ICU (#829); eine Zone, die nur der Browser kennt,
 * bekommt ein 400 statt still zu landen.
 *
 * Die erste Option speichert den leeren Wert und stellt damit auf den Rückfall
 * zurück (TZ → Systemzone → UTC). Ihr Label nennt die Zone, die dann tatsächlich
 * gilt - sonst wäre "Automatisch" eine Zusage ohne Inhalt.
 */
function timeZoneOptions(selected, effective) {
  let zones = [];
  try { zones = Intl.supportedValuesOf('timeZone'); } catch { zones = []; }
  // Eine gespeicherte Zone, die dieses ICU nicht (mehr) kennt, muss sichtbar
  // bleiben: sonst zeigte das Feld "Automatisch", während der Server weiter die
  // alte Zone benutzt - ein Select, das die Wahrheit verschweigt.
  if (selected && !zones.includes(selected)) zones = [...zones, selected].sort();

  const auto = `<option value=""${selected ? '' : ' selected'}>`
    + `${esc(t('settings.timezoneAuto', { zone: effective || 'UTC' }))}</option>`;

  // UTC von Hand davor. `Intl.supportedValuesOf('timeZone')` fuehrt WEDER `UTC`
  // NOCH ein einziges `Etc/*` - und UTC ist ausgerechnet der Auslieferungs-
  // Default dieser App. Ohne diese Zeile ist die eine Zone nicht waehlbar, die
  // ein Admin ausdruecklich festnageln will, damit die Anzeige nicht mit `TZ`
  // mitwandert. Steht vor den Gruppen statt in einer eigenen "Other"-Gruppe mit
  // genau einem Eintrag: sie ist der Sonderfall, nicht eine Region.
  const utc = `<option value="UTC"${selected === 'UTC' ? ' selected' : ''}>UTC</option>`;

  const groups = new Map();
  for (const zone of zones) {
    if (zone === 'UTC') continue; // steht schon oben
    const area = zone.includes('/') ? zone.slice(0, zone.indexOf('/')) : 'Other';
    if (!groups.has(area)) groups.set(area, []);
    groups.get(area).push(zone);
  }
  const body = [...groups.entries()].map(([area, list]) => {
    const opts = list.map((zone) => {
      // Das Label laesst die Region weg - die steht schon an der optgroup, und
      // "America > America/New York" liest sich wie ein Fehler. Was uebrig
      // bleibt, behaelt seine restlichen Schraegstriche
      // ("Argentina/Buenos Aires"); der VALUE bleibt die volle IANA-Kennung.
      const label = (zone.includes('/') ? zone.slice(zone.indexOf('/') + 1) : zone).replace(/_/g, ' ');
      return `<option value="${esc(zone)}"${zone === selected ? ' selected' : ''}>${esc(label)}</option>`;
    }).join('');
    return `<optgroup label="${esc(area)}">${opts}</optgroup>`;
  }).join('');

  return auto + utc + body;
}

function regionOptions(selectedRegion) {
  const locale = getLocale();
  // Nach dem angezeigten Namen sortieren, nicht nach der Reihenfolge in
  // REGION_PRESETS: die ist nach Sprachfamilie gruppiert und war bei einem
  // Dutzend Einträgen noch überschaubar. Mit der Amerika-Abdeckung sind es
  // über 60 - da findet man "Spanisch (Peru)" nur alphabetisch wieder.
  // detectRegion() bleibt von der Sortierung unberührt, es liest das Objekt.
  const presets = [...REGION_CODES]
    .map((code) => ({ code, label: regionLabel(code, locale) }))
    .sort((a, b) => a.label.localeCompare(b.label, locale))
    .map(({ code, label }) => (
      `<option value="${esc(code)}"${selectedRegion === code ? ' selected' : ''}>${esc(label)}</option>`
    )).join('');
  const custom = `<option value="${CUSTOM_REGION}"${selectedRegion === CUSTOM_REGION ? ' selected' : ''}>${t('settings.regionCustom')}</option>`;
  return presets + custom;
}

function localeLabel(locale) {
  try {
    return new Intl.DisplayNames([getLocale()], { type: 'language' }).of(locale) || locale;
  } catch {
    return locale;
  }
}

function localeOptions() {
  const storedLocale = safeStorageGet('yuvomi-locale');
  return [
    `<option value="system"${storedLocale ? '' : ' selected'}>${t('settings.localeSystem')}</option>`,
    ...getSupportedLocales().map((locale) => (
      `<option value="${esc(locale)}"${storedLocale === locale ? ' selected' : ''}>${esc(localeLabel(locale))}</option>`
    )),
  ].join('');
}

/**
 * Optionen für die Datensprache des Haushalts (#631, #632). Der leere Wert steht
 * für "automatisch"; sein Label nennt die Sprache, auf die die Automatik fiele -
 * `language_auto`, nicht `language_effective`. Bei explizit gewählter Sprache
 * sind die beiden verschieden, und `language_effective` würde dort genau die
 * gewählte Sprache als Automatik-Ergebnis ausgeben.
 */
function dataLanguageOptions(selected, auto_) {
  const auto = t('settings.dataLanguageAuto', { language: localeLabel(auto_) });
  return [
    `<option value=""${selected ? '' : ' selected'}>${esc(auto)}</option>`,
    ...getSupportedLocales().map((locale) => (
      `<option value="${esc(locale)}"${selected === locale ? ' selected' : ''}>${esc(localeLabel(locale))}</option>`
    )),
  ].join('');
}

function showError(element, message) {
  if (!element) return;
  element.textContent = message || t('common.errorGeneric');
  element.hidden = false;
}

function clearError(element) {
  if (!element) return;
  element.textContent = '';
  element.hidden = true;
}

function renderLoadError(container) {
  container.replaceChildren();
  container.insertAdjacentHTML('beforeend', `
    <div class="settings-card">
      <p class="form-error" role="alert">${t('settings.loadError')}</p>
      <div class="settings-form-actions">
        <button type="button" class="btn btn--secondary" id="appearance-retry">${t('settings.retry')}</button>
      </div>
    </div>
  `);
}

/**
 * Region, currency and date/time formats are household values. Keep the
 * related controls together for administrators, while members can read the
 * formats and freely change their personal theme, typography and language.
 */
function renderPage(container, preferences, isAdmin) {
  const theme = currentTheme();
  const appearance = normalizeAppearancePreferences(preferences);
  const activeRegion = resolveRegion(preferences);
  const customHidden = isAdmin && activeRegion !== CUSTOM_REGION;
  container.replaceChildren();
  container.insertAdjacentHTML('beforeend', `
    <section class="settings-section">
      <h2 class="settings-section__title">${t('appearanceOptions.theme')} &amp; ${t('appearanceOptions.typography')}</h2>
      <div class="settings-card">
        <p class="form-label" id="appearance-mode-label">${t('appearanceOptions.appearance')}</p>
        <div class="theme-toggle" id="theme-toggle" role="group" aria-labelledby="appearance-mode-label">
          <button class="theme-toggle__btn ${theme === 'system' ? 'theme-toggle__btn--active' : ''}" type="button" data-theme-value="system" aria-label="${t('settings.themeSysLabel')}" aria-pressed="${theme === 'system'}">
            <i data-lucide="monitor" class="icon-md" aria-hidden="true"></i>
            ${t('settings.themeSystem')}
          </button>
          <button class="theme-toggle__btn ${theme === 'light' ? 'theme-toggle__btn--active' : ''}" type="button" data-theme-value="light" aria-label="${t('settings.themeLightLabel')}" aria-pressed="${theme === 'light'}">
            <i data-lucide="sun" class="icon-md" aria-hidden="true"></i>
            ${t('settings.themeLight')}
          </button>
          <button class="theme-toggle__btn ${theme === 'dark' ? 'theme-toggle__btn--active' : ''}" type="button" data-theme-value="dark" aria-label="${t('settings.themeDarkLabel')}" aria-pressed="${theme === 'dark'}">
            <i data-lucide="moon" class="icon-md" aria-hidden="true"></i>
            ${t('settings.themeDark')}
          </button>
        </div>
      </div>
      <div class="settings-card">
        <div class="settings-field-grid">
        <div class="form-group">
          <label class="form-label" for="color-theme-select">${t('appearanceOptions.theme')}</label>
          <select class="form-input" id="color-theme-select" aria-describedby="color-theme-hint appearance-choice-error">
            ${['warm', 'neutral', 'cool'].map((value) => `<option value="${value}"${appearance.color_theme === value ? ' selected' : ''}>${t(`appearanceOptions.${value}`)}</option>`).join('')}
          </select>
          <p class="form-hint" id="color-theme-hint">${t('appearanceOptions.themeHint')}</p>
        </div>
        <div class="form-group">
          <label class="form-label" for="heading-font-select">${t('appearanceOptions.typography')}</label>
          <select class="form-input" id="heading-font-select" aria-describedby="heading-font-hint appearance-choice-error">
            ${['default', 'serif'].map((value) => `<option value="${value}"${appearance.heading_font === value ? ' selected' : ''}>${t(`appearanceOptions.${value}`)}</option>`).join('')}
          </select>
          <p class="form-hint" id="heading-font-hint">${t('appearanceOptions.typographyHint')}</p>
        </div>
        </div>
        <p class="form-error" id="appearance-choice-error" role="alert" hidden></p>
      </div>
      <!-- DER WAND-MODUS WOHNT HIER UND NICHT IM ANPASSEN-PANEL.
           Er ist wie Theme und Sprache GERÄTELOKAL (localStorage) - das
           Anpassen-Panel schreibt dagegen die haushaltweite Widget-Konfiguration
           auf den Server. Ein gerätelokaler Schalter dort wäre eine zweite
           Speicher-Semantik im selben Panel; und der Anpassen-Modus bearbeitet
           das Raster, während dieser Schalter eine Betriebsart wählt. -->
      <div class="settings-card">
        ${toggleRowHtml({
          label: t('settings.wallModeLabel'),
          checked: isWallModeEnabled(),
          icon: 'tablet',
          attrs: { id: 'wall-mode-toggle', 'aria-describedby': 'wall-mode-hint' },
        })}
        <p class="form-hint" id="wall-mode-hint">${t('settings.wallModeHint')}</p>
      </div>
    </section>

    <section class="settings-section">
      <h2 class="settings-section__title">${t('settings.languageTitle')}</h2>
      <div class="settings-card">
        <div class="form-group">
          <label class="form-label" for="locale-select">${t('settings.localeLabel')}</label>
          <select class="form-input locale-picker__select" id="locale-select" aria-describedby="locale-error">
            ${localeOptions()}
          </select>
        </div>
        <div id="locale-error" class="form-error" role="alert" hidden></div>
      </div>
      <!-- Eigene Karte, nicht angehängt an die Sprachauswahl darüber: als
           Nachbar im selben Block läse sich der Hinweis wie die Erklärung der
           Anzeigesprache - und beide sagen etwas Gegensätzliches aus. -->
      <div class="settings-card">
        ${isAdmin ? `
        <p class="form-hint" id="data-language-hint">${t('settings.dataLanguageHint')}</p>
        <div class="form-group">
          <label class="form-label" for="data-language-select">${t('settings.dataLanguageLabel')}</label>
          <select class="form-input" id="data-language-select" aria-describedby="data-language-hint data-language-error">
            ${dataLanguageOptions(preferences.language, preferences.language_auto)}
          </select>
        </div>
        <div id="data-language-error" class="form-error" role="alert" hidden></div>` : `
        <p class="form-hint">${t('settings.dataLanguageAdminOnly')}</p>`}
      </div>
    </section>

    <section class="settings-section">
      <h2 class="settings-section__title">${t('settings.regionTitle')}</h2>
      ${isAdmin ? `
      <div class="settings-card">
        <p class="form-hint" id="region-hint">${t('settings.regionHint')}</p>
        <div class="form-group">
          <label class="form-label" for="region-select">${t('settings.regionLabel')}</label>
          <select class="form-input" id="region-select" aria-describedby="region-hint region-error">
            ${regionOptions(activeRegion)}
          </select>
        </div>
        <div id="region-error" class="form-error" role="alert" hidden></div>
      </div>` : `
      <div class="settings-card">
        <p class="form-hint">${t('settings.regionAdminOnly')}</p>
      </div>`}
      <!-- Eigene Karte, nicht in den Formatblock darunter: die Zeitzone ist
           keine Formatierung. Datum und Uhrzeit dort ändern nur, WIE ein Wert
           dasteht; die Zone ändert, WELCHER Tag "heute" ist, wann Erinnerungen
           auslösen und mit welcher Uhrzeit ein Termin bei Google ankommt. -->
      <div class="settings-card">
        <h3 class="settings-card__title">${t('settings.timezoneTitle')}</h3>
        ${isAdmin ? `
        <p class="form-hint" id="timezone-hint">${t('settings.timezoneHint')}</p>
        <div class="form-group">
          <label class="form-label" for="timezone-select">${t('settings.timezoneLabel')}</label>
          <select class="form-input" id="timezone-select" aria-describedby="timezone-hint timezone-error">
            ${timeZoneOptions(preferences.timezone, preferences.timezone_effective)}
          </select>
        </div>
        <div id="timezone-error" class="form-error" role="alert" hidden></div>` : `
        <p class="form-hint">${t('settings.timezoneAdminOnly')}</p>
        <p class="form-hint">${esc(t('settings.timezoneAuto', { zone: preferences.timezone_effective || 'UTC' }))}</p>`}
      </div>
      <div class="settings-card" id="custom-formats"${customHidden ? ' hidden' : ''}>
        ${isAdmin ? `
        <div class="form-group">
          <label class="form-label" for="currency-select">${t('settings.currencyLabel')}</label>
          <select class="form-input" id="currency-select" aria-describedby="currency-error"></select>
        </div>
        <div id="currency-error" class="form-error" role="alert" hidden></div>` : ''}
        <p class="form-hint" id="formats-household-hint">${t('settings.adminOnly')}</p>
        ${isAdmin ? `
        <div class="form-group">
          <label class="form-label" for="date-format-select">${t('settings.dateFormatLabel')}</label>
          <select class="form-input" id="date-format-select" aria-describedby="formats-household-hint date-format-error">
            ${formatOptions(preferences.date_format)}
          </select>
        </div>
        <div id="date-format-error" class="form-error" role="alert" hidden></div>
        <div class="form-group">
          <label class="form-label" for="time-format-select">${t('settings.timeFormatLabel')}</label>
          <select class="form-input" id="time-format-select" aria-describedby="formats-household-hint time-format-error">
            <option value="24h"${preferences.time_format === '24h' ? ' selected' : ''}>24 ${t('settings.timeFormatHours')}</option>
            <option value="12h"${preferences.time_format === '12h' ? ' selected' : ''}>AM/PM</option>
          </select>
        </div>
        <div id="time-format-error" class="form-error" role="alert" hidden></div>
        ` : `<p>${t('settings.dateFormatLabel')}: ${esc(preferences.date_format)} · ${t('settings.timeFormatLabel')}: ${esc(preferences.time_format)}</p>`}
      </div>
    </section>
  `);
}

function applyTheme(value) {
  safeStorageSet('yuvomi-theme', value);
  if (window.yuvomi?.applyTheme) {
    try {
      window.yuvomi.applyTheme(value);
      return;
    } catch {
      // Fall back to applying the theme directly when router storage fails.
    }
  }

  if (value === 'dark' || value === 'light') {
    document.documentElement.setAttribute('data-theme', value);
  } else {
    document.documentElement.removeAttribute('data-theme');
  }
}

// Spiegelt die aktive Region als Formatier-Locale für Zahlen/Währung in den
// localStorage (getFormatLocale() in i18n.js liest ihn). Leert den Schlüssel bei
// "Benutzerdefiniert", damit die Zahlenformatierung auf die UI-Sprache zurückfällt.
function applyNumberLocale({ region, currency, date_format, time_format }) {
  const numberLocale = numberLocaleFor({ region, currency, date_format, time_format });
  if (numberLocale) {
    safeStorageSet('yuvomi-number-locale', numberLocale);
  } else {
    safeStorageRemove('yuvomi-number-locale');
  }
}

// Liest den aktuellen Format-Zustand aus den vier Selects der Seite.
function readFormatState(container) {
  return {
    region: container.querySelector('#region-select')?.value,
    currency: container.querySelector('#currency-select')?.value,
    date_format: container.querySelector('#date-format-select')?.value,
    time_format: container.querySelector('#time-format-select')?.value,
  };
}

// Hält den Region-Dropdown mit den drei Einzel-Selects synchron (Preset oder
// "Benutzerdefiniert"), nachdem ein Einzelwert manuell geändert wurde.
function syncRegionSelect(container) {
  const regionSelect = container.querySelector('#region-select');
  if (!regionSelect) return;
  regionSelect.value = detectRegion({
    currency: container.querySelector('#currency-select')?.value,
    date_format: container.querySelector('#date-format-select')?.value,
    time_format: container.querySelector('#time-format-select')?.value,
  });
}

/**
 * Baut die Optionen der Datensprache neu auf. Nötig nach einem Regionswechsel:
 * steht die Datensprache auf "automatisch", leitet der Server sie aus der Region
 * ab, und das Label nennt dann eine andere Sprache. Die Ableitung bleibt dabei
 * beim Server - hier wird nur der frisch gelesene Wert angezeigt, statt die
 * Regel im Client zu wiederholen.
 */
async function refreshDataLanguageOptions(container) {
  const select = container.querySelector('#data-language-select');
  if (!select) return;
  const preferences = await getPreferences();
  select.replaceChildren();
  select.insertAdjacentHTML('beforeend', dataLanguageOptions(
    preferences.language || null,
    preferences.language_auto || 'en',
  ));
}

function bindEvents(container, user) {
  const colorSelect = container.querySelector('#color-theme-select');
  const fontSelect = container.querySelector('#heading-font-select');
  let savedAppearance = normalizeAppearancePreferences({ color_theme: colorSelect?.value, heading_font: fontSelect?.value });
  const saveAppearance = async () => {
    const errorElement = container.querySelector('#appearance-choice-error');
    clearError(errorElement);
    const requested = { color_theme: colorSelect.value, heading_font: fontSelect.value };
    applyAppearancePreferences(requested);
    const previewRevision = appearanceRevision();
    colorSelect.disabled = true;
    fontSelect.disabled = true;
    try {
      await savePreferences(requested);
      savedAppearance = requested;
      if (container.isConnected) window.yuvomi?.showToast(t('appearanceOptions.saved'), 'success');
    } catch (error) {
      // A failed save must not appear persisted. Do not restore stale personal
      // colors after logout or after the settings page has been replaced.
      if (appearanceRevision() === previewRevision) applyAppearancePreferences(savedAppearance);
      if (container.isConnected) {
        colorSelect.value = savedAppearance.color_theme;
        fontSelect.value = savedAppearance.heading_font;
        showError(errorElement, error.message);
      }
    } finally {
      if (container.isConnected) {
        colorSelect.disabled = false;
        fontSelect.disabled = false;
      }
    }
  };
  colorSelect?.addEventListener('change', saveAppearance);
  fontSelect?.addEventListener('change', saveAppearance);
  const themeToggle = container.querySelector('#theme-toggle');
  themeToggle?.addEventListener('click', (event) => {
    const button = event.target.closest('[data-theme-value]');
    if (!button) return;
    applyTheme(button.dataset.themeValue);
    themeToggle.querySelectorAll('.theme-toggle__btn').forEach((candidate) => {
      const active = candidate === button;
      candidate.classList.toggle('theme-toggle__btn--active', active);
      candidate.setAttribute('aria-pressed', String(active));
    });
  });

  // Gerätelokal wie das Theme darüber: kein Server-Request, keine Preference.
  // Wirksam wird er auf der Dashboard-Route - der Toast sagt das, statt den
  // Nutzer wortlos aus den Einstellungen zu werfen.
  const wallToggle = container.querySelector('#wall-mode-toggle');
  wallToggle?.addEventListener('change', () => {
    setWallModeEnabled(wallToggle.checked);
    window.yuvomi?.showToast(
      wallToggle.checked
        ? t('settings.wallModeOn', { page: t('nav.dashboard') })
        : t('settings.wallModeOff'),
      'success',
    );
  });

  const localeSelect = container.querySelector('#locale-select');
  localeSelect?.addEventListener('change', async () => {
    const errorElement = container.querySelector('#locale-error');
    clearError(errorElement);
    localeSelect.disabled = true;
    try {
      if (localeSelect.value === 'system') {
        safeStorageRemove('yuvomi-locale');
        location.reload();
        return;
      }
      const locale = localeSelect.value;
      await setLocale(locale);
      await render(container, { user });
    } catch (error) {
      showError(errorElement, error.message);
    } finally {
      if (localeSelect.isConnected) localeSelect.disabled = false;
    }
  });

  // Datensprache: anders als der Locale-Picker darüber schreibt sie eine
  // haushaltweite Preference und betitelt serverseitig die bereits gespeicherten
  // Geburtstags-Termine um. Danach neu rendern, damit das Automatik-Label die
  // eventuell veränderte Ableitung zeigt.
  const dataLanguageSelect = container.querySelector('#data-language-select');
  let persistedDataLanguage = dataLanguageSelect?.value ?? '';
  dataLanguageSelect?.addEventListener('change', async () => {
    const errorElement = container.querySelector('#data-language-error');
    clearError(errorElement);
    dataLanguageSelect.disabled = true;
    try {
      await savePreferences({ language: dataLanguageSelect.value || null });
      persistedDataLanguage = dataLanguageSelect.value;
      // Nur die Optionen neu aufbauen statt die Seite: ein voller Re-Render nähme
      // dem gerade bedienten Select den Fokus und würde eine noch nicht
      // gespeicherte "Benutzerdefiniert"-Wahl im Region-Block wieder zuklappen.
      await refreshDataLanguageOptions(container);
      window.yuvomi?.showToast(t('settings.dataLanguageSaved'), 'success');
    } catch (error) {
      // Zurück auf den gespeicherten Wert: sonst zeigt die Seite eine
      // Datensprache an, die nie geschrieben wurde.
      dataLanguageSelect.value = persistedDataLanguage;
      showError(errorElement, error.message);
    } finally {
      if (dataLanguageSelect.isConnected) dataLanguageSelect.disabled = false;
    }
  });

  const timezoneSelect = container.querySelector('#timezone-select');
  timezoneSelect?.addEventListener('change', async () => {
    const errorElement = container.querySelector('#timezone-error');
    clearError(errorElement);
    timezoneSelect.disabled = true;
    try {
      const saved = await savePreferences({ timezone: timezoneSelect.value || null });
      // Neu beschriften statt nur zu speichern: das Label der ersten Option
      // nennt die Zone, die bei "Automatisch" GILT. Wer von einer gesetzten Zone
      // auf Automatisch zurückstellt, sieht sonst weiter den alten Rückfallwert.
      // Genommen wird die PUT-Antwort, nicht ein zweiter GET - beide Felder
      // stehen dort, und der Server hat sie gerade frisch aufgelöst.
      timezoneSelect.replaceChildren();
      timezoneSelect.insertAdjacentHTML(
        'beforeend', timeZoneOptions(saved?.data?.timezone, saved?.data?.timezone_effective)
      );
      // Die Anzeige folgt der neuen Zone sofort - dasselbe Paar aus Spiegeln und
      // Neuzeichnen wie bei Datums- und Zeitformat. Ohne das Ereignis blieben die
      // bereits gezeichneten Uhrzeiten bis zum naechsten Seitenwechsel stehen.
      setDisplayTimeZone(saved?.data?.timezone ?? null);
      window.dispatchEvent(new CustomEvent('timezone-changed', {
        detail: { timezone: saved?.data?.timezone ?? null },
      }));
      window.yuvomi?.showToast(t('settings.timezoneSaved'), 'success');
    } catch (error) {
      showError(errorElement, error.message);
    } finally {
      if (timezoneSelect.isConnected) timezoneSelect.disabled = false;
    }
  });

  const regionSelect = container.querySelector('#region-select');
  regionSelect?.addEventListener('change', async () => {
    const customBlock = container.querySelector('#custom-formats');
    if (regionSelect.value === CUSTOM_REGION) {
      if (customBlock) customBlock.hidden = false;
      return;
    }
    const preset = REGION_PRESETS[regionSelect.value];
    if (!preset) return;
    const errorElement = container.querySelector('#region-error');
    clearError(errorElement);
    regionSelect.disabled = true;
    try {
      await savePreferences({
        currency: preset.currency,
        date_format: preset.date_format,
        time_format: preset.time_format,
        // Gewählte Region mitspeichern, sonst würde detectRegion() beim
        // nächsten Laden auf die erste Region mit gleichem Triple springen (#486).
        region: regionSelect.value,
      });
      const currencySelect = container.querySelector('#currency-select');
      if (currencySelect) currencySelect.value = preset.currency;
      const dateSelect = container.querySelector('#date-format-select');
      if (dateSelect) dateSelect.value = preset.date_format;
      const timeSelect = container.querySelector('#time-format-select');
      if (timeSelect) timeSelect.value = preset.time_format;
      safeStorageSet('yuvomi-date-format', preset.date_format);
      safeStorageSet('yuvomi-time-format', preset.time_format);
      applyNumberLocale({
        region: regionSelect.value,
        currency: preset.currency,
        date_format: preset.date_format,
        time_format: preset.time_format,
      });
      window.dispatchEvent(new CustomEvent('date-format-changed', {
        detail: { dateFormat: preset.date_format },
      }));
      window.dispatchEvent(new CustomEvent('time-format-changed', {
        detail: { timeFormat: preset.time_format },
      }));
      if (customBlock) customBlock.hidden = true;
      // Scheitert das Nachladen, bleibt nur das Automatik-Label stale - kein
      // Grund, den erfolgreichen Regionswechsel als Fehler zu melden.
      await refreshDataLanguageOptions(container).catch(() => {});
      window.yuvomi?.showToast(t('settings.regionSaved'), 'success');
    } catch (error) {
      showError(errorElement, error.message);
    } finally {
      if (regionSelect.isConnected) regionSelect.disabled = false;
    }
  });

  const currencySelect = container.querySelector('#currency-select');
  let persistedCurrency = currencySelect?.value;
  currencySelect?.addEventListener('change', async () => {
    if (currencySelect.disabled) return;
    const errorElement = container.querySelector('#currency-error');
    clearError(errorElement);
    try {
      await persistCurrencySelection(
        currencySelect,
        persistedCurrency,
        () => savePreferences({ currency: currencySelect.value }),
      );
      persistedCurrency = currencySelect.value;
      syncRegionSelect(container);
      applyNumberLocale(readFormatState(container));
      window.yuvomi?.showToast(t('settings.currencySaved'), 'success');
    } catch (error) {
      showError(errorElement, error.message);
    }
  });

  const dateFormatSelect = container.querySelector('#date-format-select');
  dateFormatSelect?.addEventListener('change', async () => {
    const errorElement = container.querySelector('#date-format-error');
    clearError(errorElement);
    dateFormatSelect.disabled = true;
    try {
      await savePreferences({ date_format: dateFormatSelect.value });
      safeStorageSet('yuvomi-date-format', dateFormatSelect.value);
      window.dispatchEvent(new CustomEvent('date-format-changed', {
        detail: { dateFormat: dateFormatSelect.value },
      }));
      syncRegionSelect(container);
      applyNumberLocale(readFormatState(container));
      window.yuvomi?.showToast(t('settings.dateFormatSavedToast'), 'success');
    } catch (error) {
      showError(errorElement, error.message);
    } finally {
      dateFormatSelect.disabled = false;
    }
  });

  const timeFormatSelect = container.querySelector('#time-format-select');
  timeFormatSelect?.addEventListener('change', async () => {
    const errorElement = container.querySelector('#time-format-error');
    clearError(errorElement);
    timeFormatSelect.disabled = true;
    try {
      await savePreferences({ time_format: timeFormatSelect.value });
      safeStorageSet('yuvomi-time-format', timeFormatSelect.value);
      window.dispatchEvent(new CustomEvent('time-format-changed', {
        detail: { timeFormat: timeFormatSelect.value },
      }));
      syncRegionSelect(container);
      applyNumberLocale(readFormatState(container));
      window.yuvomi?.showToast(t('settings.timeFormatSavedToast'), 'success');
    } catch (error) {
      showError(errorElement, error.message);
    } finally {
      timeFormatSelect.disabled = false;
    }
  });
}

export async function render(container, { user }) {
  let renderAppearanceRevision = appearanceRevision();
  try {
    const loaded = await getPreferences();
    if (!container.isConnected || appearanceRevision() !== renderAppearanceRevision) return;
    const preferences = {
      ...normalizeAppearancePreferences(loaded),
      currency: loaded.currency || 'EUR',
      date_format: loaded.date_format || 'dmy',
      time_format: loaded.time_format || '24h',
      region: loaded.region || null,
      language: loaded.language || null,
      language_auto: loaded.language_auto || 'en',
      // Beide Zonen-Felder gehoeren hier durchgereicht: renderPage() liest sie
      // (Auswahlzustand und Automatik-Label), und ohne sie stand das Feld nach
      // dem Speichern beim naechsten Oeffnen wieder auf "Automatisch (UTC)" -
      // die Zone WAR gesetzt, das Formular zeigte sie nur nicht.
      timezone: loaded.timezone || null,
      timezone_effective: loaded.timezone_effective || null,
    };

    safeStorageSet('yuvomi-date-format', preferences.date_format);
    applyAppearancePreferences(preferences);
    renderAppearanceRevision = appearanceRevision();
    safeStorageSet('yuvomi-time-format', preferences.time_format);
    setDisplayTimeZone(preferences.timezone);
    applyNumberLocale(preferences);
    const isAdmin = user?.role === 'admin';
    renderPage(container, preferences, isAdmin);
    if (isAdmin) {
      appendCurrencyOptions(container.querySelector('#currency-select'), preferences.currency);
    }
    bindEvents(container, user);
    window.lucide?.createIcons({ el: container });
  } catch {
    if (!container.isConnected || appearanceRevision() !== renderAppearanceRevision) return;
    renderLoadError(container);
    container.querySelector('#appearance-retry')?.addEventListener('click', () => {
      render(container, { user });
    });
  }
}
