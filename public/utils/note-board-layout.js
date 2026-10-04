/** Shared grid units, with a top-left origin. Projection never writes layouts. */
export const NOTE_COLUMNS = 12;
export const NOTE_ROW_HEIGHT = 48;
export const NOTE_MAX_POSITION = 10000;
export const NOTE_CANVAS_MARGIN = 192;
const integer = (value, fallback, min, max) => Number.isFinite(Number(value))
  ? Math.max(min, Math.min(max, Math.round(Number(value)))) : fallback;

export function normalizeNoteLayout(value = {}) {
  const width = integer(value.width, 4, 3, NOTE_COLUMNS);
  return {
    x: integer(value.x, 0, 0, NOTE_MAX_POSITION),
    y: integer(value.y, 0, 0, 10000),
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

export function organizeNoteLayouts(notes, { includeLocked = false, canEdit = () => true } = {}) {
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
          nextY = Math.max(...overlaps.map(rect => rect.y + rect.height));
        }
        if (nextY <= NOTE_MAX_POSITION && nextY < y) { x = column; y = nextY; }
      }
    }
    if (!Number.isFinite(y)) throw new RangeError('The Notes canvas is full.');
    occupied.push({ x, y, width: layout.width, height: layout.height });
    return { note_id: note.id, expected_layout_revision: layout.revision, layout: { x, y, width: layout.width, height: layout.height } };
  });
}

export function projectNoteLayouts(notes, { compact = false, filtered = false } = {}) {
  const defaults = new Map(organizeNoteLayouts(notes, { includeLocked: true }).map(item => [item.note_id, item.layout]));
  let y = 0;
  return notes.map(note => {
    const layout = normalizeNoteLayout(filtered ? { ...defaults.get(note.id), revision: note.layout?.revision } : note.layout || defaults.get(note.id));
    if (compact) { layout.x = 0; layout.y = y; layout.width = NOTE_COLUMNS; y += layout.height; }
    return { note_id: note.id, layout };
  });
}
