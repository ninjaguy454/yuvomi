import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';import vm from 'node:vm';
let model;
try { model = await import('../public/utils/named-appearance.js'); }
catch (e) { if (e.code !== 'ERR_MODULE_NOT_FOUND') throw e; }
const need = () => { assert.ok(model, 'approved named appearance model must exist'); return model; };
test('one coherent catalog exposes exactly44 complete identities including the four reviewed concepts', () => {
  const { NAMED_THEMES } = need();
  assert.equal(NAMED_THEMES.length,44);
  assert.equal(new Set(NAMED_THEMES.map(t=>t.id)).size,44);
  assert.equal(NAMED_THEMES.filter(t=>t.kind==='light').length,22);
  for (const name of ['Liquid Glass','Coffee','Christmas','Medieval Parchment']) assert.ok(NAMED_THEMES.some(t=>t.name===name));
  assert.equal(NAMED_THEMES.find(t=>t.id==='ocean-glass').name,'Liquid Glass');
  assert.ok(NAMED_THEMES.find(t=>t.id==='ocean-glass').aliases.includes('Ocean Glass'));
  for(const t of NAMED_THEMES){assert.equal(t.slots.length,12);assert.equal(t.slotNames.length,12);assert.equal(new Set(t.slots).size,12);assert.ok(t.identity);}
  assert.equal(new Set(NAMED_THEMES.map(t=>JSON.stringify(t.slots))).size,44);
});
test('reviewed indexed palettes preserve their exact identity independently of global hue names',()=>{
  const { NAMED_THEMES }=need(),by=id=>NAMED_THEMES.find(t=>t.id===id);
  assert.deepEqual(by('coffee').slots,['#955631','#548064','#8163a1','#a26f24','#427a8a','#ae5268','#656871','#80833a','#a46345','#536599','#886377','#637e70']);
  assert.deepEqual(by('christmas').slots,['#c54864','#b59432','#287757','#4696b0','#8260ad','#c86835','#699644','#b84682','#3b74ac','#b17c58','#778299','#a777bd']);
  assert.equal(by('ocean-glass').slots[0],'#7954c8');assert.equal(by('medieval-parchment').slots[0],'#1e6c78');
});
test('every indexed card and essential edge remains readable on its theme',()=>{
  const {NAMED_THEMES,CARD_SLOTS,cardColor,contrastRatio}=need();assert.equal(CARD_SLOTS.length,13);
  for(const t of NAMED_THEMES)for(const slot of CARD_SLOTS){const p=cardColor(t,slot);assert.ok(contrastRatio(p.text,p.fill)>=4.5,`${t.name}/${slot} ink`);assert.ok(contrastRatio(p.edge,p.fill)>=3,`${t.name}/${slot} edge`);assert.ok(contrastRatio(p.edge,t.surface)>=3,`${t.name}/${slot} adjacent surface`);assert.ok(p.name);}
});
const schedule={version:1,theme:'holidays',timeZone:'America/Los_Angeles',hemisphere:'north',seasons:{spring:'spring-bloom',summer:'summer-coast',autumn:'autumn-leaves',winter:'winter-frost'},outside:'seasons',holidays:[{enabled:true,theme:'halloween',start:'2026-10-28',end:'2026-11-01'}]};
test('inclusive holiday dates use personal timezone then Seasons outside fallback',()=>{
  const {resolveNamedAppearance:r}=need();assert.equal(r(schedule,new Date('2026-11-02T06:59:59Z')).theme.id,'halloween');assert.equal(r(schedule,new Date('2026-11-02T08:00:01Z')).theme.id,'autumn-leaves');
  assert.equal(r({...schedule,outside:'coffee'},new Date('2026-11-03T12:00:00Z')).theme.id,'coffee');
  assert.equal(r({...schedule,theme:'christmas'},new Date('2026-10-30T12:00:00Z')).theme.id,'christmas');
});
test('every northern and southern season resolves without recursive or missing targets',()=>{
  const {resolveNamedAppearance:r}=need(),expected=['winter-frost','winter-frost','spring-bloom','spring-bloom','spring-bloom','summer-coast','summer-coast','summer-coast','autumn-leaves','autumn-leaves','autumn-leaves','winter-frost'];
  for(let m=1;m<=12;m++){const date=new Date(`2026-${String(m).padStart(2,'0')}-15T12:00:00Z`);assert.equal(r({...schedule,theme:'seasons',timeZone:'UTC'},date).theme.id,expected[m-1]);assert.equal(r({...schedule,theme:'seasons',timeZone:'UTC',hemisphere:'south'},date).theme.id,expected[(m+5)%12]);}
});
test('invalid writes reject impossible dates, dynamic window targets and fallback cycles',()=>{
  const {validateNamedAppearance:v,normalizeNamedAppearance:n}=need();
  for(const p of [{outside:'holidays'},{seasons:{...schedule.seasons,spring:'holidays'}},{timeZone:'invented/zone'},{holidays:[{enabled:true,theme:'holidays',start:'2026-10-28',end:'2026-11-01'}]},{holidays:[{enabled:true,theme:'halloween',start:'2026-02-29',end:'2026-03-01'}]},{holidays:[{enabled:true,theme:'halloween',start:'2026-11-02',end:'2026-11-01'}]}])assert.throws(()=>v({...schedule,...p}));
  assert.equal(n(null),null);assert.equal(n({theme:'unknown'}),null);assert.deepEqual(v(schedule),schedule);
});
test('overlapping windows resolve first included entry and disabled windows never activate',()=>{
  const {resolveNamedAppearance:r}=need(),window={enabled:true,theme:'christmas',start:'2026-10-28',end:'2026-11-01'},date=new Date('2026-10-30T12:00:00Z');
  assert.equal(r({...schedule,holidays:[...schedule.holidays,window]},date).theme.id,'halloween');assert.equal(r({...schedule,holidays:[{...schedule.holidays[0],enabled:false},window]},date).theme.id,'christmas');
});
test('sound choices are independent, strictly validated and legacy defaults remain silent',()=>{
  const {normalizeUiSounds:n,validateUiSounds:v}=need();assert.deepEqual(n(null),{version:1,mode:'off',pack:'soft',volume:15});
  for(const mode of ['off','theme','pack'])for(const pack of ['soft','glass','wood','playful'])assert.deepEqual(v({version:1,mode,pack,volume:15}),{version:1,mode,pack,volume:15});
  for(const p of [{mode:'automatic'},{pack:'remote-url'},{volume:-1},{volume:101},{volume:'15'},{version:2}])assert.throws(()=>v({version:1,mode:'off',pack:'soft',volume:15,...p}));
});
test('generated classic prepaint uses the exact registry and scheduling contract',()=>{
  const m=need(),context={};vm.runInNewContext(readFileSync(new URL('../public/named-appearance-init.js',import.meta.url),'utf8'),context);const pre=context.VidamiaAppearance;
  assert.deepEqual(JSON.parse(JSON.stringify(pre.NAMED_THEMES)),JSON.parse(JSON.stringify(m.NAMED_THEMES)));
  for(const d of ['2026-10-28T12:00:00Z','2026-11-02T08:00:01Z'])assert.equal(pre.resolveNamedAppearance(schedule,new Date(d)).theme.id,m.resolveNamedAppearance(schedule,new Date(d)).theme.id);
});
test('every colored card keeps metadata, warning text and essential control focus readable',()=>{
  const {NAMED_THEMES,CARD_SLOTS,cardColor,contrastRatio}=need();for(const theme of NAMED_THEMES)for(const slot of CARD_SLOTS){const c=cardColor(theme,slot);for(const role of['muted','danger','success','warning','info','focus'])assert.ok(c[role]&&contrastRatio(c[role],c.fill)>=4.5,theme.name+' '+slot+' '+role);}
});
