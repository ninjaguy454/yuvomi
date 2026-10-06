/** Sparse grants preserve pre-granularity devices until each control is configured. */
export const NOTE_LAYOUT_ACTIONS = ['move','pin','group','ungroup'];
export function deviceNoteAllows(capabilities, action) {
  const key = `device_notes.${action}`;
  const value = capabilities?.[key];
  return (NOTE_LAYOUT_ACTIONS.includes(action) && !Object.hasOwn(capabilities || {}, key)
    ? capabilities?.['device_notes.edit'] : value) === 'allow';
}
/** Old board projections inherit their previous Edit/can_manage authority. */
export function noteItemAllows(item, action) {
  if (!item || item.can_manage === false) return false;
  const permissions = item.kind === 'group' ? item.permissions : item.note?.permissions;
  if (permissions?.[action] !== undefined) return permissions[action] === true;
  return item.kind === 'group' ? item.can_manage === true
    : permissions?.view !== false && permissions?.edit !== false && permissions?.arrange !== false;
}
export function noteLayoutActions(before, after) {
  const actions = [];
  if (!!before.position_locked !== !!after.position_locked) actions.push('pin');
  if (['x','y','width','height'].some(key => before[key] !== after[key]) || !!before.always_on_top !== !!after.always_on_top) actions.push('move');
  return actions;
}
