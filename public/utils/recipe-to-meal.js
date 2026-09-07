/**
 * Rezept -> Mahlzeit: der gemeinsame Payload.
 *
 * Lag als lokale Funktion in `meals.js`, wo drei Wege sie nutzen (Drag&Drop auf
 * einen Slot, der Zufallsplan und der Test-Export). Seit der Rezepte-Tab selbst
 * einplant - „Für wann?" direkt auf der Karte, statt auf `/meals?recipe=<id>` zu
 * navigieren (Critique 2026-07-29) - braucht sie ein zweiter Konsument. Ein
 * geteiltes Util statt eines Cross-Page-Imports: Seiten sind lazy geladene
 * Route-Module, `recipes.js` würde sonst das komplette Mahlzeiten-Modul
 * mitziehen.
 */

import { DEFAULT_CATEGORY_NAME } from '/utils/shopping-categories.js';

/**
 * Baut den POST-Body für `/meals` aus einem Rezept.
 *
 * @param {object} recipe   Rezept mit `title`, `notes`, `recipe_url`, `ingredients`, optional `yield_portions`
 * @param {string} date     Lokaler Datums-Key (YYYY-MM-DD), siehe utils/date.js
 * @param {string} mealType 'breakfast' | 'lunch' | 'dinner' | 'snack'
 */
export function mealPayloadFromRecipe(recipe, date, mealType) {
  return {
    date,
    meal_type: mealType,
    title: recipe.title,
    notes: recipe.notes || null,
    recipe_url: recipe.recipe_url || null,
    recipe_id: recipe.id,
    // An explicit yield makes the recipe's listed ingredients a batch. Let the
    // server materialize it for this Meal's cook target instead of copying the
    // full batch and accidentally treating it as one portion. Unspecified
    // yields keep the existing ingredient-snapshot handoff unchanged.
    ...(Number(recipe.yield_portions) > 0 ? {
      portions_mode: 'auto',
      ingredients_manual_override: false,
    } : {
      ingredients: (recipe.ingredients || []).map((ingredient) => ({
        name: ingredient.name,
        quantity: ingredient.quantity || null,
        category: ingredient.category || DEFAULT_CATEGORY_NAME,
      })),
    }),
  };
}
