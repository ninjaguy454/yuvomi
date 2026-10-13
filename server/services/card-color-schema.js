/** Nullable additions only: historic Tasks/Notes and restored copies retain their colors. */
const slots=Array.from({length:12},(_,i)=>`'slot-${String(i+1).padStart(2,'0')}-v1'`).concat("'neutral-v1'").join(',');
export const CARD_COLOR_FIELDS_SQL=`ALTER TABLE tasks ADD COLUMN card_color TEXT CHECK(card_color IS NULL OR card_color IN (${slots}));
  ALTER TABLE tasks ADD COLUMN card_color_choice TEXT CHECK(card_color_choice IS NULL OR json_valid(card_color_choice));
  ALTER TABLE notes ADD COLUMN card_color_slot TEXT CHECK(card_color_slot IS NULL OR card_color_slot IN (${slots}));`;
export function addCardColorSchema(d){
  const has=(table,name)=>d.prepare(`PRAGMA table_info(${table})`).all().some(c=>c.name===name);
  if(!has('tasks','card_color'))d.exec(`ALTER TABLE tasks ADD COLUMN card_color TEXT CHECK(card_color IS NULL OR card_color IN (${slots}));`);
  if(!has('tasks','card_color_choice'))d.exec('ALTER TABLE tasks ADD COLUMN card_color_choice TEXT CHECK(card_color_choice IS NULL OR json_valid(card_color_choice));');
  if(!has('notes','card_color_slot'))d.exec(`ALTER TABLE notes ADD COLUMN card_color_slot TEXT CHECK(card_color_slot IS NULL OR card_color_slot IN (${slots}));`);
  const fields=d.prepare('PRAGMA table_info(tasks)').all().map(c=>c.name).filter(n=>!['revision','updated_at'].includes(n));
  d.exec(`DROP TRIGGER IF EXISTS trg_tasks_revision;
    CREATE TRIGGER trg_tasks_revision AFTER UPDATE OF ${fields.join(',')} ON tasks
    WHEN ${fields.map(n=>`NEW.${n} IS NOT OLD.${n}`).join(' OR ')}
    BEGIN UPDATE tasks SET revision=revision+1 WHERE id=OLD.parent_task_id AND NEW.parent_task_id IS NOT OLD.parent_task_id;
      UPDATE tasks SET revision=revision+1 WHERE id=NEW.id; END;
    DROP TRIGGER IF EXISTS trg_note_board_revision;
    CREATE TRIGGER trg_note_board_revision AFTER UPDATE OF title,content,color,card_color_slot,pinned,visibility,created_by,created_by_device ON notes
      WHEN NEW.title IS NOT OLD.title OR NEW.content IS NOT OLD.content OR NEW.color IS NOT OLD.color OR NEW.card_color_slot IS NOT OLD.card_color_slot
        OR NEW.pinned IS NOT OLD.pinned OR NEW.visibility IS NOT OLD.visibility OR NEW.created_by IS NOT OLD.created_by OR NEW.created_by_device IS NOT OLD.created_by_device
      BEGIN UPDATE notes SET revision=revision+1 WHERE id=NEW.id; END;`);
}
