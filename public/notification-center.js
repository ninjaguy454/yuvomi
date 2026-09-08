/** Durable, per-user notification history. Domain reminders keep their own lifecycle. */
import { api } from '/api.js';
import { t } from '/i18n.js';
import { openModal, closeModal } from '/components/modal.js';
import { isWallModeEnabled } from '/utils/wall-mode.js';
import { toastSurface } from '/utils/toast-surface.js';
import { createOriginSeal } from '/reminders.js';

let running = false;
let generation = 0;
let timer = null;
let pending = null;
let snapshot = { items: [], unreadCount: 0 };
let initializedHistory = false;
let seen = new Set();
let panel = null;
let panelVersion = 0;
let dataVersion = 0;
let mutationQueue = Promise.resolve();
const INTERVAL = 60_000;

function text(key, values) { return t(`notificationCenter.${key}`, values); }
function privateSurface() { return running && !isWallModeEnabled(); }

export function safeNotificationUrl(value) {
  if (typeof value !== 'string' || !value.startsWith('/') || value.startsWith('//') || /[\\\u0000-\u001f]/.test(value)) return null;
  const url = new URL(value, location.origin);
  return url.origin === location.origin ? `${url.pathname}${url.search}${url.hash}` : null;
}

export function paintNotificationBadges() {
  document.querySelectorAll('[data-notification-center]').forEach((button) => {
    button.hidden = !privateSurface();
    const count = snapshot.unreadCount;
    button.setAttribute('aria-label', count ? text('unreadCount', { count }) : text('title'));
    button.setAttribute('title', text('title'));
    const badge = button.querySelector('.reminder-bell-badge');
    if (badge) {
      badge.hidden = !count;
      badge.textContent = count > 99 ? '99+' : String(count);
    }
  });
}

function accept(data) {
  snapshot = { items: Array.isArray(data?.items) ? data.items : [], unreadCount: Number(data?.unreadCount) || 0 };
  paintNotificationBadges();
}

function status(message, error = false) {
  const element = panel?.querySelector('[data-inbox-status]');
  if (!element) return;
  element.textContent = message;
  element.classList.toggle('form-hint--danger', error);
}

async function change(method, path, { refreshPanel = true } = {}) {
  const epoch = generation;
  const operation = mutationQueue.catch(() => {}).then(async () => {
    if (epoch !== generation || !privateSurface()) return false;
    // A poll started before this mutation must not restore stale unread state.
    dataVersion++;
    const response = await api[method](path, {});
    if (epoch !== generation || !privateSurface()) return false;
    // Also invalidate polls that began while this write was in flight: their
    // server read may precede the commit even if their response arrives later.
    dataVersion++;
    accept(response.data);
    status('');
    if (refreshPanel && panel?.isConnected) renderItems();
    return true;
  });
  mutationQueue = operation;
  return operation;
}

export async function openNotificationItem(item) {
  if (!privateSurface()) return;
  const destination = safeNotificationUrl(item.url);
  if (!destination) { status(text('unavailable'), true); return; }
  try {
    if (!await change('patch', `/notifications/inbox/${item.id}/read`, { refreshPanel: false })) return;
    // The router consumes the shared overlay marker when it navigates. Closing
    // first schedules history.back(), which can race and replace the destination.
    if (privateSurface()) window.yuvomi?.navigate?.(destination);
  } catch { status(text('actionFailed'), true); }
}

function action(label, handler, className = 'btn btn--ghost btn--sm') {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = className;
  button.textContent = label;
  button.addEventListener('click', async () => {
    button.disabled = true;
    try { await handler(); } catch { status(text('actionFailed'), true); }
    finally {
      if (button.isConnected) button.disabled = button.hasAttribute('data-inbox-read-all') && !snapshot.unreadCount;
    }
  });
  return button;
}

function renderItems() {
  if (!panel?.isConnected || !privateSurface()) return;
  const list = panel.querySelector('[data-inbox-items]');
  const focusKey = list.contains(document.activeElement) ? document.activeElement?.dataset.inboxAction : null;
  list.replaceChildren();
  panel.querySelector('[data-inbox-read-all]').disabled = snapshot.unreadCount === 0;
  if (!snapshot.items.length) {
    const empty = document.createElement('li');
    empty.className = 'notification-center__empty';
    empty.textContent = text('empty');
    list.append(empty);
  }
  for (const item of snapshot.items) {
    const row = document.createElement('li');
    row.className = `notification-center__item${item.read_at ? '' : ' notification-center__item--unread'}`;
    const open = action('', () => openNotificationItem(item), 'notification-center__open');
    open.dataset.inboxAction = `open-${item.id}`;
    const title = document.createElement('strong');
    title.textContent = item.title;
    const body = document.createElement('span');
    body.textContent = item.body || '';
    const metadata = document.createElement('span');
    metadata.className = 'notification-center__metadata';
    const date = new Date(String(item.created_at).replace(' ', 'T') + (/Z$|[+-]\d\d:\d\d$/.test(item.created_at) ? '' : 'Z'));
    metadata.textContent = [item.read_at ? text('read') : text('unread'), Number.isNaN(date.valueOf()) ? '' : date.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })].filter(Boolean).join(' · ');
    open.append(title, body, metadata);
    const controls = document.createElement('div');
    controls.className = 'notification-center__actions';
    if (!item.read_at) {
      const read = action(text('markRead'), () => change('patch', `/notifications/inbox/${item.id}/read`));
      read.dataset.inboxAction = `read-${item.id}`;
      controls.append(read);
    }
    const dismiss = action(text('dismiss'), () => change('delete', `/notifications/inbox/${item.id}`));
    dismiss.dataset.inboxAction = `dismiss-${item.id}`;
    dismiss.setAttribute('aria-label', `${text('dismiss')}: ${item.title}`);
    controls.append(dismiss);
    row.append(createOriginSeal({ tasks: 'task', meals: 'meal', calendar: 'event', automation: 'task' }[item.category],
      item.category === 'shopping' ? { accent: 'var(--module-shopping)', icon: 'shopping-cart' } : null), open, controls);
    list.append(row);
  }
  if (focusKey) {
    const target = [...list.querySelectorAll('[data-inbox-action]')].find((el) => el.dataset.inboxAction === focusKey);
    (target || list.querySelector('button') || panel.querySelector('[data-inbox-refresh]')).focus();
  }
}

function notifyNew(items) {
  const newItems = items.filter((item) => !item.read_at && !seen.has(item.id));
  items.forEach((item) => seen.add(item.id));
  if (!initializedHistory || document.visibilityState !== 'visible' || panel) { initializedHistory = true; return; }
  const surface = toastSurface('polite');
  if (!surface) return;
  for (const item of newItems.slice(0, 3)) {
    const toast = document.createElement('div');
    toast.className = 'toast toast--notification';
    const open = action(item.title, () => { toast.remove(); return openNotificationItem(item); }, 'toast__notification-open');
    const dismiss = action(text('hideToast'), () => toast.remove(), 'toast__undo');
    dismiss.setAttribute('aria-label', text('hideToast'));
    toast.append(open, dismiss);
    surface.append(toast);
    setTimeout(() => toast.remove(), 10_000);
  }
}

export async function refresh() {
  if (!privateSurface()) return false;
  if (pending) return pending;
  const epoch = generation;
  const version = dataVersion;
  const request = (async () => {
    try {
      const response = await api.get('/notifications/inbox?limit=50');
      if (epoch !== generation || version !== dataVersion || !privateSurface()) return false;
      accept(response.data);
      notifyNew(snapshot.items);
      if (panel?.isConnected) { renderItems(); status(''); }
      return true;
    } catch {
      if (epoch === generation && privateSurface()) status(text('loadFailed'), true);
      return false;
    }
  })();
  pending = request;
  try { return await request; } finally { if (pending === request) pending = null; }
}

export async function openNotificationCenter({ notificationId } = {}) {
  if (!privateSurface()) return;
  window._closeMoreSheet?.({ restoreFocus: false });
  if (await closeModal() === false || !privateSurface()) return;
  const version = ++panelVersion;
  const content = document.createElement('section');
  content.className = 'notification-center';
  const toolbar = document.createElement('div');
  toolbar.className = 'notification-center__toolbar';
  const all = action(text('markAllRead'), () => change('post', '/notifications/inbox/read-all'), 'btn btn--secondary btn--sm');
  all.dataset.inboxReadAll = '';
  const reload = action('', refresh, 'btn btn--ghost btn--icon');
  reload.setAttribute('aria-label', text('refresh'));
  reload.setAttribute('title', text('refresh'));
  const refreshIcon = document.createElement('i');
  refreshIcon.dataset.lucide = 'refresh-cw';
  refreshIcon.className = 'icon-sm';
  refreshIcon.setAttribute('aria-hidden', 'true');
  reload.append(refreshIcon);
  reload.dataset.inboxRefresh = '';
  toolbar.append(all, reload);
  const message = document.createElement('p');
  message.className = 'form-hint';
  message.dataset.inboxStatus = '';
  message.setAttribute('role', 'status');
  message.textContent = text('loading');
  const list = document.createElement('ul');
  list.className = 'notification-center__list';
  list.dataset.inboxItems = '';
  const settings = action(text('settings'), () => window.yuvomi?.navigate?.('/settings/personal/notifications'));
  content.append(toolbar, message, list, settings);
  openModal({
    title: text('title'), content: '', size: 'md',
    onSave(modal) {
      modal.querySelector('.modal-panel__body').append(content);
      panel = content;
      renderItems();
      window.lucide?.createIcons({ el: content });
    },
    onClose: () => { if (version === panelVersion) panel = null; },
  });
  const loaded = await refresh();
  if (notificationId && loaded && version === panelVersion) {
    try {
      const item = snapshot.items.find((entry) => String(entry.id) === String(notificationId))
        || (await api.get(`/notifications/inbox/${encodeURIComponent(notificationId)}`)).data;
      if (item && privateSurface() && version === panelVersion) await openNotificationItem(item);
      else status(text('unavailable'), true);
    } catch { status(text('unavailable'), true); }
  }
}

function syncPrivacy() {
  generation++;
  panelVersion++;
  mutationQueue = Promise.resolve();
  pending = null;
  snapshot = { items: [], unreadCount: 0 };
  seen.clear();
  initializedHistory = false;
  document.querySelectorAll('.toast--notification').forEach((toast) => toast.remove());
  if (isWallModeEnabled() && panel) { panel.replaceChildren(); panel = null; closeModal({ force: true }); }
  paintNotificationBadges();
  if (privateSurface()) void refresh();
}
function onVisibility() { if (document.visibilityState === 'visible') void refresh(); }
function onStorage(event) { if (event.key === 'yuvomi-wall-mode' || event.key === null) syncPrivacy(); }

export function init() {
  if (running) return;
  running = true;
  generation++;
  window.addEventListener('yuvomi:wall-mode-change', syncPrivacy);
  window.addEventListener('storage', onStorage);
  document.addEventListener('visibilitychange', onVisibility);
  paintNotificationBadges();
  void refresh();
  timer = setInterval(refresh, INTERVAL);
}

export function stop() {
  running = false;
  generation++;
  panelVersion++;
  mutationQueue = Promise.resolve();
  clearInterval(timer);
  timer = null;
  pending = null;
  window.removeEventListener('yuvomi:wall-mode-change', syncPrivacy);
  window.removeEventListener('storage', onStorage);
  document.removeEventListener('visibilitychange', onVisibility);
  if (panel) { panel.replaceChildren(); void closeModal({ force: true }); }
  panel = null;
  snapshot = { items: [], unreadCount: 0 };
  initializedHistory = false;
  seen.clear();
  document.querySelectorAll('.toast--notification').forEach((toast) => toast.remove());
  paintNotificationBadges();
}
