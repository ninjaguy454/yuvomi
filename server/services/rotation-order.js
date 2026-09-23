/** The shared pure strategy implementation. No consumer owns rotation arithmetic. */
export function orderedRotationSelection({memberIds = [], eligibleIds = memberIds, nextMemberId = null,
  previousMemberId = null, strategy = 'round_robin', direction = 'first_to_last'} = {}) {
  if (!['round_robin','rotating_order','fixed_order'].includes(strategy)) throw new Error('Unknown rotation strategy.');
  if (!['first_to_last','last_to_first'].includes(direction)) throw new Error('Unknown rotation direction.');
  const ring = [...new Set(memberIds.map(Number))].filter(id => Number.isSafeInteger(id) && id > 0);
  const eligible = new Set(eligibleIds.map(Number));
  let start = ring.indexOf(Number(nextMemberId));
  if (nextMemberId == null && previousMemberId != null) {
    const previous = ring.indexOf(Number(previousMemberId));
    start = previous < 0 ? 0 : (previous + (strategy === 'rotating_order' && direction === 'last_to_first' ? ring.length - 1 : 1)) % ring.length;
  }
  if (start < 0 || strategy === 'fixed_order') start = 0;
  const ordered = ring.slice(start).concat(ring.slice(0,start)).filter(id => eligible.has(id));
  const selected = strategy === 'round_robin' ? ordered.slice(0,1) : ordered;
  const first = ring.indexOf(ordered[0]);
  return {member_ids:selected, next_member_id:strategy === 'fixed_order' || first < 0
    ? ring[start] ?? null : strategy === 'rotating_order' && direction === 'last_to_first'
      ? ordered.at(-1) : ring[(first + 1) % ring.length] ?? null};
}
