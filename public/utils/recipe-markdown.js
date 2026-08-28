import { normalizeRecipeMealTypes } from './recipe-meal-types.js';

const DEFAULT_MEAL_TYPE_LABELS = {
  breakfast: 'Breakfast',
  lunch: 'Lunch',
  dinner: 'Dinner',
  snack: 'Snack',
};

function inlineText(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function sourceText(recipe) {
  const parts = [];
  const url = inlineText(recipe?.recipe_url).replace(/>/g, '\\>');
  if (url) parts.push(`<${url}>`);

  const provider = inlineText(recipe?.source);
  if (provider && provider !== 'native') {
    const providerLabel = `${provider[0].toLocaleUpperCase()}${provider.slice(1)}`;
    const account = inlineText(recipe?.provider_account_name);
    parts.push(account ? `${providerLabel} (${account})` : providerLabel);
  }
  return parts.join(' — ');
}

/**
 * Converts the shareable recipe content into Markdown that can be read as-is
 * or pasted back into Yuvomi's Markdown recipe importer for review.
 */
export function recipeToMarkdown(recipe, { mealTypeLabels = DEFAULT_MEAL_TYPE_LABELS } = {}) {
  const title = inlineText(recipe?.title) || 'Untitled recipe';
  const mealTypes = normalizeRecipeMealTypes(recipe?.meal_types)
    .map((key) => inlineText(mealTypeLabels[key]) || key);
  const ingredients = Array.isArray(recipe?.ingredients) ? recipe.ingredients : [];
  const notes = String(recipe?.notes ?? '').trim();
  const source = sourceText(recipe);

  const sections = [
    `# ${title}`,
    `**Meal types:** ${mealTypes.length ? mealTypes.join(', ') : 'None'}`,
  ];
  if (source) sections.push(`**Source:** ${source}`);

  const ingredientLines = ingredients.map((ingredient) => {
    const quantity = inlineText(ingredient?.quantity);
    const name = inlineText(ingredient?.name);
    return name ? `- ${quantity ? `${quantity} ` : ''}${name}` : '';
  }).filter(Boolean);
  sections.push(`## Ingredients${ingredientLines.length ? `\n\n${ingredientLines.join('\n')}` : ''}`);

  if (notes) {
    sections.push(/^#{1,6}\s+/.test(notes) ? notes : `## Notes\n\n${notes}`);
  }

  return `${sections.join('\n\n')}\n`;
}
