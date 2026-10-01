function addDays(dateStr, days) {
  const d = new Date(dateStr + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function mealWeekday(dateStr) {
  const day = new Date(dateStr + 'T00:00:00Z').getUTCDay();
  return (day + 6) % 7;
}

function datesForTemplateInRange(template, from, to) {
  const start = template.start_date > from ? template.start_date : from;
  // end_date ist die letzte erlaubte Wiederholung (einschließlich); NULL heißt
  // unbegrenzt. Ohne diese Grenze materialisierte jede aufgeschlagene Woche eine
  // weitere Instanz, ohne dass die Serie je hätte enden können (#619).
  const end = template.end_date && template.end_date < to ? template.end_date : to;
  const dates = [];
  for (let cursor = start; cursor <= end; cursor = addDays(cursor, 1)) {
    if (mealWeekday(cursor) === template.weekday) dates.push(cursor);
  }
  return dates;
}

export { addDays, mealWeekday, datesForTemplateInRange };

/** Canonical legacy recurrence writer shared by compatibility routes and explicit cycle ensure. */
export function materializeRecurringMealOccurrences(database,{from,to,mealTypes=null}={}) {
  const templates = database.prepare(`
    SELECT *
    FROM meal_recurrence_templates
    WHERE start_date <= ?
      AND (end_date IS NULL OR end_date >= ?)
    ORDER BY id ASC
  `).all(to, from);

  if (!templates.length) return;

  const createMeals = database.transaction(() => {
    const hasException = database.prepare(`
      SELECT 1
      FROM meal_recurrence_exceptions
      WHERE template_id = ? AND date = ?
    `);
    const hasMeal = database.prepare(`
      SELECT 1
      FROM meals
      WHERE recurrence_template_id = ? AND date = ?
    `);
    const templateIngredients = database.prepare(`
      SELECT name, quantity, category
      FROM meal_recurrence_ingredients
      WHERE template_id = ?
      ORDER BY id ASC
    `);
    const insertMeal = database.prepare(`
      INSERT INTO meals (
        date, meal_type, custom_label, title, notes, recipe_url, recipe_id, recurrence_template_id,
        created_by, source, source_key, provenance_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'recurrence', ?, ?)
    `);

    for (const template of templates) {
      if (!Number.isInteger(template.weekday) || template.weekday<0 || template.weekday>6 || (mealTypes&&!mealTypes.includes(template.meal_type))) continue;
      const ingredients = templateIngredients.all(template.id);
      for (const date of datesForTemplateInRange(template, from, to)) {
        if (hasException.get(template.id, date) || hasMeal.get(template.id, date)) continue;
        const result = insertMeal.run(
          date,
          template.meal_type,
          template.meal_type === 'custom' ? template.custom_label : null,
          template.title,
          template.notes,
          template.recipe_url,
          template.recipe_id,
          template.id,
          template.created_by,
          `legacy-recurrence:${template.id}:${date}`,
          JSON.stringify({ source: 'recurrence', template_id: template.id }),
        );
        for(const ingredient of ingredients)database.prepare('INSERT INTO meal_ingredients(meal_id,name,quantity,category) VALUES(?,?,?,?)').run(result.lastInsertRowid,ingredient.name,ingredient.quantity,ingredient.category||'Sonstiges');
      }
    }
  });

  createMeals();
}
