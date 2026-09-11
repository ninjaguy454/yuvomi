// Isolated synthetic household for the Availability browser acceptance gate.
// Never import a deployment .env or use a caller-supplied database path.
import { mkdirSync } from 'node:fs';
import path from 'node:path';
const root = path.resolve(import.meta.dirname, '..');
const qa = path.join(root, '.qa');
mkdirSync(qa, { recursive: true });
process.env.DB_PATH = path.join(qa, 'availability-browser-v2.db');
process.env.DB_ENCRYPTION_KEY = '';
process.env.SESSION_SECRET = 'isolated-availability-browser-qa-not-for-production';
process.env.SESSION_SECURE = 'false';
process.env.BACKUP_ENABLED = 'false';
process.env.BACKUP_DIR = path.join(qa, 'backups');
process.env.DOCUMENTS_DIR = path.join(qa, 'documents');
process.env.PORT = '3197';
process.env.TZ = 'America/New_York';
process.env.NODE_ENV = 'development';
const { get } = await import('../server/db.js');
const { hashPassword } = await import('../server/utils/password.js');
const { saveTrip } = await import('../server/services/trips.js');
const d = get();
const password = 'AvailabilityQA!2026';
const hash = await hashPassword(password);
const insertUser = d.prepare('INSERT INTO users(username,display_name,password_hash,role,family_role) VALUES(?,?,?,?,?)');
if (!d.prepare("SELECT 1 FROM users WHERE username='availability-qa'").get()) {
  d.transaction(() => {
  const admin = Number(insertUser.run('availability-qa','QA Admin',hash,'admin','parent').lastInsertRowid);
  const weekly = Number(insertUser.run('weekly-qa','Morgan Weekly',hash,'member','parent').lastInsertRowid);
  const alternating = Number(insertUser.run('alternating-qa','Riley Alternating',hash,'member','parent').lastInsertRowid);
  const rotating = Number(insertUser.run('rotating-qa','Taylor Rotation',hash,'member','parent').lastInsertRowid);
  const overnight = Number(insertUser.run('overnight-qa','Alex Overnight',hash,'member','parent').lastInsertRowid);
  const unknown = Number(insertUser.run('unknown-qa','Casey Unconfigured',hash,'member','parent').lastInsertRowid);
  const home = Number(d.prepare("SELECT id FROM places WHERE type='home' ORDER BY id LIMIT 1").get().id);
  const work = Number(d.prepare("INSERT INTO places(name,type) VALUES('QA Workplace','work')").run().lastInsertRowid);
  const destination = Number(d.prepare("INSERT INTO places(name,type) VALUES('QA Travel Destination','destination')").run().lastInsertRowid);
  d.prepare("INSERT INTO sync_config(key,value) VALUES('household_timezone','America/New_York') ON CONFLICT(key) DO UPDATE SET value=excluded.value").run();
  d.prepare("INSERT INTO sync_config(key,value) VALUES('app_name','Vidamia QA') ON CONFLICT(key) DO UPDATE SET value=excluded.value").run();
  d.prepare("INSERT INTO availability_rules(user_id,name,weekdays_json,start_time,end_time,state,place_id,created_by) VALUES(?,?,?,?,?,?,?,?)").run(weekly,'Weekday work','[0,1,2,3,4]','08:00','16:00','busy',work,admin);
  const day = Number(d.prepare('INSERT INTO schedule_shift_types(name,short_code,start_time,end_time,color,availability_state,place_id,created_by) VALUES(?,?,?,?,?,?,?,?)').run('Day shift','D','08:00','16:00','#15803D','busy',work,admin).lastInsertRowid);
  const night = Number(d.prepare('INSERT INTO schedule_shift_types(name,short_code,start_time,end_time,color,availability_state,place_id,created_by) VALUES(?,?,?,?,?,?,?,?)').run('Night shift','N','22:00','06:00','#4338CA','busy',work,admin).lastInsertRowid);
  function pattern(user,name,anchor,length,assignments) {
    const id = Number(d.prepare('INSERT INTO schedule_patterns(user_id,name,anchor_date,cycle_length) VALUES(?,?,?,?)').run(user,name,anchor,length).lastInsertRowid);
    for (const [position,shift] of assignments) d.prepare('INSERT INTO schedule_pattern_days(pattern_id,position,shift_type_id) VALUES(?,?,?)').run(id,position,shift);
    return id;
  }
  pattern(alternating,'Week A / Week B','2026-09-07',14,Array.from({length:14},(_,i)=>[i,i<5 ? day : null]));
  pattern(rotating,'Four on / four off','2026-09-11',8,Array.from({length:8},(_,i)=>[i,i<4 ? day : null]));
  pattern(overnight,'Night rotation','2026-09-11',2,[[0,night],[1,null]]);
  pattern(unknown,'Needs day assignments','2026-09-11',8,[]);
  d.prepare('INSERT INTO schedule_overrides(user_id,date_key,shift_type_id,note) VALUES(?,?,NULL,?)').run(rotating,'2026-09-12','Day off this work routine');
  saveTrip(d,{name:'QA trip exception',destination_place_id:destination,starts_at:'2026-09-13T00:00:00',ends_at:'2026-09-15T00:00:00',participant_ids:[rotating],status:'active',create_away_periods:true,tasks:[]},admin);
  d.prepare("INSERT INTO activity_templates(name,title_template,assignment_strategy,fixed_user_id,presence_policy,presence_window) VALUES('QA work-aware task','QA work-aware task','fixed',?,'available_before_due','due')").run(rotating);
  // A dated manual location belief remains separate from availability capacity.
  d.prepare("INSERT INTO availability_periods(user_id,source,state,place_id,starts_at,ends_at,note) VALUES(?,'manual','unknown',?,?,?,'Manual location belief for QA')").run(admin,home,'2026-09-11T00:00:00','2026-09-12T00:00:00');
  console.log('Synthetic household seeded. Schedule remains disabled by its historical default.');
  })();
}
// Add this regression case on both a fresh seed and an existing QA household.
// Calendar can explain a location without becoming an availability restriction.
d.transaction(() => {
  let calendarUser = d.prepare("SELECT id FROM users WHERE username='calendar-qa'").get();
  if (!calendarUser) calendarUser = { id: Number(insertUser.run('calendar-qa', 'Jordan Calendar', hash, 'member', 'parent').lastInsertRowid) };
  const admin = d.prepare("SELECT id FROM users WHERE username='availability-qa'").get();
  const workplace = d.prepare("SELECT id FROM places WHERE name='QA Workplace' ORDER BY id LIMIT 1").get();
  let event = d.prepare("SELECT id FROM calendar_events WHERE title='QA advisory Calendar day' AND assigned_to=? AND start_datetime='2026-09-11T00:00:00' ORDER BY id LIMIT 1").get(calendarUser.id);
  if (!event) event = { id: Number(d.prepare(`INSERT INTO calendar_events
    (title,start_datetime,end_datetime,all_day,assigned_to,created_by,place_id)
    VALUES('QA advisory Calendar day','2026-09-11T00:00:00','2026-09-12T00:00:00',1,?,?,?)
  `).run(calendarUser.id, admin.id, workplace?.id ?? null).lastInsertRowid) };
  d.prepare('INSERT OR IGNORE INTO event_assignments(event_id,user_id) VALUES(?,?)').run(event.id, calendarUser.id);
})();
// Keep the test household accessible only on loopback.
const { default: express } = await import('express');
// The isolated checkout lives beneath .codex, which sendFile otherwise treats
// as a hidden path. Permit only this fixture's public SPA entry point.
const originalSendFile = express.response.sendFile;
express.response.sendFile = function(file, options, callback) {
  if (file === path.join(root, 'public', 'index.html')) {
    return originalSendFile.call(this, file, { ...(typeof options === 'object' ? options : {}), dotfiles: 'allow' }, callback);
  }
  return originalSendFile.call(this, file, options, callback);
};
const originalListen = express.application.listen;
express.application.listen = function(port, ...args) { return originalListen.call(this, port, '127.0.0.1', ...args); };
await import('../server/index.js');
console.log('Availability QA: http://127.0.0.1:3197 | availability-qa | synthetic password in this fixture');
