import { t } from '/i18n.js';
import { memberLabel } from '/utils/member-label.js';
import { authenticationSnapshot, sameAuthentication } from '/utils/device-context.js';
import { pushOverlay, dropOverlay } from '/utils/overlay-history.js';

let activeCard = null;
const END_EVENTS = ['auth:context-ending', 'auth:expired', 'auth:context-rejected'];
const FOCUSABLE = 'button:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])';

// Match the canonical avatar_data contract. A stale URL never starts a profile
// or remote image request from a safe acceptance projection.
export function safeTaskPersonPhoto(value) {
  return typeof value === 'string' && value.length <= 768 * 1024
    && /^data:image\/(?:png|jpeg|webp);base64,[a-z0-9+/=]+$/i.test(value) ? value : null;
}

export function taskPersonInitials(name = '') {
  const words = String(name).trim().split(/\s+/).filter(Boolean);
  const segmenter = typeof Intl.Segmenter === 'function' ? new Intl.Segmenter(undefined, { granularity: 'grapheme' }) : null;
  const first = word => segmenter ? segmenter.segment(word)[Symbol.iterator]().next().value?.segment || '' : Array.from(word)[0] || '';
  return [words[0], ...(words.length > 1 ? [words.at(-1)] : [])].filter(Boolean).map(first).join('').toLocaleUpperCase();
}

/** Present only supplied authorized fields. Callers own profile resolution. */
export function openTaskPersonCard({ person = {}, anchor, host = document.body, signal, onClose = () => {} }) {
  activeCard?.dispose();
  const authentication = authenticationSnapshot();
  const listeners = new AbortController();
  const panel = document.createElement('div');
  panel.className = 'task-detail-profile-preview';
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-modal', 'true');
  panel.setAttribute('aria-label', memberLabel(person) || t('tasks.participantsLabel'));
  panel.tabIndex = -1;
  let closed = false, outsidePointer = null, observer = null, resizeObserver = null, overlayToken = null;
  const handle = { panel, close: () => finish(true), dispose: () => finish(false) };

  function authorizedAnchor() {
    return anchor?.isConnected && !anchor.closest('[inert], [hidden]') && sameAuthentication(authentication) && !signal?.aborted;
  }
  function finish(restoreFocus) {
    if (closed) return;
    closed = true;
    listeners.abort();
    observer?.disconnect();
    resizeObserver?.disconnect();
    outsidePointer = null;
    panel.remove();
    if (overlayToken !== null) {
      dropOverlay(overlayToken);
      overlayToken = null;
    }
    if (activeCard === handle) activeCard = null;
    if (restoreFocus && authorizedAnchor()) anchor.focus({ preventScroll: true });
    onClose();
  }
  function current() {
    if (closed) return false;
    if (!authorizedAnchor() || !host.isConnected || host.closest('[inert], [hidden]') || !panel.isConnected) {
      finish(false);
      return false;
    }
    return true;
  }
  const listen = (target, type, handler, options = {}) => target.addEventListener(type, handler, { ...options, signal: listeners.signal });
  const consume = event => { event.preventDefault(); event.stopImmediatePropagation(); };
  const dispose = () => finish(false);

  if (signal?.aborted || !authorizedAnchor() || !host.isConnected) {
    finish(false);
    return handle;
  }

  const closeButton = document.createElement('button');
  closeButton.type = 'button';
  closeButton.className = 'btn btn--ghost btn--icon btn--icon-sm task-detail-profile-preview__close';
  closeButton.setAttribute('aria-label', t('common.close'));
  const closeIcon = document.createElement('i');
  closeIcon.dataset.lucide = 'x';
  closeIcon.className = 'icon-sm';
  closeIcon.setAttribute('aria-hidden', 'true');
  closeButton.appendChild(closeIcon);
  listen(closeButton, 'click', handle.close);

  const photo = safeTaskPersonPhoto(person.avatar_data);
  const avatar = document.createElement(photo ? 'img' : 'span');
  avatar.className = 'task-detail-profile-preview__avatar';
  if (photo) { avatar.src = photo; avatar.alt = ''; }
  else {
    avatar.textContent = taskPersonInitials(person.display_name);
    avatar.style.backgroundColor = person.avatar_color || person.color || '#64748b';
    avatar.setAttribute('aria-hidden', 'true');
  }
  const identity = document.createElement('div');
  identity.className = 'task-detail-profile-preview__identity';
  const name = document.createElement('strong');
  name.textContent = memberLabel(person);
  identity.append(avatar, name);
  if (person.family_role) {
    const familyRole = document.createElement('span');
    familyRole.textContent = person.family_role;
    identity.appendChild(familyRole);
  }
  const contacts = document.createElement('div');
  contacts.className = 'task-detail-profile-preview__contacts';
  for (const [kind, value, label] of [
    ['phone', person.phone, t('contacts.phoneLabel')],
    ['mail', person.email, t('contacts.emailLabel')],
  ]) {
    if (!value) continue;
    const link = document.createElement('a');
    link.href = `${kind === 'phone' ? 'tel' : 'mailto'}:${value}`;
    const icon = document.createElement('i');
    icon.dataset.lucide = kind;
    icon.className = 'icon-sm';
    icon.setAttribute('aria-hidden', 'true');
    const text = document.createElement('span');
    const caption = document.createElement('small');
    caption.textContent = label;
    text.append(caption, document.createTextNode(String(value)));
    link.append(icon, text);
    contacts.appendChild(link);
  }
  panel.append(closeButton, identity);
  if (contacts.childElementCount) panel.appendChild(contacts);
  host.appendChild(panel);
  activeCard = handle;
  overlayToken = pushOverlay(({ force }) => finish(!force));
  window.lucide?.createIcons({ el: panel });

  function position() {
    if (!current()) return;
    const viewport = window.visualViewport;
    const visible = { left: viewport?.offsetLeft || 0, top: viewport?.offsetTop || 0,
      right: (viewport?.offsetLeft || 0) + (viewport?.width || window.innerWidth),
      bottom: (viewport?.offsetTop || 0) + (viewport?.height || window.innerHeight) };
    const bounds = host === document.body ? visible : host.getBoundingClientRect();
    const left = Math.max(visible.left, bounds.left) + 8, top = Math.max(visible.top, bounds.top) + 8;
    const right = Math.min(visible.right, bounds.right) - 8, bottom = Math.min(visible.bottom, bounds.bottom) - 8;
    if (right <= left || bottom <= top) { dispose(); return; }
    panel.style.maxWidth = `${right - left}px`;
    panel.style.maxHeight = `${bottom - top}px`;
    // Fixed children can be positioned relative to a transformed modal. Read
    // that origin instead of assuming the viewport is their containing block.
    panel.style.left = '0px'; panel.style.top = '0px';
    const origin = panel.getBoundingClientRect(), target = anchor.getBoundingClientRect();
    const x = Math.max(left, Math.min(target.left, right - origin.width));
    const below = target.bottom + 8;
    const preferredY = below + origin.height <= bottom ? below : target.top - origin.height - 8;
    const y = Math.max(top, Math.min(preferredY, bottom - origin.height));
    panel.style.left = `${x - origin.left}px`;
    panel.style.top = `${y - origin.top}px`;
  }

  listen(document, 'keydown', event => {
    if (!current() || !['Escape', 'Tab'].includes(event.key)) return;
    consume(event);
    if (event.key === 'Escape') { handle.close(); return; }
    const targets = [...panel.querySelectorAll(FOCUSABLE)].filter(node => node.getClientRects().length && !node.closest('[hidden], [inert]'));
    const index = targets.indexOf(document.activeElement);
    const next = event.shiftKey ? (index <= 0 ? targets.length - 1 : index - 1) : (index + 1) % targets.length;
    (targets[next] || panel).focus({ preventScroll: true });
  }, { capture: true });
  const outside = event => !panel.contains(event.target) && !anchor.contains(event.target);
  listen(document, 'pointerdown', event => {
    if (!current() || !outside(event)) return;
    outsidePointer = event.pointerId;
    consume(event);
  }, { capture: true });
  listen(document, 'pointerup', event => {
    if (outsidePointer === event.pointerId) consume(event);
  }, { capture: true });
  listen(document, 'pointercancel', event => {
    if (outsidePointer !== event.pointerId) return;
    consume(event); handle.close();
  }, { capture: true });
  listen(document, 'click', event => {
    if (!current() || (outsidePointer === null && !outside(event))) return;
    // Close after consuming the entire action, so no dangling click suppression
    // timer/listener is needed and the underlying assignment never receives it.
    consume(event); handle.close();
  }, { capture: true });
  listen(window, 'resize', position);
  listen(document, 'scroll', event => { if (!panel.contains(event.target)) position(); }, { capture: true, passive: true });
  if (window.visualViewport) {
    listen(window.visualViewport, 'resize', position);
    listen(window.visualViewport, 'scroll', position);
  }
  for (const event of END_EVENTS) listen(window, event, dispose);
  listen(window, 'vidamia:auth-context', () => { if (!sameAuthentication(authentication)) dispose(); });
  if (signal) listen(signal, 'abort', dispose, { once: true });
  observer = new MutationObserver(current);
  observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['inert', 'hidden'] });
  resizeObserver = new ResizeObserver(position);
  resizeObserver.observe(host);
  position();
  if (!closed) panel.focus({ preventScroll: true });
  return handle;
}
