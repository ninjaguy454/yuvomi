import {reviewCycle,cycleSourceFingerprint,cyclePermissionFingerprint} from './meal-cycles.js';
import {loadSourceIngredients} from './meal-grocery-runs.js';
import {mealDishPortionSummary} from './meal-dishes.js';
/** Immutable effective input, captured before publication in the owning transaction. */
export function captureCycleEffective(d,cycleId,{actorId,now}={}) {
 const r=reviewCycle(d,cycleId,{actorId,now});
 const ids=[...new Set(r.destinations.flatMap(p=>p.source_meal_ids))];
 return {version:1,occurrences:r.occurrences,partitions:r.destinations,
  dishes:ids.flatMap(id=>mealDishPortionSummary(d,id).dishes.filter(x=>x.meal_id===id)),
  ingredients:loadSourceIngredients(d,r.cycle.period_start,r.cycle.period_end,ids),
  source_fingerprint:cycleSourceFingerprint(d,cycleId),permission_fingerprint:cyclePermissionFingerprint(d,cycleId)};
}
