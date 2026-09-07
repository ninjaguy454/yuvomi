import { createHash } from 'node:crypto';
import { validatePipeline, pipelineSource } from '../../public/utils/recipe-pipeline.js';
import { moduleAccessVerdict, MODULE_ACCESS_ALLOW } from '../permissions.js';
import { tokenAllows } from '../scopes.js';

export function recipePipelineSourceHash(recipe) {
  return createHash('sha256').update(pipelineSource(recipe)).digest('hex');
}

// Saving acknowledges the current written recipe. Each starting ingredient
// must therefore bind to one actual ingredient occurrence, without creating a
// second quantity under a new resource ID. A stale copy remains readable and
// duplicable; this check runs only when its author explicitly saves a review.
export function validateRecipePipelineBindings(pipeline, recipe) {
  const source = JSON.parse(pipelineSource(recipe)).ingredients;
  const ingredients = pipeline.resources.filter(resource => resource.kind === 'ingredient');
  const snapshots = JSON.parse(pipelineSource({ ingredients })).ingredients;
  const selected = new Set();
  ingredients.forEach((resource, index) => {
    const position = resource.source_index;
    if (!Number.isSafeInteger(position) || position < 0 || position >= source.length) {
      throw new Error(`Select a current recipe ingredient for “${resource.name}” before saving.`);
    }
    if (selected.has(position)) {
      throw new Error('Each recipe ingredient can be selected only once. Use Divide to create separate portions.');
    }
    selected.add(position);
    if (snapshots[index].name !== source[position].name || snapshots[index].quantity !== source[position].quantity) {
      throw new Error(`The recipe ingredient for “${resource.name}” changed. Select its current ingredient to review the name and quantity before saving.`);
    }
  });
}

export function canWriteRecipePipeline(req) {
  if (!(req.authUserId || req.session?.userId)) return false;
  if (moduleAccessVerdict(req.sessionModuleAccess, 'meals', 'write') !== MODULE_ACCESS_ALLOW) return false;
  return req.authMethod !== 'api_token' || tokenAllows(req.authScopes, 'meals', 'write');
}

// Ingredient SQL rows are replaced by ordinary recipe edits/provider sync.
// A pipeline instead owns stable, local resource IDs and ingredient snapshots.
// Its source hash identifies written content changes without invalidating it
// merely because a recipe was renamed or its SQL ingredient IDs changed.
export function withRecipePipeline(recipe, req) {
  const { execution_json, execution_revision, execution_source_hash, ...publicRecipe } = recipe;
  let pipeline = null;
  let invalid = false;
  if (execution_json !== null && execution_json !== undefined) {
    try { pipeline = validatePipeline(JSON.parse(execution_json)); }
    catch { invalid = true; }
  }
  const currentHash = recipePipelineSourceHash(recipe);
  return {
    ...publicRecipe,
    pipeline,
    pipeline_revision: Number(execution_revision || 0),
    pipeline_source_hash: execution_source_hash || null,
    pipeline_current_source_hash: currentHash,
    pipeline_review_needed: Boolean((pipeline || invalid) && execution_source_hash !== currentHash),
    pipeline_invalid: invalid,
    pipeline_can_edit: !recipe.provider_account_id
      && Number(recipe.created_by) === Number(req.authUserId || req.session?.userId)
      && canWriteRecipePipeline(req),
  };
}
