// Personal visual choices are independent of device light/dark appearance.
const COLOR_THEMES = ['neutral', 'warm', 'cool'];
const HEADING_FONTS = ['default', 'serif'];
let revision = 0;

export function appearanceRevision() { return revision; }

export function normalizeAppearancePreferences(preferences = {}) {
  preferences ||= {};
  return {
    color_theme: COLOR_THEMES.includes(preferences.color_theme) ? preferences.color_theme : 'neutral',
    heading_font: HEADING_FONTS.includes(preferences.heading_font) ? preferences.heading_font : 'default',
  };
}

export function applyAppearancePreferences(preferences, { persist = true } = {}) {
  const values = normalizeAppearancePreferences(preferences);
  revision += 1;
  document.documentElement.setAttribute('data-color-theme', values.color_theme);
  document.documentElement.setAttribute('data-typography', values.heading_font);
  if (persist) {
    try { localStorage.setItem('yuvomi-appearance', JSON.stringify(values)); } catch { /* optional prepaint cache */ }
  }
  window.dispatchEvent(new CustomEvent('appearance-preferences-changed', { detail: values }));
  return values;
}

export function applyStoredAppearancePreferences() {
  let values;
  try { values = JSON.parse(localStorage.getItem('yuvomi-appearance') || '{}'); } catch { values = {}; }
  return applyAppearancePreferences(values, { persist: false });
}

export function resetAppearancePreferences() {
  try { localStorage.removeItem('yuvomi-appearance'); } catch { /* storage may be unavailable */ }
  applyAppearancePreferences({}, { persist: false });
}
