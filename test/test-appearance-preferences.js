import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { eachRule } from './css-rules.js';
import { applyAppearancePreferences, resetAppearancePreferences, normalizeAppearancePreferences, appearanceRevision } from '../public/utils/appearance-preferences.js';

const tokens = readFileSync(new URL('../public/styles/tokens.css', import.meta.url), 'utf8');
const rules = [...eachRule(tokens)];
function declarations(body) {
  return Object.fromEntries([...body.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)].map((m) => [m[1], m[2].trim()]));
}
function palette(theme, mode) {
  const values = {};
  const apply = (rule) => Object.assign(values, declarations(rule.body));
  rules.filter((r) => r.selector === ':root' && !r.at.length).forEach(apply);
  if (mode === 'dark') rules.filter((r) => r.selector === '[data-theme="dark"]').forEach(apply);
  if (theme !== 'neutral') {
    rules.filter((r) => r.selector === `:root[data-color-theme="${theme}"]`).forEach(apply);
    rules.filter((r) => r.selector.startsWith(':root:is([data-color-theme=') && !r.at.length).forEach(apply);
    if (mode === 'dark') rules.filter((r) => r.selector.startsWith(':root:is([data-color-theme=') && r.selector.endsWith('[data-theme="dark"]')).forEach(apply);
  }
  const resolve = (key, depth = 0) => {
    assert.ok(depth < 20, `cyclic token ${key}`);
    assert.ok(values[key] !== undefined, `missing token ${key}`);
    return values[key].replace(/var\((--[\w-]+)\)/g, (_, next) => resolve(next, depth + 1));
  };
  return { values, resolve };
}
function luminance(hex) {
  assert.match(hex, /^#[\da-f]{6}$/i);
  const channels = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((v) => v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4);
  return channels[0] * .2126 + channels[1] * .7152 + channels[2] * .0722;
}
function contrast(a, b) {
  const [high, low] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (high + .05) / (low + .05);
}
function mix(a, b, weight) {
  return '#' + [1, 3, 5].map((offset) => Math.round(parseInt(a.slice(offset, offset + 2), 16) * weight
    + parseInt(b.slice(offset, offset + 2), 16) * (1 - weight)).toString(16).padStart(2, '0')).join('');
}
for (const theme of ['neutral', 'warm', 'cool']) {
  for (const mode of ['light', 'dark']) {
    test(`${theme}/${mode}: readable text, recognizable semantic color, visible focus`, () => {
      const colors = palette(theme, mode);
      const backgrounds = ['--color-bg', '--color-surface', '--color-surface-2', '--color-surface-3', '--color-surface-raised'];
      for (const foreground of ['--color-text-primary', '--color-text-secondary', '--color-text-tertiary']) {
        for (const background of backgrounds) {
          const ratio = contrast(colors.resolve(foreground), colors.resolve(background));
          assert.ok(ratio >= 4.5, `${foreground} on ${background}: ${ratio.toFixed(2)}:1`);
        }
      }
      for (const foreground of ['--color-accent', '--color-success', '--color-danger', '--color-warning']) {
        for (const background of ['--color-bg', '--color-surface', '--color-surface-raised']) {
          const ratio = contrast(colors.resolve(foreground), colors.resolve(background));
          assert.ok(ratio >= 4.5, `${foreground} on ${background}: ${ratio.toFixed(2)}:1`);
        }
      }
      assert.ok(contrast(colors.resolve('--color-accent'), colors.resolve('--color-surface')) >= 3);
      for (const background of ['--color-surface', '--color-surface-work']) {
        assert.ok(contrast(colors.resolve('--color-border-control'), colors.resolve(background)) >= 3,
          `input boundaries meet 3:1 against ${background}`);
      }
      for (const foreground of Object.keys(colors.values).filter((key) => /^--module-[a-z-]+$/.test(key))) {
        if (!/^#[\da-f]{6}$/i.test(colors.resolve(foreground))) continue;
        for (const background of ['--color-bg', '--color-surface', '--color-surface-raised']) {
          const ratio = contrast(colors.resolve(foreground), colors.resolve(background));
          assert.ok(ratio >= 4.5, `${foreground} on ${background}: ${ratio.toFixed(2)}:1`);
        }
      }
      assert.notEqual(colors.resolve('--color-text-disabled'), colors.resolve('--color-text-secondary'));
    });
    test(`${theme}/${mode}: themed action, selection and hover ink retain contrast`, () => {
      const colors = palette(theme, mode);
      for (const fill of ['--color-accent-light', '--color-accent-subtle']) {
        assert.ok(contrast(colors.resolve('--color-accent'), colors.resolve(fill)) >= 4.5, `${fill}: selected text`);
      }
      for (const weight of [.88, .76]) {
        const fill = mix(colors.resolve('--color-accent'), colors.resolve('--neutral-950'), weight);
        assert.ok(contrast(colors.resolve('--color-ink-on-vivid'), fill) >= 4.5, `${weight}: primary button label`);
      }
      for (const fill of ['--color-btn-primary', '--color-btn-primary-hover']) {
        assert.ok(contrast(colors.resolve('--color-text-on-accent'), colors.resolve(fill)) >= 4.5, `${fill}: legacy label`);
      }
      for (const fill of ['--color-bg', '--color-surface', '--color-surface-raised']) {
        assert.ok(contrast(colors.resolve('--color-accent-hover'), colors.resolve(fill)) >= 4.5, `${fill}: hover text`);
      }
    });
  }
}

function browser(storage = new Map()) {
  const attrs = new Map([['data-theme', 'dark']]);
  const events = [];
  return {
    attrs, storage, events,
    document: { documentElement: { setAttribute: (k, v) => attrs.set(k, v), removeAttribute: (k) => attrs.delete(k) }, querySelectorAll: () => [] },
    window: { dispatchEvent: (event) => events.push(event) },
    localStorage: { getItem: (k) => storage.get(k) ?? null, setItem: (k, v) => storage.set(k, v), removeItem: (k) => storage.delete(k) },
    CustomEvent: class { constructor(type, options) { this.type = type; this.detail = options.detail; } },
  };
}

test('personal choices apply immediately, persist, and clear without changing device appearance', () => {
  const env = browser();
  Object.assign(globalThis, { document: env.document, window: env.window, localStorage: env.localStorage, CustomEvent: env.CustomEvent });
  applyAppearancePreferences({ color_theme: 'warm', heading_font: 'serif' });
  assert.equal(env.attrs.get('data-color-theme'), 'warm');
  assert.equal(env.attrs.get('data-typography'), 'serif');
  assert.equal(env.attrs.get('data-theme'), 'dark');
  assert.deepEqual(JSON.parse(env.storage.get('yuvomi-appearance')), { color_theme: 'warm', heading_font: 'serif' });
  const preview = appearanceRevision();
  resetAppearancePreferences();
  assert.ok(appearanceRevision() > preview, 'logout invalidates pending rollback');
  assert.equal(env.attrs.get('data-color-theme'), 'neutral');
  assert.equal(env.attrs.get('data-typography'), 'default');
  assert.equal(env.attrs.get('data-theme'), 'dark');
  assert.equal(env.storage.has('yuvomi-appearance'), false);
});

test('invalid preferences and unavailable storage have safe defaults', () => {
  assert.deepEqual(normalizeAppearancePreferences(null), { color_theme: 'neutral', heading_font: 'default' });
  assert.deepEqual(normalizeAppearancePreferences({ color_theme: '<style>', heading_font: 'remote-font' }), { color_theme: 'neutral', heading_font: 'default' });
  const env = browser();
  Object.assign(globalThis, { document: env.document, window: env.window, CustomEvent: env.CustomEvent,
    localStorage: { setItem() { throw new Error('disabled'); }, removeItem() { throw new Error('disabled'); } } });
  assert.doesNotThrow(() => applyAppearancePreferences({ color_theme: 'cool', heading_font: 'serif' }));
  assert.equal(env.attrs.get('data-color-theme'), 'cool');
  assert.doesNotThrow(resetAppearancePreferences);
});

test('prepaint restores valid choices and survives blocked storage', () => {
  const source = readFileSync(new URL('../public/theme-init.js', import.meta.url), 'utf8');
  const env = browser(new Map([['yuvomi-theme', 'dark'], ['yuvomi-appearance', JSON.stringify({ color_theme: 'cool', heading_font: 'serif' })]]));
  vm.runInNewContext(source, { ...env, sessionStorage: env.localStorage, location: { pathname: '/tasks' } });
  assert.equal(env.attrs.get('data-color-theme'), 'cool');
  assert.equal(env.attrs.get('data-typography'), 'serif');
  assert.equal(env.attrs.get('data-theme'), 'dark');
  const blocked = browser();
  vm.runInNewContext(source, { ...blocked, localStorage: { getItem() { throw new Error('disabled'); } }, sessionStorage: {}, location: { pathname: '/' } });
  assert.equal(blocked.attrs.get('data-color-theme'), 'neutral');
});

test('serif is confined to heading roles and uses local fonts', () => {
  const source = readFileSync(new URL('../public/styles/typography.css', import.meta.url), 'utf8');
  const headingRule = [...eachRule(source)].find((rule) => rule.body.includes('font-family: var(--font-heading)'));
  assert.ok(headingRule.selector.includes('.recipe-card__title'));
  assert.ok(headingRule.selector.includes('.meal-card__title'));
  assert.ok(headingRule.selector.includes('.meal-choice-card__headline strong'));
  assert.ok(headingRule.selector.includes('.recipe-row .list-row__name'));
  assert.ok(headingRule.selector.includes('.clock-widget__time'));
  assert.doesNotMatch(headingRule.selector, /(^|[,\s])(button|input|select|textarea|nav|table|body)([,\s]|$)/);
  assert.match(tokens, /--font-serif:[^;]*Georgia, serif/);
  assert.doesNotMatch(tokens, /@font-face|fonts\.google/);
});

function bindAppearanceForm(savePreferences) {
  const env = browser();
  Object.assign(globalThis, { document: env.document, window: env.window, localStorage: env.localStorage, CustomEvent: env.CustomEvent });
  const control = (value) => ({ value, disabled: false, listeners: {}, addEventListener(type, fn) { this.listeners[type] = fn; } });
  const color = control('neutral');
  const font = control('default');
  const error = { hidden: true, textContent: '' };
  const nodes = { '#color-theme-select': color, '#heading-font-select': font, '#appearance-choice-error': error };
  const container = { isConnected: true, querySelector: (selector) => nodes[selector] };
  const source = readFileSync(new URL('../public/settings/pages/personal-appearance.js', import.meta.url), 'utf8');
  const start = source.indexOf('  const colorSelect =', source.indexOf('function bindEvents('));
  const end = source.indexOf('  const themeToggle =', start);
  assert.ok(start > 0 && end > start);
  vm.runInNewContext(`(function(container) { ${source.slice(start, end)} })(container);`, {
    container, window: env.window, savePreferences, applyAppearancePreferences, normalizeAppearancePreferences, appearanceRevision,
    t: (key) => key, clearError: (node) => { node.hidden = true; node.textContent = ''; },
    showError: (node, message) => { node.hidden = false; node.textContent = message; },
  });
  return { ...env, container, color, font, error };
}

test('Appearance previews instantly and restores the saved values after a failed save', async () => {
  let reject;
  const ui = bindAppearanceForm(() => new Promise((_resolve, fail) => { reject = fail; }));
  ui.color.value = 'warm';
  ui.font.value = 'serif';
  const pending = ui.color.listeners.change();
  assert.equal(ui.attrs.get('data-color-theme'), 'warm');
  assert.equal(ui.attrs.get('data-typography'), 'serif');
  assert.equal(ui.color.disabled, true);
  reject(new Error('Save unavailable'));
  await pending;
  assert.equal(ui.attrs.get('data-color-theme'), 'neutral');
  assert.equal(ui.font.value, 'default');
  assert.equal(ui.error.textContent, 'Save unavailable');
  assert.equal(ui.color.disabled, false);
});

test('late save failure cannot restore another account appearance after logout', async () => {
  let reject;
  const ui = bindAppearanceForm(() => new Promise((_resolve, fail) => { reject = fail; }));
  ui.color.value = 'cool';
  const pending = ui.color.listeners.change();
  ui.container.isConnected = false;
  resetAppearancePreferences();
  applyAppearancePreferences({ color_theme: 'warm', heading_font: 'serif' });
  reject(new Error('Session ended'));
  await pending;
  assert.equal(ui.attrs.get('data-color-theme'), 'warm');
  assert.equal(ui.attrs.get('data-typography'), 'serif');
  assert.equal(ui.error.hidden, true);
});

test('leaving Settings during a failed save still rolls back the unsaved global preview', async () => {
  let reject;
  const ui = bindAppearanceForm(() => new Promise((_resolve, fail) => { reject = fail; }));
  ui.color.value = 'cool';
  const pending = ui.color.listeners.change();
  ui.container.isConnected = false;
  reject(new Error('Offline'));
  await pending;
  assert.equal(ui.attrs.get('data-color-theme'), 'neutral');
  assert.equal(ui.error.hidden, true);
});

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

function preferenceSyncHarness(response) {
  const env = browser();
  Object.assign(globalThis, { document: env.document, window: env.window, localStorage: env.localStorage, CustomEvent: env.CustomEvent });
  const noop = () => {};
  const context = vm.createContext({
    _preferencesLoaded: false, currentUser: { id: 1 },
    api: { get: (path) => path === '/preferences' ? response : Promise.resolve({}) },
    localStorage: env.localStorage, applyAppearancePreferences, appearanceRevision,
    setDisplayTimeZone: noop, numberLocaleFor: noop, setAppName: noop, setAppVersion: noop,
    setMaxUploadBytes: noop, updateBranding: noop, syncThirdPartyModules: noop,
  });
  const source = readFileSync(new URL('../public/router.js', import.meta.url), 'utf8');
  const start = source.indexOf('async function syncPreferencesOnce()');
  const end = source.indexOf('\nasync function syncThirdPartyModules()', start);
  assert.ok(start > 0 && end > start);
  vm.runInContext(source.slice(start, end), context);
  return { ...env, context, run: () => vm.runInContext('syncPreferencesOnce()', context) };
}

test('startup appearance reads apply for their current account', async () => {
  const ui = preferenceSyncHarness(Promise.resolve({ data: { color_theme: 'cool', heading_font: 'serif' } }));
  await ui.run();
  assert.equal(ui.attrs.get('data-color-theme'), 'cool');
  assert.equal(ui.attrs.get('data-typography'), 'serif');
});

test('late startup preferences cannot restore the previous account after logout or account switch', async () => {
  for (const nextUser of [null, { id: 2 }]) {
    const request = deferred();
    const ui = preferenceSyncHarness(request.promise);
    const pending = ui.run();
    resetAppearancePreferences();
    ui.context.currentUser = nextUser;
    if (nextUser) applyAppearancePreferences({ color_theme: 'cool', heading_font: 'default' });
    request.resolve({ data: { color_theme: 'warm', heading_font: 'serif' } });
    await pending;
    assert.equal(ui.attrs.get('data-color-theme'), nextUser ? 'cool' : 'neutral');
    assert.equal(ui.attrs.get('data-typography'), 'default');
    if (!nextUser) assert.equal(ui.storage.has('yuvomi-appearance'), false);
  }
});

test('late startup preferences cannot overwrite a newer appearance choice in the same account', async () => {
  const request = deferred();
  const ui = preferenceSyncHarness(request.promise);
  const pending = ui.run();
  applyAppearancePreferences({ color_theme: 'cool', heading_font: 'serif' });
  request.resolve({ data: { color_theme: 'warm', heading_font: 'default' } });
  await pending;
  assert.equal(ui.attrs.get('data-color-theme'), 'cool');
  assert.equal(ui.attrs.get('data-typography'), 'serif');
});

test('late Appearance page reads and failures stop after navigation or logout', async () => {
  for (const detach of [false, true]) {
    for (const fail of [false, true]) {
      const env = browser();
      Object.assign(globalThis, { document: env.document, window: env.window, localStorage: env.localStorage, CustomEvent: env.CustomEvent });
      const request = deferred();
      const container = { isConnected: true, querySelector: () => null };
      let rendered = false;
      const noop = () => {};
      const context = vm.createContext({
        container, appearanceRevision, applyAppearancePreferences, normalizeAppearancePreferences,
        getPreferences: () => request.promise, safeStorageSet: noop, setDisplayTimeZone: noop, applyNumberLocale: noop,
        renderPage: () => { rendered = true; }, renderLoadError: () => { rendered = true; }, bindEvents: noop, window: {},
      });
      const source = readFileSync(new URL('../public/settings/pages/personal-appearance.js', import.meta.url), 'utf8');
      const start = source.indexOf('export async function render(');
      assert.ok(start > 0);
      vm.runInContext(source.slice(start).replace('export async', 'async'), context);
      const pending = vm.runInContext('render(container, { user: { id: 1, role: "member" } })', context);
      if (detach) container.isConnected = false;
      resetAppearancePreferences();
      if (fail) request.reject(new Error('Old request failed'));
      else request.resolve({ color_theme: 'warm', heading_font: 'serif' });
      await pending;
      assert.equal(env.attrs.get('data-color-theme'), 'neutral');
      assert.equal(env.attrs.get('data-typography'), 'default');
      assert.equal(env.storage.has('yuvomi-appearance'), false);
      assert.equal(rendered, false);
    }
  }
});
