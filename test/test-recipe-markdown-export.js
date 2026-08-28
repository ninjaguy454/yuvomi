import assert from 'node:assert/strict';
import test from 'node:test';

import { recipeToMarkdown } from '../public/utils/recipe-markdown.js';
import { parseRecipeMarkdown } from '../server/services/recipe-url-import.js';

test('recipeToMarkdown exports all shareable native recipe content', () => {
  const markdown = recipeToMarkdown({
    title: 'Weeknight Lemon Pasta',
    meal_types: ['lunch', 'dinner'],
    recipe_url: 'https://recipes.example/lemon-pasta',
    source: 'native',
    ingredients: [
      { quantity: '8 oz', name: 'spaghetti', category: 'Sonstiges' },
      { quantity: '2', name: 'lemons', category: 'Obst & Gemüse' },
      { quantity: null, name: 'black pepper', category: 'Sonstiges' },
    ],
    notes: '## Instructions\n\n1. Boil the pasta.\n2. Toss with lemon.',
  });

  assert.equal(markdown, `# Weeknight Lemon Pasta

**Meal types:** Lunch, Dinner

**Source:** <https://recipes.example/lemon-pasta>

## Ingredients

- 8 oz spaghetti
- 2 lemons
- black pepper

## Instructions

1. Boil the pasta.
2. Toss with lemon.
`);

  const imported = parseRecipeMarkdown(markdown);
  assert.equal(imported.title, 'Weeknight Lemon Pasta');
  assert.deepEqual(imported.meal_types, ['lunch', 'dinner']);
  assert.equal(imported.recipe_url, 'https://recipes.example/lemon-pasta');
  assert.equal(imported.ingredients.length, 3);
  assert.equal(imported.notes, '## Instructions\n\n1. Boil the pasta.\n2. Toss with lemon.');
});

test('recipeToMarkdown includes provider identity and wraps plain notes', () => {
  const markdown = recipeToMarkdown({
    title: '  Shared   Soup  ',
    meal_types: [],
    source: 'mealie',
    provider_account_name: 'Family Server',
    ingredients: [],
    notes: 'Serve warm.',
  });

  assert.equal(markdown, `# Shared Soup

**Meal types:** None

**Source:** Mealie (Family Server)

## Ingredients

## Notes

Serve warm.
`);

  const imported = parseRecipeMarkdown(markdown);
  assert.deepEqual(imported.meal_types, []);
  assert.equal(imported.recipe_url, null);
  assert.equal(imported.notes, '## Notes\n\nServe warm.');
});

test('recipeToMarkdown supports localized meal labels without changing headings', () => {
  const markdown = recipeToMarkdown({ title: 'Toast', meal_types: ['breakfast'] }, {
    mealTypeLabels: { breakfast: 'Frühstück' },
  });
  assert.match(markdown, /\*\*Meal types:\*\* Frühstück/);
  assert.match(markdown, /## Ingredients/);
});
