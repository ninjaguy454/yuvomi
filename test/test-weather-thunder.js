import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync, readdirSync} from 'node:fs';
import {registerHooks} from 'node:module';

// DOM and audio hardware are unavailable in node:test. The production engine,
// settings component, appearance state and buffer synthesis remain real.
registerHooks({resolve(specifier, context, nextResolve) {
  return nextResolve(specifier.startsWith('/') ? new URL('../public' + specifier, import.meta.url).href : specifier, context);
}});
const attrs = new Map();
globalThis.document = new EventTarget();
document.visibilityState = 'visible';
document.hasFocus = () => true;
document.querySelectorAll = () => [];
document.getElementById = () => null;
document.documentElement = {
  getAttribute: key => attrs.get(key) ?? null,
  setAttribute: (key, value) => attrs.set(key, value),
  removeAttribute: key => attrs.delete(key),
  style: {setProperty() {}, removeProperty() {}},
};
globalThis.window = new EventTarget();
globalThis.CustomEvent = class extends Event {constructor(type, options) {super(type); this.detail = options?.detail;}};
globalThis.localStorage = {getItem: () => null, setItem() {}, removeItem() {}};

let contexts = [], audioFailure = null, deferredResumes = [];
class AudioNode {
  constructor() {this.connections = []; this.disconnected = false;}
  connect(node) {this.connections.push(node);}
  disconnect() {this.disconnected = true;}
}
class Source extends AudioNode {
  start() {if (audioFailure === 'start') throw Error('Audio refused'); this.started = true;}
  stop() {this.stopped = true; this.onended?.();}
}
class TestAudioContext extends EventTarget {
  constructor() {super(); this.state = 'suspended'; this.sampleRate = 4000; this.currentTime = 0; this.destination = {}; this.sources = []; this.gains = []; this.filters = []; contexts.push(this);}
  resume() {if (audioFailure === 'resume') return Promise.reject(Error('Audio refused')); if (audioFailure === 'deferred') return new Promise((resolve, reject) => deferredResumes.push({resolve, reject})); this.state = 'running'; return Promise.resolve();}
  close() {this.state = 'closed'; this.dispatchEvent(new Event('statechange')); return Promise.resolve();}
  createBuffer(channels, length, sampleRate) {if (audioFailure === 'buffer') throw Error('Audio refused'); const data = new Float32Array(length); return {length, sampleRate, numberOfChannels: channels, getChannelData: () => data};}
  createBufferSource() {const node = new Source(); this.sources.push(node); return node;}
  createBiquadFilter() {const node = new AudioNode(); node.frequency = {}; node.Q = {}; this.filters.push(node); return node;}
  createGain() {const node = new AudioNode(); node.gain = {value: 1, setValueAtTime() {}, exponentialRampToValueAtTime() {}}; this.gains.push(node); return node;}
  createOscillator() {const node = new Source(); node.frequency = {}; this.sources.push(node); return node;}
}
globalThis.AudioContext = TestAudioContext;
const sound = await import('../public/utils/ui-sounds.js');
const {defaultNamedAppearance} = await import('../public/utils/named-appearance.js');
let appearance, mountUiSoundSettings;
async function loadSettings() {
  appearance ??= await import('../public/utils/named-appearance-runtime.js');
  ({mountUiSoundSettings} = await import('../public/components/ui-sound-settings.js'));
}
const enabled = {version: 1, mode: 'pack', pack: 'glass', volume: 15};
const trusted = {isTrusted: true};
const realTimeout = globalThis.setTimeout, realClearTimeout = globalThis.clearTimeout;
let pending, scheduled, nextTimer;
test.beforeEach(() => {
  sound.resetUiSounds(); contexts = []; audioFailure = null; deferredResumes = []; attrs.clear();
  document.visibilityState = 'visible'; document.hasFocus = () => true;
  pending = new Map(); scheduled = []; nextTimer = 0;
  globalThis.setTimeout = (fn, delay) => {const id = ++nextTimer; pending.set(id, fn); scheduled.push({id, fn, delay}); return id;};
  globalThis.clearTimeout = id => pending.delete(id);
});
test.afterEach(() => {sound.resetUiSounds(); appearance?.clearNamedAppearance(); globalThis.setTimeout = realTimeout; globalThis.clearTimeout = realClearTimeout;});
const queue = (id = 'flash-1', delayMs = 2100) => sound.queueWeatherThunder({id, delayMs});
function fireLast() {const item = scheduled.at(-1); pending.delete(item.id); item.fn();}
function consent(config = enabled, theme = 'local-weather-storm-day') {
  sound.configureUiSounds(config, theme);
  assert.equal(sound.setWeatherThunderOptIn(true, trusted), true);
}

test('Weather thunder defaults silent and does not create a context from renderer events', () => {
  assert.equal(typeof sound.queueWeatherThunder, 'function', 'canonical thunder API exists');
  sound.configureUiSounds(enabled, 'local-weather-storm-day');
  assert.equal(sound.weatherThunderEnabled(), false);
  assert.equal(queue(), false);
  assert.equal(contexts.length, 0);
  assert.equal(pending.size, 0);
});

test('only trusted foreground opt-in activates audio, independent of canonical mode ordering', () => {
  assert.equal(typeof sound.setWeatherThunderOptIn, 'function');
  assert.equal(sound.setWeatherThunderOptIn(true, {isTrusted: false}), false);
  document.hasFocus = () => false;
  assert.equal(sound.setWeatherThunderOptIn(true, trusted), false);
  document.hasFocus = () => true;
  assert.equal(sound.setWeatherThunderOptIn(true, trusted), true, 'consent before mode');
  assert.equal(sound.weatherThunderEnabled(), true);
  assert.equal(queue(), false, 'canonical default remains Off');
  sound.configureUiSounds(enabled, 'local-weather-storm-day');
  assert.equal(queue(), true);
  fireLast();
  assert.equal(contexts[0].sources.filter(source => source.started).length, 1);
  sound.resetUiSounds();
  sound.configureUiSounds(enabled, 'local-weather-storm-day');
  assert.equal(sound.setWeatherThunderOptIn(true, trusted), true, 'mode before consent');
  assert.equal(queue(), true);
});

test('Off, zero volume and Night Shift Theme default prohibit rumble without changing consent or v1 persistence', () => {
  assert.equal(typeof sound.setWeatherThunderOptIn, 'function');
  consent();
  for (const [config, theme] of [[{...enabled, mode: 'off'}, 'local-weather-storm-day'], [{...enabled, volume: 0}, 'local-weather-storm-day'], [{...enabled, mode: 'theme'}, 'night-shift']]) {
    sound.configureUiSounds(config, theme);
    assert.equal(queue(), false);
    assert.equal(sound.weatherThunderEnabled(), true);
    assert.deepEqual(sound.currentUiSounds(), config);
  }
  sound.configureUiSounds({...enabled, mode: 'pack'}, 'night-shift');
  assert.equal(queue(), true, 'explicit selected pack retains the existing Night Shift policy');
});

test('one bounded delayed event replaces its predecessor and canceled generations cannot play', () => {
  assert.equal(typeof sound.setWeatherThunderOptIn, 'function');
  consent();
  assert.equal(queue('first', 90000), true);
  assert.ok(scheduled[0].delay <= 4000);
  assert.equal(queue('first', 90000), false, 'duplicate flash is consumed once');
  const stale = scheduled[0];
  assert.equal(queue('second', -10), true);
  assert.equal(pending.size, 1);
  assert.equal(scheduled[1].delay, 0);
  stale.fn();
  assert.equal(contexts[0].sources.length, 0);
  fireLast();
  assert.equal(contexts[0].sources.filter(source => source.started).length, 1);
  assert.equal(queue('second'), false, 'completed flash cannot play twice');
  assert.equal(queue('third'), true);
  fireLast();
  assert.equal(contexts[0].sources[0].stopped, true);
  assert.equal(contexts[0].sources.filter(source => source.started && !source.stopped).length, 1);
});

test('invalid event IDs and delays do not allocate timers', () => {
  assert.equal(typeof sound.setWeatherThunderOptIn, 'function');
  consent();
  for (const event of [{}, {id: null, delayMs: 1}, {id: {}, delayMs: 1}, {id: '', delayMs: 1}, {id: 'a', delayMs: NaN}, {id: 'a', delayMs: Infinity}]) assert.equal(sound.queueWeatherThunder(event), false);
  assert.equal(pending.size, 0);
});

test('every canonical mode, pack, or volume update cancels pending and active rumble while keeping consent', () => {
  assert.equal(typeof sound.setWeatherThunderOptIn, 'function');
  consent();
  let id = 0, emitted = 0;
  for (const config of [{...enabled, pack: 'wood'}, {...enabled, volume: 14}, {...enabled, mode: 'theme'}, enabled]) {
    assert.equal(queue(++id), true);
    const stale = scheduled.at(-1);
    sound.configureUiSounds(config, 'local-weather-storm-day');
    assert.equal(pending.size, 0);
    stale.fn();
    assert.equal(contexts[0].sources.length, emitted);
    assert.equal(queue(++id), true);
    fireLast();
    emitted++;
    sound.configureUiSounds(config, 'local-weather-storm-day');
    assert.equal(contexts[0].sources.at(-1).stopped, true);
    assert.equal(sound.weatherThunderEnabled(), true);
  }
});

test('approved normalized rumble has a soft attack, bounded waveform, low-pass filter and canonical gain', () => {
  assert.equal(typeof sound.setWeatherThunderOptIn, 'function');
  consent({...enabled, volume: 7}); queue(); fireLast();
  const ctx = contexts[0], source = ctx.sources[0], samples = source.buffer.getChannelData(0);
  assert.equal(source.buffer.numberOfChannels, 1);
  assert.equal(source.buffer.length, Math.floor(ctx.sampleRate * 2.2));
  assert.equal(Math.abs(samples[0]), 0);
  assert.ok(Math.max(...samples.map(Math.abs)) <= .8);
  assert.ok(samples.some(sample => sample !== 0));
  assert.ok(Math.abs(samples.at(-1)) < .001);
  assert.equal(ctx.filters[0].type, 'lowpass');
  assert.equal(ctx.filters[0].frequency.value, 280);
  assert.equal(ctx.filters[0].Q.value, .3);
  assert.ok(ctx.gains[0].gain.value > 0 && ctx.gains[0].gain.value <= .007 + Number.EPSILON);
  sound.configureUiSounds({...enabled, volume: 100}, 'local-weather-storm-day'); queue('louder'); fireLast();
  assert.ok(ctx.gains[1].gain.value <= .025);
});

test('toggle, blur, hidden, pagehide and auth ending silence delayed and active voices', () => {
  assert.equal(typeof sound.setWeatherThunderOptIn, 'function');
  for (const [target, event, resets] of [[window, 'blur', false], [document, 'visibilitychange', false], [window, 'pagehide', true], [window, 'auth:context-ending', true]]) {
    consent(); queue(event); const stale = scheduled.at(-1);
    if (event === 'visibilitychange') document.visibilityState = 'hidden';
    target.dispatchEvent(new Event(event)); stale.fn();
    assert.equal(pending.size, 0); assert.equal(contexts.at(-1).sources.length, 0);
    assert.equal(sound.weatherThunderEnabled(), !resets);
    document.visibilityState = 'visible';
    consent(); queue(event + '-active'); fireLast(); const source = contexts.at(-1).sources.at(-1);
    if (event === 'visibilitychange') document.visibilityState = 'hidden';
    target.dispatchEvent(new Event(event)); assert.equal(source.stopped, true);
    document.visibilityState = 'visible'; sound.resetUiSounds();
  }
  consent(); queue(); fireLast();
  assert.equal(sound.setWeatherThunderOptIn(false), false);
  assert.equal(contexts.at(-1).sources.at(-1).stopped, true);
  assert.equal(sound.weatherThunderEnabled(), false);
});

test('owner reset and context suspension prevent stale audio, including later reactivation', () => {
  assert.equal(typeof sound.setWeatherThunderOptIn, 'function');
  consent(); queue(); const stale = scheduled.at(-1);
  sound.cancelWeatherThunder({resetOptIn: true});
  assert.equal(sound.weatherThunderEnabled(), false);
  consent(); stale.fn(); assert.equal(contexts[0].sources.length, 0);
  queue('suspend'); const second = scheduled.at(-1);
  contexts[0].state = 'suspended'; contexts[0].dispatchEvent(new Event('statechange'));
  assert.equal(pending.size, 0); assert.equal(queue('while-suspended'), false);
  sound.setWeatherThunderOptIn(true, trusted); second.fn(); assert.equal(contexts[0].sources.length, 0);
  queue('close'); void contexts[0].close();
  assert.equal(pending.size, 0); assert.equal(sound.weatherThunderEnabled(), false);
});

test('foreground is checked again when the delay fires without relying on blur delivery', () => {
  assert.equal(typeof sound.setWeatherThunderOptIn, 'function');
  consent(); queue(); document.hasFocus = () => false; fireLast();
  assert.equal(contexts[0].sources.length, 0);
});

test('current owner and fresh storm facts are checked before queueing and again after the artistic delay', () => {
  consent(); let current = false;
  assert.equal(sound.queueWeatherThunder({id: 'outdated', delayMs: 2000, isCurrent: () => current}), false);
  current = true;
  assert.equal(sound.queueWeatherThunder({id: 'expires', delayMs: 2000, isCurrent: () => current}), true);
  current = false; fireLast();
  assert.equal(contexts[0].sources.length, 0);
  assert.equal(sound.queueWeatherThunder({id: 'throws', delayMs: 2000, isCurrent() {throw Error('Owner disposed');}}), false);
});

test('a rejected resume from an ended context cannot cancel the new owner audio generation', async () => {
  audioFailure = 'deferred'; consent();
  sound.resetUiSounds(); audioFailure = null;
  consent(); queue('new-owner');
  deferredResumes[0].reject(Error('Old owner audio refused'));
  await Promise.resolve();
  assert.equal(pending.size, 1);
  fireLast(); assert.equal(contexts.at(-1).sources.length, 1);
});

test('canonical completion confirmation retains its single-use ticket and replaces the shared thunder voice', () => {
  consent(); const ticket = sound.captureCompletionSound(trusted);
  queue('before-completion'); fireLast(); const rumble = contexts[0].sources[0];
  assert.equal(sound.confirmCompletionSound(ticket, true), true);
  assert.equal(rumble.stopped, true);
  assert.equal(sound.confirmCompletionSound(ticket, true), false);
  assert.equal(sound.captureCompletionSound({isTrusted: false}), null);
  assert.equal(contexts[0].sources.length, 2);
});

test('audio refusal is caught without blocking settings or renderer interaction', async () => {
  assert.equal(typeof sound.setWeatherThunderOptIn, 'function');
  for (const failure of ['resume', 'buffer', 'start']) {
    sound.resetUiSounds(); audioFailure = failure;
    sound.configureUiSounds(enabled, 'local-weather-storm-day');
    assert.doesNotThrow(() => sound.setWeatherThunderOptIn(true, trusted));
    if (failure === 'resume') {await Promise.resolve(); assert.equal(queue(failure), false);}
    else {sound.configureUiSounds(enabled, 'local-weather-storm-day'); assert.equal(queue(failure), true); assert.doesNotThrow(fireLast);}
  }
});

function hostFixture() {
  const controls = new Map(), handlers = new Map();
  const host = {
    isConnected: true, html: '',
    replaceChildren() {controls.clear(); this.html = '';},
    insertAdjacentHTML(where, html) {
      this.html += html;
      for (const match of html.matchAll(/<(select|input|output|p|button)\b([^>]*)>(?:([^]*?)<\/\1>)?/g)) {
        const [, tag, attributes, body] = match, keys = [...attributes.matchAll(/\b(data-[\w-]+)(?:="[^"]*")?/g)].map(m => m[1]);
        if (tag === 'output') keys.push('output');
        if (!keys.length) continue;
        const control = {tag, id: attributes.match(/\bid="([^"]+)"/)?.[1], value: attributes.match(/\bvalue="([^"]*)"/)?.[1] ?? body?.match(/<option value="([^"]+)" selected/)?.[1] ?? '', checked: /\bchecked\b/.test(attributes), disabled: /\bdisabled\b/.test(attributes), textContent: body ?? '', hidden: /\bhidden\b/.test(attributes), matches: selector => selector.split(',').some(s => s === tag || keys.includes(s.replace(/[\[\]]/g, ''))), closest(selector) {return this.matches(selector) ? this : null;}};
        for (const key of keys) controls.set(key, control);
      }
    },
    querySelector(selector) {return controls.get(selector.replace(/[\[\]]/g, '')) ?? null;},
    querySelectorAll(selector) {return [...new Set(controls.values())].filter(c => c.matches(selector));},
    addEventListener(type, handler) {handlers.set(type, handler);},
    removeEventListener(type) {handlers.delete(type);},
    dispatch(type, target, isTrusted = true) {return handlers.get(type)?.({target, isTrusted});},
  };
  return host;
}
function localAppearance() {appearance.applyNamedAppearance({...defaultNamedAppearance(), theme: 'local-weather'}, {persist: false, weatherEnabled: false});}

test('settings show session consent only for the current Local Weather owner with localized accessible labeling', async () => {
  await loadSettings();
  appearance.applyNamedAppearance({...defaultNamedAppearance(), theme: 'neutral'}, {persist: false});
  const host = hostFixture(); mountUiSoundSettings(host, {value: enabled});
  assert.equal(host.querySelector('[data-weather-thunder]'), null);
  localAppearance();
  assert.equal(document.documentElement.getAttribute('data-named-theme'), 'neutral', 'unavailable Weather keeps the same coarse theme');
  assert.ok(host.querySelector('[data-weather-thunder]'));
  assert.equal(host.querySelector('[data-weather-thunder]').checked, false);
  assert.match(host.html, /<label[^>]*for="ui-sounds-thunder"[^>]*>/);
  assert.match(host.html, /uiSounds\.weatherThunder/);
  appearance.applyNamedAppearance({...defaultNamedAppearance(), theme: 'neutral'}, {persist: false});
  assert.equal(document.documentElement.getAttribute('data-named-theme'), 'neutral');
  assert.equal(host.querySelector('[data-weather-thunder]'), null);
});

test('settings retain real gesture activation before an asynchronous canonical save in both ordering cases', async () => {
  await loadSettings();
  assert.equal(typeof sound.setWeatherThunderOptIn, 'function');
  localAppearance();
  const host = hostFixture(), saved = []; let finish;
  mountUiSoundSettings(host, {value: {...enabled, mode: 'off'}, onChange: value => {saved.push(value); return new Promise(resolve => {finish = () => {sound.configureUiSounds(value, 'local-weather-storm-day'); resolve();};});}});
  const toggle = host.querySelector('[data-weather-thunder]'); toggle.checked = true;
  await host.dispatch('change', toggle);
  assert.equal(sound.weatherThunderEnabled(), true); assert.equal(contexts.length, 1); assert.equal(saved.length, 0);
  const mode = host.querySelector('[data-sound-mode]'); mode.value = 'pack';
  const save = host.dispatch('change', mode); assert.equal(saved.length, 1); assert.equal(queue(), false);
  assert.deepEqual(Object.keys(saved[0]).sort(), ['mode', 'pack', 'version', 'volume']);
  finish(); await save; assert.equal(queue(), true);
  sound.resetUiSounds();
  const second = hostFixture(); mountUiSoundSettings(second, {value: enabled, onChange: value => sound.configureUiSounds(value, 'local-weather-storm-day')});
  const nextMode = second.querySelector('[data-sound-mode]'); nextMode.value = 'theme'; await second.dispatch('change', nextMode);
  const nextToggle = second.querySelector('[data-weather-thunder]'); nextToggle.checked = true; await second.dispatch('change', nextToggle);
  assert.equal(queue('second-order'), true);
});

test('settings cancel on volume input and pack change before awaiting persistence', async () => {
  await loadSettings();
  assert.equal(typeof sound.setWeatherThunderOptIn, 'function');
  localAppearance(); consent(); const host = hostFixture(); let finish;
  mountUiSoundSettings(host, {value: enabled, onChange: () => new Promise(resolve => {finish = resolve;})});
  queue('input'); const input = host.querySelector('[data-sound-volume]'); input.value = '14';
  host.dispatch('input', input); assert.equal(pending.size, 0);
  queue('pack'); const pack = host.querySelector('[data-sound-pack]'); pack.value = 'wood';
  const change = host.dispatch('change', pack); assert.equal(pending.size, 0); finish(); await change;
});

test('every existing locale includes the transient Weather thunder label', () => {
  for (const file of readdirSync(new URL('../public/locales/', import.meta.url)).filter(name => name.endsWith('.json'))) {
    const locale = JSON.parse(readFileSync(new URL('../public/locales/' + file, import.meta.url), 'utf8'));
    assert.equal(typeof locale.uiSounds?.weatherThunder, 'string', file);
    assert.ok(locale.uiSounds.weatherThunder.length > 0, file);
  }
});
