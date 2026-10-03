/** Shared 12-column geometry. Projection never mutates persisted note layouts. */
export const NOTE_COLUMNS = 12;
export const NOTE_ROW_HEIGHT = 48;
const integer = (value, fallback, min, max) => Number.isFinite(Number(value))
  ? Math.max(min, Math.min(max, Math.round(Number(value)))) : fallback;

export function normalizeNoteLayout(value = {}) {
  const width = integer(value.width, 4, 3, NOTE_COLUMNS);
  return {
    x: integer(value.x, 0, 0, NOTE_COLUMNS - width),
    y: integer(value.y, 0, 0, 10000),
    width,
    height: integer(value.height, 6, 4, 100),
    revision: integer(value.revision, 0, 0, Number.MAX_SAFE_INTEGER),
  };
}

export function organizeNoteLayouts(notes) {
  const heights = Array(NOTE_COLUMNS).fill(0);
  return [...notes].sort((a, b) => Number(!!b.pinned) - Number(!!a.pinned)).map(note => {
    const layout = normalizeNoteLayout(note.layout);
    let x = 0, y = Infinity;
    for (let column = 0; column <= NOTE_COLUMNS - layout.width; column++) {
      const nextY = Math.max(...heights.slice(column, column + layout.width));
      if (nextY < y) { x = column; y = nextY; }
    }
    for (let column = x; column < x + layout.width; column++) heights[column] = y + layout.height;
    return { note_id: note.id, expected_layout_revision: layout.revision, layout: { x, y, width: layout.width, height: layout.height } };
  });
}

export function projectNoteLayouts(notes, { compact = false, filtered = false } = {}) {
  const defaults = new Map(organizeNoteLayouts(notes).map(item => [item.note_id, item.layout]));
  let y = 0;
  return notes.map(note => {
    const layout = normalizeNoteLayout(filtered ? { ...defaults.get(note.id), revision: note.layout?.revision } : note.layout || defaults.get(note.id));
    if (compact) { layout.x = 0; layout.y = y; layout.width = NOTE_COLUMNS; y += layout.height; }
    return { note_id: note.id, layout };
  });
}
