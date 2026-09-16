// Search UI metadata only. The selected value remains an ordinary Unicode sequence.
export function normalizeEmojiSearch(value) {
  return String(value || '').normalize('NFKD').replace(/\p{M}/gu, '').toLocaleLowerCase().replace(/[_:-]+/g, ' ').replace(/\s+/g, ' ').trim();
}

export function indexEmojiCatalog(catalog, localized = {}) {
  return catalog.map(([emoji, label, group, order, tags, skins]) => {
    const local = localized[emoji];
    const names = [...new Set([label, local?.[0]].filter(Boolean).map(normalizeEmojiSearch))];
    const keywords = normalizeEmojiSearch([...names, ...(tags || []), ...(local?.[1] || [])].join(' '));
    return { emoji, label: local?.[0] || label, group, order, names, keywords,
      variants: skins.map(([value, name, rank]) => ({ emoji: value, label: localized[value]?.[0] || name, order: rank })) };
  });
}

export function searchEmojiCatalog(index, query) {
  const needle = normalizeEmojiSearch(query);
  if (!needle) return index;
  const terms = needle.split(' ');
  return index.map(item => {
    if (!terms.every(term => item.keywords.includes(term))) return null;
    const score = item.names.includes(needle) ? 0
      : item.names.some(name => name.startsWith(needle)) ? 1
        : item.names.some(name => terms.every(term => name.split(' ').some(word => word.startsWith(term)))) ? 2
          : terms.every(term => item.keywords.split(' ').some(word => word.startsWith(term))) ? 3
            : item.names.some(name => terms.every(term => name.includes(term))) ? 4 : 5;
    return { item, score };
  }).filter(Boolean).sort((a, b) => a.score - b.score || a.item.order - b.item.order).map(result => result.item);
}

export function emojiWindow(count, scrollTop, height, width) {
  const columns = Math.max(1, Math.min(12, Math.floor(width / 58)));
  const rowHeight = 60;
  const firstRow = Math.max(0, Math.floor(scrollTop / rowHeight) - 1);
  const rows = Math.ceil(height / rowHeight) + 2;
  return { columns, rowHeight, first: firstRow * columns, last: Math.min(count, (firstRow + rows) * columns), height: Math.ceil(count / columns) * rowHeight,
    visibleFirst: Math.max(0, Math.floor(scrollTop / rowHeight)) * columns, visibleLast: Math.min(count, Math.ceil((scrollTop + height) / rowHeight) * columns) };
}

const recentKey = userId => userId == null ? null : `vidamia-emoji-recents:${String(userId)}`;
export function recentEmojis(userId, storage = globalThis.localStorage) {
  const key = recentKey(userId);
  if (!key) return [];
  try { const value = JSON.parse(storage.getItem(key)); return Array.isArray(value) ? value.filter(item => typeof item === 'string').slice(0, 24) : []; } catch { return []; }
}
export function rememberEmoji(userId, emoji, storage = globalThis.localStorage) {
  const key = recentKey(userId);
  if (!key) return;
  try { storage.setItem(key, JSON.stringify([emoji, ...recentEmojis(userId, storage).filter(item => item !== emoji)].slice(0, 24))); } catch { /* private mode or storage quota must not block selection */ }
}
