import assert from 'node:assert/strict';
import test from 'node:test';
import { auditBranding, classifyOccurrence } from '../scripts/audit-branding.mjs';

function category(path, line, index = 0) {
  const match = [...line.matchAll(/yuvomi|oikos|ordoma/gi)][index];
  return classifyOccurrence(path, line, { before: line.slice(0, match.index), after: line.slice(match.index), context: line })[0];
}

test('branding audit rejects accidental visible labels even beside a compatible namespace', () => {
  assert.equal(category('public/pages/login.js', '<h1>Welcome to Yuvomi</h1>'), 'accidental remaining user-facing branding');
  const line = "window.yuvomi.notify('Yuvomi')";
  assert.equal(category('public/router.js', line), 'internal identifier');
  assert.equal(category('public/router.js', line, 1), 'accidental remaining user-facing branding');
});

test('branding audit distinguishes persisted identifiers and real infrastructure', () => {
  assert.equal(category('public/theme-init.js', "localStorage.getItem('yuvomi:theme')"), 'compatibility');
  assert.equal(category('server/db.js', 'process.env.OIKOS_HTTP_PORT'), 'compatibility');
  assert.equal(category('README.md', 'https://github.com/ulsklyc/yuvomi'), 'infrastructure');
  assert.equal(category('server/db.js', "'/data/yuvomi.db'"), 'infrastructure');
});

test('branding audit keeps attribution and historical evidence explicit', () => {
  assert.equal(category('LICENSE', 'Copyright Yuvomi contributors'), 'historical/upstream attribution');
  assert.equal(category('README.md', 'Vidamia is derived from upstream Yuvomi.'), 'historical/upstream attribution');
  assert.equal(category('docs/release-readiness-20260906.md', 'Yuvomi release tested'), 'historical/upstream attribution');
});

test('the superseded name cannot hide beside attribution or a file path', () => {
  assert.equal(category('public/pages/login.js', '<h1>Welcome to Ordoma</h1>'), 'accidental remaining user-facing branding');
  assert.equal(category('docs/index.html', '<h1>Ordoma</h1><p>Derived from upstream Yuvomi.</p>'), 'accidental remaining user-facing branding');
  const line = '<a href="https://example.com/ordoma">Ordoma</a>';
  assert.equal(category('docs/index.html', line), 'infrastructure');
  assert.equal(category('docs/index.html', line, 1), 'accidental remaining user-facing branding');
  assert.equal(category('docs/index.html', '<h1>/Ordoma</h1>'), 'accidental remaining user-facing branding');
  assert.equal(category('docs/index.html', '<h1>MyOrdoma</h1>'), 'accidental remaining user-facing branding');
  assert.equal(category('docs/installation.md', '[Former report](ordoma-rebrand-20260908.md)'), 'infrastructure');
  assert.equal(category('scripts/generate-icons.js', "writeFileSync(resolve('public/icons/ordoma-mark.svg'), currentMark);"), 'compatibility');
  assert.equal(category('public/settings/shell.js', 'function allowedLeavesForDomain(domainId, user) {'), 'internal identifier');
});

test('current documentation is audited while deployed historical evidence stays intact', () => {
  assert.equal(category('docs/install.html', '<h1>Install Ordoma</h1>'), 'accidental remaining user-facing branding');
  assert.equal(category('docs/privacy.html', '<h1>Ordoma</h1>'), 'accidental remaining user-facing branding');
  assert.equal(category('docs/vidamia-rebrand-20260908.md', 'This supersedes the former Ordoma product name.'), 'historical/upstream attribution');
  assert.equal(category('docs/tasks-refinement-report-20260908.md', 'Ordoma was tested at release time.'), 'historical/upstream attribution');
  assert.equal(category('docs/ordoma-rebrand-20260908.md', 'Ordoma release logo'), 'historical/upstream attribution');
  assert.equal(category('server/utils/brand.js', "const LEGACY_NAMES = ['Yuvomi', 'Ordoma'];", 1), 'compatibility');
});

test('every remaining historical product-name occurrence has an explained classification', () => {
  const report = auditBranding();
  const unexplained = report.occurrences.filter(item => item.category === 'accidental remaining user-facing branding');
  assert.deepEqual(unexplained.map(item => `${item.path}:${item.line}: ${item.text}`), []);
  assert.ok(report.occurrences.length > 0, 'Compatibility and attribution should be preserved rather than deleted.');
});
