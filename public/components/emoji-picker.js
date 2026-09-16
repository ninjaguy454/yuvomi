import { getLocale } from '/i18n.js';
import { attachOverlay, dropOverlay } from '/utils/overlay-history.js';
import { indexEmojiCatalog, searchEmojiCatalog, emojiWindow, recentEmojis, rememberEmoji } from '/utils/emoji-catalog.js';

const dataPromises = new Map();
async function loadCatalog(locale) {
  if (!dataPromises.has(locale)) dataPromises.set(locale, (async () => {
    const data = await import('/data/emoji/catalog.js');
    const local = data.locales.includes(locale) ? await fetch(`/data/emoji/${locale}.json`).then(response => {
      if (!response.ok) throw Error('Emoji metadata could not be loaded');
      return response.json();
    }) : {};
    return { index: indexEmojiCatalog(data.catalog, local.labels), groups: (local.groups || data.groups).filter(group => group.key !== 'component') };
  })().catch(error => { dataPromises.delete(locale); throw error; }));
  return dataPromises.get(locale);
}

function ensureStyles() {
  if (document.querySelector('link[data-emoji-picker]')) return;
  const link = document.createElement('link'); link.rel = 'stylesheet'; link.href = '/styles/emoji-picker.css'; link.dataset.emojiPicker = '';
  document.head.append(link);
}

/** Reusable Vidamia picker. Resolves sequence, null for clear, undefined for cancel.
 * Uses the same overlay-history integration as the existing Lucide picker.
 * Only the current virtual rows enter the DOM; all search runs locally.
 */
export function openEmojiPicker({ current = null, userId = null, locale = getLocale(), title = 'Choose icon' } = {}) {
  ensureStyles();
  return new Promise(resolve => {
    const previousFocus = document.activeElement;
    const dialog = document.createElement('dialog'); dialog.className = 'emoji-picker'; dialog.setAttribute('aria-label', title);
    dialog.innerHTML = `<header class="emoji-picker__header"><h2></h2><button type="button" class="btn btn--ghost" data-cancel aria-label="Close icon picker">Close</button></header>
      <label class="emoji-picker__search"><span class="sr-only">Search emojis</span><input type="search" class="input" placeholder="Search emojis…" autocomplete="off" spellcheck="false"></label>
      <nav class="emoji-picker__categories" aria-label="Emoji categories"></nav>
      <p class="emoji-picker__count" role="status" aria-live="polite">Loading emojis…</p>
      <div class="emoji-picker__viewport" tabindex="0" aria-label="Emojis"><div class="emoji-picker__grid" role="group" aria-label="Choose an emoji"></div></div>
      <section class="emoji-picker__variants" hidden aria-label="Emoji variations"><span>Choose a variation</span><button type="button" data-close-variants aria-label="Close variations">×</button><div></div></section>
      <footer class="emoji-picker__footer"><span>Hold an emoji for variations.</span><button type="button" class="btn btn--ghost" data-clear>Remove icon</button></footer>`;
    dialog.querySelector('h2').textContent = title;
    const viewport = dialog.querySelector('.emoji-picker__viewport');
    const grid = dialog.querySelector('.emoji-picker__grid');
    const input = dialog.querySelector('input');
    const navigation = dialog.querySelector('nav');
    const count = dialog.querySelector('[role=status]');
    const variants = dialog.querySelector('.emoji-picker__variants');
    let token, settled = false, index = [], results = [], category = '0', frame = null, gesture = null, held = false, painted = '', resultVersion = 0;
    const known = new Map();
    const finish = value => {
      if (settled) return;
      settled = true; clearTimeout(gesture?.timer); cancelAnimationFrame(frame); observer?.disconnect();
      if (token != null) dropOverlay(token);
      dialog.close(); dialog.remove();
      if (previousFocus?.isConnected) previousFocus.focus({ preventScroll: true });
      if (typeof value === 'string') rememberEmoji(userId, value);
      resolve(value);
    };
    const tile = item => {
      const button = document.createElement('button'); button.type = 'button'; button.className = 'emoji-picker__tile';
      button.textContent = item.emoji; button.dataset.emoji = item.emoji; button.title = item.label;
      button.setAttribute('aria-label', `${item.label}${item.variants?.length ? '; hold or press Shift+F10 for variations' : ''}`);
      button.setAttribute('aria-pressed', String(item.emoji === current));
      if (item.variants?.length) button.dataset.variants = '';
      return button;
    };
    const paint = () => {
      frame = null;
      const range = emojiWindow(results.length, viewport.scrollTop, viewport.clientHeight, viewport.clientWidth);
      const signature = `${resultVersion}:${range.first}:${range.last}:${range.columns}`;
      if (signature === painted) return;
      painted = signature;
      grid.style.height = `${range.height}px`;
      const active = document.activeElement?.dataset?.emoji;
      const existing = new Map([...grid.children].map(button => [button.dataset.emoji, button]));
      const retained = new Set();
      results.slice(range.first, range.last).forEach((item, offset) => {
        const position = range.first + offset;
        const button = existing.get(item.emoji) || tile(item); button.dataset.index = String(position); retained.add(button);
        button.style.top = `${Math.floor(position / range.columns) * range.rowHeight}px`;
        button.style.left = `${(position % range.columns) * 100 / range.columns}%`;
        button.style.width = `${100 / range.columns}%`;
        if (grid.children[offset] !== button) grid.insertBefore(button, grid.children[offset] || null);
      });
      for (const button of existing.values()) if (!retained.has(button)) button.remove();
      if (active) [...grid.children].find(button => button.dataset.emoji === active)?.focus({ preventScroll: true });
    };
    const schedulePaint = () => { if (!frame) frame = requestAnimationFrame(paint); };
    const refresh = () => {
      variants.hidden = true;
      const query = input.value.trim();
      results = query ? searchEmojiCatalog(index, query)
        : category === 'recent' ? recentEmojis(userId).map(value => known.get(value)).filter(Boolean)
          : index.filter(item => item.group === Number(category));
      resultVersion++;
      for (const button of navigation.children) button.setAttribute('aria-pressed', String(!query && button.dataset.category === category));
      count.textContent = results.length ? `${results.length} emojis` : (category === 'recent' && !query ? 'Your recent choices will appear here.' : 'No matching emojis. Try another word.');
      viewport.scrollTop = 0; paint();
    };
    const showVariants = value => {
      const item = known.get(value);
      if (!item?.variants?.length) return;
      variants.querySelector('div').replaceChildren(...[item, ...item.variants].map(tile)); variants.hidden = false;
    };
    const cancelHold = () => { clearTimeout(gesture?.timer); gesture = null; };
    grid.addEventListener('pointerdown', event => {
      const button = event.target.closest('[data-variants]'); if (!button || event.button !== 0) return;
      held = false; gesture = { x: event.clientX, y: event.clientY, timer: setTimeout(() => { held = true; showVariants(button.dataset.emoji); }, 550) };
    });
    grid.addEventListener('pointermove', event => { if (gesture && Math.hypot(event.clientX - gesture.x, event.clientY - gesture.y) > 8) cancelHold(); });
    grid.addEventListener('pointerup', cancelHold); grid.addEventListener('pointercancel', cancelHold);
    viewport.addEventListener('scroll', () => { cancelHold(); schedulePaint(); }, { passive: true });
    grid.addEventListener('contextmenu', event => { const button = event.target.closest('[data-variants]'); if (button) { event.preventDefault(); showVariants(button.dataset.emoji); } });
    dialog.addEventListener('click', event => {
      const button = event.target.closest('[data-emoji]'); if (!button) return;
      if (held && grid.contains(button)) { held = false; return; }
      finish(button.dataset.emoji);
    });
    grid.addEventListener('keydown', event => {
      const button = event.target.closest('[data-index]'); if (!button) return;
      if (event.key === 'F10' && event.shiftKey) { event.preventDefault(); showVariants(button.dataset.emoji); return; }
      const range = emojiWindow(results.length, viewport.scrollTop, viewport.clientHeight, viewport.clientWidth);
      const shift = { ArrowRight: 1, ArrowLeft: -1, ArrowDown: range.columns, ArrowUp: -range.columns }[event.key];
      if (!shift) return;
      event.preventDefault(); const next = Math.max(0, Math.min(results.length - 1, Number(button.dataset.index) + shift));
      const top = Math.floor(next / range.columns) * range.rowHeight;
      if (top < viewport.scrollTop) viewport.scrollTop = top;
      else if (top + range.rowHeight > viewport.scrollTop + viewport.clientHeight) viewport.scrollTop = top + range.rowHeight - viewport.clientHeight;
      paint(); grid.querySelector(`[data-index="${next}"]`)?.focus({ preventScroll: true });
    });
    input.addEventListener('input', refresh);
    navigation.addEventListener('click', event => { const button = event.target.closest('[data-category]'); if (button) { category = button.dataset.category; input.value = ''; refresh(); } });
    dialog.querySelector('[data-close-variants]').addEventListener('click', () => { variants.hidden = true; });
    dialog.querySelector('[data-cancel]').addEventListener('click', () => finish(undefined));
    dialog.querySelector('[data-clear]').addEventListener('click', () => finish(null));
    dialog.addEventListener('cancel', event => { event.preventDefault(); finish(undefined); });
    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(schedulePaint) : null;
    document.body.append(dialog); dialog.showModal(); token = attachOverlay(dialog, () => finish(undefined));
    // Avoid summoning the Android keyboard just to browse icons.
    dialog.querySelector('[data-cancel]').focus({ preventScroll: true }); observer?.observe(viewport);
    loadCatalog(String(locale || 'en').split('-')[0]).then(data => {
      if (settled) return;
      index = data.index;
      index.forEach(item => { known.set(item.emoji, item); item.variants.forEach(variant => known.set(variant.emoji, { ...variant, group: item.group })); });
      navigation.replaceChildren(...[{ order: 'recent', message: 'Recent' }, ...data.groups].map(group => {
        const button = document.createElement('button'); button.type = 'button'; button.dataset.category = String(group.order); button.textContent = group.message; return button;
      }));
      const recent = recentEmojis(userId); category = recent.length ? 'recent' : '0'; refresh();
    }).catch(() => { if (!settled) count.textContent = 'Emoji data could not be loaded. Close and reopen to retry.'; });
  });
}
