import { api, auth } from '/api.js';
import { esc } from '/utils/html.js';
import { formatDate, formatTime } from '/i18n.js';
import { openModal, closeModal, confirmOverModal } from '/components/modal.js';
import { watchTaskChanges } from '/utils/task-live.js';
import { setWallModeEnabled, exitWallMode } from '/utils/wall-mode.js';
import { clearApiCache } from '/sw-register.js';
import { rewardRequest } from '/utils/reward-request.js';
import { watchRewardChanges } from '/utils/reward-live.js';
import { displayTimeZone, setDisplayTimeZone } from '/utils/timezone.js';

const LABELS = { tasks:'Tasks', calendar:'Upcoming events', meals:'Today’s meals', shopping:'Shopping',
  presence:'Household presence', points:'Points', rewards:'Rewards', notes:'Announcements', weather:'Weather' };
const ACTIONS = { task_complete:'Complete Task steps', task_claim:'Claim Tasks', reward_redeem:'Redeem Rewards' };
const option = (value, label, current) => `<option value="${esc(value)}"${value === current ? ' selected' : ''}>${esc(label)}</option>`;
const button = (label, attrs = '') => `<button type="button" class="btn btn--secondary" ${attrs}>${esc(label)}</button>`;
const empty = text => `<p class="wall-dashboard__empty">${esc(text)}</p>`;
function privacyMessage(enabled) {
  navigator.serviceWorker?.controller?.postMessage({ type:'WALL_MODE', enabled });
  clearApiCache();
}

/** Adapt the existing Dashboard widgets, but remove all normal-account navigation.
 * Input is exclusively the server's Wall projection. No personal Dashboard API.
 */
export function wallWidgetContent(id, data, renderers) {
  if (id === 'tasks') return renderers.tasks(data.urgentTasks || []);
  if (id === 'calendar') return renderers.calendar(data.upcomingEvents || []);
  if (id === 'meals') return renderers.meals(data.todayMeals || []);
  if (id === 'shopping') return renderers.shopping((data.shoppingLists || []).map(x => ({...x,items:x.items || [],total_count:x.total_count ?? x.open_count})));
  if (id === 'notes') return renderers.notes(data.pinnedNotes || [], '2x2');
  if (id === 'points') return renderers.points({standings:data.points || [],pending:0});
  if (id === 'weather') return data.weather ? renderers.weather(data.weather) : empty('Set a household weather location to show the forecast.');
  if (id === 'presence') return (data.presence || []).map(p => `<div class="wall-member-row"><strong>${esc(p.display_name)}</strong><span>${esc(p.state || 'Unknown')}${p.inferred ? ' · estimated' : ''}</span></div>`).join('') || empty('Presence is hidden or not available.');
  if (id === 'rewards') return data.rewardCatalog?.length ? `<div class="wall-reward-grid">${data.rewardCatalog.map(r => `<button type="button" class="wall-reward" data-wall-reward="${r.id}"><span class="wall-reward__icon" aria-hidden="true">${esc(r.icon || '🎁')}</span><strong>${esc(r.name)}</strong><span>${r.cost} points</span></button>`).join('')}</div>` : empty('No Rewards yet.');
  return '';
}

export async function mountWallDashboard(container, { user, signal, renderers }) {
  let snapshot, configuration, defaults, actor = null, expiryTimer, refreshTimer, refreshPending = false, refreshAgain = false;
  let generation = 0, disposed = false, detail = null, detailGeneration = 0, mutationPending = false, supportedActions=[];
  const originalAppearance = ['data-theme','data-color-theme','data-typography'].map(key => [key,document.documentElement.getAttribute(key)]);
  const originalZone = displayTimeZone();
  // Natural-height rows fill the space beside taller Task widgets. The DOM and
  // keyboard order remain the configured order; no dragging is needed.
  const layoutObserver = new ResizeObserver(entries => {
    for (const {target} of entries) {
      const span = Math.ceil((target.getBoundingClientRect().height + 22) / 30);
      target.style.gridRowEnd = `span ${Math.max(1,span)}`;
    }
  });
  const css = document.createElement('link'); css.rel='stylesheet'; css.href='/styles/wall-dashboard.css'; document.head.append(css);
  container.innerHTML = `<div class="wall-dashboard"><p role="status">Opening household display…</p></div>`;
  const fail = error => window.yuvomi?.showToast(error.message || 'Unable to complete this action.', 'error');
  const actorHeaders = () => actor ? { 'X-Wall-Actor':actor.actor_token } : {};
  const canAct = action => configuration?.interaction?.mode === 'interactive' && configuration.interaction.actions.includes(action);
  const actorValid = () => actor && Date.now() < actor.expiresAt;
  const settingsError = (panel, error) => { const el=panel.querySelector('[data-wall-error]'); if(el) { el.textContent=error.message; el.hidden=false; } };
  const safeModal = options => openModal({...options, size:'xl', onSave(panel) { panel.classList.add('wall-dialog'); options.onSave?.(panel); }});

  async function forget() {
    const token = actor?.actor_token; actor = null; clearTimeout(expiryTimer); paintIdentity();
    if(token) await api.post('/wall/forget', {}, {headers:{'X-Wall-Actor':token}}).catch(()=>{});
  }
  function paintIdentity() {
    const el=container.querySelector('[data-wall-identify]');
    if(el) el.textContent=actorValid() ? `Acting as ${actor.member?.display_name || actor.user?.display_name || actor.display_name || 'member'}` : 'Identify yourself';
    const done=container.querySelector('[data-wall-forget]'); if(done) done.hidden=!actorValid();
  }
  function identify(next = () => {}, admin = false) {
    if(actorValid() && (!admin || actor.isAdmin)) return next();
    detail=null; detailGeneration++;
    safeModal({title:admin ? 'Administrator verification' : 'Who is acting?', initialFocus:'none', content:`
      <form data-wall-identify-form class="wall-form">
        <p>${admin ? 'Verify an administrator to change this display or leave Wall Mode.' : 'Use your own Vidamia account. Your actions will be recorded in your name.'}</p>
        <label>Household member<select class="form-input" name="user_id" required>${(snapshot?.users || []).map(u=>option(String(u.id),u.display_name,'')).join('')}</select></label>
        <label>Password<input class="form-input" name="password" type="password" autocomplete="current-password" required></label>
        <label>Two-factor code, if enabled<input class="form-input" name="code" inputmode="numeric" autocomplete="one-time-code"></label>
        <p class="form-error" role="alert" data-wall-error hidden></p>
        <div class="modal-footer"><button class="btn btn--primary" type="submit">Verify identity</button>${button('Cancel','data-action="close-modal"')}</div>
      </form>`, onSave(panel) {
        panel.querySelector('form').addEventListener('submit',async event=>{
          event.preventDefault(); const submit=panel.querySelector('[type=submit]'); if(submit.disabled)return; submit.disabled=true;
          const form=new FormData(event.currentTarget);
          try {
            const response=await api.post('/wall/identify',{user_id:Number(form.get('user_id')),password:form.get('password'),code:form.get('code') || undefined});
            actor=response.data; actor.expiresAt=Date.now()+((actor.expires_in || actor.expiresInSeconds || 120)*1000);
            panel.querySelector('[name=password]').value=''; panel.querySelector('[name=code]').value='';
            if(admin&&!actor.isAdmin)throw new Error('Choose an administrator account to change Wall settings or exit.');
            clearTimeout(expiryTimer); expiryTimer=setTimeout(()=>{ actor=null; paintIdentity(); if(detail)openDetail(detail.kind,detail.id); },Math.max(0,actor.expiresAt-Date.now()));
            // Keep the modal slot while handing off to another dialog. Closing
            // first races history.back() against the next overlay's marker.
            paintIdentity(); await next();
            if(panel.closest('.modal-overlay')?.id==='shared-modal-overlay')await closeModal({force:true});
          } catch(error) {settingsError(panel,error);} finally{submit.disabled=false;}
        });
      }});
  }

  function appearance() {
    const root=document.documentElement, a=configuration.appearance;
    root.setAttribute('data-color-theme',a.palette); root.setAttribute('data-typography',a.font);
    root.removeAttribute('data-wall-night');
    if(a.theme==='system') root.removeAttribute('data-theme'); else root.setAttribute('data-theme',a.theme);
    container.querySelector('.wall-dashboard')?.setAttribute('data-density',a.density);
  }
  function shell() {
    container.innerHTML=`<div class="dashboard dashboard--wall wall-dashboard">
      <header class="wall-dashboard__header"><div><p class="wall-dashboard__eyebrow">Shared household display</p><h1>At home</h1></div>
        <div class="wall-dashboard__clock" data-wall-clock></div><div class="wall-dashboard__controls">
        ${button('Identify yourself','data-wall-identify')}${button('Done','data-wall-forget hidden')}
        ${button('Wall settings','data-wall-settings')}${button('Full screen','data-wall-fullscreen')}${button('Exit Wall Mode','data-wall-exit')}${button('Sign out','data-wall-signout')}
        <a href="/device/pair" class="btn btn--secondary">Pair as household device</a>
      </div></header><p class="wall-dashboard__connection" role="status" data-wall-connection></p>
      <div class="wall-dashboard__grid" data-wall-grid></div><footer class="wall-dashboard__footer"><span data-wall-updated></span><span data-wall-notifications></span></footer></div>`;
    container.querySelector('[data-wall-identify]').onclick=()=>identify();
    container.querySelector('[data-wall-forget]').onclick=()=>forget();
    container.querySelector('[data-wall-signout]').onclick=async()=>{
      if(!(await confirmOverModal('Sign out of this household display?')))return;
      try {await auth.logout();actor=null;exitWallMode();privacyMessage(false);location.assign('/login');}catch(error){fail(error);}
    };
    container.querySelector('[data-wall-settings]').onclick=()=>identify(openSettings,true);
    container.querySelector('[data-wall-exit]').onclick=()=>identify(async()=>{
      try {await api.post('/wall/exit',{}, {headers:actorHeaders()}); actor=null; privacyMessage(false); exitWallMode(); location.assign('/');} catch(error){fail(error);}
    },true);
    container.querySelector('[data-wall-fullscreen]').onclick=async()=>{
      try {if(document.fullscreenElement)await document.exitFullscreen(); else if(document.documentElement.requestFullscreen)await document.documentElement.requestFullscreen(); else throw new Error('Use Fully Kiosk’s fullscreen setting on this device.');}catch(error){fail(error);}
    };
    container.addEventListener('click',event=>{
      const target=event.target.closest('[data-wall-open]'); if(!target)return;
      event.preventDefault();event.stopPropagation();openDetail(target.dataset.wallKind,Number(target.dataset.wallOpen));
    },{signal});
    container.addEventListener('keydown',event=>{
      if(['Enter',' '].includes(event.key) && event.target.matches('[data-wall-open]:not(button)')){event.preventDefault();event.target.click();}
    },{signal});
  }
  function prepareWidget(wrapper,id) {
    if(id==='points'){const title=wrapper.querySelector('.widget__title');if(title)title.textContent='Points';}
    const open=(node,kind,entityId)=>{if(!node||!entityId)return;node.dataset.wallOpen=entityId;node.dataset.wallKind=kind;node.setAttribute('role','button');node.tabIndex=0;};
    wrapper.querySelectorAll('[data-task-id]').forEach(el=>open(el,'tasks',el.dataset.taskId));
    wrapper.querySelectorAll('[data-route]').forEach(el=>{
      const route=el.dataset.route;const url=new URL(route,location.origin);
      if(url.pathname==='/calendar')open(el,'calendar',url.searchParams.get('open'));
      if(url.pathname==='/notes')open(el,'notes',url.searchParams.get('open') || url.searchParams.get('id'));
    });
    if(id==='meals') wrapper.querySelectorAll('[data-type]').forEach(el=>open(el,'meals',snapshot.todayMeals.find(m=>m.meal_type===el.dataset.type)?.id));
    if(id==='shopping') wrapper.querySelectorAll('.shopping-widget-list').forEach((el,i)=>open(el,'shopping',snapshot.shoppingLists[i]?.id));
    wrapper.querySelectorAll('[data-wall-reward]').forEach(el=>open(el,'rewards',el.dataset.wallReward));
    // Normal widgets may contain full-module links or create CTAs. These never
    // cross the shared-display boundary; only mapped safe detail targets work.
    wrapper.querySelectorAll('[data-route],[href],[data-task-id]').forEach(el=>{
      el.removeAttribute('data-route');el.removeAttribute('href');el.removeAttribute('data-task-id');
      if(!el.dataset.wallOpen){el.removeAttribute('role');el.removeAttribute('tabindex');}
    });
    wrapper.querySelectorAll('.widget__link,.widget__empty-cta,.widget__retry,.weather-widget__refresh').forEach(el=>el.remove());
  }
  function paint() {
    if(disposed)return;
    if(!container.querySelector('[data-wall-grid]'))shell();
    appearance(); paintIdentity();
    const grid=container.querySelector('[data-wall-grid]');
    const shown=configuration.widgets.filter(w=>w.visible).sort((a,b)=>a.order-b.order);
    const ids=new Set(shown.map(w=>w.id));
    for(const el of [...grid.children])if(!ids.has(el.dataset.widget)){layoutObserver.unobserve(el);el.remove();}
    for(const [index,w] of shown.entries()){
      let node=grid.querySelector(`[data-widget="${w.id}"]`);
      if(!node){node=document.createElement('section');node.dataset.widget=w.id;node.className='wall-dashboard__widget';layoutObserver.observe(node);}
      node.dataset.size=w.size;
      const content=wallWidgetContent(w.id,snapshot,renderers);
      if(node._content!==content){const scroll=node.querySelector('.widget__body')?.scrollTop || 0;const hasHeader=content.includes('widget__header');node.innerHTML=`${hasHeader?'':`<header class="widget__header"><h2 class="widget__title">${LABELS[w.id]}</h2></header>`}${content}`;node._content=content;prepareWidget(node,w.id);const body=node.querySelector('.widget__body');if(body)body.scrollTop=scroll;}
      if(grid.children[index]!==node)grid.insertBefore(node,grid.children[index] || null);
    }
    clock();
    container.querySelector('[data-wall-updated]').textContent=`Updated ${formatTime(new Date())}`;
    const notice=snapshot.notification || {};
    container.querySelector('[data-wall-notifications]').textContent=notice.mode==='count' ? `${notice.count || 0} notifications` : notice.mode==='generic' ? 'Check your own account for notifications' : '';
    window.lucide?.createIcons({el:grid});
  }
  function clock(){
    const el=container.querySelector('[data-wall-clock]');if(!el)return;
    el.hidden=!configuration?.appearance.clock;
    const now=new Date(),zone=snapshot?.timezone;
    const date=new Intl.DateTimeFormat(undefined,{weekday:'long',month:'long',day:'numeric',...(zone ? {timeZone:zone}: {})}).format(now);
    el.innerHTML=`<strong>${esc(formatTime(now))}</strong><span>${esc(date)}</span>`;
  }
  async function refresh() {
    if(disposed||document.hidden)return;
    if(refreshPending){refreshAgain=true;return;}refreshPending=true; const run=++generation;
    try{
      const response=await api.get('/wall/dashboard');
      if(disposed||run!==generation)return;
      snapshot=response.data;configuration=snapshot.config || configuration;
      setDisplayTimeZone(snapshot.timezone);
      if(configuration.widgets.some(w=>w.id==='weather'&&w.visible))snapshot.weather=(await api.get('/wall/weather').catch(()=>({data:null}))).data;
      if(disposed||run!==generation)return;paint();
      container.querySelector('[data-wall-connection]').textContent=configuration.interaction.mode==='read_only'?'Read-only display · identify an administrator to configure interactions':'Shared content only · identify yourself before taking an action';
      if(detail&&!mutationPending)await openDetail(detail.kind,detail.id,true);
    }catch(error){if(!disposed){const el=container.querySelector('[data-wall-connection]');if(el)el.textContent='Offline or disconnected. Reconnecting…';}}
    finally{refreshPending=false;if(refreshAgain&&!disposed){refreshAgain=false;void refresh();}}
  }

  async function openDetail(kind,id,refreshOnly=false) {
    const request=++detailGeneration;
    try{
      let data;
      if(kind==='rewards')data=snapshot.rewardCatalog.find(r=>r.id===id);
      else if(kind==='notes')data=snapshot.pinnedNotes.find(r=>r.id===id);
      else data=(await api.get(`/wall/${kind}/${id}`,{headers:actorHeaders()})).data;
      if(!data||disposed||request!==detailGeneration)return;
      if(refreshOnly&&(!detail||detail.kind!==kind||detail.id!==id))return;
      detail={kind,id};
      const content=detailContent(kind,data);
      if(refreshOnly){const body=document.querySelector('.wall-dialog [data-wall-detail-body]');if(body && body.innerHTML!==content){const scroll=body.closest('.modal-panel__body').scrollTop;body.innerHTML=content;wireDetail(body,data,kind,id);body.closest('.modal-panel__body').scrollTop=scroll;}return;}
      safeModal({title:data.title || data.name || LABELS[kind],initialFocus:'none',content:`<div data-wall-detail-body>${content}</div>`,onClose(){detail=null;detailGeneration++;},onSave(panel){wireDetail(panel,data,kind,id);}});
    }catch(error){if(refreshOnly){if(error.status===403||error.status===404){detail=null;await closeModal({force:true});}}else fail(error);}
  }
  function detailContent(kind,data){
    const who=actorValid()?`Acting as ${actor.member?.display_name || actor.user?.display_name || actor.display_name || 'member'}`:'Identify yourself to take an action';
    let html=`<p class="wall-action-identity">${esc(who)}</p>`;
    if(kind==='tasks'){
      const actions=(data.subtasks || data.children || []).filter(s=>data.is_supervision_projection || !s.is_supervision_projection);
      const progress={completed:data.subtask_done,total:data.subtask_total};html+=`<p>${esc(data.status==='done'?'Completed':data.status==='in_progress'?'In progress':'Not started')}${progress.total?` · ${progress.completed ?? 0} of ${progress.total} steps`:''}${data.waiting_on_helper?' · Your steps are complete; waiting on helper work':''}</p>`;
      if(data.description)html+=`<p class="wall-detail-instructions">${esc(data.description)}</p>`;
      html+=`<div class="wall-date-pair"><span>Starts ${esc(data.start_date?formatDate(data.start_date):'Any time')}</span><span>Due ${esc(data.due_date?formatDate(data.due_date):'No date')}</span></div>`;
      if(data.supervision?.supervisor_name)html+=`<p>Helper: ${esc(data.supervision.supervisor_name)}</p>`;
      if(['needed','unresolved'].includes(data.supervision?.state))html+=`<p>${esc(data.supervision.explanation || 'Helper work is unresolved. Use your personal Tasks view for assignment details.')}</p>`;
      html+=`<div class="wall-task-steps">${actions.map(s=>`<div class="wall-task-step"><button type="button" data-wall-step="${s.id}" ${!canAct('task_complete')||s.status==='done'||s.is_delegated_action||(actorValid()&&!s.permissions?.complete)?'disabled':''} aria-label="${esc(s.status==='done'?'Completed: ':'Complete: ')}${esc(s.title)}"><span aria-hidden="true">${s.status==='done'?'✓':'○'}</span><span>${esc(s.title)}</span></button>${s.required_skills?.length?`<p>${esc(s.required_skills.map(x=>x.name).join(', '))}${s.supervision_action?.execution_mode==='delegated'?' · Helper responsibility':s.supervision_action&&s.supervision_action.state!=='not_required'?' · Supervision required':''}</p>`:''}</div>`).join('')}</div>`;
      if(canAct('task_complete')&&data.status!=='done')html+=button('Complete Task',`data-wall-complete ${actorValid()&&!data.permissions?.complete?'disabled':''}`);
      if(canAct('task_claim')&&!data.assigned_to)html+=button('Claim this Task',`data-wall-claim ${actorValid()&&!data.permissions?.claim?'disabled':''}`);
    }else if(kind==='rewards'){
      html+=`<p class="wall-reward__icon" aria-hidden="true">${esc(data.icon || '🎁')}</p><p>${esc(data.description || '')}</p><strong>${data.cost} points</strong>`;
      if(canAct('reward_redeem'))html+=button('Redeem this Reward','data-wall-redeem');
    }else if(kind==='shopping')html+=`<ul>${(data.items || []).map(i=>`<li>${esc(i.name)} ${esc(i.quantity || '')}</li>`).join('')}</ul>`;
    else if(kind==='calendar')html+=`<p>${esc(data.start_datetime || '')} – ${esc(data.end_datetime || '')}</p><p>${esc(data.location || '')}</p><p>${esc(data.description || '')}</p>`;
    else if(kind==='meals')html+=`<p>${esc(data.date || '')} · ${esc(data.meal_type || '')}</p><p>${esc(data.notes || '')}</p>`;
    else if(kind==='notes')html+=`<p class="wall-detail-instructions">${esc(data.content || '')}</p>`;
    html+='<p role="alert" class="form-error" data-wall-error hidden></p>';return html;
  }
  function wireDetail(panel,data,kind,id){
    const run=(selector,work)=>panel.querySelectorAll(selector).forEach(btn=>btn.onclick=()=>identify(async()=>{
      if(mutationPending)return;mutationPending=true;btn.disabled=true;
      const initiator=actor;
      const intent={headers:{'X-Wall-Actor':initiator.actor_token},memberId:initiator.member.id,
        assertCurrent(){if(actor!==initiator||!actorValid())throw new Error('Your identity changed or expired. Identify yourself and try the action again.');}};
      try{const reopen=await work(btn,intent);await refresh();if(reopen!==false)await openDetail(kind,id);}catch(error){settingsError(panel,error);await openDetail(kind,id);fail(error);}finally{mutationPending=false;if(btn.isConnected)btn.disabled=false;}
    }));
    const complete=async (target,intent)=>{
      // Read current revision after identity verification. Canonical API still
      // validates it and all supervision, permission, and start-date rules.
      const action=(await api.get(`/wall/tasks/${target}`,{headers:intent.headers})).data;
      if(!action)throw new Error('This step changed. Please reopen the Task.');
      // A displayed subtask can itself contain nested work. Fetch its own scope
      // and confirm before requesting bulk completion, just as for the parent.
      const remaining=(action.subtasks || action.children || []).some(s=>s.status!=='done');
      if(remaining&&!(await confirmOverModal(`Complete the remaining permitted steps in “${action.title}”?`,{closeOnConfirm:false})))return false;
      intent.assertCurrent();
      await api.patch(`/wall/tasks/${target}/status`,{status:'done',expected_revision:action.revision,expected_parent_revision:action.parent_revision,complete_remaining:remaining},{headers:intent.headers});
    };
    run('[data-wall-step]',(btn,intent)=>complete(Number(btn.dataset.wallStep),intent));
    run('[data-wall-complete]',(_btn,intent)=>complete(id,intent));
    run('[data-wall-claim]',async(_btn,intent)=>{const fresh=(await api.get(`/wall/tasks/${id}`,{headers:intent.headers})).data;intent.assertCurrent();await api.post(`/wall/tasks/${id}/claim`,{expected_revision:fresh.revision,expected_parent_revision:fresh.parent_revision},{headers:intent.headers});});
    // One key belongs to this explicit redemption attempt, including network
    // retries. A failed/uncertain request does not get a new key on another tap.
    run('[data-wall-redeem]',async(_btn,intent)=>{
      if(!(await confirmOverModal(`Redeem ${data.name} for ${data.cost} points?`,{closeOnConfirm:false})))return;
      intent.assertCurrent();
      const attempt=rewardRequest(intent.memberId,{catalog_id:id});
      await api.post('/wall/rewards/redemptions',{catalog_id:id},{headers:{...intent.headers,'Idempotency-Key':attempt.key}});
      attempt.finish();
      detail=null;await closeModal({force:true});window.yuvomi?.showToast('Reward requested.','success');
      return false;
    });
  }

  function openSettings(){
    detail=null;detailGeneration++;
    const draft=structuredClone(configuration);
    const choose=(name,label,values,current)=>`<label>${label}<select class="form-input" name="${name}">${values.map(v=>option(v, v.replaceAll('_',' '),current)).join('')}</select></label>`;
    safeModal({title:'Wall settings',initialFocus:'none',content:`<form class="wall-form" data-wall-settings-form>
      <p>Saved for the household Wall display, independently of personal Dashboards.</p>
      <h3>Layout</h3><div data-wall-layout></div>${button('Reset Wall layout','data-wall-reset')}
      <h3>Appearance</h3><div class="wall-settings-grid">
      ${choose('theme','Light / Dark',['system','light','dark'],draft.appearance.theme)}${choose('palette','Colors',['warm','neutral','cool'],draft.appearance.palette)}
      ${choose('font','Headings',['default','serif'],draft.appearance.font)}${choose('density','Density',['comfortable','compact'],draft.appearance.density)}
      <label><input type="checkbox" name="clock" ${draft.appearance.clock?'checked':''}> Show clock and date</label></div>
      <h3>Interaction</h3>${choose('mode','Display mode',['read_only','interactive'],draft.interaction.mode)}
      <p>Every action requires a verified member. Verification expires after two minutes; use Done when finished. Password and existing two-factor authentication are supported. Member PINs are not configured in Vidamia.</p>
      <div class="wall-settings-grid">${Object.entries(ACTIONS).filter(([value])=>supportedActions.includes(value)).map(([value,label])=>`<label><input type="checkbox" name="action" value="${value}" ${draft.interaction.actions.includes(value)?'checked':''}>${label}</label>`).join('')}</div>
      <h3>Privacy</h3>${choose('notifications','Notification display',['hidden','generic','count'],draft.privacy.notifications)}
      <label><input type="checkbox" name="showPoints" ${draft.privacy.showPoints?'checked':''}> Show household point balances</label>
      <label><input type="checkbox" name="showPresence" ${draft.privacy.showPresence?'checked':''}> Show household presence</label>
      <p>Private and assignee-only content stays hidden. Personal photo screensavers are disabled here. Configure device brightness, sleep and kiosk lockdown in Fully Kiosk.</p>
      <p class="form-error" role="alert" data-wall-error hidden></p><div class="modal-footer"><button type="submit" class="btn btn--primary">Save Wall settings</button>${button('Cancel','data-action="close-modal"')}</div></form>`,onSave(panel){
        const layout=panel.querySelector('[data-wall-layout]');
        function rows(){layout.innerHTML=draft.widgets.map((w,i)=>`<div class="wall-layout-row" data-id="${w.id}"><label><input type="checkbox" data-visible ${w.visible?'checked':''}>${LABELS[w.id]}</label><select class="form-input" data-size aria-label="${LABELS[w.id]} size">${['small','medium','large'].map(v=>option(v,v,w.size)).join('')}</select>${button('↑',`data-move="-1" aria-label="Move ${LABELS[w.id]} up" ${i===0?'disabled':''}`)}${button('↓',`data-move="1" aria-label="Move ${LABELS[w.id]} down" ${i===draft.widgets.length-1?'disabled':''}`)}</div>`).join('');}
        rows();
        layout.onchange=event=>{const row=event.target.closest('[data-id]');const w=draft.widgets.find(w=>w.id===row.dataset.id);if(event.target.matches('[data-visible]'))w.visible=event.target.checked;else w.size=event.target.value;};
        layout.onclick=event=>{const btn=event.target.closest('[data-move]');if(!btn)return;const id=btn.closest('[data-id]').dataset.id;const index=draft.widgets.findIndex(w=>w.id===id),next=index+Number(btn.dataset.move);if(next<0||next>=draft.widgets.length)return;[draft.widgets[index],draft.widgets[next]]=[draft.widgets[next],draft.widgets[index]];draft.widgets.forEach((w,i)=>w.order=i);rows();layout.querySelector(`[data-id="${id}"] [data-move="${btn.dataset.move}"]`)?.focus();};
        panel.querySelector('[data-wall-reset]').onclick=()=>{draft.widgets=structuredClone(defaults.widgets);rows();};
        panel.querySelector('form').onsubmit=async event=>{
          event.preventDefault();const submit=panel.querySelector('[type=submit]');if(submit.disabled)return;submit.disabled=true;
          const f=new FormData(event.currentTarget);
          draft.appearance={theme:f.get('theme'),palette:f.get('palette'),font:f.get('font'),density:f.get('density'),clock:f.has('clock')};
          draft.interaction={mode:f.get('mode'),actions:f.getAll('action')};draft.privacy={notifications:f.get('notifications'),showPoints:f.has('showPoints'),showPresence:f.has('showPresence')};
          try{await api.put('/wall/config',draft,{headers:actorHeaders()});configuration=draft;await closeModal({force:true});await refresh();}catch(error){settingsError(panel,error);}finally{submit.disabled=false;}
        };
      }});
  }
  function dispose(){disposed=true;generation++;detailGeneration++;clearTimeout(expiryTimer);clearInterval(refreshTimer);stopLive?.();stopRewards?.();layoutObserver.disconnect();css.remove();actor=null;setDisplayTimeZone(originalZone);for(const [key,value] of originalAppearance){if(value===null)document.documentElement.removeAttribute(key);else document.documentElement.setAttribute(key,value);}}
  let stopLive,stopRewards;
  signal?.addEventListener('abort',dispose,{once:true});
  try{
    await api.post('/wall/enter',{});if(disposed)return dispose;
    setWallModeEnabled(true);privacyMessage(true);
    const response=await api.get('/wall/config');configuration=response.data.config;defaults=response.data.defaults;supportedActions=response.data.supportedActions || [];
    await refresh();
    stopLive=watchTaskChanges(refresh);
    stopRewards=watchRewardChanges(refresh);
    // Other existing widgets do not have a change stream; use a bounded refresh,
    // pause hidden tabs, and refresh immediately after a reconnect or wake.
    refreshTimer=setInterval(()=>{clock();refresh();},60_000);
    for(const name of ['online','pageshow','focus'])window.addEventListener(name,refresh,{signal});
    document.addEventListener('visibilitychange',()=>{if(document.hidden)forget();else refresh();},{signal});
  }catch(error){container.innerHTML=`<div class="wall-dashboard"><h1>Household display unavailable</h1><p>${esc(error.message)}</p><button type="button" data-wall-retry class="btn btn--primary">Retry</button></div>`;container.querySelector('[data-wall-retry]').onclick=()=>location.reload();}
  return dispose;
}
