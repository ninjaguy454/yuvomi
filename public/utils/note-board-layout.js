/** Shared grid units, with a top-left origin. Projection never writes layouts. */
export const NOTE_COLUMNS = 12;
export const NOTE_ROW_HEIGHT = 48;
export const NOTE_MAX_POSITION = 10000;
export const NOTE_CANVAS_MARGIN = 192;
const integer = (value, fallback, min, max) => Number.isFinite(Number(value))
  ? Math.max(min, Math.min(max, Math.round(Number(value)))) : fallback;
const position = value => Number.isFinite(Number(value)) ? Math.max(0, Math.min(NOTE_MAX_POSITION, Number(value))) : 0;

export function normalizeNoteLayout(value = {}) {
  const width = integer(value.width, 4, 3, NOTE_COLUMNS);
  return {
    x: position(value.x),
    y: position(value.y),
    width,
    height: integer(value.height, 6, 4, 100),
    revision: integer(value.revision, 0, 0, Number.MAX_SAFE_INTEGER),
  };
}

export function noteCanvasExtent(layouts, viewportWidth, viewportHeight) {
  let width = viewportWidth, height = viewportHeight;
  const pitch = viewportWidth / NOTE_COLUMNS;
  for (const value of layouts) {
    const rect = normalizeNoteLayout(value);
    width = Math.max(width, (rect.x + rect.width) * pitch + NOTE_CANVAS_MARGIN);
    height = Math.max(height, (rect.y + rect.height) * NOTE_ROW_HEIGHT + NOTE_CANVAS_MARGIN);
  }
  return { width, height };
}

/** Discover stacks using only the caller's authorized, currently projected notes. */
export function overlappingLockedNoteIds(notes, projected = projectNoteLayouts(notes)) {
  const rectangles = new Map(projected.map(item => [item.note_id, item.layout]));
  return notes.filter(note => {
    const rect = rectangles.get(note.id);
    return note.layout?.position_locked && rect && projected.some(other => other.note_id !== note.id
      && rect.x < other.layout.x + other.layout.width && rect.x + rect.width > other.layout.x
      && rect.y < other.layout.y + other.layout.height && rect.y + rect.height > other.layout.y);
  }).map(note => note.id);
}

function packNoteLayouts(notes, { includeLocked = false, canEdit = () => true } = {}) {
  const fixed = note => !canEdit(note) || (!includeLocked && note.layout?.position_locked);
  const occupied = notes.filter(fixed).map(note => normalizeNoteLayout(note.layout));
  return [...notes].filter(note => !fixed(note)).sort((a, b) => Number(!!b.pinned) - Number(!!a.pinned)).map(note => {
    const layout = normalizeNoteLayout(note.layout);
    let x = 0, y = Infinity;
    // Scan the familiar twelve-column lanes; overflow adds a lane to the right.
    for (let lane = 0; lane <= NOTE_MAX_POSITION && !Number.isFinite(y); lane += NOTE_COLUMNS) {
      for (let column = lane; column <= Math.min(NOTE_MAX_POSITION, lane + NOTE_COLUMNS - layout.width); column++) {
        let nextY = 0;
        while (nextY <= NOTE_MAX_POSITION) {
          const overlaps = occupied.filter(rect => column < rect.x + rect.width && column + layout.width > rect.x && nextY < rect.y + rect.height && nextY + layout.height > rect.y);
          if (!overlaps.length) break;
          nextY = Math.ceil(Math.max(...overlaps.map(rect => rect.y + rect.height)));
        }
        if (nextY <= NOTE_MAX_POSITION && nextY < y) { x = column; y = nextY; }
      }
    }
    if (!Number.isFinite(y)) throw new RangeError('The Notes canvas is full.');
    occupied.push({ x, y, width: layout.width, height: layout.height });
    return { note_id: note.id, expected_layout_revision: layout.revision, layout: { x, y, width: layout.width, height: layout.height } };
  });
}

export function organizeNoteLayouts(notes, { includeLocked = false, canEdit = () => true } = {}) {
  return packNoteLayouts(notes,{includeLocked,canEdit:note=>note.permissions?.arrange!==false && canEdit(note)});
}

export function projectNoteLayouts(notes, { compact = false, filtered = false } = {}) {
  // Saved boards already have geometry. Packing is only a fallback for legacy
  // notes, or an intentional filtered projection, never part of every drag.
  const defaults = filtered || notes.some(note => !note.layout)
    ? new Map(packNoteLayouts(notes, { includeLocked: true }).map(item => [item.note_id, item.layout])) : new Map();
  let y = 0;
  return notes.map(note => {
    const layout = normalizeNoteLayout(filtered ? { ...defaults.get(note.id), revision: note.layout?.revision } : note.layout || defaults.get(note.id));
    if (compact) { layout.x = 0; layout.y = y; layout.width = NOTE_COLUMNS; y += layout.height; }
    return { note_id: note.id, layout };
  });
}

/** A command rectangle never carries a note's layout revision or hidden members. */
export function noteGroupArrangeItem(item, changes = {}) {
  const value = { ...item.layout, ...changes };
  const { x, y, width, height } = normalizeNoteLayout(value);
  return { kind: item.kind, id: item.id, layout: { x, y, width, height,
    position_locked: !!value.position_locked, always_on_top: !!value.always_on_top } };
}

/** Project only authorized notes. Local filtering cannot dissolve stored groups. */
export function projectNoteGroupItems(board, { activePages = new Map(), compact = false, filtered = false } = {}) {
  const notes = board.notes || [], byId = new Map(notes.map(note => [note.id, note]));
  const members = new Map(), groups = new Map();
  for (const group of board.groups || []) {
    const visible = group.member_ids.filter(id => byId.has(id) && !members.has(id));
    if (!visible.length) continue;
    const active = activePages instanceof Map ? activePages.get(group.id) : activePages[group.id];
    const item = { key: `group:${group.id}`, kind: 'group', id: group.id, revision: group.revision,
      layout: noteGroupArrangeItem({ kind:'group', id:group.id, layout:group.layout }).layout,
      note: byId.get(visible.includes(active) ? active : visible[0]), member_ids: visible,
      can_manage: group.can_manage === true && visible.length === group.member_ids.length };
    groups.set(group.id, item);
    visible.forEach(id => members.set(id, group.id));
  }
  const emitted = new Set(), items = [];
  const defaults = new Map(projectNoteLayouts(notes).map(item => [item.note_id,item.layout]));
  for (const note of notes) {
    const groupId = members.get(note.id);
    if (groupId !== undefined) {
      if (!emitted.has(groupId)) { items.push(groups.get(groupId)); emitted.add(groupId); }
    } else items.push({ key:`note:${note.id}`, kind:'note', id:note.id, note,
      layout:noteGroupArrangeItem({ kind:'note', id:note.id, layout:note.layout || defaults.get(note.id) }).layout,
      can_manage:note.permissions?.edit !== false && note.permissions?.arrange !== false });
  }
  const packed = filtered ? new Map(packNoteGroupItems(items, { includeLocked:true, canEdit:()=>true }).map(item=>[`${item.kind}:${item.id}`,item.layout])) : null;
  let y = 0;
  return items.map(item => {
    const layout = { ...(packed?.get(item.key) || item.layout) };
    if (compact) { layout.x=0; layout.y=y; layout.width=NOTE_COLUMNS; y+=layout.height; }
    return { ...item, layout, can_manage:!filtered && item.can_manage };
  });
}

/** Pack whole groups and standalone notes atomically; locked items remain obstacles. */
export function organizeNoteGroupItems(items, { includeLocked = false, canEdit = () => true } = {}) {
  return packNoteGroupItems(items,{includeLocked,canEdit:item=>item.can_manage!==false
    && (item.kind==='group' || item.note?.permissions?.arrange!==false) && canEdit(item)});
}

/** Visual packing has no write authority; structural callers apply it above. */
function packNoteGroupItems(items, { includeLocked = false, canEdit = () => true } = {}) {
  const byKey = new Map(items.map(item => [item.key,item]));
  const proxies = items.map(item => ({ id:item.key, layout:item.layout, pinned:item.kind==='note' && item.note?.pinned }));
  return packNoteLayouts(proxies,{includeLocked,canEdit:proxy=>canEdit(byKey.get(proxy.id))})
    .map(result=>noteGroupArrangeItem(byKey.get(result.note_id),result.layout));
}
