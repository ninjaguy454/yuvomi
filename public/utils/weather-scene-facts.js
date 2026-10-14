import {normalizeWeatherObservation,wmoThemeCondition} from './weather-appearance.js';

// This boundary deliberately carries no provider body, location or identity.
const SCENE_KEYS=['version','provider','observed_at','fetched_at','expires_at','condition_code','phenomena','precipitation','wind','cloud_cover','visibility_m','solar'];
const PRECIPITATION_KEYS=['kind','intensity','liquid_mm','snow_cm','snow_water_mm','interval_seconds','classification'];
const PHENOMENA=['clear','partly-cloudy','overcast','fog','rime','mist','drizzle','rain','freezing-liquid','snow','snow-grains','sleet','thunder','hail','haze','smoke','dust','sand','ash'];
const KINDS=['unknown','none','drizzle','rain','snow','snow-grains','sleet','mixed'];
const exact=(value,keys)=>!!value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).length===keys.length&&keys.every(key=>Object.hasOwn(value,key));
const finite=(value,min=0,max=Infinity)=>typeof value==='number'&&Number.isFinite(value)&&value>=min&&value<=max;
const optional=(value,max=Infinity)=>value===null||finite(value,0,max);
const bounded=value=>{try{return new TextEncoder().encode(JSON.stringify(value)).length<=4096;}catch{return false;}};
const timeKeys=['observed_at','fetched_at','expires_at'];

// Current provider tables, verified 2026-10-14 against their official docs.
const wmo={
  0:[['clear'],'none'],1:[['clear'],'none'],2:[['partly-cloudy'],'none'],3:[['overcast'],'none'],45:[['fog'],'unknown'],48:[['fog','rime'],'unknown'],
  51:[['drizzle'],'drizzle','light'],53:[['drizzle'],'drizzle','moderate'],55:[['drizzle'],'drizzle','heavy'],56:[['drizzle','freezing-liquid'],'drizzle','light'],57:[['drizzle','freezing-liquid'],'drizzle','heavy'],
  61:[['rain'],'rain','light'],63:[['rain'],'rain','moderate'],65:[['rain'],'rain','heavy'],66:[['rain','freezing-liquid'],'rain','light'],67:[['rain','freezing-liquid'],'rain','heavy'],
  71:[['snow'],'snow','light'],73:[['snow'],'snow','moderate'],75:[['snow'],'snow','heavy'],77:[['snow-grains'],'snow-grains'],80:[['rain'],'rain','light'],81:[['rain'],'rain','moderate'],82:[['rain'],'rain','heavy'],85:[['snow'],'snow','light'],86:[['snow'],'snow','heavy'],
  95:[['thunder'],'unknown'],96:[['thunder','hail'],'unknown'],97:[['thunder'],'unknown'],99:[['thunder','hail'],'unknown'],
};
const owm={
  200:[['thunder','rain'],'rain','light'],201:[['thunder','rain'],'rain','moderate'],202:[['thunder','rain'],'rain','heavy'],210:[['thunder'],'unknown'],211:[['thunder'],'unknown'],212:[['thunder'],'unknown'],221:[['thunder'],'unknown'],230:[['thunder','drizzle'],'drizzle','light'],231:[['thunder','drizzle'],'drizzle','moderate'],232:[['thunder','drizzle'],'drizzle','heavy'],
  300:[['drizzle'],'drizzle','light'],301:[['drizzle'],'drizzle','moderate'],302:[['drizzle'],'drizzle','heavy'],310:[['drizzle','rain'],'drizzle','light'],311:[['drizzle','rain'],'drizzle','moderate'],312:[['drizzle','rain'],'drizzle','heavy'],313:[['drizzle','rain'],'drizzle'],314:[['drizzle','rain'],'drizzle','heavy'],321:[['drizzle'],'drizzle'],
  500:[['rain'],'rain','light'],501:[['rain'],'rain','moderate'],502:[['rain'],'rain','heavy'],503:[['rain'],'rain','heavy'],504:[['rain'],'rain','heavy'],511:[['rain','freezing-liquid'],'rain'],520:[['rain'],'rain','light'],521:[['rain'],'rain','moderate'],522:[['rain'],'rain','heavy'],531:[['rain'],'rain'],
  600:[['snow'],'snow','light'],601:[['snow'],'snow','moderate'],602:[['snow'],'snow','heavy'],611:[['sleet'],'sleet'],612:[['sleet'],'sleet','light'],613:[['sleet'],'sleet'],615:[['rain','snow'],'mixed','light'],616:[['rain','snow'],'mixed'],620:[['snow'],'snow','light'],621:[['snow'],'snow','moderate'],622:[['snow'],'snow','heavy'],
  701:[['mist'],'unknown'],711:[['smoke'],'unknown'],721:[['haze'],'unknown'],731:[['dust','sand'],'unknown'],741:[['fog'],'unknown'],751:[['sand'],'unknown'],761:[['dust'],'unknown'],762:[['ash'],'unknown'],771:[[],'unknown'],781:[[],'unknown'],
  800:[['clear'],'none'],801:[['partly-cloudy'],'none'],802:[['partly-cloudy'],'none'],803:[['overcast'],'none'],804:[['overcast'],'none'],
};
const table=provider=>provider==='open-meteo'?wmo:provider==='openweathermap'?owm:null;

export function normalizeWeatherScene(value,theme,now=new Date()){
  const companion=normalizeWeatherObservation(theme,now);
  if(!companion||!exact(value,SCENE_KEYS)||!bounded(value)||value.version!==1||!Number.isSafeInteger(value.condition_code)||!Object.hasOwn(table(value.provider)||{},value.condition_code))return null;
  if(timeKeys.some(key=>value[key]!==companion[key]))return null;
  if(value.provider==='open-meteo'&&wmoThemeCondition(value.condition_code)!==companion.condition)return null;
  if(!Array.isArray(value.phenomena)||value.phenomena.length>4||value.phenomena.some(p=>!PHENOMENA.includes(p))||new Set(value.phenomena).size!==value.phenomena.length)return null;
  const p=value.precipitation,w=value.wind,s=value.solar;
  if(!exact(p,PRECIPITATION_KEYS)||!KINDS.includes(p.kind)||!(p.intensity===null||['light','moderate','heavy'].includes(p.intensity))||!['reported','inferred'].includes(p.classification)||!['liquid_mm','snow_cm','snow_water_mm'].every(key=>optional(p[key]))||!(p.interval_seconds===null||Number.isSafeInteger(p.interval_seconds)&&p.interval_seconds>0))return null;
  if(!exact(w,['speed_mps','gust_mps','from_degrees'])||!optional(w.speed_mps,100)||!optional(w.gust_mps,120)||!optional(w.from_degrees,360)||!optional(value.cloud_cover,1)||!optional(value.visibility_m,100000))return null;
  if(!exact(s,['is_day','sunrise_at','sunset_at'])||typeof s.is_day!=='boolean'||s.is_day!==companion.is_day)return null;
  const solar=normalizeWeatherObservation({...companion,...s},now);
  if(!solar||solar.sunrise_at!==companion.sunrise_at||solar.sunset_at!==companion.sunset_at)return null;
  return {version:1,provider:value.provider,...Object.fromEntries(timeKeys.map(key=>[key,companion[key]])),condition_code:value.condition_code,phenomena:[...value.phenomena],precipitation:{...p},wind:{speed_mps:w.speed_mps,gust_mps:w.gust_mps,from_degrees:w.from_degrees===360?0:w.from_degrees},cloud_cover:value.cloud_cover,visibility_m:value.visibility_m,solar:{is_day:companion.is_day,sunrise_at:solar.sunrise_at,sunset_at:solar.sunset_at}};
}

export function normalizeWeatherSceneEnvelope(value,now=new Date()){
  if(!exact(value,['theme','scene']))return null;
  const theme=normalizeWeatherObservation(value.theme,now);if(!theme)return null;
  return {theme,scene:normalizeWeatherScene(value.scene,theme,now)};
}

const number=(value,max=Infinity)=>finite(value,0,max)?value:null;
const converted=(value,unit,conversions,max=Infinity)=>Object.hasOwn(conversions,unit)&&finite(value)?number(value*conversions[unit],max):null;
const direction=value=>finite(value,0,360)?value===360?0:value:null;
const percent=value=>finite(value,0,100)?value/100:null;
const windUnits={'km/h':1/3.6,'m/s':1,mph:.44704,kn:1852/3600,knots:1852/3600};
const liquidUnits={mm:1,inch:25.4};
const snowUnits={cm:1,inch:2.54};

/** Strict unit-aware projection from an already fetched current response. */
export function projectWeatherScene(provider,raw,theme,units,now=new Date()){
  if(!normalizeWeatherObservation(theme,now))return null;
  const cur=provider==='open-meteo'?raw?.current:raw;
  const code=provider==='open-meteo'?cur?.weather_code:cur?.weather?.[0]?.id;
  const mapping=Number.isSafeInteger(code)?table(provider)?.[code]:null;if(!mapping)return null;
  const [reported,kind,intensity=null]=mapping;
  const precipitation={kind,intensity,liquid_mm:null,snow_cm:null,snow_water_mm:null,interval_seconds:null,classification:'reported'};
  let wind,cloud,visibility,phenomena=[...reported];
  if(provider==='open-meteo'){
    const u=raw?.current_units||{};
    const rain=converted(cur.rain,u.rain,liquidUnits),showers=converted(cur.showers,u.showers,liquidUnits);
    precipitation.liquid_mm=rain!==null&&showers!==null?number(rain+showers):null;
    precipitation.snow_cm=converted(cur.snowfall,u.snowfall,snowUnits);
    precipitation.interval_seconds=Number.isSafeInteger(cur.interval)&&cur.interval>0?cur.interval:null;
    wind={speed_mps:converted(cur.wind_speed_10m,u.wind_speed_10m,windUnits,100),gust_mps:converted(cur.wind_gusts_10m,u.wind_gusts_10m,windUnits,120),from_degrees:u.wind_direction_10m==='°'?direction(cur.wind_direction_10m):null};
    cloud=u.cloud_cover==='%'?percent(cur.cloud_cover):null;visibility=u.visibility==='m'?number(cur.visibility,100000):null;
  }else{
    const windUnit=units==='imperial'?'mph':['metric','standard'].includes(units)?'m/s':null;
    wind={speed_mps:converted(cur.wind?.speed,windUnit,windUnits,100),gust_mps:converted(cur.wind?.gust,windUnit,windUnits,120),from_degrees:direction(cur.wind?.deg)};
    cloud=percent(cur.clouds?.all);visibility=number(cur.visibility,100000);
    precipitation.liquid_mm=number(cur.rain?.['1h']);precipitation.snow_water_mm=number(cur.snow?.['1h']);precipitation.interval_seconds=3600;
    for(const item of (Array.isArray(cur.weather)?cur.weather:[]).slice(1,4))for(const phenomenon of owm[item?.id]?.[0]||[])if(!phenomena.includes(phenomenon)&&phenomena.length<4)phenomena.push(phenomenon);
  }
  if(precipitation.kind!=='mixed'&&precipitation.liquid_mm>0&&(precipitation.snow_cm>0||precipitation.snow_water_mm>0)){precipitation.kind='mixed';precipitation.classification='inferred';}
  return normalizeWeatherScene({version:1,provider,...Object.fromEntries(timeKeys.map(key=>[key,theme[key]])),condition_code:code,phenomena,precipitation,wind,cloud_cover:cloud,visibility_m:visibility,solar:{is_day:theme.is_day,sunrise_at:theme.sunrise_at,sunset_at:theme.sunset_at}},theme,now);
}
