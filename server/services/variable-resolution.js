/** Typed values stay separate from display labels and persisted entity IDs. */
import {
  normalizeExpression, validateExpression, validateVariableDefinitions,
  resolveExpressionVariables, expressionDependencies, renameExpressionReference,
} from '../../public/utils/variable-expressions.js';
import { householdMembers } from './activity-eligibility.js';
import { placeWithInheritedAddress } from './presence.js';
import { householdTimeZone, todayKey, utcToWall } from '../utils/timezone.js';
import { getRotationGroup, getRotationOccurrence } from './rotation.js';

export const SYSTEM_CONTEXT_VARIABLES = Object.freeze([
  { id: 'context.current_date', key: 'context.current_date', label: 'Current date', type: 'date' },
  { id: 'context.day_of_week', key: 'context.day_of_week', label: 'Day of week', type: 'text' },
  { id: 'context.current_time', key: 'context.current_time', label: 'Current time', type: 'time' },
  { id: 'context.household_member', key: 'context.household_member', label: 'Selected household member', type: 'household_member' },
]);
const TOKEN = /\{\{([A-Za-z][A-Za-z0-9_-]*(?:\.[A-Za-z][A-Za-z0-9_-]*){0,2})\}\}/g;
const MEMBER_FIELDS = ['id', 'display_name', 'first_name', 'last_name', 'nickname'];
const PLACE_FIELDS = ['id', 'name', 'parent', 'address'];
export const variableKey = definition => String(definition.variable_key ?? definition.key ?? definition.id);
const definition = row => ({ ...row, ...(typeof row.id === 'number' ? { reusable_definition_id: row.id } : {}), id: variableKey(row) });
const parse = (raw, fallback) => raw == null || raw === '' ? fallback : JSON.parse(raw);

export function householdVariableRows(d) {
  return d.prepare(`SELECT hv.*,
    (SELECT COUNT(*) FROM workflow_variable_definitions wv WHERE wv.reusable_definition_id = hv.id) AS usage_count
    FROM household_variable_definitions hv ORDER BY hv.active DESC, hv.label COLLATE NOCASE, hv.id`).all().map(row => ({
    ...row, options: parse(row.options_json, []), default_value: parse(row.default_value_json, null),
    expression: normalizeExpression(parse(row.expression_json, null)),
    options_json: undefined, default_value_json: undefined, expression_json: undefined,
  }));
}

export function expressionScope(variables, catalog = []) {
  const byKey = new Map(catalog.map(row => [variableKey(row), definition(row)]));
  for (const row of variables) byKey.set(variableKey(row), definition(row));
  for (const row of SYSTEM_CONTEXT_VARIABLES) byKey.set(row.id, row);
  return [...byKey.values()];
}

/** Include only required reusable dependencies, retaining local stable identities. */
export function expandVariableDefinitions(variables, catalog = []) {
  const scope = expressionScope(variables, catalog);
  const byKey = new Map(scope.map(row => [row.id, row]));
  const included = new Map(variables.map(row => [variableKey(row), definition(row)]));
  const visit = row => {
    if (!row.expression) return;
    for (const key of expressionDependencies(row.expression.source, scope)) {
      if (included.has(key) || key.startsWith('context.')) continue;
      const dependency = byKey.get(key);
      included.set(key, { ...dependency, dependency_only: true });
      visit(dependency);
    }
  };
  for (const row of [...included.values()]) visit(row);
  return [...included.values()];
}

export function hydrateWorkflowDefinitions(d, workflowId, schema, catalog = householdVariableRows(d), contextDefinitions = []) {
  const stored = d.prepare('SELECT id, variable_key, scope, reusable_definition_id FROM workflow_variable_definitions WHERE workflow_template_id = ? ORDER BY id').all(workflowId);
  const byKey = new Map(stored.map(row => [row.variable_key, row]));
  const byId = new Map(catalog.map(row => [Number(row.id), row]));
  const variables = schema.map(question => {
    const key = variableKey(question);
    const identity = byKey.get(key);
    const reusableId = identity?.reusable_definition_id ?? question.reusable_definition_id;
    const reusable = reusableId ? byId.get(Number(reusableId)) : null;
    if (reusableId && !reusable) throw new Error(`Reusable variable ${key} is unavailable.`);
    return {
      ...question, id: key,
      ...(identity ? { definition_id: identity.id, scope: identity.scope, reusable_definition_id: reusableId } : {}),
      ...(reusable ? { type: reusable.type, options: reusable.options, kind: reusable.kind,
        default_value: reusable.default_value, expression: reusable.expression, active: reusable.active } :
        { expression: normalizeExpression(question.expression) }),
    };
  });
  return expandVariableDefinitions(variables, [...catalog, ...contextDefinitions]);
}

export function templateReferences(...values) {
  return [...new Set(values.flat().filter(value => value != null).flatMap(value => [...String(value).matchAll(TOKEN)].map(match => match[1])))];
}

export function validateVariableTemplate(value, definitions, field = 'Template') {
  for (const key of templateReferences(value)) {
    try { validateExpression(key, definitions); }
    catch (error) { throw new Error(`${field}: ${error.code === 'unknown_variable' ? 'Unknown variable. ' : ''}${error.message}`); }
  }
}

function safeMember(d, value, key) {
  const id = ['string', 'number'].includes(typeof value) ? Number(value) : NaN;
  const row = Number.isSafeInteger(id) && id > 0 ? householdMembers(d).find(member => Number(member.id) === id) : null;
  if (!row) throw new Error(`Variable ${key} must select a valid household member.`);
  return Object.fromEntries(MEMBER_FIELDS.map(field => [field, field === 'id' ? Number(row.id) : row[field] ?? null]));
}

function safePlace(d, value, key) {
  const id = ['string', 'number'].includes(typeof value) ? Number(value) : NaN;
  const raw = Number.isSafeInteger(id) && id > 0 ? d.prepare('SELECT * FROM places WHERE id = ? AND active = 1').get(id) : null;
  if (!raw) throw new Error(`Variable ${key} must select an active Place.`);
  const row = placeWithInheritedAddress(d, raw);
  return { id: Number(row.id), name: row.name, parent: row.path?.length > 1 ? row.path.at(-2)?.name ?? null : null,
    address: [row.street_address, row.city, row.region, row.postal_code, row.country].filter(Boolean).join(', ') || null };
}

export function normalizeVariableValue(d, variable, value) {
  const key = variableKey(variable);
  if (['rotation_group', 'rotation_occurrence'].includes(variable.type)) {
    const id = ['string', 'number'].includes(typeof value) ? Number(value) : NaN;
    const row = Number.isSafeInteger(id) && id > 0 ? (variable.type === 'rotation_group' ? getRotationGroup(d, id) : getRotationOccurrence(d, id)) : null;
    if (!row || (variable.type === 'rotation_group' && !row.active)) throw new Error(`Variable ${key} must select a valid ${variable.type === 'rotation_group' ? 'Rotation Group' : 'Rotation Occurrence'}.`);
    // Snapshot objects are never accepted from editable input. Historic members
    // intentionally retain their recorded identity/name if their profile changes.
    if (variable.type === 'rotation_group') return { id: Number(row.id), name: row.name, description: row.description ?? null };
    return rotationOccurrenceVariable(row);
  }
  if (variable.type === 'household_member_list') {
    if (!Array.isArray(value) || value.length > 100) throw new Error(`Variable ${key} must select at most 100 household members.`);
    const members = value.map(id => safeMember(d, id, key));
    if (new Set(members.map(member => member.id)).size !== members.length) throw new Error(`Variable ${key} cannot repeat a household member.`);
    return members;
  }
  if (variable.type === 'household_member') return safeMember(d, value, key);
  if (variable.type === 'location') return safePlace(d, value, key);
  if (variable.type === 'boolean') {
    if (value === true || value === false) return value;
    if (value === 'true' || value === 'false') return value === 'true';
    throw new Error(`Variable ${key} must be Yes or No.`);
  }
  if (variable.type === 'number') {
    if (!['number', 'string'].includes(typeof value) || String(value).trim() === '' || !Number.isFinite(Number(value))) throw new Error(`Variable ${key} must be a number.`);
    return Number(value);
  }
  if (typeof value !== 'string') throw new Error(`Variable ${key} must be text.`);
  if (value.length > 2000) throw new Error(`Variable ${key} is too long.`);
  if (variable.type === 'choice' || variable.type === 'select') {
    if (!(variable.options ?? []).map(String).includes(value)) throw new Error(`Variable ${key} must use one of its configured choices.`);
  } else if (variable.type === 'date') {
    const [year, month, day] = value.split('-').map(Number);
    const date = new Date(Date.UTC(year, month - 1, day));
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) throw new Error(`Variable ${key} must be a date.`);
  } else if (variable.type === 'time' && !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value)) throw new Error(`Variable ${key} must be a time.`);
  return value;
}

/** Trusted runtime bridge; expressions read this snapshot and cannot advance it. */
export function rotationOccurrenceVariable(row, subjectUserId = null) {
  if (row?.id == null) throw new Error('This Rotation occurrence has not been resolved yet.');
  const member = value => value ? Object.fromEntries(MEMBER_FIELDS.map(field => [field, field === 'id' ? Number(value.id) : value[field] ?? null])) : null;
  const position = (row.order || []).findIndex(value => Number(value.id) === Number(subjectUserId));
  return { id: Number(row.id), track_id: Number(row.track_id), order: (row.order || []).map(member), position: position < 0 ? null : position + 1,
    selected_member: member(row.selected_member), status: row.status, strategy: row.strategy };
}

export function persistedVariableValue(value) {
  return Array.isArray(value) ? value.map(member => member.id) : value && typeof value === 'object' ? value.id : value;
}

export function variableInputSchema(definitions, keys = definitions.map(variableKey)) {
  const byKey = new Map(definitions.map(row => [variableKey(row), row]));
  const wanted = new Set();
  const visit = key => {
    if (wanted.has(key)) return;
    wanted.add(key);
    const row = byKey.get(key);
    if (row?.expression) for (const dependency of expressionDependencies(row.expression.source, definitions)) visit(dependency);
  };
  keys.forEach(visit);
  return definitions.filter(row => wanted.has(variableKey(row)) && !variableKey(row).startsWith('context.') && !row.expression && row.kind !== 'value');
}

export function resolveVariables(d, variables, inputs = {}, { keys, subjectUserId = null, contextValues = {}, rotationOccurrences = {}, now = new Date() } = {}) {
  if (!inputs || typeof inputs !== 'object' || Array.isArray(inputs)) throw new Error('Variable inputs must be an object.');
  const definitions = expressionScope(variables);
  validateVariableDefinitions(definitions);
  const byKey = new Map(definitions.map(row => [row.id, row]));
  const wanted = keys ?? variables.filter(row => row.expression || Object.hasOwn(inputs, variableKey(row)) || row.default_value != null).map(variableKey);
  const needed = new Set();
  const visit = key => {
    if (needed.has(key)) return;
    needed.add(key);
    const row = byKey.get(key);
    if (row?.active === 0) throw new Error(`Variable ${key} is inactive.`);
    if (row?.expression) expressionDependencies(row.expression.source, definitions).forEach(visit);
  };
  wanted.forEach(visit);
  const values = {};
  for (const [key, value] of Object.entries(inputs)) {
    const row = byKey.get(key);
    if (!row || key.startsWith('context.')) throw new Error(`Unknown variable input: ${key}.`);
    if (row.expression) continue; // Computed values are never accepted from the client.
    if (row.kind === 'value') continue;
    values[key] = normalizeVariableValue(d, row, value);
  }
  // Only a trusted domain resolver supplies these contextual values. Explicit
  // definitions and editable inputs retain their own meaning.
  for (const [key,value] of Object.entries(contextValues)) {
    const row=byKey.get(key);
    if(row && row.kind==='value' && !row.expression && row.default_value==null && !Object.hasOwn(values,key))
      values[key]=normalizeVariableValue(d,row,value);
  }
  for (const [key, occurrence] of Object.entries(rotationOccurrences)) {
    const row = byKey.get(key);
    if (row?.type === 'rotation_occurrence' && row.kind === 'value' && !row.expression && row.default_value == null) values[key] = rotationOccurrenceVariable(occurrence, subjectUserId);
  }
  for (const row of definitions) {
    if (!needed.has(row.id) || row.expression || Object.hasOwn(values, row.id) || row.default_value == null) continue;
    values[row.id] = normalizeVariableValue(d, row, row.default_value);
  }
  const zone = householdTimeZone(d);
  values['context.current_date'] = todayKey(d, now);
  values['context.current_time'] = utcToWall(now.toISOString(), zone).time.slice(0, 5);
  values['context.day_of_week'] = new Intl.DateTimeFormat('en-US', { timeZone: zone, weekday: 'long' }).format(now);
  if (subjectUserId != null) values['context.household_member'] = safeMember(d, subjectUserId, 'context.household_member');
  const result = resolveExpressionVariables(definitions, values, { keys: wanted });
  const labels = variableLabels(result.values, result.types);
  const ids = Object.fromEntries(Object.entries(result.values).map(([key, value]) => [key, persistedVariableValue(value)]));
  const persisted = Object.fromEntries(Object.entries(ids).filter(([key]) => !key.startsWith('context.')));
  const summary = Object.entries(persisted).map(([key, value]) => ({ key, label: byKey.get(key)?.label ?? key,
    type: result.types[key], value, display_value: labels[key] }));
  return { ...result, labels, ids, persisted, summary };
}

export function definitionsForTemplates(d, templates, catalog = householdVariableRows(d)) {
  const scope = expressionScope([], catalog);
  const keys = [...new Set(templateReferences(templates).flatMap(reference => expressionDependencies(reference, scope)))];
  const selected = scope.filter(row => keys.includes(row.id) && !row.id.startsWith('context.'));
  return { definitions: expandVariableDefinitions(selected, catalog), keys };
}

/** Consumer-owned text templates may be rendered from an already resolved
 * occurrence. This never resolves/advances rotation and returns definitions
 * suitable for copying into the consumer's existing durable snapshot. */
export function renderRotationVariableTemplates(d, { templates = [], bindings = [], rotations = [], inputs = {}, subjectUserId = null, definitions = null } = {}) {
  const contextDefinitions = bindings.map(binding => ({ id: binding.purpose_key, label: binding.label || binding.purpose_key,
    type: 'rotation_occurrence', kind: 'value', default_value: null, rotation_context: true }));
  const purposeKeys = new Set(contextDefinitions.map(row => row.id));
  const catalog = [...(definitions ?? householdVariableRows(d)).filter(row => !purposeKeys.has(variableKey(row))), ...contextDefinitions];
  const wanted = definitionsForTemplates(d, templates, catalog);
  const known = new Set(wanted.definitions.map(variableKey));
  const supplied = Object.fromEntries(Object.entries(inputs).filter(([key]) => known.has(key)));
  const rotationOccurrences = Object.fromEntries(rotations.filter(row => row.occurrence?.id != null).map(row => [row.purpose_key, row.occurrence]));
  const resolved = resolveVariables(d, wanted.definitions, supplied, { keys: wanted.keys, subjectUserId, rotationOccurrences });
  return { values: templates.map(value => substituteVariableTemplate(value, resolved.labels)),
    usesRotation: wanted.definitions.some(row => purposeKeys.has(variableKey(row))),
    definitions: wanted.definitions.filter(row => !row.rotation_context), inputs: resolved.persisted, labels: resolved.labels };
}

export function variableLabels(values, types) {
  const labels = {};
  for (const [key, value] of Object.entries(values)) {
    const type = types[key];
    if (type === 'household_member' || type === 'location') {
      labels[key] = value?.[type === 'household_member' ? 'display_name' : 'name'] ?? '';
      for (const field of type === 'household_member' ? MEMBER_FIELDS : PLACE_FIELDS) labels[`${key}.${field}`] = value?.[field] == null ? '' : String(value[field]);
    } else if (type === 'household_member_list') labels[key] = (value || []).map(member => member.display_name || '').join(' → ');
    else if (type === 'rotation_group') {
      labels[key] = value?.name || '';
      for (const field of ['id', 'name', 'description']) labels[`${key}.${field}`] = String(value?.[field] ?? '');
    } else if (type === 'rotation_occurrence') {
      labels[key] = (value?.order || []).map(member => member.display_name || '').join(' → ');
      labels[`${key}.order`] = labels[key];
      labels[`${key}.selected_member`] = value?.selected_member?.display_name || '';
      for (const field of ['id', 'track_id', 'position', 'status', 'strategy']) labels[`${key}.${field}`] = String(value?.[field] ?? '');
    } else labels[key] = type === 'boolean' ? value ? 'Yes' : 'No' : String(value ?? '');
  }
  return labels;
}

export function substituteVariableTemplate(value, labels, { preserveMissing = false } = {}) {
  if (value == null) return null;
  return String(value).replace(TOKEN, (token, key) => Object.hasOwn(labels, key) ? String(labels[key] ?? '') : preserveMissing ? token : '');
}

export function renameVariableTemplate(value, oldKey, newKey) {
  if (value == null) return value;
  return String(value).replace(TOKEN, (token, key) => key === oldKey || key.startsWith(`${oldKey}.`) ? `{{${newKey}${key.slice(oldKey.length)}}}` : token);
}

export { normalizeExpression, validateExpression, validateVariableDefinitions, expressionDependencies, renameExpressionReference };
