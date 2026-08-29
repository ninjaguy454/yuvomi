import express from 'express';
import rateLimit from 'express-rate-limit';
import * as db from '../db.js';
import { generateToken } from '../middleware/csrf.js';
import { isPasswordLoginEnabled, setupAuthSession } from '../auth.js';
import { verifyPassword } from '../utils/password.js';
import * as twoFactor from '../services/two-factor.js';
import { expandRecurringEvents, loadEventExceptions } from '../services/calendar-events.js';
import { todayKey } from '../utils/timezone.js';
import { visibilityWhere } from '../services/visibility.js';

const router = express.Router();
const limiter = rateLimit({ windowMs: 10 * 60_000, max: 10, standardHeaders: true, legacyHeaders: false });
const DUMMY_HASH = '$2b$12$invalidhashfortimingprotection000000000000000000000';

// Reader login remains session-only, but handlers consume the same canonical
// authenticated-user slot as the rest of Yuvomi.
router.use((req, _res, next) => {
  req.authUserId = Number(req.session?.['userId']) || null;
  next();
});

function h(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
}

function page(title, body, { signedIn = false, csrf = '' } = {}) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${h(title)} - Yuvomi Reader</title><link rel="stylesheet" href="/reader.css"></head><body><div class="page"><header><a class="brand" href="/reader">Yuvomi Reader</a>${signedIn ? `<form class="logout" method="post" action="/reader/logout"><input type="hidden" name="csrf" value="${h(csrf)}"><button type="submit">Sign out</button></form>` : ''}</header>${signedIn ? '<nav><a href="/reader?view=today">Today</a> <a href="/reader?view=tasks">Tasks</a> <a href="/reader?view=add-task">Add Task</a> <a href="/reader?view=calendar">Calendar</a> <a href="/reader?view=meals">Meals</a> <a href="/reader?view=recipes">Recipes</a> <a href="/">Full app</a></nav>' : ''}<main>${body}</main><footer>Lightweight mode for e-readers and older browsers.</footer></div></body></html>`;
}

function loginPage(message = '') {
  return page('Sign in', `<h1>Sign in</h1>${message ? `<p class="notice">${h(message)}</p>` : ''}<form method="post" action="/reader/login"><label>Username<input name="username" maxlength="64" required></label><label>Password<input name="password" type="password" maxlength="1024" required></label><button type="submit">Sign in</button></form><p>This reader-friendly view does not require JavaScript.</p>`);
}

function secondFactorPage(message = '') {
  return page('Verification', `<h1>Verification code</h1>${message ? `<p class="notice">${h(message)}</p>` : ''}<form method="post" action="/reader/two-factor"><label>Authenticator or recovery code<input name="code" inputmode="numeric" autocomplete="one-time-code" required></label><button type="submit">Verify</button></form>`);
}

function csrf(req) {
  req.session.csrfToken ||= generateToken();
  return req.session.csrfToken;
}

function csrfValid(req) {
  const sent = String(req.body.csrf || '');
  const expected = String(req.session?.csrfToken || '');
  return sent.length === 64 && sent === expected;
}

function dateTime(value) {
  if (!value) return '';
  return String(value).replace('T', ' ').replace(/:00(?:Z)?$/, '');
}

function tasksFor(database, userId) {
  return database.prepare(`
    SELECT t.*, p.name AS place_name, tl.user_label AS location_label, tl.manual_address,
           COALESCE(p.external_place_id, tl.external_place_id) AS google_place_id
      FROM tasks t LEFT JOIN task_locations tl ON tl.task_id = t.id LEFT JOIN places p ON p.id = tl.place_id
     WHERE t.parent_task_id IS NULL AND t.archived_at IS NULL AND t.status != 'done'
       AND ${visibilityWhere('t', 'task_assignments', 'task_id')}
     ORDER BY CASE WHEN t.due_date IS NULL THEN 1 ELSE 0 END, t.due_date, t.due_time, t.priority, t.id
     LIMIT 100
  `).all(userId, userId);
}

function calendarFor(database, userId, startDate, endDate = startDate) {
  const rows = database.prepare(`
    SELECT e.* FROM calendar_events e
     WHERE ((e.recurrence_rule IS NULL AND date(e.start_datetime) <= ? AND date(COALESCE(e.end_datetime,e.start_datetime)) >= ?)
       OR (e.recurrence_rule IS NOT NULL AND date(e.start_datetime) <= ?))
       AND ${visibilityWhere('e', 'event_assignments', 'event_id')}
  `).all(endDate, startDate, endDate, userId, userId);
  const recurring = rows.filter((row) => row.recurrence_rule).map((row) => row.id);
  return expandRecurringEvents(rows, startDate, endDate, loadEventExceptions(database, recurring));
}

function mealsFor(database, date) {
  return database.prepare(`SELECT m.*, p.name AS place_name FROM meals m LEFT JOIN places p ON p.id = m.place_id WHERE m.date = ? AND m.superseded_by_id IS NULL ORDER BY CASE m.meal_type WHEN 'breakfast' THEN 0 WHEN 'lunch' THEN 1 WHEN 'dinner' THEN 2 ELSE 3 END, COALESCE(m.scheduled_time,m.preferred_time),m.id`).all(date);
}

function mapsUrl(row) {
  const params = new URLSearchParams({ api: '1' });
  const label = row.place_name || row.location_label || row.manual_address;
  if (row.google_place_id) { params.set('query', label || 'Google Maps place'); params.set('query_place_id', row.google_place_id); }
  else if (label) params.set('query', label);
  else return null;
  return `https://www.google.com/maps/search/?${params.toString()}`;
}

function taskList(rows) {
  if (!rows.length) return '<p>No open Tasks.</p>';
  return `<p><a class="action" href="/reader?view=add-task">Add a Task</a></p><ul class="items">${rows.map((task) => { const map = mapsUrl(task); return `<li><strong>${h(task.title)}</strong>${task.due_date ? `<br><span>Due ${h(task.due_date)}${task.due_time ? ` ${h(task.due_time)}` : ''}</span>` : ''}${task.description ? `<p>${h(task.description)}</p>` : ''}${task.place_name || task.location_label || task.manual_address ? `<p>Location: ${h(task.place_name || task.location_label || task.manual_address)}${map ? ` - <a href="${h(map)}">Map</a>` : ''}</p>` : ''}</li>`; }).join('')}</ul>`;
}

function eventList(rows, date) {
  if (!rows.length) return '<p>No Calendar events today.</p>';
  return `<ul class="items">${rows.map((event) => `<li><a href="/reader?view=event&amp;id=${event.id}&amp;date=${h(date)}"><strong>${h(event.title)}</strong></a><br><span>${event.all_day ? 'All day' : h(dateTime(event.start_datetime))}</span></li>`).join('')}</ul>`;
}

function mealList(rows) {
  if (!rows.length) return '<p>No Meals planned today.</p>';
  return `<ul class="items">${rows.map((meal) => `<li><strong>${h(meal.meal_type)}: ${h(meal.title)}</strong>${meal.scheduled_time || meal.preferred_time ? `<br><span>${h(meal.scheduled_time || meal.preferred_time)}</span>` : ''}${meal.place_name ? `<p>At ${h(meal.place_name)}</p>` : ''}${meal.notes ? `<p>${h(meal.notes)}</p>` : ''}</li>`).join('')}</ul>`;
}

function isoDate(value, fallback) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(value || '')) && !Number.isNaN(new Date(`${value}T12:00:00Z`).getTime())
    ? String(value) : fallback;
}

function monthCalendar(database, userId, selectedDate) {
  const year = Number(selectedDate.slice(0, 4)); const monthIndex = Number(selectedDate.slice(5, 7)) - 1;
  const first = new Date(Date.UTC(year, monthIndex, 1)); const last = new Date(Date.UTC(year, monthIndex + 1, 0));
  const start = first.toISOString().slice(0, 10); const end = last.toISOString().slice(0, 10);
  const grouped = new Map();
  calendarFor(database, userId, start, end).forEach((event) => {
    const key = String(event.start_datetime).slice(0, 10);
    if (!grouped.has(key)) grouped.set(key, []); grouped.get(key).push(event);
  });
  const previous = new Date(Date.UTC(year, monthIndex - 1, 1)).toISOString().slice(0, 10);
  const next = new Date(Date.UTC(year, monthIndex + 1, 1)).toISOString().slice(0, 10);
  const cells = Array(first.getUTCDay()).fill('<td class="empty">&nbsp;</td>');
  for (let day = 1; day <= last.getUTCDate(); day += 1) {
    const key = `${year}-${String(monthIndex + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    const events = grouped.get(key) || [];
    cells.push(`<td${key === selectedDate ? ' class="selected"' : ''}><a href="/reader?view=calendar&amp;date=${key}">${day}</a>${events.slice(0, 2).map((event) => `<small>${h(event.title)}</small>`).join('')}${events.length > 2 ? `<small>+${events.length - 2} more</small>` : ''}</td>`);
  }
  while (cells.length % 7) cells.push('<td class="empty">&nbsp;</td>');
  const rows = []; for (let index = 0; index < cells.length; index += 7) rows.push(`<tr>${cells.slice(index, index + 7).join('')}</tr>`);
  return `<div class="calendar-nav"><a href="/reader?view=calendar&amp;date=${previous}">&larr; Previous month</a><strong>${first.toLocaleString('en', { month: 'long', year: 'numeric', timeZone: 'UTC' })}</strong><a href="/reader?view=calendar&amp;date=${next}">Next month &rarr;</a></div><table class="calendar-grid"><thead><tr>${['Sun','Mon','Tue','Wed','Thu','Fri','Sat'].map((day) => `<th>${day}</th>`).join('')}</tr></thead><tbody>${rows.join('')}</tbody></table><h2>${h(selectedDate)}</h2>${eventList(grouped.get(selectedDate) || [], selectedDate)}`;
}

function recipeList(database) {
  const rows = database.prepare('SELECT id, title FROM recipes ORDER BY title COLLATE NOCASE, id DESC').all();
  if (!rows.length) return '<p>No recipes saved yet.</p>';
  return `<ul class="items">${rows.map((recipe) => `<li><a href="/reader?view=recipe&amp;id=${recipe.id}"><strong>${h(recipe.title)}</strong></a></li>`).join('')}</ul>`;
}

function recipeDetail(database, id) {
  const recipe = database.prepare('SELECT * FROM recipes WHERE id = ?').get(id);
  if (!recipe) return '<p>Recipe not found.</p><p><a href="/reader?view=recipes">Back to Recipes</a></p>';
  const ingredients = database.prepare('SELECT * FROM recipe_ingredients WHERE recipe_id = ? ORDER BY id').all(id);
  return `<p><a href="/reader?view=recipes">&larr; Back to Recipes</a></p><h1>${h(recipe.title)}</h1>${recipe.recipe_url ? `<p><a href="${h(recipe.recipe_url)}">Open original recipe</a></p>` : ''}<h2>Ingredients</h2>${ingredients.length ? `<ul>${ingredients.map((item) => `<li>${item.quantity ? `${h(item.quantity)} ` : ''}${h(item.name)}</li>`).join('')}</ul>` : '<p>No ingredients listed.</p>'}${recipe.notes ? `<h2>Instructions / notes</h2><div class="prewrap">${h(recipe.notes)}</div>` : ''}`;
}

function taskForm(token, message = '', values = {}) {
  return `<h1>Add a Task</h1>${message ? `<p class="notice">${h(message)}</p>` : ''}<form method="post" action="/reader/tasks"><input type="hidden" name="csrf" value="${h(token)}"><label>Task title<input name="title" maxlength="200" required value="${h(values.title || '')}"></label><label>Description<textarea name="description" rows="4" maxlength="10000">${h(values.description || '')}</textarea></label><label>Due date<input name="due_date" placeholder="YYYY-MM-DD" value="${h(values.due_date || '')}"></label><label>Due time<input name="due_time" placeholder="HH:MM" value="${h(values.due_time || '')}"></label><label>Priority<select name="priority"><option value="none">None</option><option value="low">Low</option><option value="medium">Medium</option><option value="high">High</option></select></label><label class="check"><input type="checkbox" name="assign_to_me" checked> Assign to me</label><button type="submit">Create Task</button></form>`;
}

router.get('/', (req, res) => {
  if (!req.authUserId) return res.type('html').send(loginPage(req.query.error || ''));
  const database = db.get(); const today = todayKey(database); const date = isoDate(req.query.date, today); const view = String(req.query.view || 'today');
  const sections = [];
  if (view === 'today' || view === 'tasks') sections.push(`<section><h1>Open Tasks</h1>${taskList(tasksFor(database, req.authUserId))}</section>`);
  if (view === 'today') sections.push(`<section><h1>Calendar - ${h(date)}</h1>${eventList(calendarFor(database, req.authUserId, date), date)}<p><a href="/reader?view=calendar&amp;date=${h(date)}">Open Calendar</a></p></section>`);
  if (view === 'calendar') sections.push(`<section><h1>Calendar</h1>${monthCalendar(database, req.authUserId, date)}</section>`);
  if (view === 'today' || view === 'meals') sections.push(`<section><h1>Meals - ${h(date)}</h1>${mealList(mealsFor(database, date))}</section>`);
  if (view === 'event') {
    const event = calendarFor(database, req.authUserId, date).find((row) => Number(row.id) === Number(req.query.id));
    sections.push(event ? `<p><a href="/reader?view=calendar&amp;date=${h(date)}">&larr; Back to Calendar</a></p><h1>${h(event.title)}</h1><p>${event.all_day ? 'All day' : `${h(dateTime(event.start_datetime))}${event.end_datetime ? ` to ${h(dateTime(event.end_datetime))}` : ''}`}</p>${event.location ? `<p><strong>Location:</strong> ${h(event.location)}</p>` : ''}${event.description ? `<h2>Details</h2><div class="prewrap">${h(event.description)}</div>` : ''}` : '<p>Event not found for this date.</p>');
  }
  if (view === 'add-task') sections.push(taskForm(csrf(req), req.query.created ? 'Task created.' : ''));
  if (view === 'recipes') sections.push(`<section><h1>Recipes</h1>${recipeList(database)}</section>`);
  if (view === 'recipe') sections.push(recipeDetail(database, Number(req.query.id)));
  res.setHeader('Cache-Control', 'private, no-store');
  res.type('html').send(page(view === 'today' ? 'Today' : view, sections.join(''), { signedIn: true, csrf: csrf(req) }));
});

router.post('/tasks', (req, res) => {
  if (!req.authUserId || !csrfValid(req)) return res.status(403).type('text').send('Invalid request.');
  const title = String(req.body.title || '').trim(); const description = String(req.body.description || '').trim() || null;
  const dueDate = String(req.body.due_date || '').trim() || null; const dueTime = String(req.body.due_time || '').trim() || null;
  const priorities = new Set(['none', 'low', 'medium', 'high']); const priority = priorities.has(req.body.priority) ? req.body.priority : 'none';
  if (!title || title.length > 200 || description?.length > 10000 || (dueDate && !/^\d{4}-\d{2}-\d{2}$/.test(dueDate)) || (dueTime && !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(dueTime))) {
    return res.status(400).type('html').send(page('Add Task', taskForm(csrf(req), 'Check the title, date, and time.', req.body), { signedIn: true, csrf: csrf(req) }));
  }
  const assignee = req.body.assign_to_me ? req.authUserId : null;
  db.get().transaction(() => {
    const result = db.get().prepare(`INSERT INTO tasks (title, description, category, priority, due_date, due_time, assigned_to, created_by, visibility) VALUES (?, ?, 'misc', ?, ?, ?, ?, ?, 'all')`).run(title, description, priority, dueDate, dueTime, assignee, req.authUserId);
    if (assignee) db.get().prepare('INSERT INTO task_assignments (task_id, user_id) VALUES (?, ?)').run(result.lastInsertRowid, assignee);
  })();
  return res.redirect(303, '/reader?view=add-task&created=1');
});

router.post('/login', limiter, async (req, res) => {
  const username = String(req.body.username || '').trim(); const password = String(req.body.password || '');
  if (!username || !password || username.length > 64 || password.length > 1024) return res.status(400).type('html').send(loginPage('Enter a valid username and password.'));
  const database = db.get(); const user = database.prepare('SELECT * FROM users WHERE username = ?').get(username);
  const checked = await verifyPassword(password, user?.password_hash || DUMMY_HASH);
  if (!user || !checked.valid) return res.status(401).type('html').send(loginPage('Invalid credentials.'));
  if (!isPasswordLoginEnabled(database)) return res.status(403).type('html').send(loginPage('Password login is disabled. Reader mode needs password login because this browser cannot complete modern SSO.'));
  if (database.prepare('SELECT 1 FROM housekeeping_workers WHERE user_id = ?').get(user.id)) return res.status(403).type('html').send(loginPage('This account cannot sign in.'));
  if (twoFactor.isEnabled(database, user.id)) {
    req.session.readerPendingUserId = user.id; req.session.readerPendingUntil = Date.now() + 5 * 60_000;
    return res.redirect(303, '/reader/two-factor');
  }
  await setupAuthSession(req, res, user); return res.redirect(303, '/reader');
});

router.get('/two-factor', (req, res) => {
  if (!req.session?.readerPendingUserId || Number(req.session.readerPendingUntil) < Date.now()) return res.redirect(303, '/reader?error=Verification+expired');
  res.type('html').send(secondFactorPage());
});

router.post('/two-factor', limiter, async (req, res) => {
  const userId = Number(req.session?.readerPendingUserId);
  if (!userId || Number(req.session.readerPendingUntil) < Date.now()) return res.redirect(303, '/reader?error=Verification+expired');
  const result = twoFactor.verifySecondFactor(db.get(), userId, String(req.body.code || ''));
  if (!result.valid) return res.status(401).type('html').send(secondFactorPage('Invalid or already-used code.'));
  const user = db.get().prepare('SELECT * FROM users WHERE id = ?').get(userId);
  delete req.session.readerPendingUserId; delete req.session.readerPendingUntil;
  await setupAuthSession(req, res, user); return res.redirect(303, '/reader');
});

router.post('/logout', (req, res) => {
  if (!req.session?.userId || !csrfValid(req)) return res.status(403).type('text').send('Invalid request.');
  req.session.destroy(() => res.redirect(303, '/reader'));
});

export default router;
