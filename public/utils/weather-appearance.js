// Coarse household conditions only. No location, credentials or provider HTML.
export const WEATHER_THEME_REFRESH_MS=30*60*1000;
export const WEATHER_THEME_MAX_AGE_MS=90*60*1000;
export const WEATHER_THEME_CONDITIONS=Object.freeze(['sunny','cloudy','rain','storm','snow']);
const instant=value=>typeof value==='string'&&/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)&&Number.isFinite(Date.parse(value))&&new Date(value).toISOString()===value?Date.parse(value):NaN;
export function normalizeWeatherObservation(value,now=new Date()){
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(key=>!['condition','is_day','observed_at','fetched_at','expires_at','sunrise_at','sunset_at'].includes(key)))return null;
  const time=Number(now),observed=instant(value.observed_at),fetched=instant(value.fetched_at),expires=instant(value.expires_at);
  if(!WEATHER_THEME_CONDITIONS.includes(value.condition)||typeof value.is_day!=='boolean'||![time,observed,fetched,expires].every(Number.isFinite)||observed>time+5*60000||fetched>time+5*60000||time-observed>=WEATHER_THEME_MAX_AGE_MS||time-fetched>=WEATHER_THEME_MAX_AGE_MS||expires<=time||expires>Math.min(observed,fetched)+WEATHER_THEME_MAX_AGE_MS)return null;
  const rise=instant(value.sunrise_at),set=instant(value.sunset_at),solar=Number.isFinite(rise)&&Number.isFinite(set)&&set>rise&&set-rise<=24*3600000;
  return{condition:value.condition,is_day:value.is_day,observed_at:value.observed_at,fetched_at:value.fetched_at,expires_at:value.expires_at,sunrise_at:solar?value.sunrise_at:null,sunset_at:solar?value.sunset_at:null};
}
export function weatherIsDay(value,now=new Date()){
  return value.sunrise_at&&value.sunset_at?Number(now)>=Date.parse(value.sunrise_at)&&Number(now)<Date.parse(value.sunset_at):value.is_day;
}
export function wmoThemeCondition(code){
  if(!Number.isInteger(code))return null;
  if([0,1].includes(code))return'sunny';if([2,3,45,48].includes(code))return'cloudy';
  if([51,53,55,56,57,61,63,65,66,67,80,81,82].includes(code))return'rain';
  if([71,73,75,77,85,86].includes(code))return'snow';if([95,96,97,99].includes(code))return'storm';return null;
}
export function owmThemeCondition(code,icon){
  if(Number.isInteger(code)){if(code>=200&&code<300)return'storm';if(code>=300&&code<600)return'rain';if(code>=600&&code<700)return'snow';if(code===800||code===801)return'sunny';if(code>=700&&code<805)return'cloudy';}
  return typeof icon==='string'?({'01':'sunny','02':'sunny','03':'cloudy','04':'cloudy','09':'rain','10':'rain','11':'storm','13':'snow','50':'cloudy'}[icon.slice(0,2)]||null):null;
}
export function providerWeatherInstant(value,offsetSeconds){
  if(typeof value!=='string')return null;
  if(/(?:Z|[+-]\d\d:\d\d)$/.test(value)){const time=Date.parse(value);return Number.isFinite(time)?new Date(time).toISOString():null;}
  if(!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?$/.test(value)||!Number.isInteger(offsetSeconds)||Math.abs(offsetSeconds)>14*3600)return null;
  const time=Date.parse(value+'Z');if(!Number.isFinite(time)||new Date(time).toISOString().slice(0,value.length)!==value)return null;
  return new Date(time-offsetSeconds*1000).toISOString();
}
export function unixWeatherInstant(value){
  if(typeof value!=='number'||!Number.isFinite(value)||value<0)return null;const time=value*1000;return Number.isFinite(new Date(time).getTime())?new Date(time).toISOString():null;
}
export function makeWeatherObservation({condition,is_day,observed_at,sunrise_at=null,sunset_at=null},now=new Date()){
  const observed=instant(observed_at),time=Number(now);if(!Number.isFinite(observed)||!Number.isFinite(time))return null;
  return normalizeWeatherObservation({condition,is_day,observed_at,fetched_at:new Date(time).toISOString(),expires_at:new Date(Math.min(observed,time)+WEATHER_THEME_MAX_AGE_MS).toISOString(),sunrise_at,sunset_at},new Date(time));
}
