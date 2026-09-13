/** Modern-client snapshot for existing positive HTTP fixtures. Release tests
 * intentionally exercising missing/stale tokens do not use this helper.
 * Explicit tokens are never replaced, so existing stale-write assertions keep
 * their original meaning. This helper is test-only and never installed in an
 * application router or the browser API client. */
export function modernTaskMutationBody(database,method,path,body) {
  if(!['POST','PUT','PATCH','DELETE'].includes(method))return body;
  if(body!==undefined&&(!body||typeof body!=='object'||Array.isArray(body)))return body;
  const d=typeof database.prepare==='function'?database:database.get();
  const value=body&&typeof body==='object'?{...body}:{};
  const route=path.split('?')[0].replace(/^\/api(?:\/v1)?(?=\/)/,'').replace(/\/+$/,'')||'/';
  const taskPath=route.replace(/^\/tasks(?=\/|$)/,'')||'/';
  const taskMatch=/^\/(\d+)(?:\/(?:status|archive|check|documents|comments(?:\/\d+)?|supervisor|location\/promote))?$/.exec(taskPath);
  const automation=/^\/automation\/tasks\/(\d+)\/(?:claim|assignment)$/.exec(route);
  const obligation=/^\/automation\/obligations\/(\d+)\/respond$/.exec(route);
  const visit=/^\/housekeeping\/visits\/(\d+)(?:\/pay)?$/.exec(route);
  let id=taskMatch?.[1]||automation?.[1];
  if(obligation)id=d.prepare('SELECT task_id FROM planning_obligations WHERE id=?').get(obligation[1])?.task_id;
  if(visit)id=d.prepare('SELECT payment_task_id FROM housekeeping_work_sessions WHERE id=?').get(visit[1])?.payment_task_id;
  if(id){
    const row=d.prepare('SELECT revision,parent_task_id FROM tasks WHERE id=?').get(Number(id));
    if(row){
      if(value.expected_revision===undefined)value.expected_revision=row.revision;
      if(row.parent_task_id&&value.expected_parent_revision===undefined)value.expected_parent_revision=d.prepare('SELECT revision FROM tasks WHERE id=?').get(row.parent_task_id)?.revision;
      if(taskPath.endsWith('/supervisor')&&row.parent_task_id){
        const source=d.prepare('SELECT source_task_id FROM task_supervision_actions WHERE action_task_id=? OR counterpart_task_id=?').get(Number(id),Number(id))?.source_task_id||row.parent_task_id;
        if(value.expected_source_revision===undefined)value.expected_source_revision=d.prepare('SELECT revision FROM tasks WHERE id=?').get(source)?.revision;
      }
    }
    return value;
  }
  if(method==='POST'&&taskPath==='/'&&value.parent_task_id){
    if(value.expected_parent_revision===undefined)value.expected_parent_revision=d.prepare('SELECT revision FROM tasks WHERE id=?').get(value.parent_task_id)?.revision;
    return value;
  }
  return body;
}

export function modernTaskFetch(database,url,options={}) {
  const method=options.method||'GET';
  let body;
  try {body=options.body===undefined?undefined:JSON.parse(options.body);}catch{return fetch(url,options);}
  const next=modernTaskMutationBody(database,method,new URL(url).pathname,body);
  return fetch(url,next===body?options:{...options,headers:{...options.headers,'Content-Type':'application/json'},body:JSON.stringify(next)});
}
