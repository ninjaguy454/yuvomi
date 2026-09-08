/** Classify historical product names without renaming persisted contracts.
 * Run: node scripts/audit-branding.mjs [--json]
 * The JSON report contains every occurrence, including its line and reason.
 */
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const HISTORICAL_DOCUMENT = /^(?:CHANGELOG\.md|LICENSE|docs\/(?:.*-2026090[67]\.md|(?:tasks-refinement-report|ordoma-rebrand)-20260908\.md|phase-3-5-release-audit\.md|awesome-selfhosted\/)|public\/vendor\/)/;
const INFRASTRUCTURE = /^(?:\.github\/workflows\/|deploy\/|tools\/quadlet\/|templates\/|(?:(?:docker|podman)-compose[^/]*\.ya?ml|Dockerfile|entrypoint\.sh|nginx\.conf\.example|ca_profile\.xml|docs\/(?:CNAME|docker-compose\.portainer\.yml))$)/;
// These current pages deliberately retain an identified upstream walkthrough or
// operator notice. Restrict that exception to reviewed text, not the whole page.
const UPSTREAM_REFERENCES = [
  [/^docs\/install\.html$/, /(?:data-t="(?:opt_(?:proxmox|truenas|umbrel|unraid)_info|step_(?:a3_desc|inst1_desc|tn\d_desc|um\d_(?:title|desc)|ur\d_desc)|success_desc_store)"|\b(?:opt_(?:proxmox|truenas|umbrel|unraid)_info|step_(?:a3_desc|inst1_desc|tn\d_desc|um\d_(?:title|desc)|ur\d_desc)|success_desc_store):)/, 'Reviewed instructions refer to the explicitly identified upstream image, repository or app-store packaging.'],
  [/^docs\/(?:privacy|datenschutz|impressum)\.html$/, /(?:self-hosted Yuvomi app|Yuvomi application running|Yuvomi-Anwendung|Yuvomi-Projekts)/, 'Retained upstream operator notice describes the upstream website and separates self-hosted instance responsibility.'],
];
// These are reviewed contracts whose literal names cannot be changed safely.
const CONTRACTS = [
  [/^docs\/installation\.md$/, /^(?:yuvomi\s+\||.*(?:TrueNAS|Umbrel|Unraid|WebUI|container|systemctl|docker|rm -rf))/, 'Explicit upstream packaging, container logs, or existing operational command.'],
  [/^tools\/installer\/README\.md$/, /running `yuvomi` container/, 'Installer checks the existing container name.'],
  [/^public\/theme-init\.js$/, /(?:keys\.push|oldKey|newKey)/, 'Browser storage upgrade from the older namespace.'],
  [/^public\/sw\.js$/, /caches\.keys\(\)/, 'Release-cache cleanup recognizes both installed namespaces.'],
  [/^scripts\/generate-icons\.js$/, /ordoma-mark\.svg/, 'The old asset URL serves the new Vidamia geometry so cached stylesheets do not lose their mark during update.'],
  [/^(?:public\/utils\/branding\.js|server\/utils\/brand\.js)$/, /(?:name|value)\s*===|LEGACY|legacy|includes\(/, 'Historical display defaults normalize to Vidamia without rewriting saved values.'],
  [/^server\/auth\.js$/, /API_TOKEN_PREFIX|header\.match/, 'API-token and session-cookie wire compatibility.'],
  [/^server\/utils\/totp\.js$/, /issuer\s*=/, 'Authenticator enrollment issuer remains recognizable.'],
  [/^server\/services\/google-drive-storage\.js$/, /APP_FOLDER_NAME/, 'Existing Google Drive application folder identity.'],
  [/^server\/mcp\/protocol\.js$/, /SERVER_INFO/, 'MCP server identity remains compatible with configured clients.'],
  [/^server\/index\.js$/, /createLogger\(/, 'Existing logger channel identity.'],
  [/^tools\/installer\/install-server\.js$/, /inspectCommand\(/, 'Existing production container name used by the installer.'],
];

export function classifyOccurrence(path, line, matched, { comment = false } = {}) {
  if (/^test\//.test(path)) return ['test fixture', 'Existing identifier, compatibility assertion, or synthetic test data.'];
  if (HISTORICAL_DOCUMENT.test(path)) return ['historical/upstream attribution', 'Historical evidence, release history, license, or vendored upstream source.'];
  if (INFRASTRUCTURE.test(path)) return ['infrastructure', 'Existing repository, deployment, provider, or hosting identity.'];
  if (/^(?:package(?:-lock)?\.json)$/.test(path)) return ['compatibility', 'The package identity and lockfile remain unchanged.'];
  if (comment) return ['internal identifier', 'Non-rendered source commentary; no product label is emitted.'];
  if (path === 'scripts/audit-branding.mjs') return ['internal identifier', 'The branding audit searches for the historical names.'];
  if (/\.[cm]?js$/.test(path) && /[A-Za-z_$][A-Za-z0-9_$]*F$/.test(matched.before) && /^orDomain\b/.test(matched.after)) {
    return ['internal identifier', 'The substring is part of a ForDomain function identifier, not a product name.'];
  }
  if (/^(?:yuvomi|oikos)\b/i.test(matched.after)) {
    for (const [file, pattern, reason] of UPSTREAM_REFERENCES) if (file.test(path) && pattern.test(line)) return ['historical/upstream attribution', reason];
  }
  for (const [file, pattern, reason] of CONTRACTS) if (file.test(path) && pattern.test(line)) return ['compatibility', reason];
  if (/^(?:[Yy]uvomi|[Oo]ikos)[A-Z][A-Za-z0-9]*\b/.test(matched.after)) return ['internal identifier', 'Existing class, variable, or browser history key.'];
  if (/(?:\bcd\s+|\bSERVICE=|docker compose (?:exec|logs)\s+|--hostname\s+)$/.test(matched.before)) return ['infrastructure', 'Command uses the existing checkout, container or host name.'];
  if (/(?:window|globalThis)\.$/.test(matched.before)) return ['internal identifier', 'Existing application namespace; renaming would break callers.'];
  if (/^(?:YUVOMI|OIKOS)_[A-Z0-9_]+\b/.test(matched.after)) return ['compatibility', 'Existing environment or configuration identifier.'];
  if (/(?:https?:\/\/|ghcr\.io\/|github\.com\/|@)[^\s"'<>`]*$/i.test(matched.before)
      || /[A-Za-z]:\\$/.test(matched.before) && /^(?:yuvomi|oikos)\b/i.test(matched.after)
      || /(?:[./~]|[A-Za-z]:\\)[^\s"'<>`]*[/\\]$/.test(matched.before) && /^(?:yuvomi|oikos)(?:[/\\]|\b)/i.test(matched.after)
      || /^[^\s"'<>`]*\.(?:com|cloud|local|db|zip|json|ya?ml|svg|png|ico|js|mjs|css|xml|container)\b/i.test(matched.after)
      || /^[^\s"'<>`]*\.md(?:[)#?:]|$)/i.test(matched.after) && /[(`/\\]$/.test(matched.before)) {
    return ['infrastructure', 'Existing URL, file, remote, or storage path; changing it is not a visual rebrand.'];
  }
  if (/\.[cm]?js$/.test(path) && /^(?:yuvomi|oikos)\??\.[A-Za-z_$]/i.test(matched.after)) return ['internal identifier', 'Existing application namespace; renaming would break callers.'];
  if (matched.before.endsWith('`') && /^(?:yuvomi|oikos)\.[a-z][a-z0-9.-]*`/i.test(matched.after)) return ['compatibility', 'Documented persisted browser key.'];
  if (/^(?:yuvomi|oikos)[:_-](?:[A-Za-z0-9_*]|['"`])/i.test(matched.after)
      || /^(?:yuvomi|oikos)(?::\s*$|-\$\{)/i.test(matched.after)
      || /[A-Za-z0-9_.-]$/.test(matched.before) && !/^ordoma/i.test(matched.after)) {
    return ['compatibility', 'Namespaced key, event, source, cache, protocol, or implementation identifier.'];
  }
  if (/^(?:yuvomi|oikos)\//i.test(matched.after)) return ['compatibility', 'Existing storage, URL path, or protocol identifier.'];
  // The superseded name needs an explicit historical explanation. Merely adding
  // an upstream link or the word "compatibility" beside a visible label must not
  // make stale product identity pass the audit.
  if (/^ordoma\b/i.test(matched.after)) {
    if (/\b(?:former|previous|historical|legacy|earlier|supersedes|superseded|formerly|renamed from)\b[^<>\n]{0,100}$/i.test(matched.before)
        || /^ordoma\b[^<>\n]{0,80}\b(?:former|previous|historical|legacy|superseded)\b/i.test(matched.after)) {
      return ['historical/upstream attribution', 'Explicitly describes the superseded product identity.'];
    }
    return ['accidental remaining user-facing branding', 'The superseded product name is not explained as history or a retained contract.'];
  }
  if (/\b(?:upstream|derived|attribution|copyright|historical|legacy|formerly|previous|compatibility|compatible|retained|rebrand|renam(?:e|ed)|MIT|Ulas|ulsklyc|Ursprungsprojekt|Ursprungsprojekts|Geschichte|kompatibel)\b/i.test(line)
      || (path === 'DESIGN.md' && line.includes('Im Vergleich zum alten'))) {
    return ['historical/upstream attribution', 'Explicit lineage or compatibility explanation.'];
  }
  return ['accidental remaining user-facing branding', 'Unclassified historical product name; review before committing.'];
}

function comments(source, path) {
  if (!/\.(?:[cm]?js|css|html|svg|sh)$/.test(path)) return [];
  const ranges = [];
  const pattern = /\/\*[\s\S]*?\*\/|<!--[\s\S]*?-->|^[\t ]*(?:\/\/|#|--).*$/gm;
  for (const match of source.matchAll(pattern)) ranges.push([match.index, match.index + match[0].length]);
  return ranges;
}

export function auditBranding(root = ROOT) {
  const listing = spawnSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { cwd: root, encoding: 'utf8' });
  if (listing.status !== 0) throw new Error(listing.stderr || 'Could not inventory repository files.');
  const files = [...new Set(listing.stdout.split('\0').filter(Boolean))].sort();
  const occurrences = [];
  for (const path of files) {
    let source;
    try { const data = readFileSync(resolve(root, path)); if (data.includes(0)) continue; source = data.toString('utf8'); } catch { continue; }
    if (!/yuvomi|oikos|ordoma/i.test(source)) continue;
    const ranges = comments(source, path);
    for (const match of source.matchAll(/yuvomi|oikos|ordoma/gi)) {
      const start = source.lastIndexOf('\n', match.index - 1) + 1;
      const end = source.indexOf('\n', match.index);
      const line = source.slice(start, end < 0 ? source.length : end).replace(/\r$/, '');
      const offset = match.index - start;
      const context = line.slice(Math.max(0, offset - 20), offset + match[0].length + 30);
      const [category, reason] = classifyOccurrence(path, line, {
        context, before: line.slice(0, offset), after: line.slice(offset),
      }, { comment: ranges.some(([a, b]) => match.index >= a && match.index < b) });
      occurrences.push({ path, line: source.slice(0, start).split('\n').length, text: line.trim(), name: match[0], category, reason });
    }
  }
  const counts = {};
  for (const item of occurrences) counts[item.category] = (counts[item.category] || 0) + 1;
  return { scannedFiles: files.length, counts, occurrences };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const report = auditBranding();
  if (process.argv.includes('--json')) console.log(JSON.stringify(report, null, 2));
  else {
    console.log(JSON.stringify({ scannedFiles: report.scannedFiles, counts: report.counts }, null, 2));
    for (const item of report.occurrences.filter(item => item.category === 'accidental remaining user-facing branding')) console.log(`${item.path}:${item.line}: ${item.text}`);
  }
  process.exitCode = report.counts['accidental remaining user-facing branding'] ? 1 : 0;
}
