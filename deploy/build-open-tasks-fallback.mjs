// Image-only recovery: keep schema, permissions, receipts and group memberships.
// Pause acceptance as before; Docker also disables structural group commands.
import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';

function replaceOnce(source,needle,replacement,file) {
  if(source.split(needle).length!==2)throw Error(`Unexpected open Tasks fallback source: ${file}`);
  return source.replace(needle,replacement);
}

export function buildOpenTasksFallback(root='/app') {
  const absolute=path.resolve(root);
  const files=['server/services/task-offers.js','server/services/task-acceptance-policy.js',
    'server/services/task-acceptance.js','public/pages/tasks.js','public/pages/notes.js',
    'public/styles/notes.css','public/styles/tasks.css','public/sw.js'];
  const source=Object.fromEntries(files.map(file=>[file,fs.readFileSync(path.join(absolute,file),'utf8')]));
  // Every read and source-pattern check happens before the first write.
  const transform=(file,needle,replacement)=>replaceOnce(source[file],needle,replacement,file);
  const unavailable="\n  throw acceptanceError('New task acceptance is temporarily unavailable. Existing Tasks and Notes remain available.',503,'acceptance_paused');";
  const notes=transform('public/pages/notes.js','const NOTE_GROUPS_INTERFACE_ENABLED = true;',
    'const NOTE_GROUPS_INTERFACE_ENABLED = false;');
  const marker='-vidamia.63',cacheParts=source['public/sw.js'].split(marker);
  if(cacheParts.length!==2||!["'",'"','`'].includes(cacheParts[1][0]))throw Error('Unexpected open Tasks fallback cache identity');
  const result={
    'server/services/task-offers.js':transform('server/services/task-offers.js',
      'export function taskOfferState(d,principal,task,{starts,includeFuture=false}={}){',
      "export function taskOfferState(d,principal,task,{starts,includeFuture=false}={}){\n  return {visible:false,claimable:false,reason:'acceptance_paused'};"),
    'server/services/task-acceptance-policy.js':transform('server/services/task-acceptance-policy.js',
      'export function acceptanceOptions(d,principal,id,primaryUserId){',
      'export function acceptanceOptions(d,principal,id,primaryUserId){'+unavailable),
    'server/services/task-acceptance.js':transform('server/services/task-acceptance.js',
      'export function acceptTask(d,principal,taskId,body){',
      'export function acceptTask(d,principal,taskId,body){'+unavailable),
    'public/pages/tasks.js':transform('public/pages/tasks.js',"new URLSearchParams(window.location.search).get('offers') === '1'",'false'),
    'public/pages/notes.js':replaceOnce(notes,'compact: false, active: true','compact: true, active: true','public/pages/notes.js'),
    'public/styles/notes.css':source['public/styles/notes.css']+
      '\n/* Group-aware recovery retains Notes privacy, hides the new task board. */\n#notes-open-tasks { display: none !important; }\n.notes-workspace { grid-template-columns: minmax(0, 1fr) !important; }\n#notes-compact-view { display: none !important; }\n',
    'public/styles/tasks.css':source['public/styles/tasks.css']+'\n#filter-open-tasks { display: none !important; }\n',
    'public/sw.js':source['public/sw.js'].replace(marker,'-vidamia.63-acceptance-paused'),
  };
  for(const file of files)fs.writeFileSync(path.join(absolute,file),result[file]);
}

if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href)buildOpenTasksFallback(process.argv[2]);
