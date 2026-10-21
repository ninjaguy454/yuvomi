// Visual intent is separate from the canonical Task model. A write may be
// acknowledged while its list refresh is still pending, so the record stays
// locked until the latest canonical result is in place.
export function createTaskStatusFeedback(paint) {
  const records=new Map();
  let sequence=0;
  const emit=record=>paint(record ? {id:record.id,status:record.status,phase:record.phase} : null);
  return {
    begin(id,status) {
      id=Number(id);
      if(records.has(id))return null;
      const token=++sequence;
      const record={id,status,phase:'pending',token};
      records.set(id,record);emit(record);
      return token;
    },
    set(id,token,phase) {
      const record=records.get(Number(id));
      if(!record||record.token!==token)return false;
      record.phase=phase;emit(record);return true;
    },
    clear(id,token) {
      id=Number(id);
      const record=records.get(id);
      if(!record||record.token!==token)return false;
      records.delete(id);paint({id,status:null,phase:null});return true;
    },
    resetSettled(id) {
      id=Number(id);
      const record=records.get(id);
      if(!['failed','confirmed','refresh_failed'].includes(record?.phase))return false;
      records.delete(id);paint({id,status:null,phase:null});return true;
    },
    get(id) {const record=records.get(Number(id));return record&&{id:record.id,status:record.status,phase:record.phase};},
    repaint() {for(const record of records.values())emit(record);},
  };
}
