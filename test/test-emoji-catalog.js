import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { catalog, groups, sequenceCount, locales } from '../public/data/emoji/catalog.js';
import { indexEmojiCatalog, searchEmojiCatalog, emojiWindow, recentEmojis, rememberEmoji } from '../public/utils/emoji-catalog.js';
import { rewardRequest, newRewardRequestKey } from '../public/utils/reward-request.js';
const index = indexEmojiCatalog(catalog);
const storage = () => { const values = new Map(); return { getItem: key => values.get(key) || null, setItem: (key, value) => values.set(key, value) }; };

test('bundled catalog covers complete RGI count with distinct fully qualified sequences and Unicode order', () => {
  const sequences = catalog.flatMap(row => [row[0], ...row[5].map(variant => variant[0])]);
  assert.equal(catalog.length, 1914); assert.equal(sequenceCount, 3944); assert.equal(new Set(sequences).size, sequenceCount);
  assert.ok(catalog.every((row, i) => !i || row[3] > catalog[i - 1][3]));
  assert.equal(groups.length, 9); assert.ok(groups.every(group => group.key !== 'component'));
  assert.ok(sequences.includes('👨‍👩‍👧‍👦')); assert.ok(sequences.includes('👍🏽')); assert.ok(sequences.includes('🇺🇸'));
});
test('natural-word search is partial, case-insensitive, multi-term and name ranked', () => {
  const result = query => searchEmojiCatalog(index, query).map(item => item.emoji);
  assert.deepEqual(result(' ICE   cream ').slice(0, 2), ['🍨', '🍦']);
  assert.deepEqual(result('ICE cr').slice(0, 2), ['🍨', '🍦']);
  for (const value of ['🎬', '🎥', '🍿']) assert.ok(result('movie').includes(value));
  for (const value of ['💵', '💰', '💳', '🪙']) assert.ok(result('money').includes(value));
  for (const value of ['🎂', '🎉', '🎈', '🎁']) assert.ok(result('birthday').includes(value));
  assert.equal(result('birthday')[0], '🎂'); assert.equal(result('nonsense-no-match-123').length, 0);
});
test('localized CLDR names and keywords work alongside English with no custom dictionary', () => {
  const de = JSON.parse(readFileSync(new URL('../public/data/emoji/de.json', import.meta.url)));
  const localized = indexEmojiCatalog(catalog, de.labels);
  assert.ok(searchEmojiCatalog(localized, 'eiscreme').some(item => item.emoji === '🍨'));
  assert.ok(searchEmojiCatalog(localized, 'ice cream').some(item => item.emoji === '🍨'));
  for (const locale of locales) {
    const data = JSON.parse(readFileSync(new URL(`../public/data/emoji/${locale}.json`, import.meta.url)));
    assert.equal(Object.keys(data.labels).length, sequenceCount);
  }
});
test('virtual row calculation keeps DOM bounded and exposes last rows', () => {
  for (const width of [300, 768, 1100, 1920]) {
    const first = emojiWindow(1914, 0, 560, width);
    assert.ok(first.last - first.first <= 196);
    const last = emojiWindow(1914, first.height - 560, 560, width);
    assert.equal(last.last, 1914); assert.ok(last.first > 0);
  }
});
test('recent choices are bounded, sequence-safe and isolated per member', () => {
  const store = storage(); rememberEmoji(1, '👨‍👩‍👧‍👦', store); rememberEmoji(2, '🍿', store); rememberEmoji(1, '👍🏽', store);
  assert.deepEqual(recentEmojis(1, store), ['👍🏽', '👨‍👩‍👧‍👦']); assert.deepEqual(recentEmojis(2, store), ['🍿']);
  assert.deepEqual(recentEmojis(null, store), []);
  for (const item of index.slice(0, 30)) rememberEmoji(1, item.emoji, store);
  assert.equal(recentEmojis(1, store).length, 24);
});
test('uncertain redemption preserves durable key across dialog reload; confirmed new intent gets new key', () => {
  const store = storage(), intent = { catalog_id: 2, user_id: 7, note: 'movie' };
  const first = rewardRequest(1, intent, store);
  assert.equal(rewardRequest(1, intent, store).key, first.key);
  assert.notEqual(rewardRequest(2, intent, store).key, first.key);
  assert.notEqual(rewardRequest(1, { ...intent, catalog_id: 3 }, store).key, first.key);
  first.finish(); assert.notEqual(rewardRequest(1, intent, store).key, first.key);
});
test('Wall retries reuse an in-memory key when all session storage access throws', () => {
  const store = { getItem() { throw new Error('Storage denied'); }, setItem() { throw new Error('Storage denied'); } };
  const body = { catalog_id: 4, user_id: 7, note: 'ice cream' };
  const first = rewardRequest(1, body, store);
  assert.equal(rewardRequest(1, body, store).key, first.key);
  assert.notEqual(rewardRequest(2, body, store).key, first.key);
  first.finish();
  const next = rewardRequest(1, body, store);
  assert.notEqual(next.key, first.key);
  first.finish(); // A delayed repeat acknowledgement cannot discard the next intent.
  assert.equal(rewardRequest(1, body, store).key, next.key);
});
test('overlapping distinct intents preserve each other through success in either order', () => {
  for (const reverse of [false, true]) for (const denied of [false, true]) {
    const store = denied ? { getItem() { throw new Error('Denied'); }, setItem() { throw new Error('Denied'); } } : storage();
    const bodyA = { catalog_id: 4, user_id: 7 }, bodyB = { catalog_id: 5, user_id: 7 };
    const a = rewardRequest(1, bodyA, store), b = rewardRequest(1, bodyB, store);
    const completed = reverse ? b : a, pending = reverse ? a : b, pendingBody = reverse ? bodyA : bodyB;
    completed.finish();
    assert.equal(rewardRequest(1, pendingBody, store).key, pending.key);
    if (!denied) assert.deepEqual(JSON.parse(store.getItem('vidamia-reward-requests:1')).map(item => item.key), [pending.key]);
    pending.finish();
    if (!denied) assert.deepEqual(JSON.parse(store.getItem('vidamia-reward-requests:1')), []);
  }
});
test('finish merges freshly persisted pending requests instead of overwriting an older snapshot', () => {
  const store = storage(), first = rewardRequest(1, { catalog_id: 4, user_id: 7 }, store);
  const later = { intent: JSON.stringify([5, 7, '']), key: 'persisted-after-handle-created' };
  store.setItem('vidamia-reward-requests:1', JSON.stringify([...JSON.parse(store.getItem('vidamia-reward-requests:1')), later]));
  first.finish();
  assert.deepEqual(JSON.parse(store.getItem('vidamia-reward-requests:1')), [later]);
  assert.equal(rewardRequest(1, { catalog_id: 5, user_id: 7 }, store).key, later.key);
});
test('completed keys are not resurrected if a storage write fails after success', () => {
  const backing = storage(); let failWrites = false;
  const store = { getItem: key => backing.getItem(key), setItem(key, value) { if (failWrites) throw new Error('Quota'); backing.setItem(key, value); } };
  const body = { catalog_id: 6, user_id: 7 }, first = rewardRequest(1, body, store);
  failWrites = true; first.finish();
  const next = rewardRequest(1, body, store);
  assert.notEqual(next.key, first.key);
  assert.equal(rewardRequest(1, body, store).key, next.key);
});
test('denied sessionStorage property access also uses the shared in-memory fallback', () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'sessionStorage');
  Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, get() { throw new Error('SecurityError'); } });
  try {
    const body = { catalog_id: 9, user_id: 8 }, first = rewardRequest(88, body);
    assert.equal(rewardRequest(88, body).key, first.key);
    const recoveredStorage = storage();
    Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, value: recoveredStorage });
    assert.equal(rewardRequest(88, body).key, first.key);
    first.finish(); assert.notEqual(rewardRequest(88, body).key, first.key);
  } finally {
    if (descriptor) Object.defineProperty(globalThis, 'sessionStorage', descriptor);
    else delete globalThis.sessionStorage;
  }
});
test('local HTTP WebView without randomUUID still creates a full entropy request key', () => {
  const cryptoSource = { getRandomValues: array => globalThis.crypto.getRandomValues(array) };
  const first = newRewardRequestKey(cryptoSource), second = newRewardRequestKey(cryptoSource);
  assert.match(first,/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
  assert.notEqual(first,second);
});
test('catalog search timings remain bounded over complete metadata', t => {
  const times = [];
  for (let i = 0; i < 100; i++) { const start = performance.now(); searchEmojiCatalog(index, ['movie', 'money', 'ice cr', 'birth'][i % 4]); times.push(performance.now() - start); }
  times.sort((a,b) => a-b); t.diagnostic(`search p50=${times[50].toFixed(2)}ms p95=${times[95].toFixed(2)}ms max=${times.at(-1).toFixed(2)}ms`);
  assert.ok(times[95] < 100);
});
