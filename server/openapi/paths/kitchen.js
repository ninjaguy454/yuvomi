import { op, idParam } from '../helpers.js';

const integer={type:'integer',minimum:1};
const revision={type:'integer',minimum:0};
const timing={oneOf:[{type:'object',additionalProperties:false,required:['day_offset','time'],properties:{day_offset:{type:'integer',minimum:-366,maximum:366},time:{type:'string',pattern:'^([01][0-9]|2[0-3]):[0-5][0-9]$'}}},{type:'object',additionalProperties:false,required:['day','month_offset','time'],properties:{day:{type:'integer',minimum:1,maximum:31},month_offset:{type:'integer',minimum:-12,maximum:12},time:{type:'string'}}}]};
const schedule={type:'object',additionalProperties:false,properties:{creation:timing,response:timing,confirmation:timing,shopping:timing,finalization_mode:{type:'string',enum:['manual','automatic']}}};
const settings={type:'object',additionalProperties:false,properties:{...schedule.properties,enabled:{type:'boolean'},timezone:{type:'string'},cadence:{type:'string',enum:['daily','weekly','fortnightly','monthly']},first_period_start:{type:'string',format:'date'},coordinator_id:integer,shopping_assignee_id:integer,shopping_list_id:integer}};
const changes={type:'array',maxItems:200,items:{type:'object',required:['meal_id','kind'],additionalProperties:false,properties:{meal_id:integer,kind:{type:'string',enum:['main','decision','ingredients','sides']},title:{type:'string',maxLength:300},recipe_id:{type:['integer','null']},decision:{type:'object',description:'Canonical own meal answer; optional select_shared_main:true resolves the current main in order and retains valid selected sides. Optional select_side_ids lists explicit existing own-meal side IDs; an empty array removes side choices. New side options become selectable after approved creation. No actor or beneficiary fields.'},ingredients:{type:'array',maxItems:500,items:{type:'object'}},operations:{type:'array',maxItems:50,items:{type:'object',additionalProperties:false,required:['operation'],properties:{operation:{type:'string',enum:['add','edit','remove']},id:integer,title:{type:'string',maxLength:300},recipe_id:{type:['integer','null']}}}}}}};
const identity={expected_revision:revision,request_key:{type:'string',minLength:1,maxLength:200}};
function cyclePaths(prefix){
  const paths={};
  const add=(path,method,summary,properties=null,required=[],mutation=false)=>{
    const params=[...(path.includes('{cycleId}')?[idParam('cycleId','Immutable planning period')]:[]),...(path.includes('{proposalId}')?[idParam('proposalId','Stored adjustment proposal')]:[])];
    if(method==='get'&&(path==='/{cycleId}'||path.includes('{proposalId}')))params.push({name:'beneficiary_id',in:'query',schema:integer,description:'Self, or another household member for an authorized administrator.'});
    const entry=op({summary,tag:'Kitchen',params,stateChanging:method!=='get',requestBody:properties?{required:true,content:{'application/json':{schema:{type:'object',additionalProperties:false,required:mutation?['expected_revision','request_key',...required]:required,properties:mutation?{...identity,...properties}:properties}}}}:null,
      responses:{200:{description:'Authorized current projection or immutable result receipt'},400:{description:'Invalid operation input'},401:{description:'Personal authentication required'},403:{description:'Current user, token, module or device access denied'},409:{description:'Revision/key conflict or actionable readiness/staleness blocker'}},
      description:'Personal household authentication and Meals scope are required. Nested Tasks/Shopping information is filtered with current user, token and module permissions. Mutations recheck downstream capabilities, revision and durable request identity. Retry an uncertain write with the identical body and request key. Reads never generate meals or outputs. No public actor, clock, scheduler trigger or internal write scope is accepted.'});
    entry.operationId=`${prefix.includes('/meals/')?'mealsCycleAlias':'kitchenCycle'}_${method}_${path.replace(/[^a-zA-Z0-9]/g,'_')}`;
    (paths[prefix+path]??={})[method]=entry;
  };
  add('','get','List Kitchen planning periods');
  add('/settings','get','Read planning settings and authorized setup options');
  add('/settings','put','Save future planning settings',{settings},['settings'],true);
  add('/preview','post','Validate and preview settings without writes',{settings},['settings']);
  add('/ensure','post','Explicitly create or adopt an anchored period',{start:{type:'string',format:'date'}},['start'],true);
  add('/{cycleId}','get','Read own planning view or authorized household review');
  add('/{cycleId}/save','post','Save visible personal draft without completing its Task',{beneficiary_id:integer,changes},['changes'],true);
  add('/{cycleId}/submit','post','Submit saved choices and complete the active personal Task',{beneficiary_id:integer},[],true);
  add('/{cycleId}/confirm','post','Confirm current household inputs and publish outputs',{},[],true);
  add('/{cycleId}/acknowledge','post','Record reviewed ingredient gaps without early finalization',{meal_ids:{type:'array',items:integer}},['meal_ids'],true);
  add('/{cycleId}/reschedule-preview','post','Preview existing period times and due-now effect',{schedule},['schedule']);
  add('/{cycleId}/reschedule','post','Explicitly reschedule an open period',{schedule,confirm_due_now:{type:'boolean'}},['schedule'],true);
  add('/{cycleId}/recover','post','Administrator recovery of invalid open-period assignments',{coordinator_id:integer,shopping_assignee_id:integer},['coordinator_id','shopping_assignee_id'],true);
  add('/{cycleId}/adjustments/{proposalId}','get','Read a permitted stored adjustment preview and fresh staleness');
  add('/{cycleId}/adjustments/preview','post','Stage a reviewed adjustment; existing accepted outputs stay unchanged',{beneficiary_id:integer,changes,base_proposal_id:integer,acknowledge_meal_ids:{type:'array',items:integer}},['changes'],true);
  for(const action of ['apply','cancel','submit'])add(`/{cycleId}/adjustments/${action}`,'post',`${action} a stored adjustment`,{proposal_id:integer,...(action==='submit'?{beneficiary_id:integer}:{})},['proposal_id'],true);
  return paths;
}

export function kitchenPaths() {
  return {
    ...cyclePaths('/api/v1/kitchen/cycles'),
    ...cyclePaths('/api/v1/meals/cycles'),
    '/api/v1/kitchen/summary': {
      get: op({
        summary: 'Kitchen cycle state for the shared tab bar (open shopping items, pantry attention)',
        tag: 'Kitchen',
      }),
    },
  };
}
