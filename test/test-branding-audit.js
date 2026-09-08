import assert from 'node:assert/strict';
import test from 'node:test';
import { auditBranding, classifyOccurrence } from '../scripts/audit-branding.mjs';

function category(path, line, index = 0) {
  const match = [...line.matchAll(/yuvomi|oikos/gi)][index];
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
  assert.equal(category('README.md', 'Ordoma is derived from upstream Yuvomi.'), 'historical/upstream attribution');
  assert.equal(category('docs/release-readiness-20260906.md', 'Yuvomi release tested'), 'historical/upstream attribution');
});

test('every remaining historical product-name occurrence has an explained classification', () => {
  const report = auditBranding();
  const unexplained = report.occurrences.filter(item => item.category === 'accidental remaining user-facing branding');
  assert.deepEqual(unexplained.map(item => `${item.path}:${item.line}: ${item.text}`), []);
  assert.ok(report.occurrences.length > 0, 'Compatibility and attribution should be preserved rather than deleted.');
});
