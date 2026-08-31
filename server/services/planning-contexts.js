import { reconcilePlanningContextMealOccurrences } from './meal-plans.js';

const CONTEXT_TYPES = new Set(['home', 'travel', 'custom']);
const CONTEXT_STATUSES = new Set(['active', 'conflict', 'resolved', 'completed', 'cancelled']);
const SOURCE_TYPES = new Set(['calendar_event', 'trip', 'manual']);
const CONFLICT_RESOLUTIONS = new Set(['keep_first', 'keep_second']);
const MEAL_PERIODS = ['breakfast', 'lunch', 'dinner', 'snack'];

function nowSql() {
  return "strftime('%Y-%m-%dT%H:%M:%SZ', 'now')";
}

function atomic(database, work) {
  return database.inTransaction ? work() : database.transaction(work)();
}

function cleanText(value, field, { required = false, max = 240 } = {}) {
  const result = value == null ? '' : String(value).trim();
  if (required && !result) throw new Error(`${field} is required.`);
  if (result.length > max) throw new Error(`${field} is too long.`);
  return result || null;
}

function positiveId(value, field, { required = false } = {}) {
  if (value == null || value === '') {
    if (required) throw new Error(`${field} is required.`);
    return null;
  }
  const id = Number(value);
  if (!Number.isInteger(id) || id < 1) throw new Error(`${field} is invalid.`);
  return id;
}

function timestamp(value, field) {
  const result = cleanText(value, field, { required: true, max: 48 });
  if (!/^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/.test(result)) {
    throw new Error(`${field} is invalid.`);
  }
  if (Number.isNaN(Date.parse(result.length === 10 ? `${result}T00:00:00Z` : result))) {
    throw new Error(`${field} is invalid.`);
  }
  return result;
}

function timeValue(value) {
  return Date.parse(value.length === 10 ? `${value}T00:00:00Z` : value);
}

function validateWindow(startsAt, endsAt) {
  if (timeValue(endsAt) <= timeValue(startsAt)) throw new Error('Planning context end must be after its start.');
}

function validPlace(database, value) {
  const id = positiveId(value, 'Place');
  if (id && !database.prepare('SELECT 1 FROM places WHERE id = ? AND active = 1').get(id)) {
    throw new Error('Choose an active Place.');
  }
  return id;
}

function validatedMemberIds(database, values, { required = false } = {}) {
  if (values === undefined) return undefined;
  const ids = [...new Set((Array.isArray(values) ? values : []).map((value) => positiveId(value, 'Household member', { required: true })))];
  if (required && !ids.length) throw new Error('Choose at least one household member.');
  if (!ids.length) return [];
  const found = database.prepare(`SELECT id FROM users WHERE id IN (${ids.map(() => '?').join(',')})`).all(...ids);
  if (found.length !== ids.length) throw new Error('Choose valid household members.');
  return ids;
}

function addDays(dateKey, days) {
  const date = new Date(`${dateKey}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function calendarEventWindow(event) {
  if (event.all_day) {
    const startDate = String(event.start_datetime).slice(0, 10);
    const inclusiveEndDate = String(event.end_datetime || event.start_datetime).slice(0, 10);
    return {
      startsAt: `${startDate}T00:00:00`,
      endsAt: `${addDays(inclusiveEndDate, 1)}T00:00:00`,
    };
  }
  if (!event.end_datetime) throw new Error('A Travel Event needs a return date or time.');
  return {
    startsAt: timestamp(event.start_datetime, 'Travel Event start'),
    endsAt: timestamp(event.end_datetime, 'Travel Event end'),
  };
}

function contextMembers(database, contextId) {
  return database.prepare(`
    SELECT pcm.*, u.display_name, u.avatar_color, u.avatar_data
      FROM planning_context_members pcm
      JOIN users u ON u.id = pcm.user_id
     WHERE pcm.planning_context_id = ?
     ORDER BY u.display_name COLLATE NOCASE, u.id
  `).all(contextId);
}

function contextSources(database, contextId) {
  return database.prepare(`
    SELECT * FROM planning_context_sources
     WHERE planning_context_id = ?
     ORDER BY source_type, source_key
  `).all(contextId);
}

function contextConflicts(database, contextId) {
  return database.prepare(`
    SELECT pcc.*, u.display_name AS user_name,
           first_context.name AS first_context_name,
           first_context.starts_at AS first_context_starts_at,
           first_context.ends_at AS first_context_ends_at,
           first_place.name AS first_context_place_name,
           second_context.name AS second_context_name,
           second_context.starts_at AS second_context_starts_at,
           second_context.ends_at AS second_context_ends_at,
           second_place.name AS second_context_place_name
      FROM planning_context_conflicts pcc
      JOIN users u ON u.id = pcc.user_id
      JOIN planning_contexts first_context ON first_context.id = pcc.first_context_id
      JOIN planning_contexts second_context ON second_context.id = pcc.second_context_id
      LEFT JOIN places first_place ON first_place.id = first_context.place_id
      LEFT JOIN places second_place ON second_place.id = second_context.place_id
     WHERE pcc.first_context_id = ? OR pcc.second_context_id = ?
     ORDER BY CASE pcc.status WHEN 'open' THEN 0 WHEN 'resolved' THEN 1 ELSE 2 END,
              pcc.overlap_starts_at, pcc.id
  `).all(contextId, contextId).map((row) => ({
    ...row,
    meal_periods: JSON.parse(row.meal_periods_json || '[]'),
  }));
}

export function getPlanningContext(database, id) {
  const contextId = positiveId(id, 'Planning context', { required: true });
  const row = database.prepare(`
    SELECT pc.*, p.name AS place_name
      FROM planning_contexts pc
      LEFT JOIN places p ON p.id = pc.place_id
     WHERE pc.id = ?
  `).get(contextId);
  if (!row) return null;
  return {
    ...row,
    members: contextMembers(database, contextId),
    member_ids: contextMembers(database, contextId)
      .filter((member) => member.membership_status !== 'released')
      .map((member) => Number(member.user_id)),
    sources: contextSources(database, contextId),
    conflicts: contextConflicts(database, contextId),
  };
}

export function listPlanningContexts(database, { from = null, to = null, includeCancelled = false } = {}) {
  const clauses = [];
  const params = [];
  if (!includeCancelled) clauses.push("status != 'cancelled'");
  if (from) {
    clauses.push('ends_at > ?');
    params.push(timestamp(from, 'Planning window start'));
  }
  if (to) {
    clauses.push('starts_at < ?');
    params.push(timestamp(to, 'Planning window end'));
  }
  const rows = database.prepare(`
    SELECT id FROM planning_contexts
    ${clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''}
    ORDER BY starts_at, id
  `).all(...params);
  return rows.map((row) => getPlanningContext(database, row.id));
}

function replaceMembers(database, contextId, memberIds, actorId) {
  const desired = new Set(memberIds.map(Number));
  const existing = database.prepare(`
    SELECT user_id, membership_status
      FROM planning_context_members
     WHERE planning_context_id = ?
  `).all(contextId);
  let changed = existing.some((row) => (
    (desired.has(Number(row.user_id)) && row.membership_status === 'released')
    || (!desired.has(Number(row.user_id)) && row.membership_status !== 'released')
  ));
  if (existing.filter((row) => row.membership_status !== 'released').length !== desired.size) changed = true;

  database.prepare(`
    UPDATE planning_context_members
       SET membership_status = 'released', updated_at = ${nowSql()}
     WHERE planning_context_id = ? AND membership_status != 'released'
  `).run(contextId);
  const upsert = database.prepare(`
    INSERT INTO planning_context_members (
      planning_context_id, user_id, membership_status, added_by, updated_at
    ) VALUES (?, ?, 'active', ?, ${nowSql()})
    ON CONFLICT(planning_context_id, user_id) DO UPDATE SET
      membership_status = 'active',
      added_by = COALESCE(planning_context_members.added_by, excluded.added_by),
      updated_at = excluded.updated_at
  `);
  for (const userId of desired) upsert.run(contextId, userId, actorId || null);
  return changed;
}

export function replacePlanningContextMembers(database, contextId, memberIds, actorId = null) {
  const id = positiveId(contextId, 'Planning context', { required: true });
  if (!database.prepare('SELECT 1 FROM planning_contexts WHERE id = ?').get(id)) throw new Error('Planning context not found.');
  const validated = validatedMemberIds(database, memberIds, { required: false });
  return atomic(database, () => {
    const changed = replaceMembers(database, id, validated, actorId);
    if (changed) database.prepare(`UPDATE planning_contexts SET revision = revision + 1, updated_at = ${nowSql()} WHERE id = ?`).run(id);
    reconcilePlanningContextConflicts(database, actorId);
    reconcilePlanningContextMealOccurrences(database, { contextIds: [id], actorId });
    return getPlanningContext(database, id);
  });
}

export function attachPlanningContextSource(database, contextId, source, { allowMove = false } = {}) {
  const id = positiveId(contextId, 'Planning context', { required: true });
  if (!database.prepare('SELECT 1 FROM planning_contexts WHERE id = ?').get(id)) throw new Error('Planning context not found.');
  const sourceType = cleanText(source?.sourceType ?? source?.source_type, 'Planning source type', { required: true, max: 40 });
  const sourceKey = cleanText(source?.sourceKey ?? source?.source_key, 'Planning source key', { required: true, max: 180 });
  const sourceId = positiveId(source?.sourceId ?? source?.source_id, 'Planning source id');
  if (!SOURCE_TYPES.has(sourceType)) throw new Error('Planning source type is invalid.');
  return atomic(database, () => {
    const existing = database.prepare(`
      SELECT * FROM planning_context_sources
       WHERE source_type = ? AND source_key = ?
    `).get(sourceType, sourceKey);
    if (existing && Number(existing.planning_context_id) !== id && !allowMove) {
      throw new Error('That planning source already belongs to another context.');
    }
    if (existing) {
      database.prepare(`
        UPDATE planning_context_sources
           SET planning_context_id = ?, source_id = ?
         WHERE source_type = ? AND source_key = ?
      `).run(id, sourceId, sourceType, sourceKey);
    } else {
      database.prepare(`
        INSERT INTO planning_context_sources (
          planning_context_id, source_type, source_id, source_key
        ) VALUES (?, ?, ?, ?)
      `).run(id, sourceType, sourceId, sourceKey);
    }
    return database.prepare(`
      SELECT * FROM planning_context_sources
       WHERE source_type = ? AND source_key = ?
    `).get(sourceType, sourceKey);
  });
}

export function detachPlanningContextSource(database, source) {
  const sourceType = cleanText(source?.sourceType ?? source?.source_type, 'Planning source type', { required: true, max: 40 });
  const sourceKey = cleanText(source?.sourceKey ?? source?.source_key, 'Planning source key', { required: true, max: 180 });
  const existing = database.prepare(`
    SELECT * FROM planning_context_sources
     WHERE source_type = ? AND source_key = ?
  `).get(sourceType, sourceKey);
  if (!existing) return null;
  database.prepare('DELETE FROM planning_context_sources WHERE source_type = ? AND source_key = ?')
    .run(sourceType, sourceKey);
  return existing;
}

function conflictCandidates(database) {
  const memberships = database.prepare(`
    SELECT pcm.user_id, pcm.planning_context_id, pc.starts_at, pc.ends_at
      FROM planning_context_members pcm
      JOIN planning_contexts pc ON pc.id = pcm.planning_context_id
     WHERE pcm.membership_status IN ('active', 'conflict')
       AND pc.status NOT IN ('completed', 'cancelled')
     ORDER BY pcm.user_id, pc.id
  `).all();
  const byUser = new Map();
  for (const row of memberships) {
    if (!byUser.has(Number(row.user_id))) byUser.set(Number(row.user_id), []);
    byUser.get(Number(row.user_id)).push(row);
  }
  const pairs = [];
  for (const [userId, contexts] of byUser) {
    for (let firstIndex = 0; firstIndex < contexts.length; firstIndex += 1) {
      for (let secondIndex = firstIndex + 1; secondIndex < contexts.length; secondIndex += 1) {
        const left = contexts[firstIndex];
        const right = contexts[secondIndex];
        const leftStart = timeValue(left.starts_at);
        const rightStart = timeValue(right.starts_at);
        const leftEnd = timeValue(left.ends_at);
        const rightEnd = timeValue(right.ends_at);
        const overlapStart = leftStart >= rightStart ? left.starts_at : right.starts_at;
        const overlapEnd = leftEnd <= rightEnd ? left.ends_at : right.ends_at;
        if (timeValue(overlapEnd) <= timeValue(overlapStart)) continue;
        pairs.push({
          userId,
          firstContextId: Math.min(Number(left.planning_context_id), Number(right.planning_context_id)),
          secondContextId: Math.max(Number(left.planning_context_id), Number(right.planning_context_id)),
          overlapStart,
          overlapEnd,
        });
      }
    }
  }
  return pairs;
}

function conflictIdentity(pair) {
  return `${pair.userId}:${pair.firstContextId}:${pair.secondContextId}:${pair.overlapStart}:${pair.overlapEnd}`;
}

export function reconcilePlanningContextConflicts(database, actorId = null) {
  return atomic(database, () => {
    // Earlier builds exposed `allow_both`, although two distinct contexts
    // cannot both own one person's meal-period decisions. Reopen those legacy
    // resolutions so the household makes the now-required keep-one choice.
    const legacyAllowBoth = database.prepare(`
      SELECT * FROM planning_context_conflicts
       WHERE status = 'resolved' AND resolution = 'allow_both'
    `).all();
    database.prepare(`
      UPDATE planning_context_conflicts
         SET status = 'open', resolution = NULL, resolved_by = NULL,
             resolved_at = NULL, updated_at = ${nowSql()}
       WHERE status = 'resolved' AND resolution = 'allow_both'
    `).run();
    const pairs = conflictCandidates(database);
    const current = new Set(pairs.map(conflictIdentity));
    const existingRows = database.prepare('SELECT * FROM planning_context_conflicts').all();
    const affectedContextIds = new Set();
    for (const pair of pairs) {
      affectedContextIds.add(Number(pair.firstContextId));
      affectedContextIds.add(Number(pair.secondContextId));
    }
    for (const row of existingRows) {
      affectedContextIds.add(Number(row.first_context_id));
      affectedContextIds.add(Number(row.second_context_id));
    }
    for (const row of existingRows) {
      const key = conflictIdentity({
        userId: Number(row.user_id),
        firstContextId: Number(row.first_context_id),
        secondContextId: Number(row.second_context_id),
        overlapStart: row.overlap_starts_at,
        overlapEnd: row.overlap_ends_at,
      });
      if (row.status === 'open' && !current.has(key)) {
        database.prepare(`
          UPDATE planning_context_conflicts
             SET status = 'superseded', updated_at = ${nowSql()}
           WHERE id = ?
        `).run(row.id);
      }
    }

    for (const pair of pairs) {
      const existing = database.prepare(`
        SELECT * FROM planning_context_conflicts
         WHERE user_id = ? AND first_context_id = ? AND second_context_id = ?
           AND overlap_starts_at = ? AND overlap_ends_at = ?
      `).get(pair.userId, pair.firstContextId, pair.secondContextId, pair.overlapStart, pair.overlapEnd);
      if (existing?.status === 'resolved') {
        if (existing.resolution === 'keep_first') {
          database.prepare(`
            UPDATE planning_context_members
               SET membership_status = 'released', updated_at = ${nowSql()}
             WHERE planning_context_id = ? AND user_id = ?
          `).run(pair.secondContextId, pair.userId);
        } else if (existing.resolution === 'keep_second') {
          database.prepare(`
            UPDATE planning_context_members
               SET membership_status = 'released', updated_at = ${nowSql()}
             WHERE planning_context_id = ? AND user_id = ?
          `).run(pair.firstContextId, pair.userId);
        }
        continue;
      }
      if (existing?.status === 'open') continue;
      if (existing?.status === 'superseded') {
        database.prepare(`
          UPDATE planning_context_conflicts
             SET status = 'open', resolution = NULL, resolved_by = NULL,
                 resolved_at = NULL, meal_periods_json = ?, updated_at = ${nowSql()}
           WHERE id = ?
        `).run(JSON.stringify(MEAL_PERIODS), existing.id);
      } else {
        database.prepare(`
          INSERT INTO planning_context_conflicts (
            user_id, first_context_id, second_context_id, overlap_starts_at,
            overlap_ends_at, meal_periods_json, status
          ) VALUES (?, ?, ?, ?, ?, ?, 'open')
        `).run(
          pair.userId, pair.firstContextId, pair.secondContextId,
          pair.overlapStart, pair.overlapEnd, JSON.stringify(MEAL_PERIODS),
        );
      }
    }

    database.prepare(`
      UPDATE planning_context_members
         SET membership_status = 'active', updated_at = ${nowSql()}
       WHERE membership_status = 'conflict'
    `).run();
    database.prepare(`
      UPDATE planning_contexts
         SET status = 'active', updated_at = ${nowSql()}
       WHERE status IN ('conflict', 'resolved')
    `).run();
    const openConflicts = database.prepare(`
      SELECT * FROM planning_context_conflicts WHERE status = 'open'
    `).all();
    const markMember = database.prepare(`
      UPDATE planning_context_members
         SET membership_status = 'conflict', updated_at = ${nowSql()}
       WHERE planning_context_id = ? AND user_id = ? AND membership_status != 'released'
    `);
    const markContext = database.prepare(`
      UPDATE planning_contexts SET status = 'conflict', updated_at = ${nowSql()}
       WHERE id = ? AND status NOT IN ('completed', 'cancelled')
    `);
    for (const conflict of openConflicts) {
      markMember.run(conflict.first_context_id, conflict.user_id);
      markMember.run(conflict.second_context_id, conflict.user_id);
      markContext.run(conflict.first_context_id);
      markContext.run(conflict.second_context_id);
    }
    reconcilePlanningContextMealOccurrences(database, {
      contextIds: [...affectedContextIds],
      actorId,
    });
    // `allow_both` used to regenerate Away periods and task eligibility in
    // both contexts. Reopening the decision must repair those projections in
    // the same transaction, not leave both plans operational until edited.
    const repairedContexts = new Set();
    for (const conflict of legacyAllowBoth) {
      for (const rawContextId of [conflict.first_context_id, conflict.second_context_id]) {
        const contextId = Number(rawContextId);
        if (repairedContexts.has(contextId)) continue;
        repairedContexts.add(contextId);
        const context = database.prepare('SELECT * FROM planning_contexts WHERE id = ?').get(contextId);
        if (!context) continue;
        const repairActorId = Number(conflict.resolved_by || conflict.user_id || context.created_by || 0) || null;
        reconcilePlanningContextAwayPeriods(database, contextId, repairActorId);
        if (context.context_type === 'travel') {
          ensureTravelMealPlanTask(database, contextId, repairActorId);
        }
      }
    }
    return openConflicts.map((row) => ({ ...row, meal_periods: JSON.parse(row.meal_periods_json || '[]') }));
  });
}

export function resolvePlanningContextConflict(database, conflictId, resolution, actorId) {
  const id = positiveId(conflictId, 'Planning context conflict', { required: true });
  const choice = cleanText(resolution, 'Conflict resolution', { required: true, max: 40 });
  if (!CONFLICT_RESOLUTIONS.has(choice)) throw new Error('Choose which planning context to keep.');
  const actor = positiveId(actorId, 'Resolving household member', { required: true });
  return atomic(database, () => {
    const conflict = database.prepare('SELECT * FROM planning_context_conflicts WHERE id = ?').get(id);
    if (!conflict) throw new Error('Planning context conflict not found.');
    if (conflict.status !== 'open') throw new Error('This planning context conflict is already closed.');
    database.prepare(`
      UPDATE planning_context_conflicts
         SET status = 'resolved', resolution = ?, resolved_by = ?,
             resolved_at = ${nowSql()}, updated_at = ${nowSql()}
       WHERE id = ? AND status = 'open'
    `).run(choice, actor, id);
    if (choice === 'keep_first' || choice === 'keep_second') {
      const releasedContextId = choice === 'keep_first'
        ? Number(conflict.second_context_id)
        : Number(conflict.first_context_id);
      database.prepare(`
        UPDATE planning_context_members
           SET membership_status = 'released', updated_at = ${nowSql()}
         WHERE planning_context_id = ? AND user_id = ?
      `).run(releasedContextId, conflict.user_id);
    }
    reconcilePlanningContextConflicts(database, actor);
    for (const contextId of [conflict.first_context_id, conflict.second_context_id]) {
      reconcilePlanningContextAwayPeriods(database, contextId, actor);
      ensureTravelMealPlanTask(database, contextId, actor);
    }
    return {
      ...database.prepare('SELECT * FROM planning_context_conflicts WHERE id = ?').get(id),
      first_context: getPlanningContext(database, conflict.first_context_id),
      second_context: getPlanningContext(database, conflict.second_context_id),
    };
  });
}

export function savePlanningContext(database, body, actorId, id = null) {
  const contextId = id == null ? null : positiveId(id, 'Planning context', { required: true });
  const existing = contextId ? database.prepare('SELECT * FROM planning_contexts WHERE id = ?').get(contextId) : null;
  if (contextId && !existing) throw new Error('Planning context not found.');
  const contextKey = cleanText(body.context_key ?? body.contextKey ?? existing?.context_key, 'Planning context key', { required: true, max: 180 });
  const name = cleanText(body.name ?? existing?.name, 'Planning context name', { required: true, max: 160 });
  const contextType = body.context_type ?? body.contextType ?? existing?.context_type ?? 'home';
  const status = body.status ?? existing?.status ?? 'active';
  if (!CONTEXT_TYPES.has(contextType)) throw new Error('Planning context type is invalid.');
  if (!CONTEXT_STATUSES.has(status)) throw new Error('Planning context status is invalid.');
  const startsAt = timestamp(body.starts_at ?? body.startsAt ?? existing?.starts_at, 'Planning context start');
  const endsAt = timestamp(body.ends_at ?? body.endsAt ?? existing?.ends_at, 'Planning context end');
  validateWindow(startsAt, endsAt);
  const placeId = validPlace(database, body.place_id ?? body.placeId ?? existing?.place_id);
  const members = validatedMemberIds(database, body.member_ids ?? body.memberIds, { required: false });
  let savedId = contextId;
  return atomic(database, () => {
    if (existing) {
      const coreChanged = existing.context_key !== contextKey
        || existing.name !== name
        || existing.context_type !== contextType
        || existing.starts_at !== startsAt
        || existing.ends_at !== endsAt
        || Number(existing.place_id || 0) !== Number(placeId || 0)
        || existing.status !== status;
      database.prepare(`
        UPDATE planning_contexts
           SET context_key = ?, name = ?, context_type = ?, starts_at = ?, ends_at = ?,
               place_id = ?, status = ?, revision = revision + ?, updated_at = ${nowSql()}
         WHERE id = ?
      `).run(contextKey, name, contextType, startsAt, endsAt, placeId, status, coreChanged ? 1 : 0, savedId);
    } else {
      savedId = Number(database.prepare(`
        INSERT INTO planning_contexts (
          context_key, name, context_type, starts_at, ends_at, place_id, status, created_by
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(contextKey, name, contextType, startsAt, endsAt, placeId, status, actorId || null).lastInsertRowid);
    }
    if (members !== undefined) {
      const changed = replaceMembers(database, savedId, members, actorId);
      if (changed && existing) database.prepare(`UPDATE planning_contexts SET revision = revision + 1, updated_at = ${nowSql()} WHERE id = ?`).run(savedId);
    }
    if (body.source) attachPlanningContextSource(database, savedId, body.source, { allowMove: body.allow_source_move === true });
    reconcilePlanningContextConflicts(database, actorId);
    reconcilePlanningContextMealOccurrences(database, { contextIds: [savedId], actorId });
    return getPlanningContext(database, savedId);
  });
}

function contextAwayNote(contextId) {
  return `Planning context:${contextId}:travel`;
}

export function reconcilePlanningContextAwayPeriods(database, contextId, actorId = null) {
  const id = positiveId(contextId, 'Planning context', { required: true });
  return atomic(database, () => {
    const context = database.prepare('SELECT * FROM planning_contexts WHERE id = ?').get(id);
    if (!context) throw new Error('Planning context not found.');
    const note = contextAwayNote(id);
    const enabled = context.context_type === 'travel' && context.status !== 'cancelled' && Boolean(database.prepare(`
      SELECT (
        EXISTS(
          SELECT 1 FROM calendar_travel_details
           WHERE planning_context_id = ? AND create_away_periods = 1
        ) OR EXISTS(
          SELECT 1 FROM trip_plans
           WHERE planning_context_id = ? AND create_away_periods = 1 AND status != 'cancelled'
        )
      ) AS enabled
    `).get(id, id)?.enabled);
    const desiredMembers = enabled ? database.prepare(`
      SELECT user_id FROM planning_context_members
       WHERE planning_context_id = ? AND membership_status = 'active'
       ORDER BY user_id
    `).all(id).map((row) => Number(row.user_id)) : [];
    const desired = new Set(desiredMembers);
    const existing = database.prepare(`
      SELECT * FROM availability_periods
       WHERE source = 'explicit' AND category = 'travel' AND note = ?
       ORDER BY id
    `).all(note);
    const byUser = new Map(existing.map((row) => [Number(row.user_id), row]));
    const remove = database.prepare('DELETE FROM availability_periods WHERE id = ?');
    for (const row of existing) if (!desired.has(Number(row.user_id))) remove.run(row.id);
    const update = database.prepare(`
      UPDATE availability_periods
         SET state = 'away', custom_state = NULL, place_id = ?, starts_at = ?, ends_at = ?,
             active = 1, updated_at = ${nowSql()}
       WHERE id = ?
    `);
    const insert = database.prepare(`
      INSERT INTO availability_periods (
        user_id, source, category, state, place_id, starts_at, ends_at, note, active, created_by
      ) VALUES (?, 'explicit', 'travel', 'away', ?, ?, ?, ?, 1, ?)
    `);
    const periodByUser = new Map();
    for (const userId of desiredMembers) {
      const row = byUser.get(userId);
      if (row) {
        update.run(context.place_id, context.starts_at, context.ends_at, row.id);
        periodByUser.set(userId, Number(row.id));
      } else {
        const result = insert.run(
          userId, context.place_id, context.starts_at, context.ends_at, note,
          actorId || context.created_by || null,
        );
        periodByUser.set(userId, Number(result.lastInsertRowid));
      }
    }
    database.prepare(`
      UPDATE trip_participants
         SET availability_period_id = NULL
       WHERE trip_id IN (SELECT id FROM trip_plans WHERE planning_context_id = ?)
    `).run(id);
    const linkTripPeriod = database.prepare(`
      UPDATE trip_participants
         SET availability_period_id = ?
       WHERE user_id = ?
         AND trip_id IN (SELECT id FROM trip_plans WHERE planning_context_id = ?)
    `);
    for (const [userId, periodId] of periodByUser) linkTripPeriod.run(periodId, userId, id);
    return database.prepare(`
      SELECT * FROM availability_periods
       WHERE source = 'explicit' AND category = 'travel' AND note = ?
       ORDER BY user_id
    `).all(note);
  });
}

function previousGeneratedDueDate(actionLink) {
  if (!actionLink?.params_json) return null;
  try { return JSON.parse(actionLink.params_json)?.generated_due_date || null; } catch { return null; }
}

function travelTaskDueDate(context) {
  return addDays(context.starts_at.slice(0, 10), -1);
}

export function getTravelMealPlanTask(database, contextId) {
  const id = positiveId(contextId, 'Planning context', { required: true });
  const row = database.prepare(`
    SELECT t.*, tac.strategy, tac.state AS assignment_state, tal.action_type,
           tal.label AS action_label, tal.path AS action_path, tal.params_json,
           tal.source_type, tal.source_id
      FROM task_action_links tal
      JOIN tasks t ON t.id = tal.task_id
      LEFT JOIN task_assignment_context tac ON tac.task_id = t.id
     WHERE tal.action_type = 'travel_meal_plan'
       AND tal.source_type = 'planning_context' AND tal.source_id = ?
     ORDER BY t.id
  `).all(id);
  if (row.length > 1) throw new Error('This planning context has more than one travel meal-plan Task.');
  if (!row.length) return null;
  const eligible = database.prepare(`
    SELECT tce.user_id, u.display_name, u.avatar_color, u.avatar_data
      FROM task_claim_eligibility tce
      JOIN users u ON u.id = tce.user_id
     WHERE tce.task_id = ? ORDER BY u.display_name COLLATE NOCASE, u.id
  `).all(row[0].id);
  let actionParams = {};
  try { actionParams = JSON.parse(row[0].params_json || '{}'); } catch { /* migration CHECK keeps this valid */ }
  return { ...row[0], action_params: actionParams, eligible, eligible_user_ids: eligible.map((member) => Number(member.user_id)) };
}

export function ensureTravelMealPlanTask(database, contextId, actorId = null) {
  const id = positiveId(contextId, 'Planning context', { required: true });
  return atomic(database, () => {
    const context = database.prepare('SELECT * FROM planning_contexts WHERE id = ?').get(id);
    if (!context) throw new Error('Planning context not found.');
    // Conflict reconciliation can touch a home/custom context paired with a
    // trip. Those contexts must never acquire a travel-specific Task.
    if (context.context_type !== 'travel') return null;
    let existing = getTravelMealPlanTask(database, id);
    if (context.status === 'cancelled' || context.status === 'completed') {
      if (existing) {
        const assignment = database.prepare('SELECT state FROM task_assignment_context WHERE task_id = ?').get(existing.id);
        if (assignment && assignment.state !== 'fulfilled') {
          database.prepare(`
            UPDATE task_assignment_context
               SET state = 'cancelled', updated_at = ${nowSql()}
             WHERE task_id = ? AND state != 'fulfilled'
          `).run(existing.id);
          database.prepare(`
            UPDATE planning_obligations
               SET status = 'cancelled', responded_at = COALESCE(responded_at, ${nowSql()}),
                   updated_at = ${nowSql()}
             WHERE task_id = ? AND status IN ('pending', 'accepted')
          `).run(existing.id);
          database.prepare(`
            UPDATE task_responsibilities
               SET status = 'cancelled', updated_at = ${nowSql()}
             WHERE task_id = ? AND status = 'active'
          `).run(existing.id);
        }
      }
      return existing;
    }
    const creatorId = positiveId(actorId || context.created_by, 'Task creator', { required: true });
    const logicalKey = `planning-context:${id}:travel-meal-plan`;
    const obligation = database.prepare('SELECT * FROM planning_obligations WHERE logical_key = ?').get(logicalKey);
    if (!existing && obligation?.task_id) {
      const task = database.prepare('SELECT 1 FROM tasks WHERE id = ?').get(obligation.task_id);
      if (task) {
        database.prepare(`
          INSERT OR IGNORE INTO task_action_links (
            task_id, action_type, label, path, params_json, source_type, source_id
          ) VALUES (?, 'travel_meal_plan', 'Open Meals', '/meals', '{}', 'planning_context', ?)
        `).run(obligation.task_id, id);
        existing = getTravelMealPlanTask(database, id);
      }
    }
    const generatedDueDate = travelTaskDueDate(context);
    if (!existing) {
      const result = database.prepare(`
        INSERT INTO tasks (
          title, description, category, priority, status, due_date, assigned_to, created_by,
          is_recurring, assignment_mode, rotation_index, points, visibility, countdown, locked
        ) VALUES (
          'Create travel meal plan', ?, 'household', 'none', 'open', ?, NULL, ?,
          0, 'fixed', 0, 0, 'all', 0, 0
        )
      `).run(`Plan meals for ${context.name}.`, generatedDueDate, creatorId);
      const taskId = Number(result.lastInsertRowid);
      database.prepare(`
        INSERT INTO task_assignment_context (
          task_id, strategy, state, override_allowed, beneficiary_user_id, source, rotation_key
        ) VALUES (?, 'open_claimable', 'open', 1, NULL, 'planning_context', ?)
      `).run(taskId, `planning-context:${id}:travel-meal-plan`);
      database.prepare(`
        INSERT INTO planning_obligations (
          entity_type, entity_id, task_id, logical_key, role, responsible_user_id,
          responsible_group, due_at, response_deadline, status, attempt, metadata_json
        ) VALUES ('task', ?, ?, ?, 'primary', NULL, ?, ?, ?, 'pending', 1, ?)
      `).run(
        taskId, taskId, logicalKey, `planning-context:${id}:travelers`,
        `${generatedDueDate}T23:59:00`, `${generatedDueDate}T23:59:00`,
        JSON.stringify({ strategy: 'open_claimable', planning_context_id: id }),
      );
      database.prepare(`
        INSERT INTO task_action_links (
          task_id, action_type, label, path, params_json, source_type, source_id
        ) VALUES (?, 'travel_meal_plan', 'Open Meals', '/meals', '{}', 'planning_context', ?)
      `).run(taskId, id);
      existing = getTravelMealPlanTask(database, id);
    } else {
      const oldGeneratedDueDate = previousGeneratedDueDate(existing);
      if (!oldGeneratedDueDate || existing.due_date === oldGeneratedDueDate) {
        database.prepare('UPDATE tasks SET due_date = ? WHERE id = ?').run(generatedDueDate, existing.id);
        database.prepare(`
          UPDATE planning_obligations
             SET due_at = ?, response_deadline = ?, updated_at = ${nowSql()}
           WHERE logical_key = ? AND status = 'pending'
        `).run(`${generatedDueDate}T23:59:00`, `${generatedDueDate}T23:59:00`, logicalKey);
      }
    }
    database.prepare(`
      UPDATE task_assignment_context
         SET override_allowed = 1, updated_at = ${nowSql()}
       WHERE task_id = ? AND source = 'planning_context'
    `).run(existing.id);
    const actionParams = {
      week: context.starts_at.slice(0, 10),
      mode: 'choices',
      context: id,
      planning_context_id: id,
      context_key: context.context_key,
      focus: 'meal-plan',
      generated_due_date: generatedDueDate,
    };
    database.prepare(`
      UPDATE task_action_links
         SET label = 'Open Meals', path = '/meals', params_json = ?,
             source_type = 'planning_context', source_id = ?, updated_at = ${nowSql()}
       WHERE task_id = ?
    `).run(JSON.stringify(actionParams), id, existing.id);
    database.prepare('DELETE FROM task_claim_eligibility WHERE task_id = ?').run(existing.id);
    const insertEligible = database.prepare(`
      INSERT INTO task_claim_eligibility (task_id, user_id, source)
      VALUES (?, ?, 'planning_context')
    `);
    const eligible = database.prepare(`
      SELECT user_id FROM planning_context_members
       WHERE planning_context_id = ? AND membership_status = 'active'
       ORDER BY user_id
    `).all(id);
    for (const member of eligible) insertEligible.run(existing.id, member.user_id);
    return getTravelMealPlanTask(database, id);
  });
}

function sourceProjection(database, contextId) {
  const calendarRows = database.prepare(`
    SELECT e.*, ctd.destination_place_id, ctd.create_away_periods
      FROM calendar_travel_details ctd
      JOIN calendar_events e ON e.id = ctd.calendar_event_id
     WHERE ctd.planning_context_id = ?
  `).all(contextId);
  const tripRows = database.prepare(`
    SELECT * FROM trip_plans
     WHERE planning_context_id = ? AND status != 'cancelled'
  `).all(contextId);
  const memberIds = new Set();
  for (const event of calendarRows) {
    const assigned = database.prepare('SELECT user_id FROM event_assignments WHERE event_id = ?').all(event.id);
    for (const row of assigned) memberIds.add(Number(row.user_id));
  }
  for (const trip of tripRows) {
    const participants = database.prepare('SELECT user_id FROM trip_participants WHERE trip_id = ?').all(trip.id);
    for (const row of participants) memberIds.add(Number(row.user_id));
  }
  const hasManualSource = Boolean(database.prepare(`
    SELECT 1 FROM planning_context_sources
     WHERE planning_context_id = ? AND source_type = 'manual'
  `).get(contextId));
  if (hasManualSource) {
    for (const row of database.prepare(`
      SELECT user_id FROM planning_context_members
       WHERE planning_context_id = ? AND membership_status != 'released'
    `).all(contextId)) memberIds.add(Number(row.user_id));
  }
  const windows = [
    ...calendarRows.map(calendarEventWindow),
    ...tripRows.map((trip) => ({ startsAt: trip.starts_at, endsAt: trip.ends_at })),
  ];
  const placeIds = new Set([
    ...calendarRows.map((row) => row.destination_place_id),
    ...tripRows.map((row) => row.destination_place_id),
  ].filter(Boolean).map(Number));
  return { calendarRows, tripRows, memberIds: [...memberIds], windows, placeIds };
}

function conflictRelatedContextIds(database, contextId) {
  const ids = new Set([Number(contextId)]);
  const rows = database.prepare(`
    SELECT first_context_id, second_context_id
      FROM planning_context_conflicts
     WHERE status = 'open' AND (first_context_id = ? OR second_context_id = ?)
  `).all(contextId, contextId);
  for (const row of rows) {
    ids.add(Number(row.first_context_id));
    ids.add(Number(row.second_context_id));
  }
  return ids;
}

export function reconcileTravelPlanningContext(database, contextId, actorId = null) {
  const id = positiveId(contextId, 'Planning context', { required: true });
  return atomic(database, () => {
    const current = database.prepare('SELECT * FROM planning_contexts WHERE id = ?').get(id);
    if (!current) throw new Error('Planning context not found.');
    const affectedContextIds = conflictRelatedContextIds(database, id);
    const projection = sourceProjection(database, id);
    if (!projection.windows.length) {
      database.prepare(`
        UPDATE planning_contexts
           SET status = 'cancelled', revision = revision + 1, updated_at = ${nowSql()}
         WHERE id = ? AND status != 'cancelled'
      `).run(id);
      replaceMembers(database, id, [], actorId);
      reconcilePlanningContextConflicts(database, actorId);
      reconcilePlanningContextMealOccurrences(database, { contextIds: [id], actorId });
      for (const affectedId of conflictRelatedContextIds(database, id)) affectedContextIds.add(affectedId);
      for (const affectedId of affectedContextIds) {
        reconcilePlanningContextAwayPeriods(database, affectedId, actorId);
        ensureTravelMealPlanTask(database, affectedId, actorId || current.created_by);
      }
      return getPlanningContext(database, id);
    }
    if (projection.placeIds.size > 1) {
      throw new Error('Travel sources in one planning context must share the same destination Place.');
    }
    const startsAt = projection.windows.reduce((value, window) => (
      timeValue(window.startsAt) < timeValue(value) ? window.startsAt : value
    ), projection.windows[0].startsAt);
    const endsAt = projection.windows.reduce((value, window) => (
      timeValue(window.endsAt) > timeValue(value) ? window.endsAt : value
    ), projection.windows[0].endsAt);
    const allTripsComplete = projection.calendarRows.length === 0
      && projection.tripRows.length > 0
      && projection.tripRows.every((trip) => trip.status === 'completed');
    const placeId = [...projection.placeIds][0] || current.place_id || null;
    const coreChanged = current.starts_at !== startsAt
      || current.ends_at !== endsAt
      || Number(current.place_id || 0) !== Number(placeId || 0)
      || current.context_type !== 'travel'
      || (allTripsComplete ? current.status !== 'completed' : ['completed', 'cancelled'].includes(current.status));
    database.prepare(`
      UPDATE planning_contexts
         SET context_type = 'travel', starts_at = ?, ends_at = ?, place_id = ?,
             status = ?, revision = revision + ?, updated_at = ${nowSql()}
       WHERE id = ?
    `).run(
      startsAt, endsAt, placeId, allTripsComplete ? 'completed' : 'active',
      coreChanged ? 1 : 0, id,
    );
    const memberChanged = replaceMembers(database, id, projection.memberIds, actorId);
    if (memberChanged) database.prepare(`UPDATE planning_contexts SET revision = revision + 1, updated_at = ${nowSql()} WHERE id = ?`).run(id);
    reconcilePlanningContextConflicts(database, actorId);
    reconcilePlanningContextMealOccurrences(database, { contextIds: [id], actorId });
    for (const affectedId of conflictRelatedContextIds(database, id)) affectedContextIds.add(affectedId);
    for (const affectedId of affectedContextIds) {
      reconcilePlanningContextAwayPeriods(database, affectedId, actorId);
      ensureTravelMealPlanTask(database, affectedId, actorId || current.created_by);
    }
    return getPlanningContext(database, id);
  });
}

export const PLANNING_CONTEXT_CONFLICT_RESOLUTIONS = [...CONFLICT_RESOLUTIONS];
