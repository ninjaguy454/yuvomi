/**
 * Modul: Guard - jeder benutzte Icon-Name steht auch im Bundle
 * Zweck: `lucide.createIcons()` ersetzt ein `<i data-lucide="foo">` durch ein
 *        SVG, wenn es `foo` kennt - und laesst es sonst stehen, mit einer
 *        Warnung in der Konsole und ohne Icon in der Oberflaeche. Nichts
 *        bricht, nichts wird rot, der Knopf ist nur leer.
 *
 *        Anlass (2026-08-25): `tag-off` in der Massenauswahl der Aufgaben und
 *        `image-search` im Abo-Formular waren beide nicht im gebuendelten
 *        Lucide v0.469.0. Zwei Knoepfe ohne Icon, unbemerkt, weil der einzige
 *        Hinweis eine Browser-Warnung ist, die niemand liest.
 *
 *        Der Guard ist ausserdem das Netz unter einem Bundle-Update: Lucide
 *        benennt Icons zwischen Versionen um und laesst die Altnamen irgendwann
 *        fallen (`alert-triangle` → `triangle-alert`; die App benutzt beide
 *        Schreibweisen). Ein Update ohne diesen Guard tauschte ein leeres Icon
 *        gegen mehrere aus.
 * Ausfuehren: node --test test/test-lucide-icons.js
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT       = fileURLToPath(new URL('../', import.meta.url));
const PUBLIC_DIR = path.join(ROOT, 'public');
const BUNDLE     = path.join(PUBLIC_DIR, 'lucide.min.js');

/**
 * Die Icons, die das Bundle kennt.
 *
 * Es fuehrt sie minifiziert als `PascalName:kuerzel` - der Name bleibt lesbar,
 * weil `createIcons` ihn zur Laufzeit aus dem Attribut ableitet. Genau diese
 * Ableitung wird hier nachvollzogen, nicht eine gepflegte Liste: eine Liste
 * waere die zweite Wahrheit neben dem Bundle.
 */
function bundledIcons() {
  const src = readFileSync(BUNDLE, 'utf8');
  return new Set([...src.matchAll(/([A-Z][A-Za-z0-9]*):[a-zA-Z$_]/g)].map((m) => m[1]));
}

/** `tag-off` → `TagOff`, so wie lucide.createIcons() den Namen aufloest. */
const toPascal = (kebab) => kebab.split('-').map((s) => s[0].toUpperCase() + s.slice(1)).join('');

function sourceFiles(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) {
      // vendor/ ist Fremdcode, locales/ traegt keine Icons.
      if (name !== 'vendor' && name !== 'locales') sourceFiles(full, out);
    } else if (/\.(js|html)$/.test(name) && name !== 'lucide.min.js') {
      out.push(full);
    }
  }
  return out;
}

/**
 * Alle benutzten Icon-Namen samt Fundstelle.
 *
 * Zwei Schreibweisen: das Attribut im Markup und die `icon:`-Eigenschaft der
 * datengetriebenen Listen (Modul-Registry, Gesundheits-Reiter, Formatierungs-
 * leiste), die spaeter genau dieses Attribut bauen.
 */
function usedIcons() {
  const used = new Map();
  const add = (name, file) => {
    if (!used.has(name)) used.set(name, new Set());
    used.get(name).add(path.relative(ROOT, file));
  };
  for (const file of sourceFiles(PUBLIC_DIR)) {
    const src = readFileSync(file, 'utf8');
    for (const m of src.matchAll(/data-lucide="([a-z0-9-]+)"/g)) add(m[1], file);
    for (const m of src.matchAll(/\bicon:\s*['"]([a-z0-9-]+)['"]/g)) add(m[1], file);
  }
  return used;
}

test('das Bundle wird ueberhaupt gelesen', () => {
  const icons = bundledIcons();
  // Ohne diese Probe koennte ein geaendertes Bundle-Format die Menge leeren -
  // und der Guard darunter waere gruen, weil er nichts mehr vergleicht.
  assert.ok(icons.size > 1000, `nur ${icons.size} Icons erkannt - liest der Parser das Bundle noch?`);
  for (const known of ['Tag', 'Pencil', 'Plus', 'Check', 'ListChecks']) {
    assert.ok(icons.has(known), `${known} muss im Bundle stehen`);
  }
});

test('es werden ueberhaupt Icon-Namen gefunden', () => {
  const used = usedIcons();
  assert.ok(used.size > 100, `nur ${used.size} benutzte Namen gefunden - greift die Suche noch?`);
});

test('jeder benutzte Icon-Name steht im gebuendelten Lucide', () => {
  const icons   = bundledIcons();
  const missing = [...usedIcons()]
    .filter(([name]) => !icons.has(toPascal(name)))
    .map(([name, files]) => `${name} (${[...files].join(', ')})`);

  assert.deepEqual(missing, [],
    'Diese Namen kennt das gebuendelte Lucide nicht. Der Knopf bleibt ohne Icon, ohne dass\n'
    + 'etwas bricht. Entweder einen vorhandenen Namen waehlen oder das Bundle erneuern -\n'
    + 'aber dann diesen Guard erneut laufen lassen, weil ein Update Altnamen fallen laesst.');
});
