import {createChangesStream} from './change-stream.js';
import {noteCapabilities} from './note-access.js';
export const noteChangesStream=createChangesStream({table:'note_change_clock',deniedMessage:'Notes access is not enabled.',canRead:(d,req)=>noteCapabilities(d,req).view});
