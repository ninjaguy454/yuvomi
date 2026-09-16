// Isolated visual fixture: synthetic data only, no database or production APIs.
import express from 'express';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const app = express();
app.use(express.json());
const members = [{ id: 1, display_name: 'Parent', role: 'admin' }, { id: 2, display_name: 'Alex', role: 'member' }];
const permissions = Object.fromEntries(['edit','complete','change_dates','change_points','change_priority','change_assignment','change_category_tags','change_required_skills','delete_archive','comment'].map(key => [key, true]));
let task = { id: 1, revision: 1, title: 'Get Ready for the Day', description: 'Morning routine', status: 'in_progress', points: 2,
  start_date: '2026-09-14', start_time: '07:00', due_date: '2026-09-14', due_time: '08:00', expiration_policy: 'expire_incomplete',
  priority: 'none', category: 'misc', assigned_to: 2, assigned_users: [members[1]], permissions, is_recurring: 1, recurrence_rule: 'FREQ=DAILY',
  documents: [], subtasks: [{ id: 2, revision: 1, parent_revision: 1, title: 'Brush teeth', status: 'done', points: 0, permissions }, { id: 3, revision: 1, parent_revision: 1, title: 'Pack bag', status: 'open', points: 0, permissions }] };
let successor = null;
const clients = new Set();
const announce = () => clients.forEach(res => res.write(`event: change\ndata: ${JSON.stringify({ version: task.revision })}\n\n`));
const template = { id: 10, name: task.title, title_template: task.title, points: 2, expiration_policy: 'expire_incomplete', subject_required: false, assignment_strategy: 'open_claimable', checklist: [{ title_template: 'Brush teeth' }, { title_template: 'Pack bag' }], tags: [] };
app.use('/api/v1', (req, res) => {
  if (req.path === '/tasks/changes') { res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' }); res.flushHeaders(); clients.add(res); req.on('close', () => clients.delete(res)); return; }
  if (req.path === '/auth/me') return res.json({ user: members[0], permissions: { admin: true }, csrfToken: 'fixture' });
  if (req.path === '/fixture/expire' && req.method === 'POST') {
    task = { ...task, revision: task.revision + 1, status: 'expired', expired_at: '2026-09-14T12:00:00Z', permissions: { ...permissions, complete: false }, subtasks: task.subtasks.map(child => ({ ...child, status: child.status === 'done' ? 'done' : 'expired', permissions: { ...permissions, complete: false } })) };
    successor = { ...task, id: 4, revision: 1, status: 'open', expired_at: null, start_date: '2026-09-15', due_date: '2026-09-15', permissions, subtasks: task.subtasks.map(child => ({ ...child, id: child.id + 3, status: 'open', permissions })) };
    announce(); return res.json({ data: task });
  }
  if (req.path === '/tasks/1/reopen' && req.method === 'POST') { task = { ...task, ...req.body, status: 'in_progress', expired_at: null, revision: task.revision + 1, permissions, subtasks: task.subtasks.map(child => ({ ...child, status: child.status === 'expired' ? 'open' : child.status, permissions })) }; announce(); return res.json({ data: task }); }
  if (req.path === '/tasks/1/archive' && req.method === 'PATCH') { task.archived_at = req.body.archived ? new Date().toISOString() : null; task.revision++; announce(); return res.json({ data: task }); }
  if (req.path === '/tasks/meta/options') return res.json({ users: members, categories: [{ key: 'misc', name: 'General' }], tags: [], default_points: 0 });
  if (req.path === '/automation/activity-options') return res.json({ data: { activities: [template], skills: [] } });
  if (req.path === '/automation/admin/activity-templates') return res.json({ data: [template], members, skills: [], categories: [], variables: [], places: [] });
  if (req.path === '/planning/place-search/status') return res.json({ data: { configured: false } });
  if (req.path === '/preferences') return res.json({ data: {} });
  if (req.path === '/tasks/1/activity') return res.json({ data: task.status === 'expired' ? [{ id: 1, event_type: 'expired', action_task_id: 1, created_at: task.expired_at }] : [] });
  if (req.path.endsWith('/completions')) return res.json({ data: task.status === 'expired' ? [{ id: 1, task_id: 1, event_type: 'expired', expired_at: task.expired_at, occurred_at: task.expired_at, completed_at: null, title: task.title, user_id: null, user_name: null, user_avatar: null }] : [] });
  if (/^\/tasks\/\d+$/.test(req.path)) return res.json({ data: req.path === '/tasks/4' ? successor : task });
  if (req.path === '/tasks') {
    const statuses = [req.query.status].flat().filter(Boolean);
    return res.json({ data: [task, successor].filter(Boolean).filter(row => (!statuses.length || statuses.includes(row.status)) && (!row.archived_at || req.query.archived)) });
  }
  return res.json({ data: [] });
});
app.use(express.static(fileURLToPath(new URL('../../public', import.meta.url))));
const css = [...readFileSync(new URL('../../public/index.html', import.meta.url), 'utf8').matchAll(/<link rel="stylesheet" href="[^"]+"\s*\/>/g)].map(([tag]) => tag).join('');
app.get('/expiration-test', (_req, res) => res.send(`<!doctype html><html lang="en" data-theme="light" data-color-theme="warm"><head><title>Task expiration isolated fixture</title><meta name="viewport" content="width=device-width,initial-scale=1">${css}<link rel="stylesheet" href="/styles/tasks.css"><script src="/lucide.min.js" defer></script></head><body><p>Isolated synthetic Task expiration fixture</p><button id="expire">Simulate deadline reached</button><button id="open">Open Monday occurrence</button><button id="template">Open expiration template</button><p id="feedback" role="status"></p><main id="fixture"></main><script type="module">
window.yuvomi = { showToast: text => document.querySelector('#feedback').textContent = text };
const { initI18n, setLocale } = await import('/i18n.js'); await initI18n(); await setLocale('en');
await import('/components/datepicker.js');
const { setPermissions } = await import('/permissions.js'); setPermissions({ admin: true });
const { render } = await import('/pages/tasks.js'); await render(document.querySelector('#fixture'), { user: { id: 1, role: 'admin' } });
document.querySelector('#expire').onclick = () => fetch('/api/v1/fixture/expire', {method:'POST'});
document.querySelector('#open').onclick = async () => { const {openTaskDetail} = await import('/components/task-detail.js'); const task = (await (await fetch('/api/v1/tasks/1')).json()).data; openTaskDetail({task, currentUserId: 1, isAdmin: true}); };
document.querySelector('#template').onclick = async () => { const {openActivityTemplateEditor} = await import('/components/activity-automation.js'); await openActivityTemplateEditor({draft: ${JSON.stringify(template)}, asChild: false}); };
</script></body></html>`));
const server = app.listen(0, '127.0.0.1', () => console.log(`Task expiration fixture http://127.0.0.1:${server.address().port}/expiration-test`));
