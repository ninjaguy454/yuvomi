"""Temporary transport for reviewed edits. Only used on the isolated audit branch."""
from pathlib import Path


def edit(path, old, new):
    p = Path(path)
    source = p.read_text()
    assert source.count(old) == 1, (path, source.count(old))
    p.write_text(source.replace(old, new))


def append(path, content):
    p = Path(path)
    source = p.read_text()
    assert content.strip() not in source, path
    p.write_text(source + content)


edit('public/api.js',
     "  // CSRF-Token-Desync (haeufig nach iOS-PWA-Resume): einmal GET /auth/me\n  // ausfuehren um den CSRF-Token zu erneuern, dann den Request wiederholen.\n  if (response.status === 403 && stateChanging && !_retried) {",
     "  const data = await response.json().catch(() => null);\n\n  // A permission denial is not a token failure. Only replay a write that the\n  // CSRF middleware explicitly rejected, never an ordinary forbidden action.\n  // Keep the single retry for token desynchronization after PWA resume.\n  if (response.status === 403 && stateChanging && !_retried\n      && data?.error === 'Invalid CSRF token.') {")
edit('public/api.js',
     "  const data = await response.json().catch(() => null);\n\n  // Fallback: CSRF-Token aus Response-Body",
     "  // Fallback: CSRF-Token aus Response-Body")
edit('public/sw-register.js',
     "  let refreshing = false;\n  navigator.serviceWorker.addEventListener('controllerchange', () => {\n    if (refreshing) return;",
     "  let refreshing = false;\n  let hadController = Boolean(navigator.serviceWorker.controller);\n  navigator.serviceWorker.addEventListener('controllerchange', () => {\n    // The first takeover controls the already network-loaded page. Reloading\n    // it can erase a login or form draft. Later worker upgrades still reload.\n    if (!hadController && navigator.serviceWorker.controller) {\n      hadController = true;\n      return;\n    }\n    if (!navigator.serviceWorker.controller || refreshing) return;")
edit('public/components/activity-automation.js', '''function inputRow(label, control, hint = '') {
  return `<div class="form-group">
    <label class="label">${h(label)}</label>
    ${control}
    ${hint ? `<small class="form-hint">${h(hint)}</small>` : ''}
  </div>`;
}''', '''let inputRowSequence = 0;

function inputRow(label, control, hint = '') {
  // Parse the existing trusted control markup, preserving its names, values,
  // IDs and event hooks. Every editor using this row gets the same label and
  // help-text association, including fields revealed after a choice changes.
  const row = document.createElement('div');
  row.className = 'form-group';
  row.insertAdjacentHTML('afterbegin', `<label class="label">${h(label)}</label>
    ${control}
    ${hint ? `<small class="form-hint">${h(hint)}</small>` : ''}`);
  const field = row.querySelector('input, select, textarea');
  if (field) {
    if (!field.id) field.id = `automation-field-${++inputRowSequence}`;
    row.querySelector('label').htmlFor = field.id;
    const description = row.querySelector('.form-hint');
    if (description) {
      description.id = `automation-hint-${++inputRowSequence}`;
      const ids = [field.getAttribute('aria-describedby'), description.id].filter(Boolean);
      field.setAttribute('aria-describedby', ids.join(' '));
    }
  }
  return row.outerHTML;
}''')
for field_id, label in {
    'task-location-kind': 'Location type',
    'task-location-place': 'Saved Place',
    'task-location-label': 'Location name',
    'task-location-address': 'Address or directions',
    'task-location-latitude': 'Latitude',
    'task-location-longitude': 'Longitude',
    'task-place-query': 'Search for a business or place',
    'task-place-category': 'Place category',
    'task-place-origin-mode': 'Search area',
    'task-place-origin': 'Saved search origin',
    'task-origin-text': 'Address, city, or ZIP',
}.items():
    edit('public/pages/tasks.js', f'id="{field_id}"', f'id="{field_id}" aria-label="{label}"')
edit('public/utils/kitchen-tabs.js',
     'return !!mod && KITCHEN_MODULES.includes(mod);',
     'return !!mod && KITCHEN_MODULES_SOURCE.includes(mod);')
edit('package.json', '    "test:meal-plans-domain":',
     '    "test:meal-change-notifications-migration": "node --experimental-sqlite --test test/test-meal-change-notifications-migration.js",\n    "test:meal-plans-domain":')
edit('package.json', 'npm run test:suite-chain &&',
     'npm run test:suite-chain && npm run test:meal-change-notifications-migration &&')
edit('test/test-push.js',
     '    CREATE TABLE calendar_events (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL);',
     '    CREATE TABLE calendar_events (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL);\n    -- The shared notification query also resolves meal reminder titles.\n    CREATE TABLE meals (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL);')
edit('test/test-region-presets.js',
     '  assert.equal(new Intl.NumberFormat(chLocale).format(123456.78), "123\'456.78");',
     "  // ICU versions use either ASCII apostrophe or U+2019 for Swiss grouping.\n  // Keep the grouping and decimal contract strict without pinning ICU glyphs.\n  assert.match(new Intl.NumberFormat(chLocale).format(123456.78), /^123['’]456\\.78$/);")
edit('test/test-region-presets.js', '''  assert.ok(
    new Intl.NumberFormat(chLocale, { style: 'currency', currency: 'CHF' })
      .format(123456.78)
      .includes("123'456.78"),
  );''', '''  assert.match(
    new Intl.NumberFormat(chLocale, { style: 'currency', currency: 'CHF' }).format(123456.78),
    /123['’]456\\.78/,
  );''')
edit('test/test-kitchen-tabs.js',
     'getLastKitchenRoute, isKitchenRoute }',
     'getLastKitchenRoute, isKitchenRoute, isKitchenModule }')
append('test/test-kitchen-tabs.js', '''

test('isKitchenModule uses the canonical imported module list', () => {
  for (const module of ['meals', 'recipes', 'shopping', 'pantry']) {
    assert.equal(isKitchenModule(module), true);
  }
  for (const module of ['tasks', '/meals', '', null, undefined]) {
    assert.equal(isKitchenModule(module), false);
  }
});
''')
append('test/test-sw-upgrade.js', '''

test('first worker takeover preserves the current page; a later upgrade reloads once', () => {
  const listeners = {};
  const signals = { reloads: 0, timers: 0 };
  const serviceWorker = {
    controller: null,
    addEventListener(type, callback) { listeners[type] = callback; },
  };
  const sandbox = {
    navigator: { serviceWorker },
    window: { addEventListener() {}, location: { reload() { signals.reloads += 1; } } },
    document: { addEventListener() {} },
    setTimeout(callback) { signals.timers += 1; callback(); },
    console,
  };
  runInContext(REGISTER_SOURCE, createContext(sandbox));
  listeners.controllerchange();
  assert.equal(signals.reloads, 0, 'loss or absence of a controller is not an upgrade');
  serviceWorker.controller = { postMessage() {} };
  listeners.controllerchange();
  assert.equal(signals.timers, 0, 'first activation must not schedule a draft-erasing reload');
  serviceWorker.controller = { postMessage() {} };
  listeners.controllerchange();
  listeners.controllerchange();
  assert.equal(signals.reloads, 1, 'subsequent upgrades keep the existing once-only refresh');
});
''')
append('test/test-api.js', '''

// Permission failures retain the response without replaying a denied write.
for (const headers of [{}, { 'X-CSRF-Token': 'fresh-but-forbidden' }]) {
  test(`ordinary 403 is not retried (${Object.keys(headers).length ? 'with' : 'without'} CSRF header)`, async () => {
    setup();
    const calls = [];
    const body = { error: 'Insufficient permissions.', code: 403 };
    _mockFetch = (url) => { calls.push(url); return mockResponse(403, body, headers); };
    await assert.rejects(() => api.post('/tasks', { title: 'Denied' }), (error) => {
      assert.ok(error instanceof ApiError);
      assert.equal(error.status, 403);
      assert.equal(error.message, body.error);
      assert.equal(error.data, body);
      return true;
    });
    assert.deepEqual(calls, ['/api/v1/tasks']);
    assert.equal(dispatchedEvents.length, 0);
  });
}

test('confirmed CSRF rejection retries once with the response token', async () => {
  setup();
  const calls = [];
  _mockFetch = (url, options) => {
    calls.push({ url, options });
    return calls.length === 1
      ? mockResponse(403, { error: 'Invalid CSRF token.', code: 403 }, { 'X-CSRF-Token': 'recovered-token' })
      : mockResponse(200, { id: 7 });
  };
  assert.deepEqual(await api.post('/tasks', { title: 'Retried' }), { id: 7 });
  assert.equal(calls.length, 2);
  assert.equal(calls[1].options.headers['X-CSRF-Token'], 'recovered-token');
  assert.equal(calls[1].options.body, calls[0].options.body);
});

test('confirmed CSRF rejection without a header refreshes the session once', async () => {
  setup();
  const calls = [];
  _mockFetch = (url, options) => {
    calls.push({ url, options });
    if (calls.length === 1) return mockResponse(403, { error: 'Invalid CSRF token.', code: 403 });
    if (url === '/api/v1/auth/me') return mockResponse(200, { csrfToken: 'session-recovered' });
    return mockResponse(200, { id: 8 });
  };
  assert.deepEqual(await api.patch('/tasks/8', { title: 'Retried' }), { id: 8 });
  assert.deepEqual(calls.map(call => call.url), ['/api/v1/tasks/8', '/api/v1/auth/me', '/api/v1/tasks/8']);
  assert.equal(calls[2].options.headers['X-CSRF-Token'], 'session-recovered');
});

test('repeated CSRF rejection stops after the single allowed retry', async () => {
  setup();
  let calls = 0;
  _mockFetch = () => {
    calls += 1;
    return mockResponse(403, { error: 'Invalid CSRF token.', code: 403 }, { 'X-CSRF-Token': 'still-invalid' });
  };
  await assert.rejects(() => api.delete('/tasks/7'), error => error instanceof ApiError && error.status === 403);
  assert.equal(calls, 2);
});

test('non-JSON forbidden response is not replayed', async () => {
  setup();
  let calls = 0;
  _mockFetch = async () => {
    calls += 1;
    const response = await mockResponse(403);
    response.json = async () => { throw new SyntaxError('Not JSON'); };
    return response;
  };
  await assert.rejects(() => api.put('/tasks/7', {}), error => error.status === 403 && error.message === 'HTTP 403');
  assert.equal(calls, 1);
});
''')
