const EN={start:'Start',exit:'Exit',restart:'Restart',pause:'Pause',resume:'Resume',gentle:'Gentle',sound:'Sound + scream',volume:'Volume',lowerMonitor:'Lower monitor',raiseMonitor:'Raise monitor',left:'LEFT',right:'RIGHT',closed:'CLOSED',open:'OPEN',win:'6 AM',rooms:{stage:'Stage',dining:'Dining',west:'West hall',east:'East hall',store:'Pirate Cove'}};
const DE={...EN,exit:'Beenden',restart:'Neustart',resume:'Weiter',gentle:'Sanft',sound:'Ton + Schrei',volume:'Lautstärke',lowerMonitor:'Monitor senken',raiseMonitor:'Monitor öffnen',left:'LINKS',right:'RECHTS',closed:'ZU',open:'OFFEN',rooms:{stage:'Bühne',dining:'Speisesaal',west:'Westflur',east:'Ostflur',store:'Piratenbucht'}};
export function nightShiftCopy(locale='en'){return locale==='de'?DE:EN;}
export function canEnterNightShift({theme,pathname,wallMode,editing,dashboardAccess}={}){
  return theme==='night-shift'&&pathname==='/'&&!wallMode&&!editing&&dashboardAccess===true;
}

// Only game-local choices; household appearance/sound preferences are unrelated.
export function nightShiftSettings(raw){
  try{if(typeof raw==='string')raw=JSON.parse(raw);}catch{raw=null;}
  if(!raw||typeof raw!=='object'||Array.isArray(raw))raw={};
  return{sound:typeof raw.sound==='boolean'?raw.sound:true,gentle:typeof raw.gentle==='boolean'?raw.gentle:false,volume:Number.isFinite(raw.volume)?Math.max(0,Math.min(35,raw.volume)):15};
}
export function nightShiftSettingsKey(payload){
  const device=payload?.principal?.kind==='device'&&!payload?.temporary;
  const id=device?payload.principal.id:payload?.user?.id;
  return Number.isSafeInteger(id)&&id>0?'vidamia:night-shift-game:v1:'+(device?'device:':'user:')+id:null;
}
