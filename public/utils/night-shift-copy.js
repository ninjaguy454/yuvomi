const EN={start:'Start',exit:'Exit',restart:'Restart',pause:'Pause',resume:'Resume',gentle:'Gentle',sound:'Sound + scream',volume:'Volume',lowerMonitor:'Lower monitor',raiseMonitor:'Raise monitor',left:'LEFT',right:'RIGHT',closed:'CLOSED',open:'OPEN',win:'6 AM',rooms:{stage:'Stage',dining:'Dining',west:'West hall',east:'East hall',store:'Pirate Cove'}};
const DE={...EN,exit:'Beenden',restart:'Neustart',resume:'Weiter',gentle:'Sanft',sound:'Ton + Schrei',volume:'Lautstärke',lowerMonitor:'Monitor senken',raiseMonitor:'Monitor öffnen',left:'LINKS',right:'RECHTS',closed:'ZU',open:'OFFEN',rooms:{stage:'Bühne',dining:'Speisesaal',west:'Westflur',east:'Ostflur',store:'Piratenbucht'}};
export function nightShiftCopy(locale='en'){return locale==='de'?DE:EN;}
export function canEnterNightShift({theme,pathname,wallMode,editing,dashboardAccess}={}){
  return theme==='night-shift'&&pathname==='/'&&!wallMode&&!editing&&dashboardAccess===true;
}
