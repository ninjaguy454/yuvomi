/**
 * Import a public recipe webpage into a reviewable native Yuvomi recipe draft.
 * Only schema.org Recipe JSON-LD is accepted: it is structured, widely used,
 * and avoids brittle site-specific DOM scraping. Network access uses the shared
 * guarded lookup so user-supplied URLs cannot reach the host or private LAN.
 */

import { safeRequest } from '../utils/http.js';
import { isIP } from 'node:net';
import {
  createGuardedLookup,
  isBlockedAddress,
  isBlockedHostname,
  normalizeHostname,
} from '../utils/ssrf.js';
import { categorizeIngredient } from './recipe-providers/categorize.js';

const MAX_DOCUMENT_BYTES = 2 * 1024 * 1024;
const MAX_REDIRECTS = 5;
const MAX_INGREDIENTS = 250;

export class RecipeUrlImportError extends Error {
  constructor(message, status = 422) {
    super(message);
    this.name = 'RecipeUrlImportError';
    this.status = status;
  }
}

function normalizedUrl(raw) {
  let url;
  try {
    url = new URL(String(raw || '').trim());
  } catch {
    throw new RecipeUrlImportError('Enter a valid recipe URL.', 400);
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new RecipeUrlImportError('Recipe URLs must use public HTTP or HTTPS without embedded credentials.', 400);
  }
  const hostname = normalizeHostname(url.hostname);
  if (isBlockedHostname(hostname) || (isIP(hostname) && isBlockedAddress(hostname))) {
    throw new RecipeUrlImportError('Recipe import cannot access local or private network addresses.', 400);
  }
  url.hash = '';
  return url;
}

async function readBody(response) {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_DOCUMENT_BYTES) {
    response.body.destroy();
    throw new RecipeUrlImportError('That recipe page is too large to import.', 413);
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > MAX_DOCUMENT_BYTES) {
      response.body.destroy();
      throw new RecipeUrlImportError('That recipe page is too large to import.', 413);
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function fetchRecipeDocument(rawUrl, request) {
  let current = normalizedUrl(rawUrl);
  const lookup = createGuardedLookup();
  for (let redirect = 0; redirect <= MAX_REDIRECTS; redirect += 1) {
    let response;
    try {
      response = await request(current.href, {
        headers: { Accept: 'text/html, application/xhtml+xml;q=0.9' },
        lookup,
        redirect: 'manual',
        signal: AbortSignal.timeout(12_000),
      });
    } catch (error) {
      const privateTarget = /private IP|local|blocked/i.test(error.message || '');
      throw new RecipeUrlImportError(
        privateTarget
          ? 'Recipe import cannot access local or private network addresses.'
          : 'The recipe page could not be reached.',
        privateTarget ? 400 : 502,
      );
    }

    const location = response.headers.get('location');
    if (response.status >= 300 && response.status < 400 && location) {
      response.body.destroy();
      if (redirect === MAX_REDIRECTS) throw new RecipeUrlImportError('The recipe page redirected too many times.', 502);
      current = normalizedUrl(new URL(location, current).href);
      continue;
    }
    if (!response.ok) {
      response.body.destroy();
      throw new RecipeUrlImportError(`The recipe page returned HTTP ${response.status}.`, 502);
    }
    const contentType = String(response.headers.get('content-type') || '').toLowerCase();
    if (contentType && !contentType.includes('text/html') && !contentType.includes('application/xhtml+xml')) {
      response.body.destroy();
      throw new RecipeUrlImportError('That URL does not point to an HTML recipe page.', 415);
    }
    return { html: await readBody(response), url: current.href };
  }
  throw new RecipeUrlImportError('The recipe page redirected too many times.', 502);
}

function decodeHtml(value) {
  const named = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
  return String(value || '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (_match, entity) => {
      const lower = entity.toLowerCase();
      const numeric = lower.startsWith('#x')
        ? parseInt(lower.slice(2), 16)
        : (lower.startsWith('#') ? parseInt(lower.slice(1), 10) : null);
      if (numeric != null) return Number.isInteger(numeric) && numeric >= 0 && numeric <= 0x10ffff
        ? String.fromCodePoint(numeric)
        : _match;
      return named[lower] ?? _match;
    })
    .replace(/\s+/g, ' ')
    .trim();
}

function recipeType(value) {
  const values = Array.isArray(value) ? value : [value];
  return values.some((entry) => String(entry || '').split(/[\/#]/).pop().toLowerCase() === 'recipe');
}

function findRecipeNode(root) {
  const queue = [root];
  const seen = new Set();
  let visited = 0;
  while (queue.length && visited < 5000) {
    const value = queue.shift();
    if (!value || typeof value !== 'object' || seen.has(value)) continue;
    seen.add(value);
    visited += 1;
    if (!Array.isArray(value) && recipeType(value['@type'])) return value;
    if (Array.isArray(value)) queue.push(...value);
    else queue.push(...Object.values(value));
  }
  return null;
}

function jsonLdDocuments(html) {
  const documents = [];
  for (const match of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)) {
    if (!/\btype\s*=\s*(?:["']application\/ld\+json["']|application\/ld\+json)/i.test(match[1])) continue;
    const source = match[2].replace(/^\s*<!--|-->\s*$/g, '').replace(/^\uFEFF/, '').trim();
    if (!source) continue;
    try { documents.push(JSON.parse(source)); } catch { /* another JSON-LD block may contain the Recipe */ }
  }
  return documents;
}

function instructionSteps(value, output = []) {
  if (typeof value === 'string') {
    const text = decodeHtml(value);
    if (text) output.push(text);
  } else if (Array.isArray(value)) {
    value.forEach((entry) => instructionSteps(entry, output));
  } else if (value && typeof value === 'object') {
    if (value.text) instructionSteps(value.text, output);
    else if (value.itemListElement) instructionSteps(value.itemListElement, output);
    else if (value.name) instructionSteps(value.name, output);
  }
  return output;
}

function parseIngredient(value) {
  const text = decodeHtml(value).slice(0, 400);
  if (!text) return null;
  const match = text.match(/^((?:\d+\s+\d+\/\d+|\d+\/\d+|\d+(?:[.,]\d+)?)\s*(?:cups?|tbsp\.?|tablespoons?|tsp\.?|teaspoons?|oz\.?|ounces?|lb\.?|pounds?|g|grams?|kg|kilograms?|ml|milliliters?|l|liters?)?)\s+(.+)$/i);
  const quantity = match?.[1]?.trim().slice(0, 100) || null;
  const name = (match?.[2] || text).trim().slice(0, 200);
  if (!name) return null;
  return { name, quantity, category: categorizeIngredient({ foodName: name }) };
}

function inferredMealTypes(recipe) {
  const category = [recipe.recipeCategory, recipe.recipeCuisine, recipe.keywords]
    .flat(Infinity).map(decodeHtml).join(' ').toLowerCase();
  const types = [];
  if (/breakfast|brunch/.test(category)) types.push('breakfast');
  if (/lunch/.test(category)) types.push('lunch');
  if (/dinner|supper|main course|main dish/.test(category)) types.push('dinner');
  if (/snack|dessert|appetizer|starter/.test(category)) types.push('snack');
  return types.length ? [...new Set(types)] : ['breakfast', 'lunch', 'dinner', 'snack'];
}

export function parseRecipeDocument(html, recipeUrl) {
  let recipe = null;
  for (const document of jsonLdDocuments(String(html || ''))) {
    recipe = findRecipeNode(document);
    if (recipe) break;
  }
  if (!recipe) throw new RecipeUrlImportError('No structured recipe data was found on that page.');

  const title = decodeHtml(recipe.name || recipe.headline).slice(0, 200);
  if (!title) throw new RecipeUrlImportError('The recipe page did not provide a title.');
  const ingredients = (Array.isArray(recipe.recipeIngredient) ? recipe.recipeIngredient : [])
    .slice(0, MAX_INGREDIENTS).map(parseIngredient).filter(Boolean);
  const instructions = instructionSteps(recipe.recipeInstructions).slice(0, 100);
  const description = decodeHtml(recipe.description);
  const notes = [
    description,
    instructions.length ? `## Instructions\n\n${instructions.map((step, index) => `${index + 1}. ${step}`).join('\n')}` : '',
  ].filter(Boolean).join('\n\n').slice(0, 5000) || null;

  return {
    title,
    notes,
    recipe_url: recipeUrl,
    meal_types: inferredMealTypes(recipe),
    ingredients,
    import_source: decodeHtml(recipe.author?.name || recipe.publisher?.name) || new URL(recipeUrl).hostname,
  };
}

export async function importRecipeFromUrl(rawUrl, { request = safeRequest } = {}) {
  const page = await fetchRecipeDocument(rawUrl, request);
  return parseRecipeDocument(page.html, page.url);
}
