/**
 * Modul: Rezepte (Recipes)
 * Zweck: REST-API-Routen fuer Rezept-CRUD inkl. Zutaten
 * Abhaengigkeiten: express, server/db.js
 */

import { createLogger } from '../logger.js';
import express from 'express';
import * as db from '../db.js';
import { str, num, collectErrors, MAX_TITLE, MAX_TEXT, MAX_SHORT } from '../middleware/validate.js';
import { normalizeRecipeMealTypes } from '../../public/utils/recipe-meal-types.js';
import { validatePipeline } from '../../public/utils/recipe-pipeline.js';
import { canWriteRecipePipeline, validateRecipePipelineBindings, withRecipePipeline } from '../services/recipe-pipeline.js';
import { getAdapter } from '../services/recipe-providers/index.js';
import {
  importRecipeFromMarkdown,
  importRecipeFromUrl,
  RecipeUrlImportError,
} from '../services/recipe-url-import.js';

const log = createLogger('Recipes');
const router = express.Router();
let recipeUrlImporter = importRecipeFromUrl;

export function _setRecipeUrlImporter(importer) {
  recipeUrlImporter = importer || importRecipeFromUrl;
}

// Nicht-skriptfähige Rasterformate (kein SVG), dieselbe Allowlist wie der
// DMS-Vorschau-Proxy (server/routes/dms.js) - dort wie hier landet ein
// Content-Type, den ein Drittsystem liefert, direkt im Response-Header.
const THUMBNAIL_MIME = new Set(['image/webp', 'image/jpeg', 'image/png']);
function normalizeMime(value) { return String(value || '').split(';')[0].trim().toLowerCase(); }

// Mirror-Rezepte tragen provider_account_id; native Rezepte haben diese Spalte
// NULL. `source` liest den tatsaechlichen Provider-Namen (mealie/tandoor/...)
// vom verknuepften Account statt ihn hart zu verdrahten - das ist der einzige
// Unterschied, den Frontend und Zugriffsschutz brauchen, um ein Rezept korrekt
// zu behandeln, und er erweitert sich automatisch um jeden neuen Provider.
function withSource(recipe, req) {
  return withRecipePipeline({ ...recipe, source: recipe.provider_account_id ? recipe.provider_type : 'native' }, req);
}

function loadRecipeWithIngredients(id, req) {
  const recipe = db.get().prepare(`
    SELECT r.*, u.display_name AS creator_name, u.avatar_color AS creator_color,
           p.name AS provider_account_name, p.provider AS provider_type
    FROM recipes r
    LEFT JOIN users u ON u.id = r.created_by
    LEFT JOIN recipe_provider_accounts p ON p.id = r.provider_account_id
    WHERE r.id = ?
  `).get(id);

  if (!recipe) return null;

  const ingredients = db.get().prepare(`
    SELECT * FROM recipe_ingredients
    WHERE recipe_id = ?
    ORDER BY id ASC
  `).all(id);

  return withSource({ ...recipe, meal_types: normalizeRecipeMealTypes(recipe.meal_types), ingredients }, req);
}

router.get('/', (req, res) => {
  try {
    const recipes = db.get().prepare(`
      SELECT r.*, u.display_name AS creator_name, u.avatar_color AS creator_color,
             p.name AS provider_account_name, p.provider AS provider_type
      FROM recipes r
      LEFT JOIN users u ON u.id = r.created_by
      LEFT JOIN recipe_provider_accounts p ON p.id = r.provider_account_id
      ORDER BY r.title COLLATE NOCASE ASC, r.id DESC
    `).all();

    const ids = recipes.map((r) => r.id);
    let ingredientMap = {};

    if (ids.length > 0) {
      const placeholders = ids.map(() => '?').join(',');
      const ingredients = db.get().prepare(`
        SELECT * FROM recipe_ingredients
        WHERE recipe_id IN (${placeholders})
        ORDER BY id ASC
      `).all(...ids);

      for (const ing of ingredients) {
        if (!ingredientMap[ing.recipe_id]) ingredientMap[ing.recipe_id] = [];
        ingredientMap[ing.recipe_id].push(ing);
      }
    }

    res.json({ data: recipes.map((r) => withSource({
      ...r,
      meal_types: normalizeRecipeMealTypes(r.meal_types),
      ingredients: ingredientMap[r.id] || [],
    }, req)) });
  } catch (err) {
    log.error('GET / error:', err);
    res.status(500).json({ error: 'Internal error', code: 500 });
  }
});

// Import is deliberately preview-only. The browser opens the ordinary native
// recipe editor with this draft, and the user reviews it before POST / creates
// anything in the household database.
router.post('/url-preview', async (req, res) => {
  try {
    const url = String(req.body?.url || '').trim();
    if (!url || url.length > MAX_TEXT) {
      return res.status(400).json({ error: 'Enter a valid recipe URL.', code: 400 });
    }
    const draft = await recipeUrlImporter(url);
    res.json({ data: draft });
  } catch (err) {
    const status = err instanceof RecipeUrlImportError
      ? err.status
      : (Number.isInteger(err?.status) ? err.status : 502);
    log.warn('POST /url-preview:', err?.message || err);
    res.status(status).json({
      error: err?.message || 'The recipe page could not be imported.',
      code: status,
    });
  }
});

router.post('/markdown-preview', (req, res) => {
  try {
    const markdown = String(req.body?.markdown || '');
    const sourceUrl = String(req.body?.source_url || '').trim() || null;
    if (sourceUrl && sourceUrl.length > MAX_TEXT) {
      return res.status(400).json({ error: 'Enter a valid source URL.', code: 400 });
    }
    const draft = importRecipeFromMarkdown(markdown, { sourceUrl });
    res.json({ data: draft });
  } catch (err) {
    const status = err instanceof RecipeUrlImportError
      ? err.status
      : (Number.isInteger(err?.status) ? err.status : 422);
    log.warn('POST /markdown-preview:', err?.message || err);
    res.status(status).json({
      error: err?.message || 'The Markdown recipe could not be imported.',
      code: status,
    });
  }
});

router.post('/', (req, res) => {
  try {
    const { ingredients = [] } = req.body;

    const vTitle = str(req.body.title, 'Titel', { max: MAX_TITLE });
    const vNotes = str(req.body.notes, 'Notizen', { max: MAX_TEXT, required: false });
    const vRecipeUrl = str(req.body.recipe_url, 'Rezept-URL', { max: MAX_TEXT, required: false });
    const mealTypes = normalizeRecipeMealTypes(req.body.meal_types);

    const errors = collectErrors([vTitle, vNotes, vRecipeUrl]);
    if (errors.length) return res.status(400).json({ error: errors.join(' '), code: 400 });

    const recipeId = db.transaction(() => {
      const result = db.get().prepare(`
        INSERT INTO recipes (title, notes, recipe_url, meal_types, created_by)
        VALUES (?, ?, ?, ?, ?)
      `).run(vTitle.value, vNotes.value, vRecipeUrl.value, mealTypes.join(','), req.authUserId || req.session.userId);

      const rid = Number(result.lastInsertRowid);
      const insertIng = db.get().prepare(`
        INSERT INTO recipe_ingredients (recipe_id, name, quantity, category)
        VALUES (?, ?, ?, ?)
      `);

      for (const ing of ingredients) {
        const name = String(ing.name || '').trim().slice(0, MAX_TITLE);
        const quantity = String(ing.quantity || '').trim().slice(0, MAX_SHORT) || null;
        const category = String(ing.category || '').trim().slice(0, MAX_SHORT) || 'Sonstiges';
        if (name) insertIng.run(rid, name, quantity, category);
      }

      return rid;
    });

    const created = loadRecipeWithIngredients(recipeId, req);
    res.status(201).json({ data: created });
  } catch (err) {
    log.error('POST / error:', err);
    res.status(500).json({ error: 'Internal error', code: 500 });
  }
});

router.get('/:id', (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isSafeInteger(id) || id <= 0) return res.status(400).json({ error: 'Invalid recipe ID.', code: 400 });
    const recipe = loadRecipeWithIngredients(id, req);
    if (!recipe) return res.status(404).json({ error: 'Recipe not found.', code: 404 });
    return res.json({ data: recipe });
  } catch (err) {
    log.error('GET /:id error:', err);
    return res.status(500).json({ error: 'Recipe could not be loaded.', code: 500 });
  }
});

// Execution data belongs only to native recipes. Imported written content
// remains read-only; duplicate it into a native recipe before authoring a flow.
router.put('/:id/pipeline', (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isSafeInteger(id) || id <= 0) return res.status(400).json({ error: 'Invalid recipe ID.', code: 400 });
    const result = db.transaction(() => {
      const recipe = loadRecipeWithIngredients(id, req);
      if (!recipe) return { status: 404, error: 'Recipe not found.' };
      if (recipe.provider_account_id) return { status: 403, error: 'Duplicate this imported recipe before adding a pipeline.' };
      if (!recipe.pipeline_can_edit) return { status: 403, error: 'You do not have permission to edit this recipe pipeline.' };
      const { expected_revision: expectedRevision, source_hash: sourceHash } = req.body || {};
      if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
        return { status: 400, error: 'A valid pipeline revision is required. Reopen the recipe and try again.' };
      }
      if (typeof sourceHash !== 'string' || !/^[a-f0-9]{64}$/.test(sourceHash)) {
        return { status: 400, error: 'The recipe source is required. Reopen the recipe and try again.' };
      }
      if (recipe.pipeline_revision !== expectedRevision) {
        return { status: 409, error: 'This pipeline was changed elsewhere. Reopen it before saving your changes.' };
      }
      if (recipe.pipeline_current_source_hash !== sourceHash) {
        return { status: 409, error: 'The recipe ingredients or instructions changed. Review the current recipe before saving its pipeline.' };
      }
      let pipeline;
      try {
        pipeline = validatePipeline(req.body.pipeline);
        validateRecipePipelineBindings(pipeline, recipe);
      }
      catch (err) { return { status: 400, error: err.message }; }
      const saved = db.get().prepare(`
        UPDATE recipes SET execution_json = ?, execution_revision = execution_revision + 1,
                           execution_source_hash = ?
        WHERE id = ? AND execution_revision = ?
      `).run(JSON.stringify(pipeline), sourceHash, id, expectedRevision);
      if (saved.changes !== 1) return { status: 409, error: 'This pipeline was changed elsewhere. Reopen it before saving your changes.' };
      return { recipe: loadRecipeWithIngredients(id, req) };
    });
    if (result.error) return res.status(result.status).json({ error: result.error, code: result.status });
    return res.json({ data: result.recipe });
  } catch (err) {
    log.error('PUT /:id/pipeline error:', err);
    return res.status(500).json({ error: 'The pipeline could not be saved.', code: 500 });
  }
});

// Copy written fields, ingredients and execution data in one transaction. A
// mirror becomes an ordinary native recipe owned by the caller; a source's
// existing need for review must survive copying instead of being marked fresh.
router.post('/:id/duplicate', (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isSafeInteger(id) || id <= 0) return res.status(400).json({ error: 'Invalid recipe ID.', code: 400 });
    if (!canWriteRecipePipeline(req)) return res.status(403).json({ error: 'You do not have permission to create recipes.', code: 403 });
    const result = db.transaction(() => {
      const source = loadRecipeWithIngredients(id, req);
      if (!source) return { status: 404, error: 'Recipe not found.' };
      if (source.pipeline_invalid) return { status: 409, error: 'This recipe has an invalid saved pipeline and cannot be copied until it is repaired.' };
      const title = req.body?.title === undefined ? `${source.title.slice(0, MAX_TITLE - 7)} (copy)` : req.body.title;
      const vTitle = str(title, 'Title', { max: MAX_TITLE });
      const errors = collectErrors([vTitle]);
      if (errors.length) return { status: 400, error: errors.join(' ') };
      const info = db.get().prepare(`
        INSERT INTO recipes (title, notes, recipe_url, meal_types, created_by, execution_json, execution_revision, execution_source_hash)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(vTitle.value, source.notes, source.recipe_url, source.meal_types.join(','), req.authUserId || req.session?.userId,
        source.pipeline ? JSON.stringify(source.pipeline) : null, source.pipeline ? 1 : 0,
        source.pipeline ? source.pipeline_source_hash : null);
      const copiedId = Number(info.lastInsertRowid);
      const insertIngredient = db.get().prepare('INSERT INTO recipe_ingredients (recipe_id, name, quantity, category) VALUES (?, ?, ?, ?)');
      for (const ingredient of source.ingredients) {
        insertIngredient.run(copiedId, ingredient.name, ingredient.quantity, ingredient.category);
      }
      return { recipe: loadRecipeWithIngredients(copiedId, req) };
    });
    if (result.error) return res.status(result.status).json({ error: result.error, code: result.status });
    return res.status(201).json({ data: result.recipe });
  } catch (err) {
    log.error('POST /:id/duplicate error:', err);
    return res.status(500).json({ error: 'The recipe could not be copied.', code: 500 });
  }
});

router.put('/:id', (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!id) return res.status(400).json({ error: 'Ungueltige Rezept-ID', code: 400 });

    const existing = db.get().prepare('SELECT id, created_by, provider_account_id, meal_types FROM recipes WHERE id = ?').get(id);
    if (!existing) return res.status(404).json({ error: 'Recipe not found', code: 404 });
    // Mirror-Rezepte sind read-only: der Quell-Provider bleibt Quelle der
    // Wahrheit für ihren Inhalt. Der Check steht vor der created_by-Prüfung,
    // weil sonst genau der Nutzer, der den Provider-Account angelegt hat (und
    // damit als created_by dieser Rezepte gilt), sie über die API editieren könnte.
    if (existing.provider_account_id) return res.status(403).json({ error: 'Mirrored recipes are managed by their source provider and cannot be edited here.', code: 403 });
    if (existing.created_by !== (req.authUserId || req.session.userId)) return res.status(403).json({ error: 'Not authorized.', code: 403 });

    const { ingredients = [] } = req.body;

    const vTitle = str(req.body.title, 'Titel', { max: MAX_TITLE });
    const vNotes = str(req.body.notes, 'Notizen', { max: MAX_TEXT, required: false });
    const vRecipeUrl = str(req.body.recipe_url, 'Rezept-URL', { max: MAX_TEXT, required: false });
    // Fehlt das Feld, bleibt die gespeicherte Auswahl stehen - ein Teil-Update
    // darf sie nicht mitnehmen. Ohne den Rückgriff schriebe jeder Aufruf ohne
    // meal_types wieder alle vier Mahlzeiten hin und machte eine bewusst leere
    // Auswahl (#750) beim nächsten Speichern zunichte.
    const mealTypes = normalizeRecipeMealTypes(
      req.body.meal_types === undefined ? existing.meal_types : req.body.meal_types
    );
    const errors = collectErrors([vTitle, vNotes, vRecipeUrl]);
    if (errors.length) return res.status(400).json({ error: errors.join(' '), code: 400 });

    db.transaction(() => {
      db.get().prepare(`
        UPDATE recipes
        SET title = ?, notes = ?, recipe_url = ?, meal_types = ?
        WHERE id = ?
      `).run(vTitle.value, vNotes.value, vRecipeUrl.value, mealTypes.join(','), id);

      db.get().prepare('DELETE FROM recipe_ingredients WHERE recipe_id = ?').run(id);

      const insertIng = db.get().prepare(`
        INSERT INTO recipe_ingredients (recipe_id, name, quantity, category)
        VALUES (?, ?, ?, ?)
      `);

      for (const ing of ingredients) {
        const name = String(ing.name || '').trim().slice(0, MAX_TITLE);
        const quantity = String(ing.quantity || '').trim().slice(0, MAX_SHORT) || null;
        const category = String(ing.category || '').trim().slice(0, MAX_SHORT) || 'Sonstiges';
        if (name) insertIng.run(id, name, quantity, category);
      }
    });

    const updated = loadRecipeWithIngredients(id, req);
    res.json({ data: updated });
  } catch (err) {
    log.error('PUT /:id error:', err);
    res.status(500).json({ error: 'Internal error', code: 500 });
  }
});

router.delete('/:id', (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!id) return res.status(400).json({ error: 'Invalid recipe ID.', code: 400 });

    const existing = db.get().prepare('SELECT id, created_by, provider_account_id FROM recipes WHERE id = ?').get(id);
    if (!existing) return res.status(404).json({ error: 'Recipe not found.', code: 404 });
    // Siehe PUT /:id: Mirror-Rezepte lassen sich nur durch Löschen des
    // Provider-Accounts entfernen (DELETE /recipe-providers/accounts/:id), nicht
    // einzeln hier.
    if (existing.provider_account_id) return res.status(403).json({ error: 'Mirrored recipes are managed by their source provider and cannot be deleted here.', code: 403 });
    if (existing.created_by !== (req.authUserId || req.session.userId)) return res.status(403).json({ error: 'Not authorized.', code: 403 });

    const result = db.get().prepare('DELETE FROM recipes WHERE id = ?').run(id);
    if (result.changes === 0) return res.status(404).json({ error: 'Recipe not found', code: 404 });

    res.status(204).end();
  } catch (err) {
    log.error('DELETE /:id error:', err);
    res.status(500).json({ error: 'Internal error', code: 500 });
  }
});

/**
 * GET /api/v1/recipes/:id/provider-thumbnail
 * Proxied das Rezeptbild eines Recipe-Providers (Mealie, Tandoor, ...). Kein
 * direkter <img src> auf den Provider möglich: dessen Medien-Route verlangt
 * denselben Bearer-Token wie jeder andere Endpunkt, und der darf den Client nie
 * erreichen (siehe publicAccount() in routes/recipe-providers.js) - also holt
 * der Server die Bytes und reicht sie durch, wie der DMS-Vorschau-Proxy es für
 * Paperless/Papra tut.
 */
router.get('/:id/provider-thumbnail', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!id) return res.status(400).json({ error: 'Invalid recipe ID.', code: 400 });

    const recipe = db.get().prepare(
      'SELECT provider_account_id, provider_recipe_id, provider_slug, provider_has_image FROM recipes WHERE id = ?'
    ).get(id);
    if (!recipe?.provider_account_id || !recipe.provider_has_image) {
      return res.status(404).json({ error: 'No thumbnail available.', code: 404 });
    }

    const account = db.get().prepare('SELECT * FROM recipe_provider_accounts WHERE id = ?').get(recipe.provider_account_id);
    if (!account) return res.status(404).json({ error: 'No thumbnail available.', code: 404 });

    const thumb = await getAdapter(account).fetchThumbnail({ id: recipe.provider_recipe_id, slug: recipe.provider_slug });
    const mime = normalizeMime(thumb?.mime);
    if (!thumb?.buffer?.length || !THUMBNAIL_MIME.has(mime)) {
      return res.status(415).json({ error: 'Thumbnail not available.', code: 415 });
    }
    res.setHeader('Content-Type', mime);
    res.setHeader('Content-Length', String(thumb.buffer.length));
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'private, max-age=3600');
    res.setHeader('Content-Security-Policy', "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'");
    res.end(thumb.buffer);
  } catch (err) {
    if (err.status === 404) return res.status(404).json({ error: 'No thumbnail available.', code: 404 });
    log.error('GET /:id/provider-thumbnail error:', err);
    res.status(502).json({ error: 'Recipe provider thumbnail proxy failed.', code: 502 });
  }
});

// --------------------------------------------------------
// Integration: Rezeptzutaten → Einkaufsliste
// --------------------------------------------------------

/**
 * POST /api/v1/recipes/:id/to-shopping-list
 * Zutaten eines Rezepts auf eine Einkaufsliste übernehmen.
 * Body: { listId: number }
 * Response: { data: { transferred: number, skipped: number, added_ids: number[] } }
 *
 * Anders als bei Mahlzeiten wird hier NICHTS am Rezept markiert: ein Rezept ist
 * eine Vorlage, die beliebig oft gekocht wird - ein „schon übertragen"-Flag wie
 * meal_ingredients.on_shopping_list wäre nach dem ersten Einkauf für immer
 * gesetzt. Stattdessen überspringt der Import, was unter demselben Namen bereits
 * unabgehakt auf der Liste liegt; doppeltes Übernehmen fügt also nichts hinzu,
 * statt die Liste zu verdoppeln.
 *
 * `added_ids` trägt das Undo im Client, wie bei `/shopping/:listId/import-pantry`.
 * Ohne die IDs gäbe es nichts zurückzunehmen: die Anzahl kennt erst der Server
 * (er überspringt Duplikate), und dieser Pfad überträgt am meisten auf einmal -
 * eine ganze Zutatenliste in eine Liste, die der Nutzer gerade nicht ansieht
 * (Audit 2026-07-30, P1-B).
 */
router.post('/:id/to-shopping-list', (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!id) return res.status(400).json({ error: 'Invalid recipe ID.', code: 400 });

    const recipe = db.get().prepare('SELECT id FROM recipes WHERE id = ?').get(id);
    if (!recipe) return res.status(404).json({ error: 'Recipe not found.', code: 404 });

    const vList = num(req.body.listId, 'Listen-ID', { required: true });
    const errors = collectErrors([vList]);
    if (errors.length) return res.status(400).json({ error: errors.join(' '), code: 400 });

    const list = db.get().prepare('SELECT id FROM shopping_lists WHERE id = ?').get(vList.value);
    if (!list) return res.status(404).json({ error: 'Shopping list not found.', code: 404 });

    const ingredients = db.get().prepare(
      'SELECT name, quantity, category FROM recipe_ingredients WHERE recipe_id = ? ORDER BY id ASC',
    ).all(id);
    if (!ingredients.length) return res.json({ data: { transferred: 0, skipped: 0, added_ids: [] } });

    const result = db.transaction(() => {
      const existing = db.get().prepare(
        'SELECT name FROM shopping_items WHERE list_id = ? AND is_checked = 0',
      ).all(vList.value);
      const present = new Set(existing.map((i) => i.name.trim().toLowerCase()));

      const insertItem = db.get().prepare(`
        INSERT INTO shopping_items (list_id, name, quantity, category)
        VALUES (?, ?, ?, ?)
      `);

      const addedIds = [];
      let skipped = 0;
      for (const ing of ingredients) {
        const key = ing.name.trim().toLowerCase();
        if (present.has(key)) { skipped += 1; continue; }
        const info = insertItem.run(vList.value, ing.name, ing.quantity, ing.category || 'Sonstiges');
        present.add(key);
        addedIds.push(Number(info.lastInsertRowid));
      }
      return { transferred: addedIds.length, skipped, added_ids: addedIds };
    });

    res.json({ data: result });
  } catch (err) {
    log.error('POST /:id/to-shopping-list error:', err);
    res.status(500).json({ error: 'Internal error', code: 500 });
  }
});

export default router;
