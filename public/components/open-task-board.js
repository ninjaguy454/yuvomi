import { api } from '/api.js';
import { t } from '/i18n.js';
import { esc } from '/utils/html.js';
import { moduleAccess } from '/permissions.js';
import { authenticationSnapshot, sameAuthentication } from '/utils/device-context.js';
import { watchTaskChanges, latestTaskLoader, createTaskStartRefresh } from '/utils/task-live.js';
import { openTaskDetail } from '/components/task-detail.js';

/** A task projection beside Notes, with independent permission and lifecycle. */
export function mountOpenTaskBoard(container, { user } = {}) {
  const authentication = authenticationSnapshot();
  let active = true, tasks = [], stopLive = null;
  const valid = () => active && container.isConnected && sameAuthentication(authentication);
  const allowed = () => moduleAccess('tasks') !== 'none';
  function render(error = '') {
    if (!valid()) return;
    container.replaceChildren(); container.hidden = !allowed();
    if (!allowed()) return;
    container.insertAdjacentHTML('beforeend', `<section class="open-task-board" aria-label="${esc(t('tasks.bountyTasks'))}"><div class="open-task-board__header"><h2>${esc(t('tasks.bountyTasks'))}</h2><a href="/tasks?offers=1&view=list">${esc(t('tasks.openTasksAll'))}</a></div><p class="open-task-board__description text-muted">${esc(t('tasks.bountyTasksDescription'))}</p><div class="open-task-board__list">${error ? `<p role="alert">${esc(error)}</p>` : tasks.length ? tasks.map(task => `<button type="button" class="open-task-board__card" data-open-task="${Number(task.id)}"><strong>${esc(task.title)}</strong>${task.points ? `<span class="text-muted">${esc(t('tasks.pointsSummary', { count: task.points }))}</span>` : ''}</button>`).join('') : `<p>${esc(t('tasks.openTasksEmpty'))}</p>`}</div></section>`);
    container.querySelectorAll('[data-open-task]').forEach(button => {
      button.onclick = async () => {
        button.disabled = true;
        try {
          const response = await api.get(`/tasks/${Number(button.dataset.openTask)}`, { requireFresh: true });
          if (!valid() || !allowed()) return;
          openTaskDetail({ task: response.data, currentUserId: user?.id ?? null, isAdmin: user?.role === 'admin', onChanged: refresh });
        } catch (error) { if (valid()) window.yuvomi?.showToast(error.data?.error || error.message, 'danger'); }
        finally { if (button.isConnected) button.disabled = false; }
      };
    });
  }
  const loader = latestTaskLoader(async () => allowed() ? api.get('/tasks?offers=1', { requireFresh: true }) : { data: [] }, response => {
    if (!valid()) return;
    tasks = allowed() ? response.data || [] : []; render(); starts.update(response.visibility);
  });
  async function refresh() {
    if (!valid()) return;
    try { await loader.load(); }
    catch (error) { if (valid()) { tasks = []; render(error.data?.error || error.message); } }
  }
  const starts = createTaskStartRefresh(refresh);
  function stop() {
    if (!active) return;
    active = false; loader.dispose(); starts.dispose(); stopLive?.(); tasks = []; container.replaceChildren();
    for (const name of ['auth:context-ending', 'auth:expired', 'auth:context-rejected']) window.removeEventListener(name, stop);
  }
  for (const name of ['auth:context-ending', 'auth:expired', 'auth:context-rejected']) window.addEventListener(name, stop);
  if (allowed()) { stopLive = watchTaskChanges(refresh); void refresh(); }
  else container.hidden = true;
  return stop;
}
