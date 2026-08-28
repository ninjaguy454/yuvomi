/**
 * Import a public recipe webpage into a reviewable native Yuvomi recipe draft.
 * Schema.org Recipe JSON-LD is preferred because it is structured and widely
 * used. Pages without it fall back to recognizable Markdown-style ingredient
 * and instruction sections. Network access uses the shared guarded lookup so
 * user-supplied URLs cannot reach the host or private LAN.
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
const MAX_MARKDOWN_CHARS = 100_000;

const INGREDIENT_SECTION = /^(?:ingredients?|what you(?:'|’)ll need|zutaten|ingrédients?|ingredientes?|ingredienti|ingrediënten|ingredienser|ingredience|składniki|hozzávalók|malzemeler|ингредиенты|інгредієнти|υλικά|المكونات|مواد لازم|सामग्री|bahan|(?:mga )?sangkap|nguyên liệu|食材|配料|材料|재료)$/iu;
const INSTRUCTION_SECTION = /^(?:instructions?|directions?|method|preparation|steps?|zubereitung|anleitung|préparation|étapes?|instrucciones|preparación|pasos|istruzioni|preparazione|procedimento|instruções|preparo|bereiding|stappen|instruktioner|tillagning|postup|przygotowanie|utasítások|elkészítés|hazırlanış|yapılışı|инструкции|приготовление|інструкції|приготування|οδηγίες|εκτέλεση|طريقة التحضير|دستور پخت|विधि|निर्देश|cara membuat|paraan|hướng dẫn|cách làm|做法|步骤|作り方|手順|만드는 법|조리법)$/iu;
const END_SECTION = /^(?:notes?|tips?|nutrition|nutritional information|equipment|storage|serving suggestions?|substitutions?|faq|comments?|notizen|tipps|nährwerte|remarques|conseils|valeurs nutritives|notas|consejos|nutrición)$/iu;

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

function decodeEntities(value) {
  const named = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
  return String(value || '')
    .replace(/&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (_match, entity) => {
      const lower = entity.toLowerCase();
      const numeric = lower.startsWith('#x')
        ? parseInt(lower.slice(2), 16)
        : (lower.startsWith('#') ? parseInt(lower.slice(1), 10) : null);
      if (numeric != null) return Number.isInteger(numeric) && numeric >= 0 && numeric <= 0x10ffff
        ? String.fromCodePoint(numeric)
        : _match;
      return named[lower] ?? _match;
    });
}

function decodeHtml(value) {
  return decodeEntities(String(value || '').replace(/<[^>]*>/g, ' '))
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

function htmlToMarkdown(html) {
  return decodeEntities(String(html || '')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|noscript|svg|template)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, ' ')
    .replace(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1\s*>/gi,
      (_match, level, content) => `\n${'#'.repeat(Number(level))} ${decodeHtml(content)}\n`)
    .replace(/<li\b[^>]*>([\s\S]*?)<\/li\s*>/gi, (_match, content) => `\n- ${decodeHtml(content)}\n`)
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(?:p|div|section|article|header|footer|main|aside|ul|ol|table|tr|blockquote)\s*>/gi, '\n')
    .replace(/<[^>]*>/g, ' '))
    .replace(/\r/g, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function markdownLabel(value) {
  return decodeHtml(String(value || '')
    .replace(/^#{1,6}\s+/, '')
    .replace(/^\s*(?:\*\*|__)(.*?)(?:\*\*|__)\s*:?[ \t]*$/, '$1')
    .replace(/[#:]+\s*$/, '')
    .replace(/[*_`~]/g, ' '))
    .trim();
}

function markdownHeading(line) {
  const heading = String(line || '').trim().match(/^(#{1,6})\s+(.+?)\s*#*$/);
  if (heading) return { level: heading[1].length, label: markdownLabel(heading[2]) };
  const bold = String(line || '').trim().match(/^(?:\*\*|__)(.+?)(?:\*\*|__)\s*:?[ \t]*$/);
  if (bold) return { level: 2, label: markdownLabel(bold[1]) };
  const label = markdownLabel(line);
  if (INGREDIENT_SECTION.test(label) || INSTRUCTION_SECTION.test(label) || END_SECTION.test(label)) {
    return { level: 2, label };
  }
  return null;
}

function markdownItem(line) {
  return markdownLabel(String(line || '')
    .replace(/^\s*(?:[-*+]\s+|\d+[.)]\s+|\[[ xX]\]\s+)/, '')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1'))
    .slice(0, 500);
}

function uniqueIngredients(lines) {
  const seen = new Set();
  return lines.map(parseIngredient).filter((ingredient) => {
    if (!ingredient) return false;
    const key = `${ingredient.quantity || ''}\0${ingredient.name}`.toLocaleLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function sourceName(recipeUrl, fallback = 'Pasted Markdown') {
  try { return new URL(recipeUrl).hostname; } catch { return fallback; }
}

export function parseRecipeMarkdown(markdown, recipeUrl = null) {
  const source = String(markdown || '').replace(/\r/g, '').trim();
  if (!source) throw new RecipeUrlImportError('Paste a Markdown recipe to import.', 400);
  if (source.length > MAX_MARKDOWN_CHARS) {
    throw new RecipeUrlImportError('That Markdown recipe is too large to import.', 413);
  }

  const lines = source.split('\n');
  const firstTitle = lines.map(markdownHeading).find((heading) => (
    heading?.label && heading.level === 1
      && !INGREDIENT_SECTION.test(heading.label)
      && !INSTRUCTION_SECTION.test(heading.label)
  ));
  let title = firstTitle?.label || '';
  let section = null;
  const ingredientLines = [];
  const instructionLines = [];

  for (const line of lines) {
    const heading = markdownHeading(line);
    if (heading) {
      if (!title && heading.level <= 2
          && !INGREDIENT_SECTION.test(heading.label)
          && !INSTRUCTION_SECTION.test(heading.label)
          && !END_SECTION.test(heading.label)) title = heading.label;
      if (INGREDIENT_SECTION.test(heading.label)) section = 'ingredients';
      else if (INSTRUCTION_SECTION.test(heading.label)) section = 'instructions';
      else if (END_SECTION.test(heading.label)) section = null;
      continue;
    }
    if (!section) continue;
    const item = markdownItem(line);
    if (!item || item.length < 2) continue;
    if (section === 'ingredients') ingredientLines.push(item);
    else instructionLines.push(item);
  }

  title = title.slice(0, 200);
  const ingredients = uniqueIngredients(ingredientLines.slice(0, MAX_INGREDIENTS));
  const instructions = [...new Set(instructionLines)].slice(0, 100);
  if (!title || (!ingredients.length && !instructions.length)) {
    throw new RecipeUrlImportError(
      'No recognizable Markdown recipe was found. Use a title plus Ingredients and/or Instructions headings.',
    );
  }

  return {
    title,
    notes: instructions.length
      ? `## Instructions\n\n${instructions.map((step, index) => `${index + 1}. ${step}`).join('\n')}`.slice(0, 5000)
      : null,
    recipe_url: recipeUrl || null,
    meal_types: inferredMealTypes({ recipeCategory: source.slice(0, 3000), keywords: title }),
    ingredients,
    import_source: sourceName(recipeUrl),
  };
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
  if (!recipe) {
    try { return parseRecipeMarkdown(htmlToMarkdown(html), recipeUrl); }
    catch {
      throw new RecipeUrlImportError(
        'No structured recipe data or recognizable Markdown Ingredients/Instructions sections were found on that page.',
      );
    }
  }

  let markdownDraft = null;
  const structuredTitle = decodeHtml(recipe.name || recipe.headline).slice(0, 200);
  const structuredIngredients = (Array.isArray(recipe.recipeIngredient) ? recipe.recipeIngredient : [])
    .slice(0, MAX_INGREDIENTS).map(parseIngredient).filter(Boolean);
  const instructions = instructionSteps(recipe.recipeInstructions).slice(0, 100);
  if (!structuredTitle || !structuredIngredients.length || !instructions.length) {
    try { markdownDraft = parseRecipeMarkdown(htmlToMarkdown(html), recipeUrl); } catch { /* structured fields may still be sufficient */ }
  }
  const title = structuredTitle || markdownDraft?.title || '';
  if (!title) throw new RecipeUrlImportError('The recipe page did not provide a title.');
  const ingredients = structuredIngredients.length ? structuredIngredients : (markdownDraft?.ingredients ?? []);
  const description = decodeHtml(recipe.description);
  const notes = [
    description,
    instructions.length
      ? `## Instructions\n\n${instructions.map((step, index) => `${index + 1}. ${step}`).join('\n')}`
      : (markdownDraft?.notes || ''),
  ].filter(Boolean).join('\n\n').slice(0, 5000) || null;

  return {
    title,
    notes,
    recipe_url: recipeUrl,
    meal_types: inferredMealTypes(recipe),
    ingredients,
    import_source: decodeHtml(recipe.author?.name || recipe.publisher?.name)
      || markdownDraft?.import_source || sourceName(recipeUrl),
  };
}

export function importRecipeFromMarkdown(rawMarkdown, { sourceUrl = null } = {}) {
  const url = sourceUrl ? normalizedUrl(sourceUrl).href : null;
  return parseRecipeMarkdown(rawMarkdown, url);
}

export async function importRecipeFromUrl(rawUrl, { request = safeRequest } = {}) {
  const page = await fetchRecipeDocument(rawUrl, request);
  return parseRecipeDocument(page.html, page.url);
}
