import {aggregateMealIngredients} from './shopping-import.js';

/** Pure comparison of stored evaluated demand, never a claim about publication or coverage. */
export function ingredientDemandChanges(before={},after={}){
  const groups=new Map();
  for(const [side,snapshot] of [['before',before],['after',after]]){
    for(const ingredient of snapshot?.ingredients||[]){
      const partition=snapshot.partitions?.find(p=>p.source_meal_ids?.includes(ingredient.meal_id));
      const name=String(ingredient.name||'').trim(),category=String(ingredient.category||'Sonstiges').trim();if(!name)continue;
      const key=JSON.stringify([partition?.context_id??null,name.toLowerCase(),category]);
      if(!groups.has(key))groups.set(key,{name,context_id:partition?.context_id??null,context_name:partition?.name||null,before:[],after:[]});
      groups.get(key)[side].push(ingredient);
    }
  }
  return [...groups.values()].map(group=>{
    const quantities=rows=>aggregateMealIngredients(rows,{precision:6}).map(row=>row.quantity??null).sort((a,b)=>String(a).localeCompare(String(b)));
    const before=quantities(group.before),after=quantities(group.after);
    return {name:group.name,context_id:group.context_id,context_name:group.context_name,before,after,change:!before.length?'added':!after.length?'removed':'changed'};
  }).filter(group=>JSON.stringify(group.before)!==JSON.stringify(group.after));
}
