import { parseQuantity } from '../../public/utils/ingredient-quantity.js';

function formatQuantity(amount, unit, { precision = 2, roundUp = false } = {}) {
  const scale = 10 ** precision;
  const scaled = amount * scale;
  const rounded = (roundUp ? Math.ceil(scaled - Number.EPSILON * Math.max(1, Math.abs(scaled))) : Math.round(scaled)) / scale;
  const number = Number.isInteger(rounded) ? String(rounded) : String(rounded).replace(/\.0+$/, '').replace(/(\.\d*?)0+$/, '$1');
  return unit ? `${number} ${unit}` : number;
}

function aggregateMealIngredients(ingredients = [], quantityFormat = {}) {
  const groups = new Map();

  for (const ingredient of ingredients) {
    const name = String(ingredient?.name || '').trim();
    if (!name) continue;
    const category = String(ingredient?.category || 'Sonstiges').trim() || 'Sonstiges';
    const parsed = parseQuantity(ingredient?.quantity);
    const quantity = String(ingredient?.quantity || '').trim();
    const key = parsed
      ? `${name.toLowerCase()}\u0000${category}\u0000parsed\u0000${parsed.unit}`
      : `${name.toLowerCase()}\u0000${category}\u0000raw\u0000${quantity.toLowerCase()}`;

    if (!groups.has(key)) {
      groups.set(key, {
        name,
        category,
        quantity: quantity || null,
        amount: 0,
        unit: parsed?.unit ?? '',
        mealIds: new Set(),
        ingredientIds: [],
        count: 0,
      });
    }

    const group = groups.get(key);
    group.count += 1;
    if (parsed) {
      group.amount = (group.amount ?? 0) + parsed.amount;
      group.quantity = formatQuantity(group.amount, group.unit, quantityFormat);
    } else if (!quantity) {
      group.quantity = null;
    } else if (group.count > 1) {
      group.quantity = `${group.count} x ${quantity}`;
    }

    if (ingredient.meal_id != null) group.mealIds.add(ingredient.meal_id);
    if (ingredient.id != null) group.ingredientIds.push(ingredient.id);
  }

  return [...groups.values()].map((group) => ({
    name: group.name,
    category: group.category,
    quantity: group.quantity,
    added_from_meal: group.mealIds.size === 1 ? [...group.mealIds][0] : null,
    ingredientIds: group.ingredientIds,
  }));
}

export { aggregateMealIngredients, parseQuantity };
