import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync, readFileSync } from 'node:fs';
import puppeteer from 'puppeteer';
import { displayAppName } from '../public/utils/branding.js';

const read = path => readFileSync(new URL(`../${path}`, import.meta.url));
const text = path => read(path).toString('utf8');

test('Ordoma is the fixed product identity regardless of historical App Name values', () => {
  for (const name of [null, '', 'Yuvomi', 'Oikos', 'Ordoma', 'Our home', 'Yuvomi family archive']) assert.equal(displayAppName(name), 'Ordoma');
  assert.doesNotMatch(text('public/utils/branding.js'), /(?:localStorage|sessionStorage|\.setItem|fetch\()/);
});

test('branding preserves installed application identity and uses revalidated manifest metadata', () => {
  const manifest = JSON.parse(text('public/manifest.json'));
  assert.equal(manifest.short_name, 'Ordoma');
  assert.deepEqual([manifest.id, manifest.start_url, manifest.scope], ['/', '/', '/']);
  assert.deepEqual(manifest.icons.map(icon => [icon.src, icon.purpose]), [
    ['/icons/icon-192.png', 'any'], ['/icons/icon-512.png', 'any'],
    ['/icons/icon-maskable-192.png', 'maskable'], ['/icons/icon-maskable-512.png', 'maskable'],
  ]);
  assert.match(text('public/index.html'), /href="\/manifest\.webmanifest" crossorigin="use-credentials"/);
});

test('the release update includes the new mark and alpha badge while preserving privacy identities', () => {
  const sw = text('public/sw.js');
  for (const asset of ['/icons/ordoma-mark.svg', '/icons/notification-badge.png', '/utils/branding.js']) assert.ok(sw.includes(`'${asset}'`));
  assert.match(sw, /DEVICE_PRIVACY_CACHE\s*=\s*'yuvomi-device-privacy'/);
  assert.match(sw, /BYPASS_CACHE\s*=\s*'yuvomi-bypass-flag'/);
  assert.match(sw, /tag:\s*payload\.tag\s*\|\|\s*'yuvomi-push'/);
  assert.match(sw, /const title = payload\.title \|\| 'Ordoma'/);
  assert.match(sw, /badge:\s*'\/icons\/notification-badge\.png'/);
});

test('installer marks use canonical geometry and the favicon contains three valid icon entries', () => {
  const mark = text('public/icons/ordoma-mark.svg').match(/<svg\b[^>]*>([\s\S]*?)<\/svg>/)[1].trim();
  const installer = text('tools/installer/install.html');
  const blocks = [...installer.matchAll(/<!-- ordoma-mark:start -->([\s\S]*?)<!-- ordoma-mark:end -->/g)];
  assert.equal(blocks.length, 2);
  for (const [, block] of blocks) assert.ok(block.includes(mark));
  assert.doesNotMatch(mark, /<text|<image|https?:|<script/);
  const ico = read('public/favicon.ico');
  assert.equal(ico.readUInt16LE(0), 0); assert.equal(ico.readUInt16LE(2), 1); assert.equal(ico.readUInt16LE(4), 3);
  for (const [index, size] of [16, 32, 48].entries()) {
    const entry = 6 + index * 16, length = ico.readUInt32LE(entry + 8), offset = ico.readUInt32LE(entry + 12);
    assert.equal(ico[entry], size); assert.equal(ico[entry + 1], size);
    assert.ok(offset + length <= ico.length);
    assert.equal(ico.subarray(offset, offset + 8).toString('hex'), '89504e470d0a1a0a');
  }
});

test('browser decodes every icon size; maskable marks stay in the safe circle and badges have no opaque tile', async () => {
  const edge = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
  const browser = await puppeteer.launch({ headless: true, executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || (process.platform === 'win32' && existsSync(edge) ? edge : undefined), args: ['--no-sandbox'] });
  try {
    const page = await browser.newPage();
    const markBounds = await page.evaluate(async url => {
      const image = new Image(); image.src = url; await image.decode();
      const canvas = document.createElement('canvas'); canvas.width = canvas.height = 160;
      const context = canvas.getContext('2d'); context.drawImage(image, 0, 0, 160, 160);
      const pixels = context.getImageData(0, 0, 160, 160).data;
      let left = 160, top = 160, right = 0, bottom = 0;
      for (let y = 0; y < 160; y++) for (let x = 0; x < 160; x++) {
        if (pixels[(y * 160 + x) * 4 + 3] > 128) {
          left = Math.min(left, x); right = Math.max(right, x);
          top = Math.min(top, y); bottom = Math.max(bottom, y);
        }
      }
      return { width: right - left + 1, height: bottom - top + 1, centerAlpha: pixels[(80 * 160 + 80) * 4 + 3] };
    }, `data:image/svg+xml;base64,${read('public/icons/ordoma-mark.svg').toString('base64')}`);
    assert.ok(markBounds.width > 100, 'Radial O remains substantial inside the icon');
    assert.ok(Math.abs(markBounds.width - markBounds.height) <= 1, 'Radial O must be circular, not stretched into an oval');
    assert.equal(markBounds.centerAlpha, 0, 'Radial O retains an open center');
    const icons = [
      ['icon-192.png', 192], ['icon-512.png', 512], ['icon-maskable-192.png', 192],
      ['icon-maskable-512.png', 512], ['apple-touch-icon.png', 180], ['favicon-16.png', 16],
      ['favicon-32.png', 32], ['notification-badge.png', 96],
    ];
    for (const [name, size] of icons) {
      const pixels = await page.evaluate(async url => {
        const image = new Image(); image.src = url; await image.decode();
        const canvas = document.createElement('canvas'); canvas.width = image.naturalWidth; canvas.height = image.naturalHeight;
        const context = canvas.getContext('2d'); context.drawImage(image, 0, 0);
        const rgba = context.getImageData(0, 0, canvas.width, canvas.height).data;
        const background = Array.from(rgba.slice(0, 4));
        let clear = 0, solid = 0, outside = 0, foreground = 0;
        for (let i = 0; i < rgba.length; i += 4) {
          const alpha = rgba[i + 3]; if (!alpha) clear++; if (alpha === 255) solid++;
          if (alpha > 0 && Math.max(...background.slice(0, 3).map((v, j) => Math.abs(v - rgba[i + j]))) > 20) {
            foreground++;
            const x = (i / 4) % canvas.width + 0.5, y = Math.floor(i / 4 / canvas.width) + 0.5;
            if (Math.hypot(x - canvas.width / 2, y - canvas.height / 2) > canvas.width * 0.4) outside++;
          }
        }
        return { width: canvas.width, height: canvas.height, clear, solid, foreground, outside };
      }, `data:image/png;base64,${read(`public/icons/${name}`).toString('base64')}`);
      assert.deepEqual([pixels.width, pixels.height], [size, size], name);
      assert.ok(pixels.solid > size, `${name} must have a recognizable mark`);
      if (name.includes('maskable') || name.includes('apple-touch')) {
        assert.equal(pixels.clear, 0, `${name} must have an opaque background`);
        assert.ok(pixels.foreground > size); assert.equal(pixels.outside, 0, `${name} safe circle`);
      }
      if (name.includes('badge')) assert.ok(pixels.clear > size * size / 2, 'Notification badge must retain a transparent background');
    }
  } finally { await browser.close(); }
});
