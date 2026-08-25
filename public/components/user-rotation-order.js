/**
 * Ordered household-member selector for round-robin tasks.
 *
 * A positive position includes a member in the rotation. Position 1 owns the
 * current/new occurrence; each recurring follow-up advances to the next member.
 * The deliberately small UI keeps ordering explicit and works without drag/drop.
 */
import { esc } from '/utils/html.js';

export function renderUserRotationOrder(allUsers, selectedIds = []) {
  const order = new Map((selectedIds ?? []).map((id, index) => [Number(id), index + 1]));
  const max = Math.max(1, allUsers.length);

  return `
    <div class="user-rotation" id="task-rotation-order">
      <label class="label">Rotation order</label>
      <div class="user-rotation__rows">
        ${allUsers.map((user) => `
          <label class="list-row" data-rotation-user="${user.id}" style="display:grid;grid-template-columns:4.5rem 1fr;gap:var(--space-3);align-items:center">
            <input class="input" type="number" inputmode="numeric" min="1" max="${max}"
                   data-rotation-position value="${order.get(Number(user.id)) ?? ''}"
                   aria-label="Rotation position for ${esc(user.display_name)}">
            <span>${esc(user.display_name)}</span>
          </label>`).join('')}
      </div>
      <p class="task-field-hint">Enter 1, 2, 3… for the members who should rotate. The first member is assigned the current occurrence.</p>
    </div>`;
}

export function getRotationUserIds(container) {
  return Array.from(container.querySelectorAll('[data-rotation-user]'))
    .map((row, domIndex) => ({
      id: Number(row.dataset.rotationUser),
      position: Number(row.querySelector('[data-rotation-position]')?.value),
      domIndex,
    }))
    .filter((entry) => Number.isInteger(entry.id) && entry.id > 0
      && Number.isFinite(entry.position) && entry.position > 0)
    .sort((a, b) => a.position - b.position || a.domIndex - b.domIndex)
    .map((entry) => entry.id);
}
