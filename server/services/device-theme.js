import {assertDeviceContext,isTemporaryContext,normalizeDevicePreferences,deviceError,auditDevice} from './devices.js';
import {normalizeNamedAppearance,validateNamedAppearance} from '../../public/utils/named-appearance.js';

function currentDisplay(d,req){
  const context=assertDeviceContext(d,req);
  if(!context||req.devicePrincipal?.kind!=='device'||isTemporaryContext(req,context))throw deviceError('Return to the paired display to change its theme.',403);
  return context.device;
}
function appearance(d,row){
  const preferences=normalizeDevicePreferences(d,JSON.parse(row.preferences_json),{read:true});
  return{device_id:row.id,revision:row.revision,theme_revision:preferences.theme_revision,allow_theme_changes:preferences.allow_theme_changes,
    theme:preferences.appearance.theme,named_appearance:normalizeNamedAppearance(preferences.appearance.named_appearance)};
}
export function readDeviceTheme(d,req){return appearance(d,currentDisplay(d,req));}
export function saveDeviceTheme(d,req,body){
  return d.transaction(()=>{
    const row=currentDisplay(d,req),current=appearance(d,row);
    if(!current.allow_theme_changes)throw deviceError('Theme changes are disabled for this device.',403,'device_theme_locked');
    if(!body||typeof body!=='object'||Array.isArray(body)||Object.keys(body).some(key=>!['revision','theme_revision','theme','named_appearance'].includes(key)))throw deviceError('Only this device theme can be changed here.');
    if(!Number.isSafeInteger(body.revision)||body.revision<1)throw deviceError('Reload this device before changing its theme.');
    if(!Number.isSafeInteger(body.theme_revision)||body.theme_revision<0)throw deviceError('Reload this device before changing its theme.');
    const hasLegacy=Object.hasOwn(body,'theme'),hasNamed=Object.hasOwn(body,'named_appearance');
    if(!hasLegacy&&!hasNamed)throw deviceError('Choose a theme.');
    if(hasLegacy&&!['system','light','dark'].includes(body.theme))throw deviceError('Choose System, Light or Dark.');
    let named;
    if(hasNamed){try{named=body.named_appearance===null?null:validateNamedAppearance(body.named_appearance);}catch{throw deviceError('Choose a valid named theme configuration.');}}
    if(body.revision!==row.revision||body.theme_revision!==current.theme_revision)throw deviceError('This device changed. Reload before choosing a theme.',409,'stale_revision');
    const preferences=JSON.parse(row.preferences_json);
    const next=JSON.stringify({...preferences,appearance:{...preferences.appearance,...(hasLegacy?{theme:body.theme}:{}),...(hasNamed?{named_appearance:named}:{})}});
    if(next!==row.preferences_json){
      if(current.theme_revision===Number.MAX_SAFE_INTEGER)throw deviceError('This device needs an administrator to reset its theme revision.',409);
      const updated=JSON.parse(next);updated.theme_revision=current.theme_revision+1;
      // Authority revisions fence one-action proofs. A visual choice has its own CAS.
      d.prepare('UPDATE household_devices SET preferences_json=? WHERE id=? AND revision=?').run(JSON.stringify(updated),row.id,row.revision);
      auditDevice(d,row.id,null,'theme_changed',{source_device_id:row.id,theme:hasNamed?named?.theme||body.theme||current.theme:body.theme});
    }
    return appearance(d,d.prepare('SELECT * FROM household_devices WHERE id=?').get(row.id));
  }).immediate();
}
