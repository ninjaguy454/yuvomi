export class TaskLocationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'TaskLocationError';
  }
}

function text(value, { required = false, max = 250 } = {}) {
  const result = value == null ? '' : String(value).trim();
  if (required && !result) throw new TaskLocationError('Location needs a label.');
  if (result.length > max) throw new TaskLocationError(`Location text is limited to ${max} characters.`);
  return result || null;
}

function coordinate(value, min, max, field) {
  if (value == null || value === '') return null;
  const result = Number(value);
  if (!Number.isFinite(result) || result < min || result > max) {
    throw new TaskLocationError(`${field} is invalid.`);
  }
  return result;
}

export function normalizeTaskLocation(database, value) {
  if (value == null || value === '' || value.kind === 'none') return null;
  if (typeof value !== 'object' || Array.isArray(value)) throw new TaskLocationError('Location is invalid.');

  if (value.kind === 'saved_place') {
    const placeId = Number(value.place_id);
    if (!Number.isInteger(placeId) || placeId < 1) throw new TaskLocationError('Choose a saved Place.');
    const place = database.prepare('SELECT id FROM places WHERE id = ? AND active = 1').get(placeId);
    if (!place) throw new TaskLocationError('Choose an active saved Place.');
    return { kind: 'saved_place', placeId };
  }

  if (value.kind === 'google_place') {
    const provider = value.external_provider || 'google';
    if (provider !== 'google') throw new TaskLocationError('Location provider is invalid.');
    const externalPlaceId = text(value.external_place_id, { required: true, max: 250 });
    const userLabel = text(value.user_label, { required: true, max: 120 });
    return { kind: 'google_place', provider, externalPlaceId, userLabel };
  }

  if (value.kind === 'manual') {
    const userLabel = text(value.user_label, { required: true, max: 120 });
    const manualAddress = text(value.manual_address, { max: 500 });
    const latitude = coordinate(value.latitude, -90, 90, 'Latitude');
    const longitude = coordinate(value.longitude, -180, 180, 'Longitude');
    if ((latitude == null) !== (longitude == null)) {
      throw new TaskLocationError('Manual coordinates need both latitude and longitude.');
    }
    if (!manualAddress && latitude == null) {
      throw new TaskLocationError('Manual locations need an address or coordinates.');
    }
    return { kind: 'manual', userLabel, manualAddress, latitude, longitude };
  }

  throw new TaskLocationError('Location type is invalid.');
}

export function setTaskLocation(database, taskId, location, createdBy) {
  if (!location) {
    database.prepare('DELETE FROM task_locations WHERE task_id = ?').run(taskId);
    return;
  }
  database.prepare(`
    INSERT INTO task_locations (
      task_id, kind, place_id, external_provider, external_place_id, user_label,
      manual_address, latitude, longitude, created_by
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(task_id) DO UPDATE SET
      kind = excluded.kind,
      place_id = excluded.place_id,
      external_provider = excluded.external_provider,
      external_place_id = excluded.external_place_id,
      user_label = excluded.user_label,
      manual_address = excluded.manual_address,
      latitude = excluded.latitude,
      longitude = excluded.longitude,
      updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
  `).run(
    taskId,
    location.kind,
    location.placeId ?? null,
    location.provider ?? null,
    location.externalPlaceId ?? null,
    location.userLabel ?? null,
    location.manualAddress ?? null,
    location.latitude ?? null,
    location.longitude ?? null,
    createdBy ?? null,
  );
}

export function storedTaskLocation(database, taskId) {
  const row = database.prepare('SELECT * FROM task_locations WHERE task_id = ?').get(taskId);
  if (!row) return null;
  if (row.kind === 'saved_place') return { kind: row.kind, placeId: Number(row.place_id) };
  if (row.kind === 'google_place') {
    return {
      kind: row.kind,
      provider: row.external_provider,
      externalPlaceId: row.external_place_id,
      userLabel: row.user_label,
    };
  }
  return {
    kind: row.kind,
    userLabel: row.user_label,
    manualAddress: row.manual_address,
    latitude: row.latitude,
    longitude: row.longitude,
  };
}

export function copyTaskLocation(database, sourceTaskId, targetTaskId, createdBy) {
  const source = database.prepare('SELECT * FROM task_locations WHERE task_id = ?').get(sourceTaskId);
  if (!source) return;
  database.prepare(`
    INSERT INTO task_locations (
      task_id, kind, place_id, external_provider, external_place_id, user_label,
      manual_address, latitude, longitude, created_by
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    targetTaskId, source.kind, source.place_id, source.external_provider,
    source.external_place_id, source.user_label, source.manual_address,
    source.latitude, source.longitude, createdBy ?? source.created_by,
  );
}

function googleMapsUrl({ externalPlaceId, label, address, latitude, longitude }) {
  const params = new URLSearchParams({ api: '1' });
  if (externalPlaceId) {
    params.set('query', label || 'Google Maps place');
    params.set('query_place_id', externalPlaceId);
  } else if (latitude != null && longitude != null) {
    params.set('query', `${latitude},${longitude}`);
  } else if (address || label) {
    params.set('query', address || label);
  } else {
    return null;
  }
  return `https://www.google.com/maps/search/?${params.toString()}`;
}

function resultLocation(row) {
  if (!row) return null;
  const saved = row.kind === 'saved_place';
  const label = saved ? row.place_name : row.user_label;
  const address = saved
    ? [row.street_address, row.city, row.region, row.postal_code, row.country].filter(Boolean).join(', ')
    : row.manual_address;
  const latitude = saved ? row.place_latitude : row.latitude;
  const longitude = saved ? row.place_longitude : row.longitude;
  const externalPlaceId = saved ? row.place_external_id : row.external_place_id;
  return {
    kind: row.kind,
    place_id: row.place_id ?? null,
    external_provider: saved ? row.place_external_provider : row.external_provider,
    external_place_id: externalPlaceId ?? null,
    label,
    address: address || null,
    latitude: latitude ?? null,
    longitude: longitude ?? null,
    navigation_url: googleMapsUrl({ externalPlaceId, label, address, latitude, longitude }),
  };
}

export function attachTaskLocations(database, tasks) {
  if (!tasks?.length) return tasks;
  const ids = tasks.map((task) => Number(task.id)).filter(Number.isInteger);
  if (!ids.length) return tasks;
  const rows = database.prepare(`
    SELECT tl.*,
           p.name AS place_name, p.street_address, p.city, p.region, p.postal_code, p.country,
           p.latitude AS place_latitude, p.longitude AS place_longitude,
           p.external_provider AS place_external_provider, p.external_place_id AS place_external_id
      FROM task_locations tl
      LEFT JOIN places p ON p.id = tl.place_id
     WHERE tl.task_id IN (${ids.map(() => '?').join(', ')})
  `).all(...ids);
  const byTask = new Map(rows.map((row) => [Number(row.task_id), resultLocation(row)]));
  for (const task of tasks) task.location = byTask.get(Number(task.id)) ?? null;
  return tasks;
}

export function promoteTaskGoogleLocation(database, taskId, value, actorId) {
  const row = database.prepare(`SELECT * FROM task_locations WHERE task_id = ? AND kind = 'google_place'`).get(taskId);
  if (!row) throw new TaskLocationError('This Task does not have a one-use Google location to save.');
  const name = text(value?.name || row.user_label, { required: true, max: 120 });
  const existing = database.prepare(`SELECT * FROM places WHERE external_provider = 'google' AND external_place_id = ?`).get(row.external_place_id);
  let placeId = existing?.id ? Number(existing.id) : null;
  database.transaction(() => {
    if (!placeId) {
      const latitude = coordinate(value?.latitude, -90, 90, 'Latitude');
      const longitude = coordinate(value?.longitude, -180, 180, 'Longitude');
      if ((latitude == null) !== (longitude == null)) throw new TaskLocationError('Saved coordinates need both latitude and longitude.');
      const expiry = latitude == null ? null : new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
      const result = database.prepare(`
        INSERT INTO places (
          name, description, type, street_address, city, region, postal_code, country,
          latitude, longitude, active, created_by, external_provider, external_place_id,
          external_place_id_checked_at, coordinate_source, coordinates_expires_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, 'google', ?, strftime('%Y-%m-%dT%H:%M:%SZ', 'now'), ?, ?)
      `).run(name, text(value?.description, { max: 1000 }), text(value?.type, { max: 40 }) || 'custom',
        text(value?.street_address, { max: 250 }), text(value?.city, { max: 120 }),
        text(value?.region, { max: 120 }), text(value?.postal_code, { max: 40 }), text(value?.country, { max: 120 }),
        latitude, longitude, actorId, row.external_place_id, latitude == null ? null : 'google', expiry);
      placeId = Number(result.lastInsertRowid);
    }
    database.prepare(`
      UPDATE task_locations SET kind = 'saved_place', place_id = ?, external_provider = NULL,
        external_place_id = NULL, user_label = NULL, manual_address = NULL, latitude = NULL,
        longitude = NULL, updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now') WHERE task_id = ?
    `).run(placeId, taskId);
  })();
  const task = { id: Number(taskId) };
  attachTaskLocations(database, [task]);
  return { place_id: placeId, location: task.location, reused: Boolean(existing) };
}
