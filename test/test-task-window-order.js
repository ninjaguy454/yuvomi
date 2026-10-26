import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { orderTaskWindow, sliceTaskWindow, taskWindowQueryKey, diffAuthorizedTaskWindow } from '../server/services/task-window-order.js';

const source = readFileSync(new URL('../public/pages/tasks.js', import.meta.url), 'utf8');
const group = source.slice(source.indexOf('function groupBy('), source.indexOf('// Render-Bausteine', source.indexOf('function groupBy(')));
const due = source.slice(source.indexOf('function effectiveDue('), source.indexOf('function renderTaskGroups(', source.indexOf('function effectiveDue(')));
const order = source.slice(source.indexOf('function compareTaskField('), source.indexOf('function canCheckAndClaim(', source.indexOf('function compareTaskField(')));
const bucket = source.slice(source.indexOf('function taskBuckets('), source.indexOf('// Sichtbarkeits-Indikator',source.indexOf('function taskBuckets(')));
assert.ok(group.includes('function groupBy') && order.includes('function sortedTasks') && due.includes('function sortTasks'));

test('default category window has the same group and row order as the current List', () => {
  const categories = [{ key: 'family' }, { key: 'garden' }];
  const rows = [
    { id: 5, title: 'Zebra', category: 'garden', priority: 'low', due_date: null },
    { id: 3, title: 'Alpha', category: 'family', priority: 'high', due_date: '2026-11-02', due_time: '11:00' },
    { id: 2, title: 'Béta', category: 'family', priority: 'medium', due_date: '2026-10-31' },
    { id: 4, title: 'beta', category: 'family', priority: 'medium', due_date: '2026-10-31' },
    { id: 1, title: 'Other', category: 'unknown', priority: 'urgent', due_date: null },
  ];
  const context = vm.createContext({
    Intl, Date, Number, String, FALLBACK_CATEGORY: 'misc',
    PRIO_ORDER: { urgent:0, high:1, medium:2, low:3, none:4 },
    state: { categories, sheetSort: { field:'default', direction:'asc' }, bucketSorts:new Map() },
    getLocale: () => 'en', catSortIndex: key => categories.findIndex(row => row.key === key) < 0 ? Number.MAX_SAFE_INTEGER : categories.findIndex(row => row.key === key),
    catLabel: key => key, t: key => key,
  });
  vm.runInContext(group + '\n' + due + '\n' + order, context);
  context.rows = rows;
  const current = vm.runInContext("groupBy(rows,'category').map(g=>({id:g.id,ids:sortedTasks(g.tasks,`list:category:${g.id}`).map(row=>row.id)}))", context);
  const window = orderTaskWindow(rows, { groupMode:'category', categories, locale:'en', now:new Date(), sort:{field:'default',direction:'asc'} });
  assert.deepEqual(window.map(group => ({ id:group.id, ids:group.ids })), JSON.parse(JSON.stringify(current)));
});

test('title and due sort preserve direction, ties, missing dates, and locale collation', () => {
  const rows = [
    { id: 7, title: 'Zebra', due_date: null },
    { id: 2, title: 'eagle', due_date: '2026-11-01', due_time: '09:00' },
    { id: 3, title: '\u00c9agle', due_date: '2026-11-01', due_time: '09:00' },
    { id: 1, title: 'Bear', due_date: '2026-10-31', due_time: '10:00' },
  ];
  const context = vm.createContext({
    Intl, Date, Number, String, PRIO_ORDER: { urgent:0, high:1, medium:2, low:3, none:4 },
    state: { sheetSort:null, bucketSorts:new Map() }, getLocale:()=> 'en',
  });
  vm.runInContext(due + '\n' + order, context);
  context.rows = rows;
  for (const field of ['title', 'due']) for (const direction of ['asc', 'desc']) {
    context.state.sheetSort = { field, direction };
    const expected = vm.runInContext('sortedTasks(rows).map(row=>row.id)', context);
    const actual = orderTaskWindow(rows, { groupMode:'none', locale:'en', sort:{field,direction} })[0].ids;
    assert.deepEqual(actual, [...expected], `${field}/${direction}`);
  }
  assert.throws(() => orderTaskWindow(rows, { groupMode:'assignee' }), /descriptor missing/);
  assert.throws(() => orderTaskWindow(rows, { sort:{field:'progress'} }), /descriptor missing/);
});

test('due buckets match current calendar-day groups including closed occurrences', () => {
  const rows = [
    { id:1,title:'Old',due_date:'2026-10-20',status:'open' },
    { id:2,title:'Now',due_date:'2026-10-21',status:'open' },
    { id:3,title:'Week',due_date:'2026-10-23',status:'open' },
    { id:4,title:'Next',due_date:'2026-10-27',status:'open' },
    { id:5,title:'Later',due_date:'2026-11-10',status:'open' },
    { id:6,title:'None',due_date:null,status:'open' },
    { id:7,title:'Closed',due_date:'2026-10-19',status:'closed_incomplete' },
  ];
  const labels = { overdue:'Overdue',today:'Today',thisWeek:'This week',nextWeek:'Next week',later:'Later',noDate:'No date' };
  const translations = Object.fromEntries(Object.entries(labels).map(([key,value])=>[`tasks.group${key[0].toUpperCase()}${key.slice(1)}`,value]));
  const context = vm.createContext({
    Intl, Date, Number, String, FALLBACK_CATEGORY:'misc',
    state:{categories:[],sheetSort:{field:'default',direction:'asc'},bucketSorts:new Map()},
    getLocale:()=> 'en', todayKey:()=> '2026-10-21',
    parseLocalDateKey:value=>new Date(`${value}T12:00:00`),
    isClosedOccurrence:row=>['expired','skipped','closed_incomplete'].includes(row.status),
    closedOccurrenceLabel:row=>row.status==='closed_incomplete'?'Closed without completing remaining subtasks':row.status==='skipped'?'Skipped':'Expired',
    t:key=>translations[key] || key,
  });
  vm.runInContext(group,context);context.rows=rows;
  const expected=vm.runInContext("groupBy(rows,'due').map(g=>({id:g.id,ids:g.tasks.map(row=>row.id)}))",context);
  const actual=orderTaskWindow(rows,{groupMode:'due',today:'2026-10-21',labels});
  assert.deepEqual(actual.map(g=>({id:g.id,ids:g.ids})),JSON.parse(JSON.stringify(expected)));
});

test('equal localized group labels have stable IDs across page boundaries',()=>{
  const rows=[{id:3,title:'Third',category:'b'}, {id:1,title:'First',category:'a'}];
  const view={groupMode:'category',sort:{field:'title',direction:'asc'},
    categories:[],categoryLabel:()=> 'Same',limit:1};
  const first=sliceTaskWindow(orderTaskWindow(rows,view),view);
  const reordered=sliceTaskWindow(orderTaskWindow([...rows].reverse(),view),view);
  assert.deepEqual(first.groups.map(row=>row.id),['a','b']);
  assert.deepEqual(reordered.groups.map(row=>row.id),['a','b']);
  assert.deepEqual(first.ids,reordered.ids);
});

test('recomputed authorized window admits off-page entrant and refills removal boundary', () => {
  const rows = [
    { id:1,title:'A',priority:'low',due_date:'2026-11-01' },
    { id:2,title:'B',priority:'low',due_date:'2026-11-02' },
    { id:3,title:'C',priority:'low',due_date:'2026-11-03' },
    { id:4,title:'D',priority:'low',due_date:'2026-11-04' },
  ];
  const window = current => sliceTaskWindow(orderTaskWindow(current,{groupMode:'none',now:new Date('2026-10-21T12:00:00Z')}),{limit:2});
  assert.deepEqual(window(rows).ids,[1,2]);
  rows[3].due_date='2026-10-22';
  assert.deepEqual(window(rows).ids,[4,1],'changed off-window row enters first page');
  assert.deepEqual(window(rows.filter(row=>row.id!==4)).ids,[1,2],'removal refills page');
  assert.deepEqual(window(rows.filter(row=>row.id!==1)).ids,[4,2],'permission revocation removes ID and refills');
  assert.deepEqual(sliceTaskWindow([{id:'family',ids:[1,2,3],total:3}],{limit:2,collapsed:['family']}),
    {groups:[{id:'family',total:3,loaded:0,ids:[]}],ids:[],total:0,next_offset:null});
});

test('location groups and location sort match current browser projection',()=>{
  const rows=[
    {id:1,title:'A',location:{place_id:14,label:'Zoo'},location_label:'Zoo',location_place_id:14},
    {id:2,title:'B',location:{label:'Bakery'},location_label:'Bakery'},
    {id:3,title:'C',location:null,location_label:''},
    {id:4,title:'D',location:{place_id:12,label:'Apple'},location_label:'Apple',location_place_id:12},
  ];
  const context=vm.createContext({
    Intl, Date, Number, String, PRIO_ORDER:{urgent:0,high:1,medium:2,low:3,none:4},
    state:{sheetSort:{field:'location',direction:'asc'},bucketSorts:new Map(),users:[]},
    getLocale:()=> 'en',taskLocationLabel:row=>row.location?.label||row.location?.address||row.activity_place_name||'',
    t:key=>key==='tasks.groupNoLocation'?'No location':key,
  });
  vm.runInContext(bucket+'\n'+due+'\n'+order,context);context.rows=rows;
  const expected=vm.runInContext("taskBuckets(rows,'location').map(g=>({id:g.id,ids:sortedTasks(g.tasks).map(row=>row.id)}))",context);
  const actual=orderTaskWindow(rows,{groupMode:'location',locale:'en',labels:{noLocation:'No location'},sort:{field:'location',direction:'asc'}});
  assert.deepEqual(actual.map(g=>({id:g.id,ids:g.ids})),JSON.parse(JSON.stringify(expected)));
});

test('active status groups retain browser order without an Archive group',()=>{
  const rows=[
    {id:1,title:'Done',status:'done'},
    {id:2,title:'Open',status:'open'},
    {id:3,title:'Filed',status:'open',archived_at:'2026-10-20'},
    {id:4,title:'Working',status:'in_progress'},
  ];
  const statuses=['open','in_progress','done'];
  const context=vm.createContext({
    Intl, Date, Number, String, PRIO_ORDER:{urgent:0,high:1,medium:2,low:3,none:4},
    state:{sheetSort:{field:'title',direction:'asc'},bucketSorts:new Map(),users:[]},
    getLocale:()=> 'en',STATUSES:()=>statuses.map(value=>({value,label:value})),
    kanbanColumnOf:row=>row.archived_at?'archived':row.status,
    t:key=>key==='tasks.statusArchived'?'Archived':key,
  });
  vm.runInContext(bucket+'\n'+due+'\n'+order,context);context.rows=rows;
  const expected=vm.runInContext("taskBuckets(rows,'status').map(g=>({id:g.id,ids:sortedTasks(g.tasks).map(row=>row.id)}))",context);
  // The active SQL query excludes archived descriptors before ordering; the
  // browser also excludes that bucket. Archive has its own query and menu.
  const actual=orderTaskWindow(rows.filter(row=>!row.archived_at),{groupMode:'status',statusOrder:statuses,sort:{field:'title',direction:'asc'}});
  assert.deepEqual(actual.map(g=>({id:g.id,ids:g.ids})),JSON.parse(JSON.stringify(expected)));
});

test('window identity changes for membership, display order, and page boundary',()=>{
  const base={groupMode:'category',sort:{field:'title',direction:'asc'},locale:'en',
    timeZone:'America/New_York',today:'2026-10-21',categories:[{key:'misc',name:'Misc'}],
    bucketSorts:new Map([['list:category:misc',{field:'due',direction:'asc'}]]),
    offset:0,limit:30,collapsed:[]};
  const key=taskWindowQueryKey({status:'open',delta:'ignored'},base);
  assert.equal(key,taskWindowQueryKey({status:'open'},base),'transport cursor is excluded');
  const changed=[
    [{status:'done'},base],
    [{status:'open',search:'milk'},base],
    [{status:'open'},{...base,sort:{field:'due',direction:'asc'}}],
    [{status:'open'},{...base,bucketSorts:new Map([['list:category:misc',{field:'default',direction:'asc'}]])}],
    [{status:'open'},{...base,categories:[{key:'misc',name:'Other'}]}],
    [{status:'open'},{...base,locale:'de'}],
    [{status:'open'},{...base,timeZone:'Europe/Berlin'}],
    [{status:'open'},{...base,today:'2026-10-22'}],
    [{status:'open'},{...base,collapsed:['misc']}],
    [{status:'open'},{...base,offset:30}],
  ];
  for(const [filter,view] of changed)assert.notEqual(taskWindowQueryKey(filter,view),key);
  assert.equal(taskWindowQueryKey({status:'open'},base,{includeOffset:false}),
    taskWindowQueryKey({status:'open'},{...base,offset:30},{includeOffset:false}),
    'page navigation shares a scope key but never a page identity');
});

test('page delta sends only newly visible or changed authorized rows and ID-only removals',()=>{
  const page=ids=>({ids,groups:[{id:'all',total:4,ids}],total:4,next_offset:2});
  const old={...page([1,2]),query_key:'same'};
  assert.deepEqual(diffAuthorizedTaskWindow(old,page([1,2]),[4],'same').hydrate_ids,[],
    'an off-page edit after the boundary has no visible card payload');
  const moved=diffAuthorizedTaskWindow(old,page([4,1]),[4],'same');
  assert.deepEqual(moved.hydrate_ids,[4]);assert.deepEqual(moved.removed,[2]);
  const revoked=diffAuthorizedTaskWindow(old,page([2,3]),[1],'same');
  assert.deepEqual(revoked.removed,[1]);assert.deepEqual(revoked.hydrate_ids,[3]);
  assert.equal(diffAuthorizedTaskWindow(old,page([1,2]),[],'new').reset_required,true);
});
