import { memberLabel } from '/utils/member-label.js';
import { esc } from '/utils/html.js';

const title = value => value[0].toUpperCase() + value.slice(1);
const icon = name => `<i data-lucide="${name}" aria-hidden="true"></i>`;
const option = (value, current, label = title(value)) => `<option value="${esc(value)}"${value === current ? ' selected' : ''}>${esc(label)}</option>`;
const check = (name, label, checked, hint = '') => `<label class="device-config__choice"><input type="checkbox" name="${esc(name)}"${checked ? ' checked' : ''}><span><span class="device-config__choice-label">${esc(label)}</span>${hint ? `<small>${esc(hint)}</small>` : ''}</span></label>`;
const section = (label, glyph, body, disclosure = false) => disclosure
  ? `<details class="device-config__section"><summary>${icon(glyph)}<span>${label}</span>${icon('chevron-down')}</summary><div class="device-config__section-body">${body}</div></details>`
  : `<section class="device-config__section"><h3>${icon(glyph)}${label}</h3><div class="device-config__section-body">${body}</div></section>`;

/** Keep inherited grants explicit without changing them during a cosmetic Save. */
export function deviceConfigContent(device, model, { modules, actions, definitions, noteActions }) {
  const { preferences: prefs, permissions, scope } = device;
  const allows = key => permissions.capabilities[key] === 'allow';
  const layoutActions = {move:'Move',pin:'Pin position',group:'Group',ungroup:'Ungroup'};
  const layoutControl = ([key,label]) => {
    const value=permissions.capabilities[`device_notes.${key}`]??'legacy';
    return `<label class="label">${label}<select name="note:${key}" class="input" aria-describedby="device-note-layout-hint">${value==='legacy'?option('legacy',value,'Use Edit permission (legacy)'):''}${option('allow',value,'Allow')}${option('none',value,'Not allowed')}</select></label>`;
  };
  const taskLabels = { complete: 'Complete steps', reopen: 'Reopen steps', reset: 'Reset progress', claim: 'Accept unassigned Tasks', accept_with_helpers: 'Add helpers during acceptance' };
  const taskHints = { complete: 'Existing independent steps only.', claim: 'Choose a member for eligible unassigned Tasks.', accept_with_helpers: 'Requires Accept. Adds co-assignees and allocates unassigned subtasks; does not allow reassignment.' };
  return `<form class="device-config" data-device-config>
    ${section('Device', 'monitor', `<label class="label">Display name<input name="name" class="input" value="${esc(device.name)}" maxlength="80" required></label>`)}
    ${section('Shared content', 'eye', `<p class="device-config__hint">Only household/shared content is available. Permissions are enforced independently of layout.</p>
      <div class="device-config__choices">${modules.map(key => check(`module:${key}`, title(key), permissions.modules[key] !== 'none')).join('')}${check('rotations', 'Shared shower / rotation order', allows('rotations.view'))}${check('points', 'Permitted point totals', scope.show_points)}</div>
      <label class="label">Members shown<select name="members" class="input" multiple size="5" aria-describedby="device-members-hint">${(model.members || []).map(member => option(String(member.id), scope.member_ids.includes(member.id) ? String(member.id) : '', memberLabel(member))).join('')}</select></label>
      <p id="device-members-hint" class="device-config__hint">No selection includes all household members. Private content remains excluded.</p>`)}
    ${section('Task actions', 'list-checks', `<p class="device-config__hint">Anyone using this display can perform the actions allowed here. Supervised work still requires an authenticated qualified person's approval.</p>
      <div class="device-config__choices">${Object.keys(actions).map(key => check(`action:${key}`, taskLabels[key], allows(`device_tasks.${key}`), taskHints[key])).join('')}</div>`)}
    ${section('Notes permissions', 'sticky-note', `<p class="device-config__hint">View shares Everyone notes with anyone at this display. Private and Selected members notes stay hidden. The member filter does not limit Everyone notes.</p>
      <div class="device-config__choices">${Object.entries(noteActions).map(([key, label]) => check(`note:${key}`, label, allows(`device_notes.${key}`))).join('')}</div>
      <div class="device-config__fields">${Object.entries(layoutActions).map(layoutControl).join('')}</div>
      <p id="device-note-layout-hint" class="device-config__hint">Layout actions require View and affect only this display. Move includes resize, page order, Always on top and Auto-organize. Pin locks position; Show on Dashboard uses Edit. Group creates or joins; Ungroup extracts. Transfers and splitting into a new group require both.</p>
      <p class="device-config__hint">Content permissions are independent. Legacy layout controls follow Edit until configured. New devices start with all Notes permissions off.</p>`)}
    ${section('Appearance', 'palette', `<p class="device-config__hint">Appearance and layout apply only to this display.</p><div class="device-config__fields">
      <label class="label">Default view<select name="default_view" class="input">${Object.entries({ wall: 'Dashboard', list: 'Tasks · List', kanban: 'Tasks · Board' }).map(([value, label]) => option(value, prefs.default_view, label)).join('')}</select></label>
      ${Object.entries({ theme: ['system', 'light', 'dark'], palette: ['neutral', 'warm', 'cool'], font: ['default', 'serif'], density: ['comfortable', 'compact'] }).map(([key, values]) => `<label class="label">${title(key)}<select name="${key}" class="input">${values.map(value => option(value, prefs.appearance[key])).join('')}</select></label>`).join('')}</div>`)}
    ${section('Dashboard widgets', 'layout-dashboard', `<div class="device-config__widgets">${prefs.widgets.map(widget => `<div class="device-config__widget" data-device-widget="${esc(widget.id)}">${check(`widget:${widget.id}`, title(widget.id), widget.visible)}<label class="label">Order<input class="input" type="number" name="order:${esc(widget.id)}" min="0" max="50" value="${widget.order}"></label><label class="label">Size<select class="input" name="size:${esc(widget.id)}">${['small', 'medium', 'large'].map(value => option(value, widget.size)).join('')}</select></label></div>`).join('')}</div>`, true)}
    ${section('Advanced Task permissions', 'sliders-horizontal', `<p class="device-config__hint">Off in the family checklist preset. Creation together with point changes lets anyone at this display create rewarded work.</p>
      <div class="device-config__choices">${Object.entries(definitions).map(([key, label]) => check(`definition:${key}`, label, allows(key))).join('')}</div>
      <p class="device-config__hint">Templates, Workflows, reward prices, redemption, ledger changes and administration require personal sign-in.</p>`, true)}
    ${section('Temporary administrator access', 'shield-check', `<div class="device-config__fields"><label class="label">Idle timeout (seconds)<input class="input" name="idle" type="number" min="30" max="300" required value="${device.idle_seconds}"></label><label class="label">Maximum duration (seconds)<input class="input" name="maximum" type="number" min="60" max="1800" required value="${device.maximum_seconds}"></label></div>
      <p class="device-config__hint">Personal access also ends when the app restarts, the temporary page is hidden, or connectivity is lost. Fully Kiosk controls sleep, brightness and Android lockdown.</p>`, true)}
    <div class="modal-panel__footer device-config__footer"><p role="alert" data-device-form-error></p><button type="button" class="btn btn--secondary" data-action="close-modal">Cancel</button><button type="submit" class="btn btn--primary" data-device-save>Save device</button></div>
  </form>`;
}
