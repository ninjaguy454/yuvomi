import {CARD_SLOTS} from './named-appearance.js';
export function normalizeCardColorSlot(value){return CARD_SLOTS.includes(value)?value:null;}
export function validateCardColorChoice(value){
  if(!value||typeof value!=='object'||Array.isArray(value)||value.version!==1||!['default','random','fixed'].includes(value.mode)||Object.keys(value).some(k=>!['version','mode',...(value.mode==='fixed'?['slot']:[])].includes(k)))throw new TypeError('Choose Default, Random or a fixed card color.');
  if(value.mode==='fixed'&&!normalizeCardColorSlot(value.slot))throw new TypeError('Choose a supported card color.');
  return{version:1,mode:value.mode,...(value.mode==='fixed'?{slot:value.slot}:{})};
}
export function normalizeCardColorChoice(value){try{return validateCardColorChoice(value);}catch{return null;}}
export const NEUTRAL_CARD_DEFAULT=Object.freeze({version:1,mode:'fixed',slot:'neutral-v1'});
export function validateHouseholdCardDefault(value){const choice=validateCardColorChoice(value);if(choice.mode==='default')throw new TypeError('Choose a fixed or random household default.');return choice;}
export function resolveCardColorChoice(value,household,draw=Math.random){const choice=validateCardColorChoice(value),resolved=choice.mode==='default'?(normalizeCardColorChoice(household)?.mode!=='default'&&normalizeCardColorChoice(household)||NEUTRAL_CARD_DEFAULT):choice;if(resolved.mode==='fixed')return resolved.slot;const n=draw();if(!Number.isFinite(n)||n<0||n>=1)throw new TypeError('Invalid random color draw.');return CARD_SLOTS[Math.floor(n*12)];}
export function cardColorAttribute(slot){return normalizeCardColorSlot(slot)?` data-card-color="${slot}"`:'';}
