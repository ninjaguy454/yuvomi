// Image-only presentation fallback. The backend, schema, audiences and receipts
// remain the forward image's code/data; Docker disables structural commands.
import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';

function replaceOnce(source,needle,replacement,file) {
  if(source.split(needle).length!==2)throw Error(`Unexpected Notes fallback source: ${file}`);
  return source.replace(needle,replacement);
}

export function buildNotesFallback(root='/app') {
  const absolute=path.resolve(root);
  const files=['public/pages/notes.js','public/styles/notes.css','public/sw.js'];
  const source=Object.fromEntries(files.map(file=>[file,fs.readFileSync(path.join(absolute,file),'utf8')]));
  // Compute and validate every transformation before writing any output file.
  const page=replaceOnce(source[files[0]],'const NOTE_GROUPS_INTERFACE_ENABLED = true;',
    'const NOTE_GROUPS_INTERFACE_ENABLED = false;',files[0]);
  const marker='-vidamia.60',cacheParts=source[files[2]].split(marker);
  if(cacheParts.length!==2||!["'",'"','`'].includes(cacheParts[1][0]))throw Error('Unexpected Notes fallback cache identity');
  const result={
    [files[0]]:replaceOnce(page,'compact: false, active: true','compact: true, active: true',files[0]),
    [files[1]]:source[files[1]]+'\n/* Group-aware recovery keeps every authorized note in List. */\n#notes-compact-view { display: none !important; }\n',
    [files[2]]:source[files[2]].replace(marker,'-vidamia.60-notes-compact'),
  };
  for(const file of files)fs.writeFileSync(path.join(absolute,file),result[file]);
}

if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href)buildNotesFallback(process.argv[2]);
