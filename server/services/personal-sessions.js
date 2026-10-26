/** Personal authentication lifetime and revocation. Shared display leases stay separate. */
import crypto from 'node:crypto';
export const DAY=86400000, IDLE=7*DAY, MAXIMUM=30*DAY, REMEMBER_COOKIE='vidamia.remember';
export const isPersonal=s=>!!s?.userId&&!s.deviceCredentialId&&(!s.wallMode||!!s.personalSession);
const digest=value=>crypto.createHash('sha256').update(value).digest('hex');
export function rememberCookie(req){
 const value=String(req.headers?.cookie||'').split(';').map(v=>v.trim()).find(v=>v.startsWith(REMEMBER_COOKIE+'='))?.slice(REMEMBER_COOKIE.length+1);
 return /^[a-f0-9]{64}$/.test(value||'')?value:null;
}
// Like the existing sessions table, these are owned by the session store and
// created idempotently before it serves requests. No release migration number.
export function ensurePersonalSessionSchema(d,now=Date.now()){
 d.exec(`CREATE TABLE IF NOT EXISTS personal_session_policy(id INTEGER PRIMARY KEY CHECK(id=1),started_at INTEGER NOT NULL);
 CREATE TABLE IF NOT EXISTS personal_auth_epochs(user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,epoch INTEGER NOT NULL DEFAULT 0);
 CREATE TABLE IF NOT EXISTS remembered_browsers(id INTEGER PRIMARY KEY,user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,token_hash TEXT NOT NULL UNIQUE,epoch INTEGER NOT NULL,created_at INTEGER NOT NULL,expires_at INTEGER NOT NULL,revoked_at INTEGER);
 CREATE INDEX IF NOT EXISTS remembered_browsers_user ON remembered_browsers(user_id);
 CREATE TABLE IF NOT EXISTS personal_session_revocations(sid TEXT PRIMARY KEY,revoked_at INTEGER NOT NULL);
 CREATE TRIGGER IF NOT EXISTS personal_session_deleted BEFORE DELETE ON sessions BEGIN
 INSERT OR IGNORE INTO personal_session_revocations(sid,revoked_at) VALUES(OLD.sid,CAST(strftime('%s','now') AS INTEGER)*1000); END;
 CREATE TRIGGER IF NOT EXISTS personal_password_changed AFTER UPDATE OF password_hash ON users WHEN OLD.password_hash IS NOT NEW.password_hash BEGIN
 INSERT INTO personal_auth_epochs(user_id,epoch) VALUES(NEW.id,1) ON CONFLICT(user_id) DO UPDATE SET epoch=epoch+1;
 UPDATE remembered_browsers SET revoked_at=CAST(strftime('%s','now') AS INTEGER)*1000 WHERE user_id=NEW.id AND revoked_at IS NULL; END;
 CREATE TRIGGER IF NOT EXISTS personal_factor_changed AFTER UPDATE OF secret,confirmed_at ON user_totp WHEN OLD.secret IS NOT NEW.secret OR OLD.confirmed_at IS NOT NEW.confirmed_at BEGIN
 INSERT INTO personal_auth_epochs(user_id,epoch) VALUES(NEW.user_id,1) ON CONFLICT(user_id) DO UPDATE SET epoch=epoch+1;
 UPDATE remembered_browsers SET revoked_at=CAST(strftime('%s','now') AS INTEGER)*1000 WHERE user_id=NEW.user_id AND revoked_at IS NULL; END;
 CREATE TRIGGER IF NOT EXISTS personal_factor_deleted AFTER DELETE ON user_totp BEGIN
 INSERT INTO personal_auth_epochs(user_id,epoch) VALUES(OLD.user_id,1) ON CONFLICT(user_id) DO UPDATE SET epoch=epoch+1;
 UPDATE remembered_browsers SET revoked_at=CAST(strftime('%s','now') AS INTEGER)*1000 WHERE user_id=OLD.user_id AND revoked_at IS NULL; END;`);
 d.prepare('INSERT OR IGNORE INTO personal_session_policy(id,started_at) VALUES(1,?)').run(now);
}
export function epoch(d,id){return d.prepare('SELECT epoch FROM personal_auth_epochs WHERE user_id=?').get(id)?.epoch||0;}
export function remembered(d,req,id,now=Date.now()){
 const token=rememberCookie(req);if(!token||req.headers?.cookie?.includes('vidamia.device='))return null;
 return d.prepare('SELECT * FROM remembered_browsers WHERE token_hash=? AND user_id=? AND epoch=? AND revoked_at IS NULL AND expires_at>?').get(digest(token),id,epoch(d,id),now)||null;
}
export function startPersonalSession(d,s,{factorAt=0,trust=null,now=Date.now()}={}){
 if(!isPersonal(s))return;
 s.personalSession={issuedAt:now,absoluteExpiresAt:Math.min(now+MAXIMUM,trust?.expires_at??Infinity),epoch:epoch(d,s.userId),factorAt,trustId:trust?.id??null};
 boundPersonalCookie(s);
}
export function boundPersonalCookie(s){
 if(!isPersonal(s)||!s.personalSession||s.cookieBound)return;
 const touch=s.touch;
 Object.defineProperty(s,'cookieBound',{value:true,enumerable:false});
 s.touch=function(){touch.call(this);this.cookie.maxAge=Math.max(0,Math.min(IDLE,this.personalSession.absoluteExpiresAt-Date.now()));return this;};
 s.touch();
}
export function validPersonalSession(d,s,now=Date.now()){
 if(!isPersonal(s))return true;
 if(!s.personalSession){
  // Legacy issuance is unknown. Its grace ceiling is fixed at first rollout,
  // persisted across restarts, and cannot be restarted by traffic or upgrades.
  const started=d.prepare('SELECT started_at FROM personal_session_policy WHERE id=1').get().started_at;
  if(epoch(d,s.userId)!==0||now>=started+MAXIMUM)return false;
  s.personalSession={issuedAt:started,absoluteExpiresAt:started+MAXIMUM,epoch:0,factorAt:0,trustId:null};
 }
 const p=s.personalSession;
 if(!Number.isFinite(p.absoluteExpiresAt)||now>=p.absoluteExpiresAt||p.epoch!==epoch(d,s.userId))return false;
 if(p.trustId&&!d.prepare('SELECT 1 FROM remembered_browsers WHERE id=? AND user_id=? AND epoch=? AND revoked_at IS NULL AND expires_at>?').get(p.trustId,s.userId,p.epoch,now))return false;
 return !!d.prepare('SELECT 1 FROM users WHERE id=?').get(s.userId);
}
export function personalExpiry(d,s,now=Date.now()){
 if(!validPersonalSession(d,s,now))return null;
 return isPersonal(s)?Math.min(now+IDLE,s.personalSession.absoluteExpiresAt):now+(s.cookie?.maxAge??IDLE);
}
export function enrollBrowser(d,req,res,now=Date.now()){
 const token=crypto.randomBytes(32).toString('hex');
 const prior=remembered(d,req,req.session.userId,now);if(prior)revokeBrowser(d,req.session.userId,prior.id,now);
 const id=Number(d.prepare('INSERT INTO remembered_browsers(user_id,token_hash,epoch,created_at,expires_at) VALUES(?,?,?,?,?)').run(req.session.userId,digest(token),epoch(d,req.session.userId),now,now+MAXIMUM).lastInsertRowid);
 req.session.personalSession.trustId=id;req.session.personalSession.absoluteExpiresAt=Math.min(req.session.personalSession.absoluteExpiresAt,now+MAXIMUM);
 res.cookie(REMEMBER_COOKIE,token,{httpOnly:true,secure:process.env.SESSION_SECURE==='true',sameSite:'lax',path:'/',maxAge:MAXIMUM});
}
export function revokeBrowser(d,userId,id,now=Date.now()){
 d.prepare('UPDATE remembered_browsers SET revoked_at=? WHERE user_id=? AND id=? AND revoked_at IS NULL').run(now,userId,id);
 d.prepare("DELETE FROM sessions WHERE json_extract(sess,'$.userId')=? AND json_extract(sess,'$.personalSession.trustId')=?").run(userId,id);
}
export function revokePresentedBrowser(d,req){
 const token=rememberCookie(req);if(!token)return;
 const row=d.prepare('SELECT id,user_id FROM remembered_browsers WHERE token_hash=?').get(digest(token));
 if(row)revokeBrowser(d,row.user_id,row.id);
}
export function revokeAllPersonal(d,userId,now=Date.now()){
 d.prepare('INSERT INTO personal_auth_epochs(user_id,epoch) VALUES(?,1) ON CONFLICT(user_id) DO UPDATE SET epoch=epoch+1').run(userId);
 d.prepare('UPDATE remembered_browsers SET revoked_at=? WHERE user_id=? AND revoked_at IS NULL').run(now,userId);
 d.prepare("DELETE FROM sessions WHERE json_extract(sess,'$.userId')=? AND json_extract(sess,'$.deviceCredentialId') IS NULL AND (COALESCE(json_extract(sess,'$.wallMode'),0)=0 OR json_extract(sess,'$.personalSession') IS NOT NULL)").run(userId);
}
