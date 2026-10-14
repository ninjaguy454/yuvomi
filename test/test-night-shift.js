import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {NAMED_THEMES,CARD_SLOTS,cardColor,contrastRatio,defaultNamedAppearance,validateNamedAppearance,normalizeNamedAppearance,resolveNamedAppearance,namedThemeVariables} from '../public/utils/named-appearance.js';
import {createUiSoundEngine} from '../public/utils/ui-sounds.js';
const selected=()=>({...defaultNamedAppearance('UTC'),theme:'night-shift'});

test('Night Shift is selectable and survives the shared appearance validation/normalization contract',()=>{
 const saved=validateNamedAppearance(selected());
 assert.equal(normalizeNamedAppearance(JSON.parse(JSON.stringify(saved))).theme,'night-shift');
 const resolved=resolveNamedAppearance(saved,new Date('2026-10-14T21:00:00Z')).theme;
 assert.equal(resolved.id,'night-shift');assert.equal(resolved.name,'Night Shift');assert.equal(resolved.kind,'dark');assert.equal(resolved.group,'Custom');
 for(const alias of ['FNAF',"Five Nights at Freddy's",'Five Nights at Freddy’s'])assert.ok(resolved.aliases.includes(alias));
 assert.equal(defaultNamedAppearance().theme,'neutral','existing default remains unchanged');
});

test('Night Shift resolves all stable slots through the approved palette with readable status and control roles',()=>{
 const theme=NAMED_THEMES.find(t=>t.id==='night-shift');assert.ok(theme,'Night Shift must be in the shared catalog');
 assert.deepEqual(theme.slots,['#d7a562','#b1a0d2','#dbbe6d','#d88f77','#aac298','#85b6ab','#8faec6','#d29db4','#b2bc82','#9aa5c8','#c4ac93','#afaaa1']);
 assert.equal(CARD_SLOTS.length,13);const variables=namedThemeVariables(theme);
 for(const slot of CARD_SLOTS){const c=cardColor(theme,slot);assert.ok(contrastRatio(c.text,c.fill)>=4.5,slot+' text');assert.ok(contrastRatio(c.edge,c.fill)>=3,slot+' edge');assert.ok(contrastRatio(c.edge,theme.surface)>=3,slot+' adjacent surface');for(const role of ['muted','danger','success','warning','info','focus']){assert.ok(contrastRatio(c[role],c.fill)>=4.5,slot+' '+role);assert.equal(variables['--card-'+slot+'-'+role],c[role]);}}
});

test('classic prepaint accepts and paints the same Night Shift identity and slot roles as the module',()=>{
 const context={};vm.runInNewContext(readFileSync(new URL('../public/named-appearance-init.js',import.meta.url),'utf8'),context);
 const classic=context.VidamiaAppearance.resolveNamedAppearance(selected(),new Date('2026-10-14T21:00:00Z'));
 assert.ok(classic,'Night Shift must resolve before first paint');assert.equal(classic.theme.id,'night-shift');
 assert.deepEqual(JSON.parse(JSON.stringify(context.VidamiaAppearance.namedThemeVariables(classic.theme))),namedThemeVariables(resolveNamedAppearance(selected()).theme));
});

test('Night Shift Theme default is silent even on deliberate gestures and completion capture',()=>{
 let unlocks=0,emits=0;const engine=createUiSoundEngine({clock:()=>100,isForeground:()=>true,unlock:()=>unlocks++,emit:()=>emits++});
 const preferences={version:1,mode:'theme',pack:'glass',volume:15};engine.configure(preferences,'night-shift');
 assert.equal(engine.play('select',{isTrusted:true}),false);assert.equal(engine.capture({isTrusted:true}),null);assert.equal(unlocks,0);assert.equal(emits,0);assert.deepEqual(engine.configuration(),preferences);
});

test('an explicitly selected sound pack remains independent of Night Shift visuals',()=>{
 const sounds=[];const engine=createUiSoundEngine({clock:()=>100,isForeground:()=>true,emit:recipe=>sounds.push(recipe.pack)});
 engine.configure({version:1,mode:'pack',pack:'wood',volume:15},'night-shift');assert.equal(engine.play('select',{isTrusted:true}),true);assert.deepEqual(sounds,['wood']);
 engine.configure({version:1,mode:'off',pack:'wood',volume:15},'night-shift');assert.equal(engine.play('select',{isTrusted:true}),false);assert.deepEqual(sounds,['wood']);
});
