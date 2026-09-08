import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { APP_NAME, displayAppName, isBrandAsset } from '../server/utils/brand.js';

test('product identity remains Ordoma regardless of historical or custom display names', () => {
  assert.equal(APP_NAME, 'Ordoma');
  for (const value of [undefined, null, '', '  ', 'Yuvomi', 'Oikos', ' Yuvomi ']) {
    assert.equal(displayAppName(value), 'Ordoma');
  }
  for (const name of ['Our household', 'Yuvomi Family', 'oikos', 'Ordoma']) {
    assert.equal(displayAppName(name), 'Ordoma');
  }
});

// Execute the actual Express static header callback without starting a server,
// opening the deployment database or invoking background schedulers.
const serverSource = readFileSync(new URL('../server/index.js', import.meta.url), 'utf8');

test('version and dynamic manifest expose fixed Ordoma identity without reading historical name configuration', () => {
  const queries = [];
  const db = { get: () => ({ prepare: sql => {
    queries.push(sql);
    return { get: () => sql.includes('COUNT(*)') ? {count:1} : {value:'Old custom name'} };
  } }) };
  const versionSource = serverSource.slice(serverSource.indexOf('function buildVersionPayload('), serverSource.indexOf('// Public bootstrap metadata'));
  const version = new Function('APP_NAME', 'db', 'OIDC_PASSWORD_SENTINEL', 'isPasswordLoginEnabled', 'APP_VERSION', 'MAX_UPLOAD_BYTES', `${versionSource}; return buildVersionPayload;`)(APP_NAME,db,'OIDC',()=>false,'test-version',123);
  assert.equal(version(false).app_name,'Ordoma');
  assert.equal(version(true).app_name,'Ordoma');
  assert.equal(version(true).version,'test-version');
  assert.ok(queries.every(sql=>!sql.includes('app_name')));

  const routeStart = serverSource.indexOf("app.get('/manifest.webmanifest'");
  const route = serverSource.slice(routeStart,serverSource.indexOf('\n});',routeStart));
  const body = route.slice(route.indexOf('=> {')+4);
  const response = { type(){},setHeader(){},json(value){this.value=value;} };
  new Function('APP_NAME','res',body)(APP_NAME,response);
  assert.equal(response.value.short_name,'Ordoma');
  assert.match(response.value.name,/^Ordoma\b/);
});

const match = serverSource.match(/setHeaders\(res, filePath\) \{([\s\S]*?)\n  \},/);
assert.ok(match, 'static middleware header callback exists');
const setHeaders = new Function('res', 'filePath', 'path', 'isBrandAsset', match[1]);
function headers(filePath) {
  const result = {};
  setHeaders({ setHeader: (key, value) => { result[key] = value; } }, filePath, path, isBrandAsset);
  return result;
}

const assets = [
  'favicon.ico', 'icons/ordoma-mark.svg', 'icons/favicon-16.png', 'icons/favicon-32.png',
  'icons/apple-touch-icon.png', 'icons/icon-192.png', 'icons/icon-512.png',
  'icons/icon-maskable-192.png', 'icons/icon-maskable-512.png', 'icons/notification-badge.png',
];
test('every brand asset revalidates on both Windows and POSIX deployment paths', () => {
  for (const asset of assets) {
    for (const filePath of [`/app/public/${asset}`, `C:\\Ordoma\\public\\${asset.replaceAll('/', '\\')}`]) {
      assert.equal(isBrandAsset(filePath), true, filePath);
      assert.equal(headers(filePath)['Cache-Control'], 'no-cache, must-revalidate', filePath);
    }
  }
});

test('unrelated images and fonts retain their cache policy', () => {
  for (const relative of ['images/recipe.png', 'icons/custom.svg', 'fonts/household.woff2', 'photos/favicon.ico']) {
    const filePath = `/app/public/${relative}`;
    assert.equal(isBrandAsset(filePath), false, filePath);
    assert.equal(headers(filePath)['Cache-Control'], 'public, max-age=2592000, immutable', filePath);
  }
  assert.equal(isBrandAsset('/app/uploads/icons/icon-192.png'), false);
});

test('document and worker revalidation and MIME types remain intact', () => {
  for (const relative of ['index.html', 'app.js', 'styles/tokens.css', 'sw.js']) {
    assert.equal(headers(`/app/public/${relative}`)['Cache-Control'], 'no-cache, must-revalidate');
  }
  assert.equal(headers('/app/public/manifest.json')['Content-Type'], 'application/manifest+json; charset=utf-8');
  assert.equal(headers('/app/public/vendor/pdf.mjs')['Content-Type'], 'text/javascript; charset=utf-8');
});
