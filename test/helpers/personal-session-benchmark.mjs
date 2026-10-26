// Local synthetic comparison. Pass an isolated checkout root; emits no cookies.
import express from 'express';
import {pathToFileURL} from 'node:url';
import {resolve} from 'node:path';
import {performance} from 'node:perf_hooks';
Object.assign(process.env,{DB_PATH:':memory:',SESSION_SECRET:'synthetic-session-benchmark',SESSION_SECURE:'false',LOG_LEVEL:'error'});delete process.env.DB_ENCRYPTION_KEY;
const root=resolve(process.argv[2]||'.'),load=p=>import(pathToFileURL(resolve(root,p)).href);
const {get}=await load('server/db.js'),d=get();
const {sessionMiddleware,setupAuthSession}=await load('server/auth.js');
d.prepare("INSERT INTO users(id,username,display_name,password_hash,role) VALUES(1,'bench','Bench','no-login','member')").run();
let trust;
if(process.argv[3]==='remembered'){
 d.prepare('INSERT INTO remembered_browsers(user_id,token_hash,epoch,created_at,expires_at) VALUES(1,?,0,?,?)').run('synthetic-unused-benchmark-hash',Date.now(),Date.now()+30*86400000);
 trust=d.prepare('SELECT * FROM remembered_browsers WHERE user_id=1').get();
}
const app=express();app.use(sessionMiddleware);app.post('/login',async(req,res)=>{await setupAuthSession(req,res,{id:1,role:'member'},{trust});res.json({ok:true});});app.get('/identity',(req,res)=>res.sendStatus(req.session.userId?200:401));app.get('/static.js',(_req,res)=>res.type('js').send('export const synthetic=true;'));
const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.on('listening',r));const base=`http://127.0.0.1:${server.address().port}`;
const response=await fetch(base+'/login',{method:'POST'});const cookie=response.headers.getSetCookie().find(x=>x.startsWith('yuvomi.sid=')).split(';')[0];await response.text();
const change=()=>d.prepare('SELECT total_changes() n').get().n;
const results={};
for(const path of ['/identity','/static.js']){
 for(let i=0;i<30;i++)await (await fetch(base+path,{headers:{cookie}})).text();
 const times=[],before=change();
 for(let i=0;i<300;i++){const start=performance.now();const r=await fetch(base+path,{headers:{cookie}});await r.text();times.push(performance.now()-start);}
 times.sort((a,b)=>a-b);results[path]={n:times.length,p50_ms:times[149],p95_ms:times[284],sqlite_changes:change()-before};
}
console.log(JSON.stringify({root,remembered:!!trust,results}));server.close();
