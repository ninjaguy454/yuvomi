import { api } from '/api.js';
import { t } from '/i18n.js';
import { esc } from '/utils/html.js';
import { moduleAccess } from '/permissions.js';
import { authenticationSnapshot, sameAuthentication } from '/utils/device-context.js';
import { watchTaskChanges, latestTaskLoader, createTaskStartRefresh } from '/utils/task-live.js';
import { renderTaskCountdown, bindTaskCountdowns } from '/utils/task-countdown.js';
import { taskCompletionPoints } from '/utils/task-fields.js';

/** A task projection beside Notes, with independent permission and lifecycle. */
export function mountOpenTaskBoard(container, { user } = {}) {
  const authentication = authenticationSnapshot();
  let active = true, tasks = [], stopLive = null, renderedProjection = null;
  const valid = () => active && container.isConnected && sameAuthentication(authentication);
  const allowed = () => moduleAccess('tasks') !== 'none';
  // Notes needs only the offer cards until an inspection is requested. Keep
  // the Tasks/Settings stylesheet graph out of the board's startup path.
  let inspectionStyle = null;
  function loadInspectionStyle() {
    if (inspectionStyle) return inspectionStyle.ready;
    const link = document.createElement('link');
    link.rel = 'stylesheet'; link.href = '/styles/tasks.css';
    const entry = { link };
    entry.ready = new Promise((resolve, reject) => {
      entry.cancel = resolve;
      link.onload = () => { link.onload = link.onerror = null; resolve(); };
      link.onerror = () => {
        link.onload = link.onerror = null; link.remove();
        if (inspectionStyle === entry) inspectionStyle = null;
        reject(new Error(t('common.loadErrorDescription')));
      };
    });
    inspectionStyle = entry; document.head.appendChild(link);
    return entry.ready;
  }
  function render(error = '') {
    if (!valid()) return;
    // Routine revalidation must retain focused and pending offer controls.
    // Compare the complete projection, including authority, so changed or
    // removed offers still detach their controls and cancel stale inspections.
    const projection = JSON.stringify([moduleAccess('tasks'), error, tasks]);
    if (projection === renderedProjection) return;
    renderedProjection = projection;
    container.replaceChildren(); container.hidden = !allowed();
    if (!allowed()) return;
    container.insertAdjacentHTML('beforeend', `<section class="open-task-board" aria-label="${esc(t('tasks.bountyTasks'))}"><div class="open-task-board__header"><h2>${esc(t('tasks.bountyTasks'))}</h2><a href="/tasks?offers=1&view=list">${esc(t('tasks.openTasksAll'))}</a></div><p class="open-task-board__description text-muted">${esc(t('tasks.bountyTasksDescription'))}</p><div class="open-task-board__list">${error ? `<p role="alert">${esc(error)}</p>` : tasks.length ? tasks.map(task => `<button type="button" class="open-task-board__card" data-open-task="${Number(task.id)}"><strong>${esc(task.title)}</strong><span class="open-task-board__meta"><span class="text-muted">${esc(t('tasks.pointsSummary', { count: taskCompletionPoints(task) }))}</span>${renderTaskCountdown(task, { className: 'text-muted' })}</span></button>`).join('') : `<p>${esc(t('tasks.openTasksEmpty'))}</p>`}</div></section>`);
    container.querySelectorAll('[data-open-task]').forEach(button => {
      button.onclick = async () => {
        button.disabled = true;
        try {
          const [response, { openTaskDetail }] = await Promise.all([
            api.get(`/tasks/${Number(button.dataset.openTask)}`, { requireFresh: true }),
            import('/components/task-detail.js'),
            loadInspectionStyle(),
          ]);
          // A newer board projection can remove this offer while its module
          // loads. Never reopen the earlier response after that revalidation.
          if (!valid() || !allowed() || !button.isConnected) return;
          openTaskDetail({ task: response.data, currentUserId: user?.id ?? null, isAdmin: user?.role === 'admin', onChanged: refresh, offerInspection: true });
        } catch (error) { if (valid() && allowed() && button.isConnected) window.yuvomi?.showToast(error.data?.error || error.message, 'danger'); }
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
  const stopCountdowns = bindTaskCountdowns(container);
  function stop() {
    if (!active) return;
    active = false; loader.dispose(); starts.dispose(); stopLive?.(); stopCountdowns(); tasks = []; renderedProjection = null; container.replaceChildren();
    if (inspectionStyle) {
      inspectionStyle.link.onload = inspectionStyle.link.onerror = null;
      inspectionStyle.link.remove(); inspectionStyle.cancel(); inspectionStyle = null;
    }
    for (const name of ['auth:context-ending', 'auth:expired', 'auth:context-rejected']) window.removeEventListener(name, stop);
  }
  for (const name of ['auth:context-ending', 'auth:expired', 'auth:context-rejected']) window.addEventListener(name, stop);
  if (allowed()) { stopLive = watchTaskChanges(refresh); void refresh(); }
  else container.hidden = true;
  return stop;
}
