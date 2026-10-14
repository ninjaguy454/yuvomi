// Synthetic provider evidence, while the complete application and auth/API
// boundaries remain production code. No live provider or household is contacted.
globalThis.fetch=async url=>{
  if(new URL(url).hostname!=='api.open-meteo.com')throw Error('Unexpected synthetic provider request');
  const time=new Date().toISOString(),day=time.slice(0,10);
  return{ok:true,json:async()=>({utc_offset_seconds:0,current:{time,is_day:1,weather_code:0,temperature_2m:18,apparent_temperature:17,relative_humidity_2m:50,wind_speed_10m:5},daily:{time:[day],weather_code:[0],temperature_2m_max:[20],temperature_2m_min:[12],sunrise:[day+'T00:00'],sunset:[day+'T23:59']}})};
};
await import('./note-board-full-app-server.mjs');
