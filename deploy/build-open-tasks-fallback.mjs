// Deliberately image-only: keep schema/permissions/receipts, disable new acceptance.
import fs from 'node:fs';
function replace(file,needle,replacement){const source=fs.readFileSync(file,'utf8');if(source.split(needle).length!==2)throw Error(`Unexpected fallback source: ${file}`);fs.writeFileSync(file,source.replace(needle,replacement));}
replace('/app/server/services/task-offers.js',"export function taskOfferState(d,principal,task,{starts,includeFuture=false}={}){","export function taskOfferState(d,principal,task,{starts,includeFuture=false}={}){\n  return {visible:false,claimable:false,reason:'acceptance_paused'};");
const unavailable="\n  throw acceptanceError('New task acceptance is temporarily unavailable. Existing Tasks and Notes remain available.',503,'acceptance_paused');";
replace('/app/server/services/task-acceptance-policy.js','export function acceptanceOptions(d,principal,id,primaryUserId){','export function acceptanceOptions(d,principal,id,primaryUserId){'+unavailable);
replace('/app/server/services/task-acceptance.js','export function acceptTask(d,principal,taskId,body){','export function acceptTask(d,principal,taskId,body){'+unavailable);
fs.appendFileSync('/app/public/styles/notes.css','\n/* Certified fallback retains Notes canvas/privacy, hides new task board. */\n#notes-open-tasks { display: none !important; }\n.notes-workspace { grid-template-columns: minmax(0, 1fr) !important; }\n');
fs.appendFileSync('/app/public/styles/tasks.css','\n#filter-open-tasks { display: none !important; }\n');
replace('/app/public/pages/tasks.js',"new URLSearchParams(window.location.search).get('offers') === '1'","false");
replace('/app/public/sw.js','-vidamia.50','-vidamia.50-acceptance-paused');
