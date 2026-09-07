export const PORTION_STEP = 0.25;
export const MIN_PORTION_AMOUNT = 0.01;
export const MAX_PORTION_AMOUNT = 1000;

export const SERVING_BASIS_UNITS = Object.freeze([
  'count', 'oz', 'lb', 'g', 'kg', 'fl_oz', 'cup', 'tbsp', 'tsp', 'ml', 'l',
]);

const UNIT_LABELS = Object.freeze({ fl_oz: 'fl oz', ml: 'mL', l: 'L' });

export function roundPortions(value) {
  return Math.round((Number(value) + Number.EPSILON) * 100) / 100;
}

export function validPortionAmount(value) {
  const text = String(value ?? '').trim();
  if (!/^\d+(?:\.\d{1,2})?$/.test(text)) return false;
  const amount = Number(text);
  return Number.isFinite(amount) && amount >= MIN_PORTION_AMOUNT && amount <= MAX_PORTION_AMOUNT;
}

export function normalizePortionAmount(value, fallback = 1) {
  return validPortionAmount(value) ? roundPortions(value) : roundPortions(fallback);
}

export function stepPortionAmount(value, direction) {
  const current = validPortionAmount(value) ? Number(value) : 1;
  const next = roundPortions(current + (direction < 0 ? -PORTION_STEP : PORTION_STEP));
  return Math.min(MAX_PORTION_AMOUNT, Math.max(MIN_PORTION_AMOUNT, next));
}

export function cookPortionTarget(plannedPortions, { minimum = 1 } = {}) {
  const total = Math.max(0, roundPortions(plannedPortions));
  return Math.max(minimum, Math.ceil(total));
}

/** Preview one person's pending edit without changing the saved household total. */
export function projectRequestedPortions({ planned = 0, previous = 1, wasParticipating = false,
  participating = true, amount = 1 } = {}) {
  return Math.max(0, roundPortions(Number(planned)
    - (wasParticipating ? Number(previous) : 0) + (participating ? Number(amount) : 0)));
}

export function recipeServingBasis(recipe = {}) {
  const amount = Number(recipe.serving_basis_amount);
  const unit = String(recipe.serving_basis_unit || '').trim();
  const label = String(recipe.serving_basis_label || '').trim();
  if (!Number.isFinite(amount) || amount <= 0 || !SERVING_BASIS_UNITS.includes(unit)) return null;
  if (unit === 'count' && !label) return null;
  return { amount: roundPortions(amount), unit, label: unit === 'count' ? label : '' };
}

export function servingAmountForPortions(recipe, portions) {
  const basis = recipeServingBasis(recipe);
  if (!basis || !validPortionAmount(portions)) return null;
  // Both inputs allow two decimals; retain their four-decimal product. Rounding
  // the physical amount to two decimals can turn a valid small serving into zero.
  return { ...basis, amount: Math.round(basis.amount * Number(portions) * 10000) / 10000 };
}

function pluralizeCount(label, amount) {
  if (amount === 1 || /s$/i.test(label)) return label;
  return `${label}s`;
}

export function formatServingAmount(value) {
  if (!value) return '';
  const amount = String(value.amount);
  if (value.unit === 'count') return `${amount} ${pluralizeCount(value.label, value.amount)}`;
  return `${amount} ${UNIT_LABELS[value.unit] || value.unit}`;
}

export function formatPortions(value) {
  const amount = roundPortions(value);
  return `${amount} portion${amount === 1 ? '' : 's'}`;
}
