import assert from 'node:assert/strict';
import test from 'node:test';
import { Readable } from 'node:stream';

import {
  RecipeUrlImportError,
  importRecipeFromUrl,
  parseRecipeDocument,
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

