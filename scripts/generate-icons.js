/**
 * Generate Vidamia assets from the canonical public/icons/vidamia-mark.svg.
 * Run: node scripts/generate-icons.js (uses the existing sharp dev dependency).
 * Browser identity and existing asset URLs are deliberately unchanged.
 */
import sharp from 'sharp';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const iconsDir = join(root, 'public', 'icons');
mkdirSync(iconsDir, { recursive: true });
const canonical = readFileSync(join(iconsDir, 'vidamia-mark.svg'), 'utf8');
// Keep the previously installed shell's asset URL valid during its normal upgrade.
writeFileSync(join(iconsDir, 'ordoma-mark.svg'), canonical);
const mark = canonical.match(/<svg\b[^>]*>([\s\S]*?)<\/svg>/)?.[1].trim();
if (!mark || !canonical.includes('viewBox="0 0 160 160"')) throw Error('Invalid canonical brand mark');

// A stable two-color installed tile; the live shell uses a token-colored mask.
const ink = '#504238';
const paper = '#f7f3e9';
function tile({ maskable = false } = {}) {
  // The 0.76 maskable transform puts every foreground pixel inside radius64
  // (the standard central80% safe circle), including square/circular crops.
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 160 160">
    <rect width="160" height="160" rx="${maskable ? 0 : 34}" fill="${ink}"/>
    <g color="${paper}" fill="${paper}"${maskable ? ' transform="translate(19.2 19.2) scale(0.76)"' : ''}>${mark}</g>
  </svg>`;
}
const assets = [
  ['icon-192.png',192,tile()], ['icon-512.png',512,tile()],
  ['icon-maskable-192.png',192,tile({maskable:true})],
  ['icon-maskable-512.png',512,tile({maskable:true})],
  ['apple-touch-icon.png',180,tile({maskable:true})],
  ['favicon-16.png',16,tile()], ['favicon-32.png',32,tile()],
  // Android masks badges by alpha, so no tile/background belongs here.
  ['notification-badge.png',96,canonical.replace('currentColor','#ffffff')],
];
for (const [name,size,svg] of assets) {
  await sharp(Buffer.from(svg)).resize(size,size).png().toFile(join(iconsDir,name));
  console.log(`${name}: ${size}x${size}`);
}

// ICO embeds lossless PNGs; no platform-specific icon dependency is needed.
const faviconSizes = [16,32,48];
const images = await Promise.all(faviconSizes.map(size => sharp(Buffer.from(tile())).resize(size,size).png().toBuffer()));
const header = Buffer.alloc(6 + images.length * 16);
header.writeUInt16LE(1,2); header.writeUInt16LE(images.length,4);
let offset = header.length;
images.forEach((data,index) => {
  const entry = 6 + index * 16;
  header[entry] = faviconSizes[index]; header[entry+1] = faviconSizes[index];
  header.writeUInt16LE(1,entry+4); header.writeUInt16LE(32,entry+6);
  header.writeUInt32LE(data.length,entry+8); header.writeUInt32LE(offset,entry+12);
  offset += data.length;
});
writeFileSync(join(root,'public','favicon.ico'), Buffer.concat([header,...images]));
writeFileSync(join(root,'icon.svg'), tile());
writeFileSync(join(root,'docs','logo.svg'), tile());

// The standalone installer cannot depend on the installed app's static server.
// These generated blocks share the exact canonical geometry and currentColor.
const installerPath = join(root,'tools','installer','install.html');
const installer = readFileSync(installerPath,'utf8');
const inline = `<!-- vidamia-mark:start --><svg viewBox="0 0 160 160" fill="currentColor">${mark}</svg><!-- vidamia-mark:end -->`;
const regenerated = installer.replace(/<!-- vidamia-mark:start -->[\s\S]*?<!-- vidamia-mark:end -->/g,inline);
if ((regenerated.match(/<!-- vidamia-mark:start -->/g) || []).length !== 2) throw Error('Expected two generated installer marks');
if (regenerated !== installer) writeFileSync(installerPath,regenerated);
// Current documentation headers use generated inline tiles at their existing URLs.
for (const page of ['index.html','install.html','privacy.html','datenschutz.html','impressum.html']) {
  const path = join(root,'docs',page);
  const html = readFileSync(path,'utf8');
  const next = html.replace(/<!-- vidamia-tile:start -->[\s\S]*?<!-- vidamia-tile:end -->/g,
    `<!-- vidamia-tile:start -->${tile().replace('<svg ', '<svg aria-hidden="true" ')}<!-- vidamia-tile:end -->`);
  if (next !== html) writeFileSync(path,next);
}
// Inline startup geometry is generated too: CSS animates wrappers, never a second drawing.
const ellipses = [...mark.matchAll(/<ellipse\b[^>]*\/>/g)].map(match => match[0]);
const paint = mark.match(/<g\b[^>]*>/)?.[0];
if (ellipses.length !== 2 || !paint) throw Error('Expected two canonical oval elements');
const startup = `<svg class="app-loading__mark" viewBox="0 0 160 160" aria-hidden="true" focusable="false">${paint}<g class="app-loading__spin"><g class="app-loading__oval app-loading__oval--first">${ellipses[0]}</g><g class="app-loading__oval app-loading__oval--second">${ellipses[1]}</g></g></g></svg>`;
const entryPath = join(root,'public','index.html');
const entry = readFileSync(entryPath,'utf8');
const entryMarkers = /<!-- VIDAMIA_STARTUP_MARK_START -->[\s\S]*?<!-- VIDAMIA_STARTUP_MARK_END -->/g;
if ([...entry.matchAll(entryMarkers)].length !== 1) throw Error('Expected one generated startup mark');
const generatedEntry = entry.replace(entryMarkers,`<!-- VIDAMIA_STARTUP_MARK_START -->${startup}<!-- VIDAMIA_STARTUP_MARK_END -->`);
if (generatedEntry !== entry) writeFileSync(entryPath,generatedEntry);
console.log('favicon.ico, startup and installer marks generated');
