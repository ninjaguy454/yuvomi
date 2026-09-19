import { api } from '/api.js';
import { esc } from '/utils/html.js';
import { deviceBootstrap } from '/utils/device-context.js';
import { beginTemporarySignIn, deviceChanges } from '/utils/device-session.js';
import { createTaskCardSubtasks, taskCardPendingProjection } from '/utils/task-card-subtasks.js';
import { actionableSubtasks } from '/utils/task-progress.js';
import { completionCounts } from '/utils/task-fields.js';
import { renderRotationContext } from '/components/rotation-bindings.js';
import { openModal, closeModal, confirmModal } from '/components/modal.js';

const statusLabel = task => ({open:'Not Started',in_progress:'In Progress',done:'Completed',expired:'Expired'})[task.status] || task.status;
const unwrap = response => response?.data ?? response;
const revision = task => ({expected_revision:task.revision,...(Number.isInteger(task.parent_revision)?{expected_parent_revision:task.parent_revision}:{})});

export async function render(container) {
  const css = document.createElement('link'); css.rel = 'stylesheet'; css.href = '/styles/device.css'; document.head.append(css);
  let disposed = false, tasks = [], readEpoch = 0, detailId = null, mode = deviceBootstrap()?.device?.preferences?.default_view || 'wall';
  let readTimer, stopLive, dashboard = {};
  const boot = deviceBootstrap();
  const name = boot?.device?.name || boot?.principal?.name || 'Household display';
  container.innerHTML = `<main class="device-dashboard"><header><div><p>Paired household device</p><h1>${esc(name)}</h1><p>Anyone using this display can complete the permitted Tasks shown here.</p></div><button class="btn btn--secondary" type="button" data-device-login>Sign in temporarily</button></header><div class="device-view-controls" role="group" aria-label="Task view"><button type="button" class="btn btn--secondary" data-device-view="wall">Wall</button><button type="button" class="btn btn--secondary" data-device-view="list">List</button><button type="button" class="btn btn--secondary" data-device-view="kanban">Kanban</button></div><p role="status" data-device-connection>Connecting…</p><p role="alert" data-device-error></p><section class="device-task-grid" data-device-tasks></section><section class="device-widget-grid" data-device-widgets></section></main>`;
  const grid = container.querySelector('[data-device-tasks]');
  const allows = key => deviceBootstrap()?.device?.permissions?.capabilities?.[key] === 'allow';
  const fail = error => { if (!disposed) container.querySelector('[data-device-error]').textContent = error.message || String(error); };
  const scheduleRefresh = () => { clearTimeout(readTimer); readTimer = setTimeout(() => void refresh(), 100); };
  const find = id => tasks.find(task => Number(task.id) === Number(id));
  const queue = createTaskCardSubtasks({
    children: actionableSubtasks,
    canComplete: (_task, child) => child.status === 'done' ? child.permissions?.reopen === true : child.permissions?.complete === true,
    send: async (child, status) => {
      const response = unwrap(await api.patch(`/device/tasks/${child.id}/status`, {status,...revision(child)}));
      return response.parent_task || response.task || response;
    },
    invalidateReads: () => { readEpoch++; },
    onCanonical(task) { tasks = tasks.map(entry => Number(entry.id) === Number(task.id) ? task : entry); patch(task); },
    onPending(task, pending, state) { patch(task, pending, state); },
    onError: fail,
    refresh: scheduleRefresh,
  });
  const progress = task => { const counts = completionCounts(task); return `${counts.done} of ${counts.total} required complete${counts.optionalTotal ? ` · ${counts.optionalDone} of ${counts.optionalTotal} optional` : ''}`; };
  function stepMarkup(child) {
    const done = child.status === 'done';
    const allowed = done ? child.permissions?.reopen === true : child.permissions?.complete === true;
    return `<div class="device-step" data-device-step-row="${child.id}"><button type="button" role="checkbox" aria-checked="${done}" aria-label="${esc(child.title)}" data-device-step="${child.id}" ${allowed?'':'disabled'}><span data-device-check aria-hidden="true">${done?'✓':'○'}</span><span data-device-step-title>${esc(child.title)}</span></button>${child.is_optional?'<small>Optional</small>':''}${!allowed&&!done?'<small>Personal authority required or this action is not currently available.</small>':''}</div>`;
  }
  function markup(task) {
    const steps = actionableSubtasks(task);
    return `<article class="device-task" data-device-task="${task.id}"><header><div><h2 data-device-title>${esc(task.title)}</h2><p data-device-assignee>${esc(task.assigned_to_name || task.assigned_name || task.assignee_name || task.assignee?.display_name || (task.assignees||[]).map(member=>member.display_name).join(', ') || '')}</p></div><button type="button" class="btn btn--secondary" data-device-detail="${task.id}">Details</button></header><p data-device-status>${esc(statusLabel(task))}</p><p data-device-progress>${esc(progress(task))}</p><div data-device-rotation>${renderRotationContext(task.rotations || [])}</div><div data-device-steps>${steps.map(stepMarkup).join('')}</div>${!steps.length ? `<button type="button" class="btn btn--primary" data-device-complete="${task.id}" ${task.permissions?.complete&&task.status!=='done'?'':'disabled'}>Complete Task</button>` : ''}${task.permissions?.claim?`<div data-device-claim><label>Claim for <select class="input" data-device-claim-target><option value="">Choose a member</option>${(dashboard.members||[]).map(member=>`<option value="${member.id}">${esc(member.display_name)}</option>`).join('')}</select></label><button type="button" class="btn btn--secondary" data-device-claim-submit="${task.id}">Claim Task</button></div>`:''}</article>`;
  }
  function patch(task, pending = new Map(), state = {}) {
    const projection = taskCardPendingProjection(task, pending, actionableSubtasks);
    for (const node of container.querySelectorAll(`[data-device-task="${task.id}"]`)) {
      node.querySelector('[data-device-title]').textContent = task.title;
      node.querySelector('[data-device-status]').textContent = statusLabel(projection);
      node.querySelector('[data-device-progress]').textContent = progress(projection);
      node.querySelector('[data-device-progress]').setAttribute('aria-busy', String(pending.size > 0));
      for (const child of actionableSubtasks(task)) {
        const button = node.querySelector(`[data-device-step="${child.id}"]`);
        if (!button) continue;
        const intent = pending.get(Number(child.id));
        const done = (intent?.status || child.status) === 'done';
        button.setAttribute('aria-checked', String(done));
        button.setAttribute('aria-busy', String(!!intent));
        button.querySelector('[data-device-check]').textContent = done ? '✓' : '○';
        button.querySelector('[data-device-step-title]').textContent = child.title;
        button.disabled = !!intent || !!state.blocked || (child.status === 'done' ? child.permissions?.reopen !== true : child.permissions?.complete !== true);
      }
    }
  }
  function renderTasks() {
    grid.dataset.view = mode;
    const ids = new Set(tasks.map(task => String(task.id)));
    for (const node of grid.querySelectorAll('[data-device-task]')) if (!ids.has(node.dataset.deviceTask)) node.remove();
    for (const task of tasks) {
      let node = grid.querySelector(`[data-device-task="${task.id}"]`);
      const structure = actionableSubtasks(task).map(child => `${child.id}:${!!child.is_optional}`).join(',');
      if (!node) { grid.insertAdjacentHTML('beforeend', markup(task)); node = grid.lastElementChild; }
      else if (node.dataset.structure !== structure) {
        node.querySelector('[data-device-steps]').innerHTML = actionableSubtasks(task).map(stepMarkup).join('');
      }
      node.dataset.structure = structure;
      if (task.permissions?.edit && !node.querySelector('[data-device-edit-task]')) {
        const edit=document.createElement('button');edit.type='button';edit.className='btn btn--secondary';edit.dataset.deviceEditTask=task.id;edit.textContent='Edit';node.querySelector('header').append(edit);
      }
      if (task.permissions?.reset && !node.querySelector('[data-device-reset-task]')) {
        const reset=document.createElement('button');reset.type='button';reset.className='btn btn--secondary';reset.dataset.deviceResetTask=task.id;reset.textContent='Reset progress';node.append(reset);
      }
      const rotation = renderRotationContext(task.rotations || []), target = node.querySelector('[data-device-rotation]');
      if (target.innerHTML !== rotation) target.innerHTML = rotation;
      patch(task);
    }
    if (!tasks.length && !grid.querySelector('[data-device-empty]')) grid.innerHTML='<p data-device-empty>No permitted active Tasks.</p>';
    if (tasks.length) grid.querySelector('[data-device-empty]')?.remove();
    queue.repaint();
  }
  function taskEditor(task=null) {
    const assigning=allows('tasks.change_assignment')&&(!task||allows('tasks.reassign'));
    const dates=allows('tasks.change_dates'),points=allows('tasks.change_points');
    openModal({title:task?'Edit Task':'New Task',content:`<form data-device-task-editor><label class="label">Title<input class="input" name="title" value="${esc(task?.title||'')}" required maxlength="500"></label><label class="label">Description<textarea class="input" name="description">${esc(task?.description||'')}</textarea></label>${assigning?`<label class="label">Assigned to<select class="input" name="assigned_to"><option value="">Unassigned</option>${(dashboard.members||[]).map(member=>`<option value="${member.id}"${member.id===task?.assigned_to?' selected':''}>${esc(member.display_name)}</option>`).join('')}</select></label>`:''}${dates?`<div class="device-settings-grid">${['start','due'].map(kind=>`<label>${kind==='start'?'Start':'Due'} Date<input type="date" class="input" name="${kind}_date" value="${esc(task?.[`${kind}_date`]||'')}"></label><label>Time<input type="time" class="input" name="${kind}_time" value="${esc(task?.[`${kind}_time`]||'')}"></label>`).join('')}</div>`:''}${points?`<label class="label">Points<input class="input" type="number" name="points" min="0" max="10000" value="${Number(task?.points||0)}"></label>`:'<p>Point values are protected by this display’s permissions.</p>'}<p role="alert" data-device-editor-error></p><div class="modal-footer"><button type="button" class="btn btn--secondary" data-action="close-modal">Cancel</button><button type="submit" class="btn btn--primary">${task?'Save':'Create'} Task</button></div></form>`,onSave(panel){
      panel.querySelector('form').onsubmit=async event=>{event.preventDefault();const form=new FormData(event.target),submit=event.target.querySelector('[type=submit]');submit.disabled=true;
        const body={title:form.get('title'),description:form.get('description'),...(task?revision(task):{})};
        if(assigning)body.assigned_to=Number(form.get('assigned_to'))||null;
        if(dates)for(const key of ['start_date','start_time','due_date','due_time'])body[key]=form.get(key)||null;
        if(points)body.points=Number(form.get('points'));else if(!task)body.points=0;
        try{if(task)await api.patch(`/device/tasks/${task.id}`,body);else await api.post('/device/tasks',body);await closeModal({force:true});await refresh();}catch(error){const message=panel.querySelector('[data-device-editor-error]');message.textContent=error.message;message.tabIndex=-1;message.focus();message.scrollIntoView({block:'nearest'});}finally{submit.disabled=false;}
      };
    }});
  }
  function widgets() {
    const target = container.querySelector('[data-device-widgets]');
    const prefs = dashboard.preferences || boot?.device?.preferences || {};
    const appearance = prefs.appearance || {};
    container.dataset.density = appearance.density || 'comfortable';
    if (['light','dark'].includes(appearance.theme)) document.documentElement.setAttribute('data-theme',appearance.theme); else document.documentElement.removeAttribute('data-theme');
    document.documentElement.setAttribute('data-color-theme', appearance.palette || 'neutral');
    document.documentElement.setAttribute('data-typography', appearance.font || 'default');
    const sections = {
      calendar: ['Calendar', dashboard.calendar || [], item => `${item.title || ''} ${item.start_datetime || item.start_date || ''}`],
      meals: ['Meals', dashboard.meals || [], item => item.name || item.title || item.recipe_name || 'Meal'],
      shopping: ['Shopping', dashboard.shopping || [], item => item.name || item.title || 'Shopping list'],
      points: ['Points', dashboard.points || [], item => `${item.display_name || item.name || ''}: ${item.balance ?? item.points ?? 0}`],
      rewards: ['Rewards', dashboard.rewards || [], item => `${item.name} · ${item.cost} points`],
      rotations: ['Shared rotation', dashboard.rotations || [], item => `${item.name || 'Shared order'}${item.provisional?' · Provisional':''}: ${(item.order||[]).map(member=>member.display_name).join(' → ')}`],
    };
    const configured = [...(prefs.widgets || ['tasks',...Object.keys(sections)].map((id,order)=>({id,visible:true,order})))];
    const shown=configured.filter(widget=>widget.visible&&(sections[widget.id]||widget.id==='tasks'&&mode==='wall')).sort((a,b)=>a.order-b.order);
    const visible=new Set(shown.map(widget=>widget.id));
    const focus=document.activeElement;
    if(mode!=='wall'){grid.hidden=false;if(grid.parentNode===target||grid.closest('[data-device-widget]'))target.before(grid);}
    for(const node of [...target.children])if(!visible.has(node.dataset.deviceWidget)){
      if(node.contains(grid)){target.before(grid);grid.hidden=mode==='wall';}node.remove();
    }
    for(const [index,widget] of shown.entries()){
      let node=target.querySelector(`[data-device-widget="${widget.id}"]`);
      if(!node){node=document.createElement('section');node.dataset.deviceWidget=widget.id;}
      node.dataset.size=widget.size||'medium';
      if(widget.id==='tasks'){grid.hidden=false;if(grid.parentNode!==node)node.append(grid);}
      else{
        const [label,items,format]=sections[widget.id];
        const html=`<h2>${label}</h2>${items.length?`<ul>${items.map(item=>`<li>${esc(format(item))}</li>`).join('')}</ul>`:'<p>No shared entries.</p>'}${widget.id==='rewards'?'<p>Sign in temporarily to redeem.</p>':''}`;
        if(node.innerHTML!==html)node.innerHTML=html;
      }
      if(target.children[index]!==node)target.insertBefore(node,target.children[index]||null);
    }
    if(mode==='wall'&&!visible.has('tasks'))grid.hidden=true;
    if(focus?.isConnected&&document.activeElement!==focus)focus.focus({preventScroll:true});
  }
  async function refresh() {
    const epoch = ++readEpoch;
    try {
      const [listing, board] = await Promise.all([boot?.device?.permissions?.modules?.tasks === 'none' ? {data:[]} : api.get('/device/tasks'),api.get('/device/dashboard')]);
      if (disposed || epoch !== readEpoch) return;
      const data = unwrap(listing);
      tasks = queue.reconcile(Array.isArray(data)?data:data.tasks || []);
      dashboard = unwrap(board);
      renderTasks(); widgets();
      container.querySelector('[data-device-connection]').textContent = 'Connected · changes sync automatically';
    } catch (error) { if (!disposed && epoch === readEpoch) { fail(error); container.querySelector('[data-device-connection]').textContent='Disconnected. Actions require a connection.'; } }
  }
  container.querySelector('[data-device-login]').onclick = () => beginTemporarySignIn().catch(fail);
  if(allows('tasks.create')){const button=document.createElement('button');button.type='button';button.className='btn btn--primary';button.dataset.deviceCreateTask='';button.textContent='New Task';button.onclick=()=>taskEditor();container.querySelector('.device-view-controls').append(button);}
  container.addEventListener('click', async event => {
    const view = event.target.closest('[data-device-view]');
    if (view) { mode=view.dataset.deviceView; renderTasks();widgets(); return; }
    const edit=event.target.closest('[data-device-edit-task]');if(edit){taskEditor(find(edit.dataset.deviceEditTask));return;}
    const reset=event.target.closest('[data-device-reset-task]');if(reset){
      const task=find(reset.dataset.deviceResetTask);
      if(await confirmModal('Reset this Task’s progress?',{detail:'Required and optional progress will be reset. Completion history is retained. Protected supervision work still requires personal authority.',danger:true,confirmLabel:'Reset progress'})){
        reset.disabled=true;try{await api.patch(`/device/tasks/${task.id}/status`,{status:'open',reset_progress:true,...revision(task)});await refresh();}catch(error){fail(error);}finally{reset.disabled=false;}
      }return;
    }
    const step = event.target.closest('[data-device-step]');
    if (step) {
      const task = find(step.closest('[data-device-task]').dataset.deviceTask);
      const child = actionableSubtasks(task).find(item=>Number(item.id)===Number(step.dataset.deviceStep));
      if (child) queue.enqueue(task, child.id, child.status==='done'?'open':'done');
      return;
    }
    const detail = event.target.closest('[data-device-detail]');
    if (detail) {
      const node = detail.closest('[data-device-task]'); detailId=Number(detail.dataset.deviceDetail);
      node.classList.toggle('device-task--detail');
      detail.setAttribute('aria-expanded',String(node.classList.contains('device-task--detail')));
      let description = node.querySelector('[data-device-description]');
      if (!description) { description=document.createElement('p'); description.dataset.deviceDescription=''; description.textContent=find(detailId)?.description || 'No additional instructions.'; node.append(description); }
      description.hidden=!node.classList.contains('device-task--detail');
      return;
    }
    const complete=event.target.closest('[data-device-complete]');
    if (complete) {
      const task=find(complete.dataset.deviceComplete); complete.disabled=true;
      try { const response=unwrap(await api.patch(`/device/tasks/${task.id}/status`,{status:'done',...revision(task)})); tasks=tasks.map(item=>item.id===task.id?response:item); renderTasks(); } catch(error){fail(error);await refresh();}
    }
    const claim=event.target.closest('[data-device-claim-submit]');
    if(claim){
      const task=find(claim.dataset.deviceClaimSubmit), userId=Number(claim.closest('[data-device-claim]').querySelector('select').value);
      if(!userId){fail(new Error('Choose the member receiving this Task.'));return;}
      claim.disabled=true;
      try{await api.post(`/device/tasks/${task.id}/claim`,{user_id:userId,...revision(task)});await refresh();}catch(error){fail(error);}finally{claim.disabled=false;}
    }
  });
  await refresh();
  stopLive=deviceChanges(scheduleRefresh);
  return () => { disposed=true;readEpoch++;clearTimeout(readTimer);stopLive?.();queue.dispose();css.remove(); };
}
