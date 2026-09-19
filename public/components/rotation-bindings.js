import { api } from '/api.js';
import { esc } from '/utils/html.js';
import { canCapability } from '/permissions.js';

const bindings = value => typeof value === 'string' ? JSON.parse(value) : value || [];
const options = (values, selected) => values.map(([value, label]) => `<option value="${esc(value)}" ${String(selected) === String(value) ? 'selected' : ''}>${esc(label)}</option>`).join('');
function row(binding, groups = [], { skills = [], places = [], workflowOperations = false } = {}) {
  const eligibility = binding.eligibility || {};
  const groupOptions = [[ '', 'Choose a Rotation Group' ], ...groups.map(group => [group.id, group.name])];
  if (binding.group_id && !groups.some(group => Number(group.id) === Number(binding.group_id))) groupOptions.push([binding.group_id, `Rotation Group ${binding.group_id}`]);
  return `<fieldset class="form-group" data-rotation-binding style="border:1px solid var(--border-color);padding:var(--space-3);border-radius:var(--radius-md)">
    <legend>Rotation purpose</legend><div class="modal-grid modal-grid--2">
      <label class="label">Name<input class="input" data-rotation-label value="${esc(binding.label || '')}" maxlength="120" placeholder="e.g. Shower Order"></label>
      <label class="label">Rotation Group<select class="input" data-rotation-group>${options(groupOptions, binding.group_id || '')}</select></label>
      <label class="label">Strategy<select class="input" data-rotation-strategy>${options([['round_robin','Round Robin'],['rotating_order','Rotating Order'],['fixed_order','Fixed Order']], binding.strategy || 'rotating_order')}</select></label>
      <label class="label">Advance<select class="input" data-rotation-advance>${options([['on_finalized','After occurrence'],['on_completed','On successful completion'],['manual','Manual']], binding.advance_policy || 'on_finalized')}</select></label>
    </div>
    <div data-rotation-shared-notice hidden role="status"></div>
    <label class="label" data-rotation-period-field hidden>Scheduled evening<select class="input" data-rotation-period-offset>${options([['0','Use this Task’s scheduled evening'],['-1','Previous evening (explicit overnight routine)']],binding.period_date_offset_days||0)}</select></label>
    <label class="toggle"><input type="checkbox" data-rotation-skip ${binding.advance_on_skip ? 'checked' : ''}>Advance when skipped</label>
    ${workflowOperations?`<fieldset data-workflow-rotation-operations><legend>Workflow run operations</legend>
      <p class="form-hint">Resolve or reuse once when the run starts. Its typed Rotation Occurrence is available through this purpose key. Each child shares the owner's result.</p>
      <label class="toggle"><input type="checkbox" data-rotation-operation-finalize ${(binding.workflow_operations||[]).includes('finalize')?'checked':''}>Allow an authorized person to finalize this occurrence</label>
      <label class="toggle"><input type="checkbox" data-rotation-operation-skip ${(binding.workflow_operations||[]).includes('skip')?'checked':''}>Allow an authorized person to skip this occurrence</label>
      <p class="form-hint">These explicit actions appear on the Workflow's parent Task. They do not complete the children's Tasks. Ordinary completion still follows the chosen advancement policy.</p>
    </fieldset>`:''}
    <label class="label">When someone is unavailable<select class="input" data-rotation-eligibility-behavior>${options([['skip_unavailable','Skip unavailable members'],['keep_position','Keep their position']],binding.eligibility_behavior || 'skip_unavailable')}</select></label>
    <details><summary>Eligibility and override settings</summary>
      <label class="label">Purpose key<input class="input" data-rotation-key value="${esc(binding.purpose_key || '')}" maxlength="80" pattern="[a-z][a-z0-9_-]*"></label>
      <p class="form-hint">This stable key also identifies the rotation value in expressions.</p>
      <label class="label">Required skills<select class="input" data-rotation-skills multiple>${skills.map(skill => `<option value="${skill.id}" ${(eligibility.skill_ids || []).map(Number).includes(Number(skill.id)) ? 'selected' : ''}>${esc(skill.name)}</option>`).join('')}</select></label>
      <label class="toggle"><input type="checkbox" data-rotation-supervised ${eligibility.include_supervised ? 'checked' : ''}>Include members who need supervision</label>
      <label class="label">Availability / Presence<select class="input" data-rotation-presence>${options([['ignore','Group membership only'],['available_before_due','Available before due time'],['must_be_home','Must be home'],['must_be_at_location','Must be at the activity location'],['must_be_away','Must be away']], eligibility.presence_policy || 'ignore')}</select></label>
      <label class="label">Window<select class="input" data-rotation-window>${options([['completion','Completion window'],['start','Start'],['due','Due']], eligibility.presence_window || 'completion')}</select></label>
      <label class="label">Location<select class="input" data-rotation-place>${options([['','Use the Activity location'],...places.map(place => [place.id,place.name])], eligibility.place_id || '')}</select></label>
      <label class="toggle"><input type="checkbox" data-rotation-override-next ${binding.override_affects_next !== false ? 'checked' : ''}>An occurrence override changes who is next</label>
    </details>
    <button class="btn btn--ghost btn--sm" type="button" data-rotation-remove>Remove purpose</button>
  </fieldset>`;
}
export function renderRotationBindings(value = [], config = {}) {
  return `<section data-rotation-bindings><h3>Rotation</h3><p class="form-hint">Independent Groups keep separate turns for each Activity or Workflow owner and its descendants. A Group configured as Shared across activities deliberately joins separate recurring Activities to one scheduled order.</p>
    <div data-rotation-rows>${bindings(value).map(binding => row(binding, [], config)).join('')}</div>
    <button class="btn btn--secondary btn--sm" type="button" data-rotation-add>Add rotation purpose</button>
    <p class="form-hint" data-rotation-load-status role="status"></p></section>`;
}
export function bindRotationBindings(container, { skills = [], places = [], readOnly = false, workflowOperations = false } = {}) {
  const root = container?.matches?.('[data-rotation-bindings]') ? container : container?.querySelector('[data-rotation-bindings]');
  if (!root) return { getValue: () => [], setReadOnly() {} };
  let groups = [];
  const sharedGroup=element=>groups.find(group=>Number(group.id)===Number(element.querySelector('[data-rotation-group]').value)&&group.usage_mode==='shared');
  const lock = () => {
    root.querySelectorAll('input,select,button').forEach(control => { control.disabled = readOnly; });
    for(const element of root.querySelectorAll('[data-rotation-binding]')) {
      const group=sharedGroup(element),notice=element.querySelector('[data-rotation-shared-notice]');
      notice.hidden=!group;element.querySelector('[data-rotation-period-field]').hidden=!group;
      for(const key of ['strategy','advance','skip','eligibility-behavior','skills','supervised','presence','window','place','override-next']) {
        const label=element.querySelector(`[data-rotation-${key}]`)?.closest('label');if(label)label.hidden=!!group;
      }
      if(!group)continue;
      const config=group.shared_config||{},method={round_robin:'Round Robin',rotating_order:'Rotating Order',fixed_order:'Fixed Order'}[config.strategy]||'Shared rotation';
      notice.innerHTML=`<strong>Using shared rotation: ${esc(group.name)}</strong><p>${esc(method)} · Once per scheduled evening</p><p class="form-hint">Saving this binding deliberately joins every other Activity using this Group. Its method, availability choices and advancement schedule are controlled by the Group; this Activity cannot advance it independently.</p>${canCapability('rotations.manage')?'<button type="button" class="btn btn--secondary btn--sm" data-rotation-manage>Manage rotation</button>':''}<p class="form-hint">For text, type @ and choose this purpose’s “This action’s assignee position”. Future positions remain provisional until the scheduled period activates.</p>`;
      for(const key of ['strategy','advance','skip','eligibility-behavior','skills','supervised','presence','window','place','override-next','operation-finalize','operation-skip']) {
        const control=element.querySelector(`[data-rotation-${key}]`);if(control)control.disabled=true;
      }
      element.querySelector('[data-workflow-rotation-operations]')?.setAttribute('hidden','');
    }
    for(const element of root.querySelectorAll('[data-rotation-binding]'))if(!sharedGroup(element))element.querySelector('[data-workflow-rotation-operations]')?.removeAttribute('hidden');
  };
  const changed = () => root.dispatchEvent(new Event('input', { bubbles: true }));
  root.addEventListener('click', event => {
    if (readOnly) return;
    if (event.target.closest('[data-rotation-remove]')) { event.target.closest('[data-rotation-binding]').remove(); changed(); }
    if (event.target.closest('[data-rotation-add]')) {
      const key = `purpose_${crypto.randomUUID().replaceAll('-','').slice(0,12)}`;
      root.querySelector('[data-rotation-rows]').insertAdjacentHTML('beforeend', row({purpose_key:key}, groups, {skills,places,workflowOperations}));
      root.querySelector('[data-rotation-binding]:last-child [data-rotation-label]').focus(); lock();changed();
    }
    if(event.target.closest('[data-rotation-manage]')) {
      const group=sharedGroup(event.target.closest('[data-rotation-binding]'));
      if(group)import('/components/rotation-groups.js').then(module=>module.openRotationGroup(group.id,{onChanged:loadGroups})).catch(error=>{root.querySelector('[data-rotation-load-status]').textContent=error.message;});
    }
  });
  root.addEventListener('change',event=>{if(event.target.matches('[data-rotation-group]')){lock();changed();}});
  lock();
  const loadGroups=()=>api.get('/automation/rotation-groups').then(result => {
    if(!root.isConnected)return;
    groups = result.data || [];
    for (const select of root.querySelectorAll('[data-rotation-group]')) {
      const chosen = select.value;
      for (const group of groups) {
        let option = [...select.options].find(value => value.value === String(group.id));
        if (!option) { option = new Option(group.name, String(group.id)); select.append(option); }
        else option.textContent = group.name;
      }
      select.value = chosen;
    }
    lock();
  }).catch(() => { root.querySelector('[data-rotation-load-status]').textContent = 'Rotation Groups could not be loaded. Your draft has been preserved.'; });
  const ready = readOnly&&!canCapability('rotations.view') ? Promise.resolve() : loadGroups();
  return {
    ready,
    setReadOnly(value) { readOnly = value; lock(); },
    getValue() {
      return [...root.querySelectorAll('[data-rotation-binding]')].map(element => {
        const value = key => element.querySelector(`[data-rotation-${key}]`).value;
        const checked = key => element.querySelector(`[data-rotation-${key}]`).checked;
        const group=sharedGroup(element),shared=group?.shared_config;
        const result={ purpose_key: value('key').trim(), label: value('label').trim(), group_id: Number(value('group')),
          ...(workflowOperations?{workflow_operations:['resolve',...['finalize','skip'].filter(operation=>checked(`operation-${operation}`))]}:{}),
          strategy: value('strategy'), advance_policy: value('advance'), advance_on_skip: checked('skip'), override_affects_next: checked('override-next'),
          eligibility_behavior: value('eligibility-behavior'),
          eligibility: { skill_ids: [...element.querySelector('[data-rotation-skills]').selectedOptions].map(option => Number(option.value)),
            include_supervised: checked('supervised'), presence_policy: value('presence'), presence_window: value('window'), place_id: Number(value('place')) || null } };
        if(group)Object.assign(result,{strategy:shared?.strategy||'rotating_order',advance_policy:'on_finalized',advance_on_skip:!!shared?.advance_on_skip,
          override_affects_next:shared?.override_affects_next!==false,eligibility_behavior:shared?.eligibility_behavior||'keep_position',eligibility:shared?.eligibility||{},period_date_offset_days:Number(value('period-offset'))||0,
          ...(workflowOperations?{workflow_operations:['resolve']}:{})});
        return result;
      });
    },
  };
}

export function renderRotationContext(contexts = [], { compact = false } = {}) {
  if (!contexts.length) return '';
  const ordinal = number => `${number}${number % 100 >= 11 && number % 100 <= 13 ? 'th' : ({1:'st',2:'nd',3:'rd'}[number % 10] || 'th')}`;
  return `<div class="task-rotation-context" data-task-rotation-context>${contexts.map(({purpose_key,label: purposeLabel,occurrence,position,reason,pending,recorded_completions=[]}) => {
    const label = purposeLabel || occurrence.label || purpose_key.replaceAll('_',' ');
    const provisional=pending||occurrence.status==='preview'||occurrence.provisional;
    if(!occurrence.order.length)return `<div><strong>${esc(label)}</strong><p class="form-hint">${esc(reason || 'No eligible member is available. An authorized household member can review this rotation.')}</p></div>`;
    return `<div><strong>${esc(label)}</strong>${position ? ` <span class="badge">${provisional?'Preview: ':''}${ordinal(position)}</span>` : ''}${compact
      ? `<span class="text-muted"> · ${provisional?'Provisional · ':''}${occurrence.order.map(member => esc(member.display_name)).join(' → ')}</span>`
      : `<p class="form-hint">${provisional?'Provisional order · confirmed when the scheduled period activates':occurrence.overridden_at?'Effective planned order':'Planned order'}</p><ol>${occurrence.order.map(member => `<li>${esc(member.display_name)}</li>`).join('')}</ol>
        ${recorded_completions.length?`<details data-rotation-recorded-completions data-disclosure-key="rotation-completions-${esc(purpose_key)}"><summary>Recorded completion order</summary>
          <p class="form-hint">Linked Task completion records, not proof of the order activities happened. Bulk or indistinguishable records have no inferred order.</p>
          <ul>${recorded_completions.map(group=>`<li><time>${esc(group.recorded_at)}</time>${group.unordered?' · Order not established':''}<ul>${group.events.map(event=>`<li>${esc(event.title)}${event.bulk?' · Bulk completion':''}</li>`).join('')}</ul></li>`).join('')}</ul></details>`:''}`}</div>`;
  }).join('')}</div>`;
}
