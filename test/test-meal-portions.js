import assert from 'node:assert/strict';
import test from 'node:test';
import {
  cookPortionTarget,
  projectRequestedPortions,
  formatServingAmount,
  recipeServingBasis,
  servingAmountForPortions,
  stepPortionAmount,
  validPortionAmount,
} from '../public/utils/meal-portions.js';

test('quarter-step controls stay bounded and direct entry allows two decimal places', () => {
  assert.equal(stepPortionAmount(1, 1), 1.25);
  assert.equal(stepPortionAmount(1, -1), 0.75);
  assert.equal(stepPortionAmount(0.01, -1), 0.01);
  assert.equal(stepPortionAmount(0.25, -1), 0.01);
  assert.equal(stepPortionAmount(0.01, 1), 0.26);
  assert.equal(stepPortionAmount(999.99, 1), 1000);
  assert.equal(stepPortionAmount(1000, 1), 1000);
  assert.equal(stepPortionAmount(1.33, 1), 1.58);
  assert.equal(validPortionAmount('1.50'), true);
  assert.equal(validPortionAmount('1.125'), false);
  assert.equal(validPortionAmount('0'), false);
  assert.equal(validPortionAmount('-1'), false);
  assert.equal(validPortionAmount('1000.01'), false);
});

test('exact participant totals round up once for the cook target', () => {
  const exact = 1 + 0.75 + 1.25 + 0.5;
  assert.equal(exact, 3.5);
  assert.equal(cookPortionTarget(exact), 4);
});

test('count, weight and volume serving bases produce live household language', () => {
  const sticks = { serving_basis_amount: 4, serving_basis_unit: 'count', serving_basis_label: 'fish stick' };
  const salmon = { serving_basis_amount: 6, serving_basis_unit: 'oz' };
  const soup = { serving_basis_amount: 12, serving_basis_unit: 'fl_oz' };
  assert.deepEqual(recipeServingBasis(sticks), { amount: 4, unit: 'count', label: 'fish stick' });
  assert.equal(formatServingAmount(servingAmountForPortions(sticks, 1.5)), '6 fish sticks');
  assert.equal(formatServingAmount(servingAmountForPortions(salmon, 1.5)), '9 oz');
  assert.equal(formatServingAmount(servingAmountForPortions(soup, 1.5)), '18 fl oz');
  assert.equal(recipeServingBasis({}), null);
  assert.equal(formatServingAmount(servingAmountForPortions({ serving_basis_amount: 0.25, serving_basis_unit: 'kg' }, 0.01)), '0.0025 kg');
  assert.equal(formatServingAmount(servingAmountForPortions({ serving_basis_amount: 1, serving_basis_unit: 'count', serving_basis_label: 'cob' }, 0.5)), '0.5 cobs');
});

test('requested total preview replaces an existing response and restores opt-in', () => {
  const saved = { planned: 3.5, previous: 1.25, wasParticipating: true };
  assert.equal(projectRequestedPortions({ ...saved, amount: 1.5 }), 3.75);
  assert.equal(projectRequestedPortions({ ...saved, participating: false }), 2.25);
  assert.equal(projectRequestedPortions({ planned: 2.25, amount: 1.25 }), 3.5);
});
