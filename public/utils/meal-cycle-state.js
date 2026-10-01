import {zonedFields} from './timezone.js';
const clone=value=>structuredClone(value);
export function cycleWallTime(value,zone){const f=zonedFields(value,zone);if(!f)return '';const two=n=>String(n).padStart(2,'0');return `${f.year}-${two(f.month)}-${two(f.day)}T${two(f.hour)}:${two(f.minute)}:${two(f.second)}`;}
export function customChoice(draft){draft.recipe_id=null;return draft;}
export function cycleReturnPath(search){const q=new URLSearchParams(search),id=q.get('cycle_return'),person=q.get('beneficiary');if(!/^[1-9]\d*$/.test(id||''))return null;return `/meals?cycle=${id}${/^[1-9]\d*$/.test(person||'')?`&beneficiary=${person}`:''}&purpose=shopping`;}
/** A draft belongs to one person/period. Unknown writes keep their exact payload. */
export function createCycleDraft(){
  let revision=0,load=0,inflight=null,pending=null;const changes=new Map();
  return {
    forms:{},
    edit(id,change){if(pending)throw new Error('Retry the pending operation before editing.');changes.set(`${id}:${change.kind||'main'}`,{meal_id:id,...clone(change)});},
    begin(id,kind='main'){return clone(changes.get(`${id}:${kind}`)||{});},
    accept(id,value){this.edit(id,value);},
    changes(){const rank={main:0,sides:1,ingredients:2,decision:3};return [...changes.values()].map(clone).sort((a,b)=>(rank[a.kind]??0)-(rank[b.kind]??0));},
    remove(id,kind){if(pending)throw new Error('Retry the pending operation before editing.');changes.delete(`${id}:${kind}`);},
    loadToken(){return ++load;},
    acceptLoad(token,value){if(token!==load)return false;revision=value.revision;return true;},
    get revision(){return revision;},get pending(){return pending;},get busy(){return Boolean(inflight);},
    run(action,send,extra={}){
      if(inflight)return inflight;
      if(pending&&pending.action!==action)return Promise.reject(new Error('Retry the pending operation first.'));
      if(!pending)pending={action,payload:{expected_revision:revision,request_key:globalThis.crypto.randomUUID(),...clone(extra),...(['save','preview'].includes(action)?{changes:this.changes()}:{} )}};
      const active=pending;
      // Invoke before returning, so duplicate events share the same operation.
      let result;try{result=send(clone(active.payload));}catch(error){result=Promise.reject(error);}
      inflight=Promise.resolve(result).then(value=>{revision=value.revision??revision;if(['save','preview'].includes(action))changes.clear();pending=null;return value;},error=>{if(error.outcome==='rejected')pending=null;throw error;}).finally(()=>{inflight=null;});
      return inflight;
    },
  };
}

export function renderCycleReturn(container,label,search=window.location.search){
  const path=cycleReturnPath(search);if(!path)return;
  const link=document.createElement('a');link.className='btn btn--secondary';link.href=path;link.dataset.nav='';link.textContent=label;container.prepend(link);
}
