import { THEME_CHROME } from './named-theme-chrome.js';
import { THEME_PALETTES } from './named-theme-palettes.js';
import {normalizeWeatherObservation,weatherIsDay} from './weather-appearance.js';

export const CARD_SLOTS=Object.freeze([...Array.from({length:12},(_,i)=>`slot-${String(i+1).padStart(2,'0')}-v1`),'neutral-v1']);
const hex=values=>'#'+values.map(v=>Math.round(v).toString(16).padStart(2,'0')).join('');
const rgb=color=>color.slice(1).match(/../g).map(v=>parseInt(v,16));
export const mixColors=(a,b,p)=>hex(rgb(a).map((v,i)=>v*(1-p)+rgb(b)[i]*p));
export const luminance=color=>rgb(color).map(v=>{v/=255;return v<=.04045?v/12.92:((v+.055)/1.055)**2.4;}).reduce((sum,v,i)=>sum+v*[.2126,.7152,.0722][i],0);
export const contrastRatio=(a,b)=>(Math.max(luminance(a),luminance(b))+.05)/(Math.min(luminance(a),luminance(b))+.05);
export function readableColor(color,surfaces,min=4.5){
  if(surfaces.every(s=>contrastRatio(color,s)>=min))return color;
  const target=luminance(surfaces[0])>.3?'#111111':'#ffffff';
  for(let i=1;i<=100;i++){const value=mixColors(color,target,i/100);if(surfaces.every(s=>contrastRatio(value,s)>=min))return value;}
  return target;
}
const identity={
 'night-shift':['An unofficial FNAF fan theme: worn metal, amber light and a quiet pizzeria crew','night-shift','off'],
 'cozy-cafe':['Cream linen, coffee mugs and a quiet plant corner','cafe','soft'],
 neutral:['Calm, clean botanical neutrals','flat','soft'],linen:['Woven flax, soft sage and faded ink','weave','soft'],porcelain:['Cool glazed white with cobalt details','ceramic','glass'],slate:['Crisp angled blue-grey planes','slant','soft'],graphite:['Quiet drafting grid and metal accents','grid','soft'],midnight:['Deep indigo and scattered starlight','stars','glass'],
 coffee:['Warm latte surfaces and ceramic colors','flat','soft'],espresso:['Dark roast, crema and warm brass','flat','soft'],cocoa:['Soft cocoa and berry-cream highlights','dots','soft'],matcha:['Fresh tea greens and botanical curves','leaves','soft'],'tea-garden':['Pale jade, petals and tea-rose ink','petals','soft'],honeycomb:['Honey gold and a delicate hexagonal lattice','honey','playful'],
 'forest-day':['Light woodland foliage and creek blues','leaves','soft'],'forest-night':['Deep canopy with moonlit fern accents','canopy','soft'],moss:['Earthy greens over quiet paper grain','paper','wood'],fern:['Airy fronds and fresh meadow greens','fronds','soft'],riverstone:['Smooth pebbles and cool rippling water','ripples','glass'],'desert-clay':['Warm clay and broad sand-dune contours','dunes','wood'],
 chalkboard:['Chalk ink on deep green, with subtle paper tooth','chalk','wood'],'ocean-glass':['Frosted surfaces, translucent edges and colored light','glass','glass'],'northern-lights':['Static emerald and violet aurora over deep blue','aurora','glass'],'neon-arcade':['Magenta/cyan lights and crisp arcade edges','arcade','playful'],'laser-blue':['Ice-blue beams and clear dark controls','laser','glass'],'cyber-violet':['Violet panels, green traces and circuit details','circuit','playful'],
 'paper-ink':['Real paper texture and restrained colored inks','paper','wood'],library:['Book-cloth burgundy, leather and wooden shelving','wood','wood'],'medieval-parchment':['Wooden tabletop, tinted parchment and pigment inks','parchment','wood'],'timber-hall':['Dark aged wood and warm natural highlights','wood','wood'],'candy-shop':['Soft striped candy colors and round surfaces','candy','playful'],'lavender-mist':['Pale violet haze and softened dusk colors','mist','glass'],
 'spring-bloom':['Cream petals, green shoots and blossom inks','blossoms','soft'],'summer-coast':['Sea-blue ripples and warm beach colors','coast','glass'],'autumn-leaves':['Maple/olive leaves and warm parchment tones','autumn','wood'],'winter-frost':['Quiet ice-blue crystals and winter inks','frost','glass'],'harvest-twilight':['Amber horizon over plum evening surfaces','horizon','soft'],'rainy-day':['Blue-grey rain and warm window-light accents','rain','soft'],
 halloween:['Moonlit plum with pumpkin and candle accents','moon','playful'],christmas:['Evergreen, winter berries and festive ribbons','fir','playful'],'new-year':['Midnight, champagne and small static sparks','spark','glass'],valentine:['Rose silk and delicate heart outlines','hearts','soft'],'lunar-new-year':['Red/gold lanterns over warm porcelain','lanterns','playful'],diwali:['Warm lamp light and jewel-toned night surfaces','lamps','glass'],hanukkah:['Blue candlelight, silver and warm gold','candles','glass'],eid:['Jade, gold and softly repeating arches','arches','glass'],
};
const svgPaths={
 stars:'<path d="M14 3v8M10 7h8M39 30v6M36 33h6M65 9v5M62 12h6"/>',
 leaves:'<path d="M8 55Q14 25 37 10Q47 40 8 55ZM9 54L34 15M58 70Q66 45 82 39Q91 64 58 70Z"/>',
 petals:'<path d="M26 26C7 6 6 35 26 26C46 8 44 44 26 26C5 46 46 46 26 26ZM68 61C51 40 48 70 68 61C86 42 91 79 68 61Z"/>',
 honey:'<path d="M20 3L36 12V30L20 39L4 30V12ZM52 30L68 39V57L52 66L36 57V39ZM84 3L100 12V30L84 39L68 30V12Z"/>',
 fronds:'<path d="M8 72Q41 43 55 7M25 58L7 48M25 58L39 68M33 47L16 35M33 47L48 56M41 33L27 21M41 33L56 40M47 20L40 10M47 20L62 23"/>',
 circuit:'<path d="M5 7H32V32H54V58H79M12 65H32V48M68 8V26H81M5 7V13M79 54V62"/><circle cx="54" cy="32" r="3"/><circle cx="32" cy="48" r="3"/>',
 blossoms:'<path d="M24 15C3 1 4 28 22 25C5 43 38 41 27 25C49 29 44 5 24 15ZM67 63C48 48 49 78 67 72C83 91 91 58 72 65C83 41 55 48 67 63Z"/>',
 autumn:'<path d="M25 8L31 21L42 13L39 28L51 29L36 39L36 52L26 45L17 55L18 41L5 35L17 28L13 17L24 24ZM27 22L26 61"/>',
 frost:'<path d="M32 7V57M10 20L54 44M10 44L54 20M24 10L32 18L40 10M24 54L32 46L40 54M13 19L24 21L19 12M45 53L41 43L52 44"/>',
 moon:'<path d="M22 7A21 21 0 1 0 48 36A19 19 0 0 1 22 7ZM64 58V66M60 62H68"/>',
 fir:'<path d="M25 9L11 27H18L6 43H20V52H30V43H44L32 27H39ZM67 57L58 69H63L55 80H79L71 69H76Z"/>',
 spark:'<path d="M27 5V17M27 39V51M4 28H16M38 28H50M10 11L19 20M35 36L44 45M10 45L19 36M35 20L44 11"/>',
 hearts:'<path d="M24 15C7 0 1 23 24 39C47 23 41 0 24 15ZM68 58C56 47 50 65 68 77C86 65 80 47 68 58Z"/>',
 lanterns:'<path d="M25 7V13M17 13H33M15 18Q25 12 35 18V39Q25 45 15 39ZM17 45H33M25 45V54M68 62V68M61 68H75M59 72Q68 66 77 72V91H59Z"/>',
 lamps:'<path d="M8 36Q27 58 46 36ZM27 33Q15 23 28 9Q42 25 27 33ZM58 81Q73 98 88 81ZM73 78Q65 69 74 59Q85 71 73 78Z"/>',
 candles:'<path d="M18 23H28V55H18ZM23 19Q14 10 24 3Q34 11 23 19ZM53 62H63V92H53ZM58 58Q48 49 59 42Q69 50 58 58Z"/>',
 arches:'<path d="M5 60V30Q23 3 41 30V60M11 60V32Q23 14 35 32V60M49 98V68Q67 41 85 68V98M55 98V70Q67 52 79 70V98"/>',
};
export function themePattern(t){
  const c=t.accent+'20',d=t.second+'20';
  if(svgPaths[t.motif])return `url("data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96" fill="none" stroke="${t.accent}" stroke-opacity=".13" stroke-width="1.2">${svgPaths[t.motif]}</svg>`)}")`;
  switch(t.motif){
    case'weather-sun':case'weather-cloud':case'weather-storm':{
      const paths=t.motif==='weather-sun'?'<circle cx="72" cy="64" r="22"/><path d="M72 26v-9M72 111v-9M34 64h-9M119 64h-9M45 37l-7-7M107 99l-7-7M45 91l-7 7M107 29l-7 7"/>':'<path d="M30 92c-24-3-20-35 1-36-1-27 40-38 51-14 24-11 48 14 33 32 31-2 32 28 7 28H44"/>'+(t.motif==='weather-storm'?'<path d="M73 110l-16 27h17l-11 21"/>':'');
      return`url("data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="280" height="220" fill="none" stroke="${t.accent}" stroke-opacity=".12" stroke-width="1.5" stroke-linecap="round">${paths}</svg>`)}")`;
    }
    case'cafe':return"url('/assets/themes/cozy-cafe.svg')";
    case'night-shift':return'radial-gradient(ellipse at 70% 0,#b66b1824,transparent 48%),repeating-linear-gradient(90deg,transparent 0 79px,#83927b06 79px 80px)';
    case'flat':return'none';
    case'weave':return`repeating-linear-gradient(90deg,transparent 0 3px,${c} 3px 4px),repeating-linear-gradient(0deg,transparent 0 7px,${d} 7px 8px)`;
    case'wood':return`linear-gradient(${t.canvas}b8,${t.canvas}b8),url('/assets/themes/wood.webp')`;
    case'parchment':return`linear-gradient(#e8d0acb8,#e8d0acb8),url('/assets/themes/wood.webp')`;
    case'paper':case'chalk':return`linear-gradient(${t.canvas}ed,${t.canvas}ed),url('/assets/themes/parchment.webp')`;
    case'ceramic':return`linear-gradient(125deg,#ffffff80,transparent 36%,${d} 70%,#ffffff70)`;
    case'grid':return`repeating-linear-gradient(90deg,transparent 0 27px,${c} 27px 28px),repeating-linear-gradient(0deg,transparent 0 27px,${d} 27px 28px)`;
    case'laser':case'slant':case'rain':return`repeating-linear-gradient(${t.motif==='rain'?112:145}deg,transparent 0 ${t.motif==='laser'?74:29}px,${c} ${t.motif==='laser'?74:29}px ${t.motif==='laser'?77:30}px)`;
    case'arcade':return`linear-gradient(115deg,${t.accent}35,transparent 60%),repeating-linear-gradient(0deg,transparent 0 40px,${d} 40px 42px)`;
    case'glass':return'radial-gradient(ellipse at 12% 38%,#ad8eece6,transparent 48%),radial-gradient(ellipse at 88% 75%,#54cbb8d9,transparent 46%),radial-gradient(ellipse at 65% 25%,#f8cbf1d9,transparent 38%)';
    case'aurora':case'mist':case'horizon':case'canopy':return`radial-gradient(ellipse at 20% 0,${t.accent}40,transparent 55%),radial-gradient(ellipse at 90% 30%,${t.second}40,transparent 50%)`;
    case'candy':return`repeating-linear-gradient(135deg,transparent 0 24px,${c} 24px 38px)`;
    case'coast':case'ripples':return`repeating-radial-gradient(ellipse at 90% -20%,transparent 0 30px,${c} 30px 33px,transparent 33px 58px)`;
    case'dunes':return`repeating-radial-gradient(ellipse at 0 100%,transparent 0 42px,${c} 42px 46px,transparent 46px 76px)`;
    default:return`radial-gradient(ellipse at 12% 15%,${c} 0 2px,transparent 3px),radial-gradient(ellipse at 82% 30%,${d} 0 3px,transparent 4px)`;
  }
}
export const NAMED_THEMES=Object.freeze(THEME_CHROME.map(([name,group,kind,canvas,surface,accent,second,text,,round,font])=>{
  const id=name.toLowerCase().replace(/ & /g,'-').replaceAll(' ','-'),[description,motif,sound]=identity[id],rows=THEME_PALETTES[id][0].split(';').map(s=>s.split(','));
  if(id==='ocean-glass'){name='Liquid Glass';canvas='#bcdaea';surface='#eaf7fc';accent='#46677d';second='#7954c8';text='#173448';}
  const raised=mixColors(surface,kind==='light'?'#ffffff':'#000000',.08),t={id,name,group:group==='Seasons'?'Season palettes':group==='Celebrations'?'Holiday palettes':group,kind,canvas,surface,raised,accent,second,round,font:font==='serif'?'Georgia,serif':'system-ui,sans-serif',identity:description,motif,sound,aliases:id==='ocean-glass'?['Ocean Glass']:id==='night-shift'?['FNAF',"Five Nights at Freddy's",'Five Nights at Freddy’s']:[],slots:rows.map(r=>'#'+r[0]),slotNames:rows.map(r=>r[1])};
  t.text=readableColor(text,[canvas,surface,raised],7);t.muted=readableColor(mixColors(t.text,surface,.24),[canvas,surface,raised],4.5);t.line=readableColor(accent,[surface,raised],3);t.focus=readableColor(second,[canvas,surface,raised],4.5);t.pattern=themePattern(t);
  return Object.freeze(t);
}));
const byId=new Map(NAMED_THEMES.map(t=>[t.id,t]));
const weatherBases={sunny:['summer-coast','midnight'],cloudy:['porcelain','graphite'],rain:['riverstone','rainy-day'],storm:['porcelain','midnight'],snow:['winter-frost','graphite']};
const weatherVariants=new Map(Object.entries(weatherBases).flatMap(([condition,ids])=>ids.map((id,index)=>{
  const base=byId.get(id),motif=condition==='sunny'?(index?'stars':'weather-sun'):condition==='cloudy'?'weather-cloud':condition==='rain'?'rain':condition==='storm'?'weather-storm':'frost',variant={...base,id:`local-weather-${condition}-${index?'night':'day'}`,name:'Local Weather',motif,sound:'soft'};
  variant.pattern=themePattern(variant);return[variant.id,Object.freeze(variant)];
})));
export function cardColor(theme,slot){
  const t=typeof theme==='string'?byId.get(theme)||byId.get('neutral'):theme;
  const index=CARD_SLOTS.indexOf(slot),neutral=index<0||slot==='neutral-v1',raw=neutral?t.accent:t.slots[index];
  const fill=neutral?t.surface:mixColors(t.kind==='dark'?'#0d1918':'#ffffff',raw,t.kind==='dark'?.36:.48);
  const out={fill,text:readableColor(t.text,[fill],4.5),edge:readableColor(raw,[fill,t.surface],3),raw,name:neutral?'Neutral':t.slotNames[index]};
  for(const [role,ink]of Object.entries({muted:t.muted,danger:'#bd4f59',success:'#3a865c',warning:'#aa711e',info:'#357ca0',focus:t.focus}))out[role]=readableColor(ink,[fill,t.surface],4.6);
  return out;
}
export function namedThemeVariables(t){
  const surfaces=[t.canvas,t.surface,t.raised],accent=readableColor(t.accent,surfaces,4.5),onAccent=contrastRatio(accent,'#fffaf0')>=contrastRatio(accent,'#111111')?'#fffaf0':'#111111';
  const v={'--color-bg':t.canvas,'--color-surface':t.surface,'--color-surface-2':t.surface,'--color-surface-3':mixColors(t.surface,t.text,.035),'--color-surface-elevated':t.raised,'--color-surface-work':t.surface,'--color-surface-raised':t.raised,'--color-surface-hover':mixColors(t.surface,t.text,.055),'--color-surface-elevated-hover':mixColors(t.raised,t.text,.05),'--color-border':mixColors(t.surface,t.text,.25),'--color-border-subtle':mixColors(t.surface,t.text,.13),'--color-border-strong':t.line,'--color-border-control':t.line,'--color-text-primary':t.text,'--color-text-secondary':t.muted,'--color-text-tertiary':t.muted,'--color-text-placeholder':t.muted,'--color-accent':accent,'--color-accent-hover':mixColors(accent,t.text,.12),'--color-accent-secondary':t.focus,'--color-accent-light':mixColors(t.surface,accent,.15),'--color-accent-subtle':mixColors(t.surface,accent,.09),'--color-btn-primary':accent,'--color-btn-primary-hover':mixColors(accent,t.text,.12),'--color-text-on-accent':onAccent,'--font-heading':t.font,'--named-theme-radius':t.round+'px','--named-theme-pattern':t.pattern,'--named-theme-focus':t.focus};
  v['--focus-ring-color']=t.focus;v['--sidebar-bg']=t.surface;
  for(const [name,color]of Object.entries({success:'#3a865c',warning:'#aa711e',danger:'#bd4f59',info:'#357ca0'})){const ink=readableColor(color,surfaces,4.5);v[`--color-${name}`]=ink;v[`--color-${name}-ink`]=ink;v[`--color-${name}-light`]=mixColors(t.surface,ink,.12);v[`--color-${name}-hover`]=mixColors(ink,t.text,.12);}
  for(const slot of CARD_SLOTS){const p=cardColor(t,slot);for(const key of['fill','text','edge','muted','danger','success','warning','info','focus'])v[`--card-${slot}-${key}`]=p[key];}
  return v;
}
const seasons=Object.freeze({spring:'spring-bloom',summer:'summer-coast',autumn:'autumn-leaves',winter:'winter-frost'});
export function defaultNamedAppearance(timeZone='UTC'){return{version:1,theme:'neutral',timeZone,hemisphere:'north',seasons:{...seasons},outside:'seasons',holidays:[]};}
const object=v=>v!==null&&typeof v==='object'&&!Array.isArray(v);
function keys(value,allowed){if(!object(value)||Object.keys(value).some(k=>!allowed.includes(k)))throw new TypeError('Invalid appearance fields.');}
export function validAppearanceDate(s){return typeof s==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(s)&&Number.isFinite(Date.parse(s+'T12:00:00Z'))&&new Date(s+'T12:00:00Z').toISOString().slice(0,10)===s;}
export function validateNamedAppearance(value){
  if(value===null)return null;
  keys(value,['version','theme','timeZone','hemisphere','seasons','outside','holidays']);
  if(value.version!==1||!byId.has(value.theme)&&!['seasons','holidays','local-weather'].includes(value.theme))throw new TypeError('Invalid theme.');
  const out={...defaultNamedAppearance(),...value};
  if(typeof out.timeZone!=='string')throw new TypeError('Invalid timezone.');try{new Intl.DateTimeFormat('en',{timeZone:out.timeZone});}catch{throw new TypeError('Invalid timezone.');}
  if(!['north','south'].includes(out.hemisphere))throw new TypeError('Invalid season location.');
  keys(out.seasons,Object.keys(seasons));if(Object.keys(out.seasons).length!==4||Object.values(out.seasons).some(id=>!byId.has(id)))throw new TypeError('Season targets must be fixed themes.');
  if(out.outside!=='seasons'&&!byId.has(out.outside))throw new TypeError('Invalid outside holiday theme.');
  if(!Array.isArray(out.holidays)||out.holidays.length>24)throw new TypeError('Invalid holiday windows.');
  out.holidays=out.holidays.map(w=>{keys(w,['enabled','theme','start','end']);if(typeof w.enabled!=='boolean'||!byId.has(w.theme)||!validAppearanceDate(w.start)||!validAppearanceDate(w.end)||w.start>w.end)throw new TypeError('Invalid holiday window.');return{...w};});
  out.seasons={...out.seasons};return out;
}
export function normalizeNamedAppearance(value){try{return value==null?null:validateNamedAppearance(value);}catch{return null;}}
export function resolveNamedAppearance(value,now=new Date(),weather=null){
  const config=normalizeNamedAppearance(value);if(!config)return null;
  const parts=new Intl.DateTimeFormat('en',{timeZone:config.timeZone,year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(now),part=k=>parts.find(p=>p.type===k).value,date=`${part('year')}-${part('month')}-${part('day')}`;
  if(byId.has(config.theme))return{theme:byId.get(config.theme),reason:'fixed',date};
  if(config.theme==='local-weather'){
    const current=normalizeWeatherObservation(weather,now);if(!current)return{theme:byId.get('neutral'),reason:'weather-unavailable',date};
    const phase=weatherIsDay(current,now)?'day':'night';return{theme:weatherVariants.get(`local-weather-${current.condition}-${phase}`),reason:'weather',date,condition:current.condition,phase};
  }
  if(config.theme==='holidays'){const window=config.holidays.find(w=>w.enabled&&date>=w.start&&date<=w.end);if(window)return{theme:byId.get(window.theme),reason:'holiday',date};if(config.outside!=='seasons')return{theme:byId.get(config.outside),reason:'holiday-fallback-fixed',date};}
  const month=Number(part('month'))-1,season=['winter','spring','summer','autumn'][Math.floor(((month+(config.hemisphere==='south'?7:1))%12)/3)];
  return{theme:byId.get(config.seasons[season]),reason:config.theme==='holidays'?'holiday-fallback-seasons':'season',date,season};
}
export function validateUiSounds(value){
  keys(value,['version','mode','pack','volume']);if(value.version!==1||!['off','theme','pack'].includes(value.mode)||!['soft','glass','wood','playful'].includes(value.pack)||!Number.isInteger(value.volume)||value.volume<0||value.volume>100)throw new TypeError('Invalid sound selection.');return{version:1,mode:value.mode,pack:value.pack,volume:value.volume};
}
export function normalizeUiSounds(value){try{return validateUiSounds(value);}catch{return{version:1,mode:'off',pack:'soft',volume:15};}}
