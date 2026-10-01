// Synchronous, database-local capability. HTTP body fields never enter this scope.
const scopes=new WeakMap();
export function cycleForMeal(d,mealId) {
  if(!d.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='meal_cycle_memberships'").get())return null;
  return d.prepare(`SELECT c.* FROM meal_cycles c JOIN meal_cycle_memberships cm ON cm.cycle_id=c.id
    JOIN meals m ON m.id=? WHERE cm.meal_id=m.id OR cm.meal_id=m.parent_meal_id LIMIT 1`).get(Number(mealId))||null;
}
export function hasCycleMealWrite(d,cycleId) {return scopes.get(d)?.has(Number(cycleId))===true;}
export function withCycleMealWrite(d,cycleId,operation) {
  const previous=scopes.get(d);scopes.set(d,new Set([...(previous||[]),Number(cycleId)]));
  try {const result=operation();if(result?.then)throw new Error('Cycle write scopes must be synchronous.');return result;}
  finally {if(previous)scopes.set(d,previous);else scopes.delete(d);}
}
export function assertCycleMealWrite(d,mealId,{cycleId}={}) {
  const cycle=cycleForMeal(d,mealId);if(!cycle)return null;
  if(cycleId!=null&&Number(cycleId)!==cycle.id)throw cycleWriteError(cycle);
  if(!hasCycleMealWrite(d,cycle.id))throw cycleWriteError(cycle);
  return cycle;
}
function cycleWriteError(cycle) {
  const error=new Error(cycle.state==='finalized'?'Plan confirmed; propose a reviewed cycle adjustment.':'This meal belongs to a Kitchen cycle; open the cycle to save with its current revision.');
  error.status=409;error.code=cycle.state==='finalized'?'MEAL_CYCLE_FINALIZED':'MEAL_CYCLE_WRITE_REQUIRED';error.cycle_id=cycle.id;return error;
}
