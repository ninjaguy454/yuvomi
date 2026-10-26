const positiveId = value => {
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
};

/** Selected Groups are policy choices; their members are only assignment candidates. */
export function groupCandidatePool(groups = [], selectedIds = []) {
  const byId = new Map(groups.map(group => [positiveId(group.id), group]));
  const groupIds = [...new Set(selectedIds.map(positiveId).filter(Boolean))];
  const userIds = [], seen = new Set();
  for (const groupId of groupIds) {
    for (const member of byId.get(groupId)?.members || []) {
      const userId = positiveId(member.id);
      if ((member.active != null && !member.active) || !userId || seen.has(userId)) continue;
      seen.add(userId); userIds.push(userId);
    }
  }
  return { groupIds, userIds };
}
