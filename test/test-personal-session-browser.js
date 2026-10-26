import test from 'node:test';
import assert from 'node:assert/strict';
import {fork} from 'node:child_process';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import puppeteer from 'puppeteer';
const folder=mkdtempSync(join(tmpdir(),'vidamia-personal-session-'));
Object.assign(process.env,{DB_PATH:join(folder,'synthetic.db'),SESSION_SECRET:'synthetic-browser-continuity',SESSION_SECURE:'false',LOG_LEVEL:'error',BACKUP_ENABLED:'false',AUTH_ALLOW_PASSWORD_LOGIN:'true',RATE_LIMIT_MAX_ATTEMPTS:'1000'});
delete process.env.DB_ENCRYPTION_KEY;
const {get}=await import('../server/db.js');
const {hashPassword}=await import('../server/utils/password.js');
const {generateCode}=await import('../server/utils/totp.js');
const d=get(),password='synthetic-browser-password',secret='JBSWY3DPEHPK3PXP';
d.prepare("INSERT INTO users(id,username,display_name,password_hash,role,onboarding_version) VALUES(1,'browser','Browser',?,'admin',1)").run(await hashPassword(password,4));
d.prepare('INSERT INTO user_totp(user_id,secret,confirmed_at) VALUES(1,?,?)').run(secret,new Date().toISOString());
let server,browser,page,origin;
async function start(){
 server=fork(new URL('./helpers/note-board-full-app-server.mjs',import.meta.url),[],{env:{...process.env,PORT:'0'},stdio:['ignore','pipe','pipe','ipc']});
 let log='';for(const s of [server.stdout,server.stderr])s.on('data',v=>log=(log+v).slice(-2000));
 origin=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error(log)),45000);server.once('message',v=>{clearTimeout(timer);resolve(v.origin);});server.once('exit',code=>{clearTimeout(timer);reject(Error(`Synthetic server exited ${code}: ${log}`));});});
}
test.before(async()=>{await start();browser=await puppeteer.launch({headless:true,executablePath:process.env.PUPPETEER_EXECUTABLE_PATH||'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',args:[]});page=await browser.newPage();page.setDefaultTimeout(20000);});
test.after(async()=>{await browser?.close();server?.kill();});
test('personal browser enrollment is opt-in, survives reload/restart, and logout forgets trust',async()=>{
 await page.goto(origin+'/login');await page.waitForSelector('#username');await page.type('#username','browser');await page.type('#password',password);await page.click('#auth-btn');await page.waitForSelector('#remember-browser');
 assert.equal(await page.$eval('#remember-browser',e=>e.checked),false);
 await page.click('#remember-browser');await page.type('#two-factor-code',generateCode(secret));await page.click('#two-factor-btn');
 await page.waitForFunction(()=>location.pathname==='/');
 const cookies=await page.cookies();const remembered=cookies.find(c=>c.name==='vidamia.remember'),session=cookies.find(c=>c.name==='yuvomi.sid');
 assert.ok(remembered?.httpOnly);assert.equal(remembered.sameSite,'Lax');assert.ok(session?.httpOnly);assert.ok(session.expires>Date.now()/1000+6*86400);
 const before=await page.evaluate(async()=>{const r=await fetch('/api/v1/auth/me');return r.status;});assert.equal(before,200);
 await page.reload();assert.equal(await page.evaluate(async()=>(await fetch('/api/v1/auth/me')).status),200);
 // Restart the real application process on the same synthetic database/key.
 const old=server;old.kill();await new Promise(r=>old.once('exit',r));await start();
 await page.goto(origin+'/');assert.equal(await page.evaluate(async()=>(await fetch('/api/v1/auth/me')).status),200);
 await page.deleteCookie({name:'yuvomi.sid',url:origin});await page.goto(origin+'/login');await page.waitForSelector('#username');await page.type('#username','browser');await page.type('#password',password);await page.click('#auth-btn');await page.waitForFunction(()=>location.pathname==='/');assert.equal(await page.$('#two-factor-form'),null);
 await page.goto(origin+'/settings/personal/account');await page.waitForSelector('[data-remembered-list] button');assert.match(await page.$eval('[data-remembered-list]',e=>e.textContent),/This browser/);
 await page.evaluate(async()=>{const csrf=document.cookie.split(';').map(x=>x.trim()).find(x=>x.startsWith('csrf-token='))?.slice(11);await fetch('/api/v1/auth/logout',{method:'POST',headers:{'content-type':'application/json','x-csrf-token':csrf},body:'{}'});});
 await page.goto(origin+'/login');await page.waitForSelector('#username');await page.type('#username','browser');await page.type('#password',password);await page.click('#auth-btn');await page.waitForSelector('#remember-browser');assert.equal(await page.$eval('#remember-browser',e=>e.checked),false);
});
test('sign-out-everywhere clears another open tab through the existing session broadcast',{timeout:30000},async()=>{
 await page.goto(origin+'/login');
 d.prepare('UPDATE user_totp SET last_step=NULL WHERE user_id=1').run();
 const status=await page.evaluate(async({password,code})=>{await fetch('/api/v1/auth/login',{method:'POST',signal:AbortSignal.timeout(10000),headers:{'content-type':'application/json'},body:JSON.stringify({username:'browser',password})});return (await fetch('/api/v1/auth/2fa/verify',{method:'POST',signal:AbortSignal.timeout(10000),headers:{'content-type':'application/json'},body:JSON.stringify({code,remember_browser:true})})).status;},{password,code:generateCode(secret)});assert.equal(status,200);
 await page.goto(origin+'/');await page.waitForFunction(()=>!!window.yuvomi);
 const other=await browser.newPage();try{
  await other.goto(origin+'/');await other.waitForFunction(()=>!!window.yuvomi);
  await page.bringToFront();await page.goto(origin+'/settings/personal/account');await page.waitForSelector('[data-sign-out-everywhere]');
  // Authenticated pages intentionally keep event streams open; network-idle
  // is not an initialization signal. Wait for canonical account data instead.
  await page.waitForSelector('[data-remembered-list] button');
  const signout=page.waitForResponse(r=>r.url().endsWith('/auth/sign-out-everywhere'),{timeout:5000});
  // Use an ordinary keyboard action after the page regains foreground focus.
  // This also verifies the real account control, rather than invoking its
  // click handler directly from the test.
  await page.focus('[data-sign-out-everywhere]');
  await page.waitForFunction(()=>document.activeElement?.matches('[data-sign-out-everywhere]'));
  await page.keyboard.press('Enter');
  const result=await signout;assert.equal(result.status(),200);
  await page.waitForFunction(()=>location.pathname==='/login');await other.bringToFront();await other.waitForFunction(()=>location.pathname==='/login');
 }finally{await other.close();}
});
