// The application, authentication, permissions and provider adapter are real;
// only the external provider response is synthetic and contains no live location.
globalThis.fetch=async url=>{
  if(new URL(url).hostname!=='api.open-meteo.com')throw Error('Unexpected synthetic provider request');
  const time=new Date().toISOString(),day=time.slice(0,10);
  return{ok:true,json:async()=>({utc_offset_seconds:0,current:{time,interval:900,is_day:1,weather_code:66,temperature_2m:-1,apparent_temperature:-3,relative_humidity_2m:90,wind_speed_10m:14.4,wind_gusts_10m:28.8,wind_direction_10m:270,cloud_cover:85,visibility:2000,rain:0.2,showers:0,snowfall:0},current_units:{time:'iso8601',interval:'seconds',wind_speed_10m:'km/h',wind_gusts_10m:'km/h',wind_direction_10m:'°',cloud_cover:'%',visibility:'m',rain:'mm',showers:'mm',snowfall:'cm'},daily:{time:[day],weather_code:[66],temperature_2m_max:[1],temperature_2m_min:[-3],sunrise:[day+'T06:00'],sunset:[day+'T18:00']}})};
};
await import('./note-board-full-app-server.mjs');
