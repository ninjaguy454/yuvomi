// Personal visual choices are independent of device light/dark appearance.
import { normalizeNamedAppearance, normalizeUiSounds } from './named-appearance.js';
import { applyNamedAppearance, clearNamedAppearance } from './named-appearance-runtime.js';
import {configureUiSounds,resetUiSounds} from './ui-sounds.js';
const COLOR_THEMES = ['neutral', 'warm', 'cool'];
const HEADING_FONTS = ['default', 'serif'];
let revision = 0;

export function appearanceRevision() { return revision; }

export function normalizeAppearancePreferences(preferences = {}) {
  preferences ||= {};
  const values = {
    color_theme: COLOR_THEMES.includes(preferences.color_theme) ? preferences.color_theme : 'neutral',
    heading_font: HEADING_FONTS.includes(preferences.heading_font) ? preferences.heading_font : 'default',
  };
  if (Object.hasOwn(preferences,'named_appearance')) values.named_appearance = normalizeNamedAppearance(preferences.named_appearance);
  if (Object.hasOwn(preferences,'ui_sounds')) values.ui_sounds = normalizeUiSounds(preferences.ui_sounds);
  return values;
}

export function applyAppearancePreferences(preferences, { persist = true } = {}) {
  try { if(localStorage.getItem('vidamia-paired-device')==='1') persist=false; } catch { persist=false; }
  const values = normalizeAppearancePreferences(preferences);
  revision += 1;
  document.documentElement.setAttribute('data-color-theme', values.color_theme);
  document.documentElement.setAttribute('data-typography', values.heading_font);
  applyNamedAppearance(values.named_appearance??null,{persist});
  configureUiSounds(values.ui_sounds,document.documentElement.getAttribute?.('data-named-theme'));
  if (persist) {
    try { localStorage.setItem('yuvomi-appearance', JSON.stringify({color_theme:values.color_theme,heading_font:values.heading_font})); } catch { /* optional prepaint cache */ }
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
  resetUiSounds();
  clearNamedAppearance();
  try { localStorage.removeItem('yuvomi-appearance'); } catch { /* storage may be unavailable */ }
  applyAppearancePreferences({}, { persist: false });
}
if(typeof window!=='undefined'&&window.addEventListener)window.addEventListener('auth:context-ending',resetAppearancePreferences);
