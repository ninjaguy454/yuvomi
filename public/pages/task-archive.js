import {api} from '/api.js';
import {t,getLocale} from '/i18n.js';
import {esc} from '/utils/html.js';

const PAGE_SIZE=30;
let activePage=null;

function windowUrl(search,offset,cursor){
  const view={groupMode:'none',sort:{field:'title',direction:'asc'},offset,limit:PAGE_SIZE,
    locale:getLocale(),timeZone:Intl.DateTimeFormat().resolvedOptions().timeZone||'UTC',
    categories:[],collapsed:[],bucketSorts:{},categoryLabels:{}};
  const params=new URLSearchParams({archived:'only',view:JSON.stringify(view)});
  if(search)params.set('search',search);
  if(cursor)params.set('page_cursor',cursor);
  return `/tasks/window?${params}`;
}

function rowsHtml(rows){
  return rows.map(row=>{
    const stamp=row.archived_at?new Date(row.archived_at):null;
    const date=stamp&&!Number.isNaN(stamp.valueOf())
      ?new Intl.DateTimeFormat(getLocale(),{dateStyle:'medium'}).format(stamp):'';
    const canRestore=row.permissions?.delete_archive===true;
    return `<li class="task-archive__row" data-archive-id="${Number(row.id)}">
      <div class="task-archive__details">
        <a href="/tasks?open=${Number(row.id)}" data-route="/tasks?open=${Number(row.id)}" class="task-archive__title">${esc(row.title)}</a>
        <span class="form-hint">${esc(t('tasks.archivedLabel'))}${date?`: ${esc(date)}`:''}</span>
      </div>
      ${canRestore?`<button class="btn btn--secondary btn--sm" type="button" data-archive-restore="${Number(row.id)}">${esc(t('tasks.unarchiveButton'))}</button>`:''}
    </li>`;
  }).join('');
}

function paint(page){
  if(activePage!==page||!page.container.isConnected)return;
  const results=page.container.querySelector('#task-archive-results');
  if(!results)return;
  results.innerHTML=page.loading&&!page.rows.length
    ?`<p class="task-archive__empty">${esc(t('common.loading'))}</p>`
    :page.rows.length
    ?`<ul class="task-archive__list">${rowsHtml(page.rows)}</ul>`
    :`<p class="task-archive__empty">${esc(page.search?t('tasks.noResultsTitle'):t('documents.emptyArchivedTitle'))}</p>`;
  page.container.querySelector('#task-archive-count').textContent=t('tasks.windowLoadedStatus',{loaded:page.rows.length,total:page.total});
  const more=page.container.querySelector('#task-archive-more');
  more.hidden=!page.nextCursor;
  more.disabled=page.loading;
  const error=page.container.querySelector('#task-archive-error');
  error.textContent=page.error||'';
  page.container.querySelector('#task-archive-retry').hidden=!page.error;
  if(window.lucide)window.lucide.createIcons({el:page.container});
}

async function load(page,{more=false,retry=true}={}){
  if(activePage!==page||page.loading)return;
  const generation=++page.generation;
  page.loading=true;page.error='';
  const search=page.search,offset=more?page.rows.length:0,cursor=more?page.nextCursor:null;
  if(!more){page.rows=[];page.total=0;page.nextCursor=null;}
  paint(page);
  try{
    const response=await api.get(windowUrl(search,offset,cursor),{requireFresh:true});
    if(activePage!==page||generation!==page.generation)return;
    if(response.reset_required){
      if(more&&retry){page.loading=false;return load(page,{retry:false});}
      throw new Error(t('common.errorOccurred'));
    }
    // The archive endpoint must be the only source for this view. A defensive
    // check avoids rendering an active row if a stale server response arrives.
    if(!response.data?.every(row=>row.archived_at))throw new Error(t('common.errorOccurred'));
    const seen=new Set(page.rows.map(row=>row.id));
    page.rows=[...page.rows,...response.data.filter(row=>!seen.has(row.id))];
    page.total=Number(response.total)||0;
    page.nextCursor=response.next_cursor||null;
  }catch(error){
    if(activePage===page&&generation===page.generation)page.error=error.message||t('common.errorOccurred');
  }finally{
    if(activePage===page&&generation===page.generation){page.loading=false;paint(page);}
  }
}

export async function render(container){
  if(activePage)activePage.generation++;
  const page={container,rows:[],search:'',total:0,nextCursor:null,loading:false,error:'',generation:0};
  activePage=page;
  container.innerHTML=`<section class="task-archive page-measure--narrow">
    <div class="page-toolbar page-toolbar--wrap">
      <h1 class="page-toolbar__title">${esc(t('nav.archive'))}</h1>
      <form id="task-archive-search-form" role="search" class="task-archive__search">
        <label for="task-archive-search">${esc(t('tasks.searchPlaceholder'))}</label>
        <input id="task-archive-search" type="search" autocomplete="off" placeholder="${esc(t('tasks.searchPlaceholder'))}">
      </form>
    </div>
    <p id="task-archive-count" class="form-hint" aria-live="polite"></p>
    <p id="task-archive-error" class="form-error" role="alert"></p>
    <button id="task-archive-retry" class="btn btn--secondary" type="button" hidden>${esc(t('common.retry'))}</button>
    <div id="task-archive-results" aria-live="polite"></div>
    <button id="task-archive-more" class="btn btn--secondary" type="button" hidden>${esc(t('notes.showMore'))}</button>
  </section>`;
  let debounce;
  const input=container.querySelector('#task-archive-search');
  const search=()=>{
    const value=input.value.trim();
    if(value===page.search)return;
    page.search=value;page.generation++;page.loading=false;
    load(page);
  };
  input.addEventListener('input',()=>{clearTimeout(debounce);debounce=setTimeout(search,250);});
  container.querySelector('#task-archive-search-form').addEventListener('submit',event=>{
    event.preventDefault();clearTimeout(debounce);search();
  });
  container.querySelector('#task-archive-more').addEventListener('click',()=>load(page,{more:true}));
  container.querySelector('#task-archive-retry').addEventListener('click',()=>load(page));
  container.querySelector('#task-archive-results').addEventListener('click',async event=>{
    const button=event.target.closest('[data-archive-restore]');
    if(!button||page.loading)return;
    const id=Number(button.dataset.archiveRestore),row=page.rows.find(item=>Number(item.id)===id);
    if(!row||row.permissions?.delete_archive!==true)return;
    const priorIndex=page.rows.indexOf(row);
    button.disabled=true;button.textContent=t('common.saving');
    try{
      await api.patch(`/tasks/${id}/archive`,{archived:false,expected_revision:row.revision});
      if(activePage!==page)return;
      window.yuvomi?.showToast?.(t('tasks.unarchivedToast'),'success');
      await load(page);
      if(activePage===page){
        const links=page.container.querySelectorAll('.task-archive__title');
        (links[Math.min(priorIndex,links.length-1)]||input).focus({preventScroll:true});
      }
    }catch(error){
      if(activePage===page){
        page.error=error.message||t('common.errorOccurred');
        page.container.querySelector('#task-archive-error').textContent=page.error;
        page.container.querySelector('#task-archive-retry').hidden=false;
      }
    }finally{
      if(activePage===page&&button.isConnected){
        button.disabled=false;button.textContent=t('tasks.unarchiveButton');button.focus({preventScroll:true});
      }
    }
  });
  await load(page);
}
