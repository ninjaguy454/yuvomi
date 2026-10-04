import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import express from 'express';
import puppeteer from 'puppeteer';

// Real module rendering and handlers; HTTP fixtures never contact a live app.
const app = express();
let server, browser, base, writes = [];
const user = { id: 1, role: 'admin', username: 'parent', display_name: 'Parent', avatar_color: '#447766', avatar_data: null };
const sourceRoot = process.env.UX_SOURCE_ROOT || fileURLToPath(new URL('../public', import.meta.url));
const styles = [...readFileSync(join(sourceRoot, 'index.html'), 'utf8').matchAll(/<link rel="stylesheet" href="([^"]+)"\s*\/>/g)].map(m => m[0]).join('');
app.use(express.json());
app.use(express.static(sourceRoot));
app.get('/ux-fixture', (_req, res) => res.send(`<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width,initial-scale=1">${styles}
  ${['settings','birthdays','inventory','tasks','meals','dashboard'].map(s=>`<link rel="stylesheet" href="/styles/${s}.css">`).join('')}
  <script src="/lucide.min.js"></script><style>#main-content{padding:16px}*,*::before,*::after{animation:none!important;transition:none!important}</style></head><body><main id="main-content"></main></body></html>`));
app.use('/api/v1', (req, res) => {
  if (req.method !== 'GET') writes.push({ path: req.path, body: req.body });
  if (req.path === '/auth/me') return res.json({ user, permissions: { admin: true }, csrfToken: 'fixture' });
  if (req.path === '/auth/users') return res.json({ data: [user] });
  if (req.path === '/automation/admin/workflow-templates') return res.json({ data: [{ id: 1, name: 'After school', description: '', steps: [], input_schema: [], quick_add_enabled: true }], members: [user], activities: [], categories: [], variables: [], places: [] });
  if (req.path === '/preferences') return res.json({ data: { dashboard_widgets: [{ id: 'tasks', visible: true, order: 0, size: '2x2' }, { id: 'family', visible: true, order: 1, size: '2x2' }] } });
  if (req.path === '/dashboard') return res.json({ users: [user], urgentTasks: [], upcomingEvents: [], todayMeals: [], pinnedNotes: [], shoppingLists: [] });
  if (req.path === '/weather') return res.json({ data: null });
  if (req.path === '/meals/planning') return res.json({ data: { members: [user], slots: [], timing_defaults: [] } });
  if (req.path === '/meals/week-model') return res.json({ data: { members: [user], days: [], contexts: [] } });
  if (req.path === '/meals/plans') return res.json({ data: [{ id: 1, name: 'Weeknight dinners', status: 'active', rules: [] }] });
  if (req.path === '/meals/plans/1') return res.json({ data: { id: 1, name: 'Weeknight dinners', status: 'active', rules: [] } });
  if (req.path === '/birthdays') return res.json({ data: [] });
  if (req.path === '/auth/oidc/config') return res.json({ enabled: false });
  return res.json({ data: [], enabled: false });
});
test.before(async () => {
  server = await new Promise(resolve => { const s=app.listen(0,'127.0.0.1',()=>resolve(s)); });
  base = `http://127.0.0.1:${server.address().port}`;
  browser = await puppeteer.launch({ headless: true, executablePath: process.env.PUPPETEER_EXECUTABLE_PATH, args: ['--no-sandbox','--disable-dev-shm-usage'] });
});
test.after(async () => { await browser?.close(); server?.closeAllConnections(); await new Promise(r=>server?.close(r)||r()); });
async function mount(module, width=390, permissions={admin:true}) {
  writes=[];
  const page=await browser.newPage(); page.setDefaultTimeout(6000);
  await page.setViewport({width,height:900,isMobile:width<640,hasTouch:width<640});
  await page.goto(`${base}/ux-fixture${module==='/pages/meals.js'?'?legacy=1&focus=meal-plan':''}`);
  await page.evaluate(async ({module,user,permissions,theme})=>{
    document.documentElement.dataset.theme=theme;
    localStorage.setItem('yuvomi-locale','en');
    localStorage.setItem('yuvomi-onboarded:1','1');
    window.yuvomi={showToast:()=>{},isModuleDisabled:()=>false};
    window.EventSource=class {addEventListener(){}close(){}};
    await (await import('/i18n.js')).initI18n();
    await import('/components/datepicker.js');
    document.documentElement.style.setProperty('--module-accent', 'var(--color-accent)');
    (await import('/permissions.js')).setPermissions(permissions);
    const root=document.querySelector('#main-content');
    if(module==='workflows') await (await import('/components/activity-automation.js')).renderAutomationManager(root,{tab:'workflows'});
    else if(module==='quicklinks') await (await import('/components/quick-links-manager.js')).openQuickLinksManager();
    else await (await import(module)).render(root,{user});
  },{module,user,permissions,theme:process.env.UX_THEME||'light'});
  return page;
}
async function capture(page, name) {
  if (!process.env.UX_CLEANUP_EVIDENCE) return;
  mkdirSync(process.env.UX_CLEANUP_EVIDENCE,{recursive:true});
  await page.screenshot({path:`${process.env.UX_CLEANUP_EVIDENCE}/${name}.png`,fullPage:true});
}

for (const width of [390,1100]) for (const kind of ['profile','birthday','inventory']) {
  test(`single ${kind} photo picker retains draft when canceled at ${width}px`, async()=>{
    const page=await mount(kind==='profile'?'/settings/pages/personal-account.js':`/pages/${kind==='birthday'?'birthdays':'inventory'}.js`,width);
    try {
      if(kind==='birthday')await page.click('#fab-new-birthday');
      if(kind==='inventory') {
        await page.click('.inventory-page .page-fab');
        await page.evaluate(()=>{const el=document.querySelector('#inv-photo-preview'); for(let p=el.parentElement;p;p=p.parentElement)if(p.tagName==='DETAILS')p.open=true;});
      }
      const prefix=kind==='profile'?'profile-avatar':kind==='birthday'?'bd-photo':'inv-photo';
      const preview=kind==='profile'?'#profile-avatar-preview':kind==='birthday'?'#birthday-preview':'#inv-photo-preview';
      const name=kind==='profile'?'#profile-display-name':kind==='birthday'?'#bd-name':'#inv-name';
      await page.waitForSelector(preview); await page.evaluate(()=>window.lucide?.createIcons()); await capture(page,`${kind}-${width}`);
      assert.equal(await page.$(`#${prefix}-edit`),null,'no second button opens the same picker');
      const remove=kind==='profile'?'#profile-avatar-remove':kind==='birthday'?'#bd-remove-photo':'#inv-remove-photo';
      assert.equal(await page.$eval(remove,n=>n.checkVisibility()),false,'remove is not rendered or focusable without a photo');
      await page.focus(name); await page.keyboard.type(' Draft');
      const before=await page.$eval(name,n=>n.value);
      await page.focus(preview);
      // Acknowledge interception before the native Enter click; otherwise CDP
      // can deliver the file-input click before Puppeteer's setup has completed.
      await page._client().send('Page.setInterceptFileChooserDialog', { enabled: true });
      const chooser=page.waitForFileChooser(); await page.keyboard.press('Enter'); await (await chooser).cancel();
      assert.equal(await page.$eval(name,n=>n.value),before,'canceling file selection retains unsaved text');
      const box=await page.$eval(preview,n=>{const r=n.getBoundingClientRect();return {w:r.width,h:r.height,label:n.getAttribute('aria-label')};});
      assert.ok(box.w>=44&&box.h>=44&&box.label);
      assert.equal(writes.length,0,'photo selection never submits the parent form');
    } finally { await page.close(); }
  });
}

test('workflow title opens the same editable draft and cancellation makes no writes', async()=>{
  const page=await mount('workflows',1100);
  try {
    await capture(page,'workflows');
    assert.equal(await page.$eval('[data-edit-workflow="1"]',n=>n.textContent.trim()),'After school');
    await page.focus('[data-edit-workflow="1"]');await page.keyboard.press('Enter');
    await page.waitForSelector('#automation-workflow-form');
    assert.equal(await page.$eval('#automation-workflow-form [name="name"]',n=>n.value),'After school');
    await capture(page,'workflow-editor');
    await page.evaluate(async()=> (await import('/components/modal.js')).closeModal({force:true}));
    assert.equal(writes.length,0);
  } finally { await page.close(); }
});

for(const family of [false,true]) test(`${family?'family member':'personal'} photo removal returns focus to the remaining picker`, async()=>{
  user.avatar_data='data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
  const page=await mount(family?'/settings/pages/admin-family.js':'/settings/pages/personal-account.js',390);
  try {
    if(family)await page.click('[data-edit-user="1"]');
    const prefix=family?'edit-member-avatar':'profile-avatar';
    await page.waitForSelector(`#${prefix}-remove`);
    assert.equal(await page.$eval(`#${prefix}-remove`,n=>n.checkVisibility()),true);
    await page.focus(`#${prefix}-remove`);await page.keyboard.press('Enter');
    assert.equal(await page.$eval(`#${prefix}-remove`,n=>n.checkVisibility()),false);
    assert.equal(await page.evaluate(()=>document.activeElement.id),`${prefix}-preview`);
    assert.equal(writes.length,0,'removing a photo changes only the unsaved parent draft');
  } finally { user.avatar_data=null;await page.close(); }
});

test('meal plan name opens the existing read-only view while Edit stays separate', async()=>{
  const page=await mount('/pages/meals.js',1100);
  try {
    await page.waitForSelector('[data-plan-view="1"]'); await capture(page,'meal-plans');
    assert.equal(await page.$eval('[data-plan-view="1"]',n=>n.textContent.trim()),'Weeknight dinners');
    assert.equal((await page.$$('[data-plan-view="1"]')).length,1);
    assert.ok(await page.$('[data-plan-edit="1"]'));
    await page.focus('[data-plan-view="1"]');await page.keyboard.press('Enter');
    await page.waitForSelector('#meal-plan-form');
    assert.equal(await page.$eval('#meal-plan-form [name="name"]',n=>n.value),'Weeknight dinners');
    assert.equal(await page.$eval('#meal-plan-form [name="name"]',n=>n.disabled),true);
    assert.equal(await page.$('#meal-plan-form [type="submit"]'),null);
    assert.equal(writes.length,0);
  } finally { await page.close(); }
});

test('dashboard widget title carries the existing All destination', async()=>{
  const page=await mount('/pages/dashboard.js',1100);
  try {
    await page.waitForSelector('.widget__header'); await capture(page,'dashboard');
    assert.ok(await page.$('.widget__title a[href="/tasks"]'),'Tasks heading links directly to Tasks');
    const header=await page.$eval('.widget__title a[href="/tasks"]',n=>n.closest('.widget__header').textContent);
    assert.doesNotMatch(header,/\bAll\b/);
    assert.ok(await page.$('.widget__header > .widget__link[href="/settings"]'),'custom Manage destination remains a separate link');
    assert.equal(writes.length,0);
  } finally { await page.close(); }
});

test('read-only workflow names remain visible without an edit target', async()=>{
  const page=await mount('workflows',390,{capabilities:{'workflows.view':'allow'}});
  try {
    assert.match(await page.$eval('#main-content',n=>n.textContent),/After school/);
    assert.equal(await page.$('[data-edit-workflow]'),null);
    assert.equal(await page.$('[data-delete-workflow]'),null);
    assert.equal(writes.length,0);
  } finally { await page.close(); }
});

test('quick-link icon preview opens the existing picker without a duplicate Choose icon control', async()=>{
  const page=await mount('quicklinks',390);
  try {
    await page.click('#quick-link-add'); await page.waitForSelector('#quick-link-name');
    assert.equal(await page.$('#quick-link-icon-symbol'),null);
    await page.type('#quick-link-name','Library');
    await page.focus('#quick-link-icon-trigger'); await page.keyboard.press('Enter');
    await page.waitForSelector('.icon-picker');
    assert.equal(writes.length,0);
  } finally { await page.close(); }
});
