import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import express from 'express';
import puppeteer from 'puppeteer';

const styles = [...readFileSync(new URL('../public/index.html', import.meta.url), 'utf8')
  .matchAll(/<link rel="stylesheet" href="[^"]+"\s*\/>/g)].map(([tag]) => tag).join('');
const app = express();
app.get('/person-card-fixture', (_req, res) => res.send(`<!doctype html><html lang="en"><head>
  <meta name="viewport" content="width=device-width,initial-scale=1">${styles}
  <link rel="stylesheet" href="/styles/tasks.css">
  <style>*,*::before,*::after{animation:none!important;transition:none!important}</style>
  </head><body><button id="start">Open</button></body></html>`));
app.use(express.static(fileURLToPath(new URL('../public', import.meta.url))));
app.use('/api/v1', (_req, res) => res.json({ data: [] }));
let server, browser, origin;
const selector = '.task-detail-profile-preview';
const photo = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a/RkAAAAASUVORK5CYII=';
test.before(async () => {
  server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
  browser = await puppeteer.launch({ headless: true, executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/chromium', args: ['--no-sandbox', '--disable-dev-shm-usage'] });
});
test.after(async () => { await browser?.close(); await new Promise(resolve => server.close(resolve)); });

async function fixture({ width = 390, height = 844, detail = false } = {}) {
  const page = await browser.newPage();
  page.setDefaultTimeout(5000);
  const requests = [];
  page.on('request', request => { if (request.url().includes('/api/')) requests.push(new URL(request.url()).pathname); });
  await page.setViewport({ width, height });
  await page.goto(origin + '/person-card-fixture');
  const available = await page.evaluate(async ({ detail, photo }) => {
    await (await import('/i18n.js')).initI18n();
    await (await import('/i18n.js')).setLocale('en');
    window.closedCards = 0; window.assignments = 0;
    window.safePerson = { id: 2, display_name: 'Alex Smith', first_name: 'Alex', last_name: 'Smith', color: '#64748b' };
    window.richPerson = { ...safePerson, avatar_data: photo, phone: '+1234567', email: 'authorized@example.test', family_role: 'Parent' };
    // A richer stale app cache must not enrich the acceptance candidate.
    window.yuvomi = { users: [{ ...richPerson, email: 'secret-cached@example.test' }] };
    window.modal = await import('/components/modal.js');
    window.overlayHistory = await import('/utils/overlay-history.js');
    history.replaceState({ fixture: 'previous' }, '', '#previous');
    history.pushState({ fixture: 'current' }, '', location.pathname);
    window.historyPops = 0; window.routingAttempts = 0;
    window.addEventListener('popstate', async () => {
      if (!await overlayHistory.handleBackNavigation()) routingAttempts++;
      historyPops++;
    });
    if (detail) {
      const { openTaskDetail } = await import('/components/task-detail.js');
      openTaskDetail({ task: { id: 7, title: 'Synthetic task', status: 'todo', visibility: 'all', assigned_users: [safePerson], subtasks: [], revision: 1 }, users: [richPerson], currentUserId: 1 });
      document.querySelector('.task-detail-participant').id = 'avatar';
      return true;
    }
    modal.openModal({ title: 'Acceptance draft', initialFocus: 'none', content: '<button id="avatar">Alex Smith</button><button id="assign" style="display:block;margin-top:240px">Assign step</button><button id="other">Other</button>', onSave(panel) {
      panel.querySelector('#assign').onclick = () => assignments++;
    } });
    try { window.presenter = await import('/components/task-person-card.js'); }
    catch { return false; }
    window.openCard = (person = safePerson, options = {}) => {
      window.controller = new AbortController();
      window.card = presenter.openTaskPersonCard({ person, anchor: document.querySelector('#avatar'), host: document.querySelector('.modal-panel'), signal: controller.signal, onClose: () => closedCards++, ...options });
      return card;
    };
    return typeof presenter.openTaskPersonCard === 'function';
  }, { detail, photo });
  assert.equal(available, true, 'the reusable Task person-card presenter is available');
  return { page, requests };
}

test('supplied safe identity never enriches photos or contact data from a richer cache', async () => {
  const { page, requests } = await fixture();
  try {
    await page.evaluate(() => openCard());
    assert.equal(await page.$(`${selector} img`), null);
    assert.equal(await page.$eval(`${selector} strong`, node => node.textContent), 'Alex Smith');
    assert.equal(await page.$eval(`${selector}__avatar`, node => node.textContent), 'AS');
    assert.equal(await page.$eval(selector, node => node.textContent.includes('secret-cached@example.test')), false);
    assert.equal(await page.$$eval(`${selector} a`, nodes => nodes.length), 0);
    assert.deepEqual(requests, [], 'presenting a person makes zero API/profile requests');
  } finally { await page.close(); }
});

test('card owns Tab and Escape before the acceptance modal and restores its avatar', async () => {
  const { page } = await fixture();
  try {
    await page.evaluate(() => openCard(richPerson));
    assert.equal(await page.$eval(selector, node => node.contains(document.activeElement)), true);
    await page.keyboard.press('Tab');
    assert.equal(await page.$eval(selector, node => node.contains(document.activeElement)), true);
    await page.focus(`${selector} a:last-child`);
    await page.keyboard.press('Tab');
    assert.equal(await page.$eval(`${selector}__close`, node => node === document.activeElement), true);
    await page.keyboard.down('Shift'); await page.keyboard.press('Tab'); await page.keyboard.up('Shift');
    assert.equal(await page.$eval(`${selector} a:last-child`, node => node === document.activeElement), true);
    await page.keyboard.press('Escape');
    assert.equal(await page.$(selector), null);
    assert.equal(await page.$$eval('.modal-overlay', nodes => nodes.length), 1);
    assert.equal(await page.evaluate(() => document.activeElement.id), 'avatar');
    assert.equal(await page.evaluate(() => closedCards), 1);
  } finally { await page.close(); }
});

test('browser Back closes only the person card, preserves the acceptance draft, and restores the avatar', async () => {
  const { page } = await fixture();
  try {
    await page.evaluate(async () => {
      const { createAcceptanceDraft, setAcceptanceHelpers, assignAcceptanceSubtask } = await import('/utils/task-acceptance-draft.js');
      window.draft = createAcceptanceDraft({ primary_user_id: 1, can_add_helpers: true,
        coassignee_candidates: [safePerson], subtasks: [{ id: 10, allocatable: true, eligible_assignee_ids: [1, 2] }] }, 'person-card-history');
      setAcceptanceHelpers(draft, [2]);
      assignAcceptanceSubtask(draft, 10, 2);
      openCard();
    });
    await page.waitForFunction(() => history.state?.overlay === true);
    await page.evaluate(() => history.back());
    await page.waitForFunction(() => historyPops === 1);
    assert.equal(await page.$$eval('.modal-overlay', nodes => nodes.length), 1, 'Back must preserve the acceptance modal beneath the person card');
    assert.equal(await page.$(selector), null);
    assert.deepEqual(await page.evaluate(() => draft.assignments), { 10: 2 });
    assert.equal(await page.evaluate(() => draft.submission), null);
    assert.equal(await page.evaluate(() => document.activeElement.id), 'avatar');
    assert.equal(await page.evaluate(() => closedCards), 1);
    assert.equal(await page.evaluate(() => routingAttempts), 0);
    await page.waitForFunction(() => history.state?.overlay === true);
    await page.evaluate(() => history.back());
    // Mobile modal removal may consume its temporary closing marker with an
    // additional self-pop. Wait for the closed UI and drained marker, not the
    // implementation's exact number of popstate events.
    await page.waitForFunction(() => historyPops >= 2 && !document.querySelector('.modal-overlay') && !history.state?.overlay).catch(async error => {
      error.message += ' ' + JSON.stringify(await page.evaluate(() => ({ historyPops, routingAttempts,
        modalCount: document.querySelectorAll('.modal-overlay').length, marker: history.state,
        registered: overlayHistory.hasOpenOverlay() })));
      throw error;
    });
    assert.equal(await page.evaluate(() => overlayHistory.hasOpenOverlay()), false);
    assert.equal(await page.evaluate(() => routingAttempts), 0, 'the second deliberate Back closes the modal without routing');
    await page.evaluate(() => history.back());
    await page.waitForFunction(() => routingAttempts === 1);
    assert.equal(new URL(page.url()).hash, '#previous', 'no phantom overlay marker consumes the next route Back');
  } finally { await page.close(); }
});

for (const dismissal of ['Escape', 'outside', 'abort', 'auth', 'inert', 'host removal', 'forced navigation']) {
  test(`${dismissal} unregisters the person card without leaving a phantom Back entry`, async () => {
    const { page } = await fixture();
    try {
      await page.evaluate(() => { openCard(); window.restoredFocus = 0; document.querySelector('#avatar').addEventListener('focus', () => restoredFocus++); });
      await page.waitForFunction(() => history.state?.overlay === true);
      if (dismissal === 'Escape') await page.keyboard.press('Escape');
      else if (dismissal === 'outside') await page.click('#assign');
      else await page.evaluate(dismissal => {
        if (dismissal === 'abort') controller.abort();
        else if (dismissal === 'auth') window.dispatchEvent(new Event('auth:context-ending'));
        else if (dismissal === 'inert') document.querySelector('.modal-overlay').inert = true;
        else if (dismissal === 'host removal') document.querySelector('.modal-panel').remove();
        else overlayHistory.closeAllOverlays();
      }, dismissal);
      await page.waitForSelector(selector, { hidden: true });
      assert.equal(await page.evaluate(() => closedCards), 1);
      if (!['Escape', 'outside'].includes(dismissal)) assert.equal(await page.evaluate(() => restoredFocus), 0);
      await page.evaluate(async () => {
        const overlay = document.querySelector('.modal-overlay');
        if (overlay) overlay.inert = false;
        await modal.closeModal({ force: true });
      });
      await page.waitForFunction(() => !document.querySelector('.modal-overlay'));
      assert.equal(await page.evaluate(() => overlayHistory.hasOpenOverlay()), false);
      // closeAllOverlays intentionally leaves the marker for the next route.
      if (dismissal === 'forced navigation') await page.evaluate(() => {
        const replace = overlayHistory.consumeOverlayMarker();
        if (replace) history.replaceState({ fixture: 'next' }, '', '#next');
      });
      else await page.waitForFunction(() => !history.state?.overlay && historyPops > 0);
      assert.equal(await page.evaluate(() => routingAttempts), 0);
      await page.evaluate(() => history.back());
      await page.waitForFunction(() => routingAttempts === 1);
      assert.equal(new URL(page.url()).hash, dismissal === 'forced navigation' ? '' : '#previous');
    } finally { await page.close(); }
  });
}

test('noncanonical photo URLs use initials without making a remote image request', async () => {
  const { page } = await fixture();
  try {
    const remote = [];
    await page.setRequestInterception(true);
    page.on('request', request => { if (request.url().includes('unauthorized-image.test')) { remote.push(request.url()); request.abort(); } else request.continue(); });
    await page.evaluate(() => openCard({ ...safePerson, avatar_data: 'https://unauthorized-image.test/avatar.png' }));
    assert.equal(await page.$(`${selector} img`), null);
    assert.equal(await page.$eval(`${selector}__avatar`, node => node.textContent), 'AS');
    assert.deepEqual(remote, []);
  } finally { await page.close(); }
});

test('chooser abbreviation collisions do not suffix a unique full person-card name', async () => {
  const { page } = await fixture();
  try {
    await page.evaluate(async () => {
      (await import('/utils/member-label.js')).setMemberLabels([{ ...safePerson, age: 12, username: 'alex.smith', name_collisions: ['first_last_initial'] }]);
      openCard();
    });
    assert.equal(await page.$eval(`${selector} strong`, node => node.textContent), 'Alex Smith');
  } finally { await page.close(); }
});

test('dismissing pointer action is consumed before an assignment under the card', async () => {
  const { page } = await fixture();
  try {
    await page.evaluate(() => openCard());
    await page.click('#assign');
    assert.equal(await page.$(selector), null);
    assert.equal(await page.evaluate(() => assignments), 0);
    await page.click('#assign');
    assert.equal(await page.evaluate(() => assignments), 1, 'later deliberate action remains usable');
  } finally { await page.close(); }
});

test('replacing and repeatedly closing a card removes its listeners and calls onClose once', async () => {
  const { page } = await fixture();
  try {
    await page.evaluate(() => { window.first = openCard(); openCard({ ...safePerson, display_name: 'Second Person' }); });
    assert.equal(await page.$$eval(selector, nodes => nodes.length), 1);
    assert.equal(await page.evaluate(() => closedCards), 1);
    await page.evaluate(() => { first.close(); first.dispose(); card.close(); card.dispose(); for (let i = 0; i < 15; i++) { openCard(); card.close(); } });
    await page.click('#assign');
    assert.equal(await page.evaluate(() => assignments), 1, 'closed cards cannot consume later pointer actions');
    assert.equal(await page.evaluate(() => closedCards), 17);
  } finally { await page.close(); }
});

for (const action of ['abort', 'auth:context-ending', 'auth:expired', 'auth:context-rejected', 'host removal']) {
  test(`${action} tears down the card without restoring ended-session focus`, async () => {
    const { page } = await fixture();
    try {
      await page.evaluate(() => { openCard(); window.restoredFocus = 0; document.querySelector('#avatar').addEventListener('focus', () => restoredFocus++); });
      await page.evaluate(action => {
        if (action === 'abort') controller.abort();
        else if (action === 'host removal') document.querySelector('.modal-overlay').remove();
        else window.dispatchEvent(new Event(action));
      }, action);
      await page.waitForSelector(selector, { hidden: true });
      assert.equal(await page.evaluate(() => restoredFocus), 0);
      assert.equal(await page.evaluate(() => closedCards), 1);
    } finally { await page.close(); }
  });
}

test('removed anchor and an already-aborted signal cannot revive a card or focus', async () => {
  const { page } = await fixture();
  try {
    await page.evaluate(() => { openCard(); document.querySelector('#avatar').remove(); card.close(); });
    assert.equal(await page.$(selector), null);
    await page.evaluate(() => { const ended = new AbortController(); ended.abort(); openCard(safePerson, { signal: ended.signal }); });
    assert.equal(await page.$(selector), null);
    assert.equal(await page.evaluate(() => closedCards), 2);
  } finally { await page.close(); }
});

test('long Unicode names and contact content stay within a small visible host with scrolling', async () => {
  const { page } = await fixture({ width: 320, height: 720 });
  try {
    await page.evaluate(() => {
      const host = document.querySelector('.modal-panel');
      host.style.cssText = 'position:fixed;left:12px;top:190px;width:280px;height:210px;transform:none;';
      document.querySelector('#avatar').style.cssText = 'position:absolute;bottom:0;right:0;';
      openCard({ ...safePerson, display_name: '👩🏽‍🌾 Élodie' + ' 長い姓'.repeat(12), email: 'long'.repeat(60) + '@example.test', phone: '1234567890'.repeat(20) });
    });
    const geometry = await page.evaluate(selector => {
      const node = document.querySelector(selector), r = node.getBoundingClientRect(), h = node.parentElement.getBoundingClientRect();
      return { left:r.left, right:r.right, top:r.top, bottom:r.bottom, hostLeft:h.left, hostRight:h.right, hostTop:h.top, hostBottom:h.bottom, scrollable:node.scrollHeight > node.clientHeight, overflow:getComputedStyle(node).overflowY, horizontal:node.scrollWidth > node.clientWidth + 1 };
    }, selector);
    assert.ok(geometry.left >= geometry.hostLeft && geometry.right <= geometry.hostRight, JSON.stringify(geometry));
    assert.ok(geometry.top >= geometry.hostTop && geometry.bottom <= geometry.hostBottom, JSON.stringify(geometry));
    assert.equal(geometry.horizontal, false);
    assert.equal(geometry.scrollable, true);
    assert.equal(geometry.overflow, 'auto');
    assert.equal(await page.$eval(`${selector}__avatar`, node => node.textContent), '👩🏽‍🌾長');
  } finally { await page.close(); }
});

test('existing Task detail entry keeps its supplied authorized photo/contact and owns Escape', async () => {
  const { page, requests } = await fixture({ detail: true });
  try {
    await page.click('#avatar');
    assert.equal(await page.$eval(`${selector} img`, node => node.getAttribute('src')), photo);
    assert.equal(await page.$eval(`${selector} a[href^="mailto:"]`, node => node.getAttribute('href')), 'mailto:authorized@example.test');
    assert.equal(await page.$eval(`${selector} a[href^="tel:"]`, node => node.getAttribute('href')), 'tel:+1234567');
    assert.equal(await page.$eval(selector, node => node.contains(document.activeElement)), true);
    await page.keyboard.press('Escape');
    assert.equal(await page.$(selector), null);
    assert.equal(await page.$$eval('.modal-overlay', nodes => nodes.length), 1);
    assert.equal(await page.evaluate(() => document.activeElement.id), 'avatar');
    assert.ok(!requests.some(path => /auth\/users|profile|birth|contacts/.test(path)));
    await page.click('#avatar');
    await page.evaluate(() => window.dispatchEvent(new Event('auth:context-ending')));
    await page.waitForSelector(selector, { hidden: true });
  } finally { await page.close(); }
});
