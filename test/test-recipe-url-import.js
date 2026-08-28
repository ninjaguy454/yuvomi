import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { Readable } from 'node:stream';

import {
  RecipeUrlImportError,
  importRecipeFromMarkdown,
  importRecipeFromUrl,
  parseRecipeDocument,
  parseRecipeMarkdown,
} from '../server/services/recipe-url-import.js';

const recipeJson = {
  '@context': 'https://schema.org',
  '@type': 'Recipe',
  name: 'Weeknight Tomato Pasta',
  description: '<p>A fast &amp; friendly dinner.</p>',
  recipeCategory: ['Dinner', 'Main course'],
  recipeIngredient: ['2 tbsp olive oil', '3 tomatoes', '1/2 cup parmesan cheese'],
  recipeInstructions: [
    { '@type': 'HowToStep', text: 'Warm the oil.' },
    { '@type': 'HowToStep', text: 'Add tomatoes and simmer.' },
  ],
  author: { '@type': 'Person', name: 'Test Kitchen' },
};

function documentFor(value) {
  return `<!doctype html><html><head><script type="application/ld+json">${JSON.stringify(value)}</script></head></html>`;
}

function response(status, body, headers = {}) {
  const normalized = new Map(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), String(value)]));
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: (name) => normalized.get(String(name).toLowerCase()) ?? null },
    body: Readable.from([Buffer.from(body)]),
  };
}

test('parseRecipeDocument extracts a reviewable recipe draft from schema.org JSON-LD', () => {
  const draft = parseRecipeDocument(documentFor({ '@graph': [{ '@type': 'WebPage' }, recipeJson] }), 'https://recipes.example/pasta');
  assert.equal(draft.title, 'Weeknight Tomato Pasta');
  assert.equal(draft.recipe_url, 'https://recipes.example/pasta');
  assert.deepEqual(draft.meal_types, ['dinner']);
  assert.equal(draft.ingredients.length, 3);
  assert.deepEqual(draft.ingredients[0], {
    name: 'olive oil', quantity: '2 tbsp', category: 'Sonstiges',
  });
  assert.deepEqual(draft.ingredients[2], {
    name: 'parmesan cheese', quantity: '1/2 cup', category: 'Milchprodukte',
  });
  assert.match(draft.notes, /A fast & friendly dinner\./);
  assert.match(draft.notes, /1\. Warm the oil\./);
  assert.equal(draft.import_source, 'Test Kitchen');
});

test('importRecipeFromUrl follows validated redirects and keeps the final URL', async () => {
  const calls = [];
  const request = async (url, options) => {
    calls.push({ url, options });
    if (calls.length === 1) return response(302, '', { location: 'https://cdn.example/final-recipe' });
    return response(200, documentFor(recipeJson), { 'content-type': 'text/html; charset=utf-8' });
  };
  const draft = await importRecipeFromUrl('https://recipes.example/start#comments', { request });
  assert.equal(calls.length, 2);
  assert.equal(calls[0].options.redirect, 'manual');
  assert.equal(draft.recipe_url, 'https://cdn.example/final-recipe');
});

test('parseRecipeDocument falls back to Markdown-style webpage sections', () => {
  const html = `<!doctype html><html><body>
    <h1>Skillet Lemon Potatoes</h1>
    <h2>Ingredients</h2>
    <ul><li>2 lb potatoes</li><li>1 tbsp olive oil</li><li>1 lemon</li></ul>
    <h2>Instructions</h2>
    <ol><li>Slice the potatoes.</li><li>Cook until golden.</li></ol>
  </body></html>`;
  const draft = parseRecipeDocument(html, 'https://recipes.example/lemon-potatoes');
  assert.equal(draft.title, 'Skillet Lemon Potatoes');
  assert.deepEqual(draft.ingredients[0], {
    name: 'potatoes', quantity: '2 lb', category: 'Sonstiges',
  });
  assert.match(draft.notes, /1\. Slice the potatoes\./);
  assert.equal(draft.recipe_url, 'https://recipes.example/lemon-potatoes');
});

test('pasted Markdown creates the same reviewable recipe draft', () => {
  const draft = importRecipeFromMarkdown(`# Weeknight Lemon Pasta

## Ingredients
- 8 oz spaghetti
- 2 lemons
- 1/2 cup parmesan cheese

## Instructions
1. Boil the pasta.
2. Toss with lemon and cheese.
`);
  assert.equal(draft.title, 'Weeknight Lemon Pasta');
  assert.equal(draft.recipe_url, null);
  assert.equal(draft.import_source, 'Pasted Markdown');
  assert.equal(draft.ingredients.length, 3);
  assert.deepEqual(draft.ingredients[2], {
    name: 'parmesan cheese', quantity: '1/2 cup', category: 'Milchprodukte',
  });
  assert.match(draft.notes, /2\. Toss with lemon and cheese\./);
});

test('parseRecipeMarkdown requires recognizable recipe sections', () => {
  assert.throws(
    () => parseRecipeMarkdown('# Grocery thoughts\n\nRemember to buy lemons.'),
    (error) => error instanceof RecipeUrlImportError && error.status === 422,
  );
});

test('importRecipeFromUrl rejects local targets before making a request', async () => {
  let called = false;
  await assert.rejects(
    () => importRecipeFromUrl('http://127.0.0.1/admin', { request: async () => { called = true; } }),
    (error) => error instanceof RecipeUrlImportError && error.status === 400 && /local|private/i.test(error.message),
  );
  assert.equal(called, false);
});

test('parseRecipeDocument reports pages without structured Recipe data', () => {
  assert.throws(
    () => parseRecipeDocument(documentFor({ '@type': 'Article', name: 'Not a recipe' }), 'https://example.com/post'),
    (error) => error instanceof RecipeUrlImportError && error.status === 422,
  );
});

test('recipe import UI offers automatic URL fallback and direct Markdown paste', async () => {
  const source = await readFile(new URL('../public/pages/recipes.js', import.meta.url), 'utf8');
  assert.match(source, /Markdown-style Ingredients and Instructions sections/);
  assert.match(source, /id="recipe-import-markdown"/);
  assert.match(source, /\/recipes\/markdown-preview/);
  assert.match(source, /\/recipes\/url-preview/);
});
