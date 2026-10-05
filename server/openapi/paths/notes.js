import { op, jsonBody, idParam } from '../helpers.js';

const strictObject = properties => ({ type:'object', additionalProperties:false, required:Object.keys(properties), properties });
const id = { type:'integer', minimum:1 }, revision = { type:'integer', minimum:1 }, layoutRevision = { type:'integer', minimum:0 };
const ids = { type:'array', minItems:1, maxItems:500, uniqueItems:true, items:id };
const before = { type:['integer','null'], minimum:1 };
const rectangle = strictObject({ x:{ type:'integer', minimum:0, maximum:10000 }, y:{ type:'integer', minimum:0, maximum:10000 },
  width:{ type:'integer', minimum:3, maximum:12 }, height:{ type:'integer', minimum:4, maximum:100 },
  position_locked:{ type:'boolean' }, always_on_top:{ type:'boolean' } });
const expected = strictObject({
  groups:{ type:'array', maxItems:500, items:strictObject({ id, revision }) },
  notes:{ type:'array', maxItems:500, items:strictObject({ id, revision, layout_revision:layoutRevision }) },
});
const variant = (kind, fields) => strictObject({ operation_id:{ type:'string', minLength:1, maxLength:200 }, kind:{ type:'string', enum:[kind] }, expected, ...fields });
const groupCommandBody = { required:true, description:'At most 500 distinct affected notes, including every canonical member of every affected group. Freeze this body once and reuse it unchanged after an uncertain network result.', content:{ 'application/json':{ schema:{ oneOf:[
  variant('create',{ source_note_id:id, target_note_id:id }),
  variant('create',{ source_group_id:id, selected_ids:ids, target_note_id:id }),
  variant('reorder',{ group_id:id, selected_ids:ids, before_note_id:before }),
  variant('transfer',{ source_group_id:id, target_group_id:id, selected_ids:ids, before_note_id:before }),
  variant('join',{ target_group_id:id, note_ids:ids, before_note_id:before }),
  variant('extract',{ source_group_id:id, selected_ids:ids, result:{ type:'string', enum:['group','individual'] }, placements:{ type:'array', minItems:1, maxItems:500, items:rectangle } }),
  variant('arrange',{ items:{ type:'array', minItems:1, maxItems:500, items:strictObject({ kind:{ type:'string', enum:['note','group'] }, id, layout:rectangle }) }, include_locked:{ type:'boolean' } }),
  variant('undo',{ expected:strictObject({ groups:{ type:'array', maxItems:0, items:strictObject({ id, revision }) }, notes:{ type:'array', maxItems:0, items:strictObject({ id, revision, layout_revision:layoutRevision }) } }),
    undo_operation_id:{ type:'string', minLength:1, maxLength:200 } }),
] } } } };

export function notesPaths() {
  return {
    '/api/v1/notes': {
      get: op({ summary: 'List notes', tag: 'Notes' }),
      post: op({ summary: 'Create note', tag: 'Notes', stateChanging: true, requestBody: jsonBody(null) }),
    },
    '/api/v1/notes/{id}': {
      get: op({ summary: 'Read an authorized note', tag: 'Notes', params: [idParam()] }),
      put: op({ summary: 'Update note', tag: 'Notes', params: [idParam()], stateChanging: true, requestBody: jsonBody(null) }),
      delete: op({ summary: 'Delete note', tag: 'Notes', params: [idParam()], stateChanging: true }),
    },
    '/api/v1/notes/members': {
      get: op({ summary: 'Household recipients for note sharing', tag: 'Notes' }),
    },
    '/api/v1/notes/board': {
      get: op({ summary:'Read the authorized Notes board and dense visible group pages', tag:'Notes',
        description:'Returns {data:{notes,groups}} with private, no-store caching. Groups expose id, revision, layout, member_ids and can_manage only for the authorized projection. A single visible member appears as a note. The legacy /notes list remains unchanged.' }),
    },
    '/api/v1/notes/group-operations': {
      post: op({ summary:'Atomically change authorized Notes group structure or layout', tag:'Notes', stateChanging:true,
        description:'Uses body operation_id and context-bound canonical receipts, not the generic Idempotency-Key cache. Every retry rechecks current access. Expected must include all affected group revisions and note content/layout revisions. Undo requires empty expected arrays; the receipt supplies its exact affected scope and checks current revisions against its recorded after-state. Returns {data:{operation_id,replayed,board,undo_available}} with private, no-store caching.',
        requestBody:groupCommandBody, responses:{
          200:{ description:'Authorized current board and operation receipt status' },
          400:{ description:'Invalid command, unknown field, or more than 500 affected notes' },
          401:{ description:'Authentication required' }, 403:{ description:'Current view/edit rights are insufficient' },
          404:{ description:'Unknown or invisible note/group' }, 409:{ description:'Stale revisions, changed context, or reused operation identity' },
          503:{ description:'Group mutations are disabled in recovery mode' },
        } }),
    },
    '/api/v1/notes/changes': {
      get: op({ summary: 'Authorized payload-free Notes change stream', tag: 'Notes' }),
    },
    '/api/v1/notes/layout': {
      patch: op({ summary: 'Atomically arrange authorized notes using layout revisions', tag: 'Notes', stateChanging: true, requestBody: jsonBody(null) }),
    },
    '/api/v1/notes/{id}/layout': {
      patch: op({ summary: 'Move or resize a note using its layout revision', tag: 'Notes', params: [idParam()], stateChanging: true, requestBody: jsonBody(null) }),
    },
    '/api/v1/notes/{id}/pin': {
      patch: op({ summary: 'Toggle note pin state', tag: 'Notes', params: [idParam()], stateChanging: true, requestBody: jsonBody(null) }),
    },
    '/api/v1/notes/{id}/check': {
      patch: op({
        summary: 'Tick one checklist item, addressed by its source line',
        tag: 'Notes',
        params: [idParam()],
        stateChanging: true,
        requestBody: jsonBody(null),
      }),
    },
  };
}
