// Numeric facts govern an illustration, never an observation of a pane or strike.
const clamp = (value, low=0, high=1) => Math.max(low,Math.min(high,value));
const wrap = value => ((value%1)+1)%1;

export function solarGrade(now,rise,set,isDay) {
  if(![now,rise,set].every(value=>typeof value==='number'&&Number.isFinite(value))||set<=rise||set-rise>86400000)return isDay?1:0;
  const smooth=x=>{x=clamp(x);return x*x*(3-2*x);};
  // Artistic twenty-minute dawn/dusk shoulders, not measured twilight.
  return smooth((now-rise+1200000)/2400000)*(1-smooth((now-set+1200000)/2400000));
}

export function deriveSceneTargets(theme,scene,now=Date.now(),time=0) {
  const rich=scene?.version===1,phenomena=new Set(rich?scene.phenomena:[]);
  const precipitation=rich?scene.precipitation:null,kind=precipitation?.kind||'unknown';
  const intensity=({light:.4,moderate:1,heavy:1.5})[precipitation?.intensity]||1;
  const wind={speed_mps:null,gust_mps:null,from_degrees:null};
  for(const [key,max]of [['speed_mps',100],['gust_mps',120],['from_degrees',359.999999]]){
    const value=rich?scene.wind?.[key]:null;
    if(typeof value==='number'&&Number.isFinite(value)&&value>=0&&value<=max)wind[key]=value;
  }
  const directed=wind.speed_mps!==null&&wind.from_degrees!==null;
  const hasGust=directed&&wind.gust_mps!==null;
  const gust=hasGust?(Math.sin(time*.73)+Math.sin(time*.31+1)+2)/4:0;
  // Preserve the reported peak even when below mean; do not raise it.
  const speed=directed?wind.speed_mps+(hasGust?(wind.gust_mps-wind.speed_mps)*gust:0):0;
  const rain=rich&&(phenomena.has('rain')||phenomena.has('drizzle')||phenomena.has('freezing-liquid')||['rain','drizzle','mixed'].includes(kind));
  const snow=rich&&(phenomena.has('snow')||phenomena.has('snow-grains')||phenomena.has('sleet')||['snow','snow-grains','sleet','mixed'].includes(kind));
  const fog=rich&&(phenomena.has('fog')||phenomena.has('mist')||phenomena.has('rime'));
  const solar=rich?scene.solar:theme;
  const daylight=solarGrade(now,solar?.sunrise_at?Date.parse(solar.sunrise_at):null,solar?.sunset_at?Date.parse(solar.sunset_at):null,solar?.is_day!==false);
  const measured=rich&&typeof scene.cloud_cover==='number'&&Number.isFinite(scene.cloud_cover)?clamp(scene.cloud_cover):null;
  const categoryCloud=phenomena.has('overcast')?1:phenomena.has('partly-cloudy')?.58:rain||snow||fog||phenomena.has('thunder')||phenomena.has('hail')?.75:0;
  const visibility=rich&&typeof scene.visibility_m==='number'&&Number.isFinite(scene.visibility_m)?scene.visibility_m:null;
  return {rich,precipitationKind:kind,wind,windX:directed?-Math.sin(wind.from_degrees*Math.PI/180)*clamp(speed,0,50)/18:0,gust,
    rain:rain?intensity:0,snow:snow?intensity:0,hail:rich&&phenomena.has('hail')?intensity:0,
    fog:fog?(visibility===null?.65:clamp(1-visibility/12000,.15,1)):0,clouds:rich?(measured??categoryCloud):0,
    daylight,freezing:rich&&phenomena.has('freezing-liquid'),rime:rich&&phenomena.has('rime'),
    grains:phenomena.has('snow-grains')||kind==='snow-grains',sleet:phenomena.has('sleet')||kind==='sleet',
    drizzle:phenomena.has('drizzle')||kind==='drizzle',lightning:rich&&phenomena.has('thunder'),
    coarseSnow:!rich&&theme?.condition==='snow'};
}

export function createSceneDynamics() {
  let theme=null,scene=null,first=true;
  const f={rich:false,rain:0,snow:0,hail:0,fog:0,clouds:0,daylight:1,windX:0,windTravel:0,gust:0,wet:0,snowMass:0,denseIce:0,ice:0,transitioning:false,coarseSnow:false};
  const keys=['rain','snow','hail','fog','clouds','daylight','windX'];
  function clear(){for(const key of Object.keys(f))f[key]=['rich','transitioning','coarseSnow'].includes(key)?false:0;first=true;}
  function advance(dt,time,now=Date.now(),still=false){
    const target=deriveSceneTargets(theme,scene,now,time),step=clamp(dt,0,.08),blend=still||first?1:1-Math.exp(-step*2);
    f.rich=target.rich;f.coarseSnow=target.coarseSnow;f.transitioning=false;
    for(const key of keys){f[key]+=(target[key]-f[key])*blend;if(Math.abs(f[key]-target[key])<.003)f[key]=target[key];if(key!=='windX'&&Math.abs(f[key]-target[key])>.008)f.transitioning=true;}
    f.gust=target.gust;
    if(target.rich){
      if(!still){
        f.windTravel+=f.windX*step;
        f.wet=target.rain?clamp(f.wet+step*.32*f.rain):Math.max(0,f.wet-step*.04*(.6+f.daylight));
        f.snowMass=target.snow?clamp(f.snowMass+step*.15*f.snow):Math.max(0,f.snowMass-step*.025*(.6+f.daylight+(target.rain?.5:0)));
        f.denseIce=target.snow&&(Math.abs(f.windX)>.65||target.snow>1)?Math.min(f.snowMass,f.denseIce+step*.15*f.snow):Math.max(0,f.denseIce-step*.025*(.6+f.daylight+(target.rain?.5:0)));
      }else{if(target.rain)f.wet=Math.max(f.wet,.65);if(target.snow){f.snowMass=Math.max(f.snowMass,.65);if(target.snow>1)f.denseIce=Math.max(f.denseIce,.65);}}
      if(!target.rain&&f.wet<.008)f.wet=0;
      if(!target.snow&&f.snowMass<.008)f.snowMass=0;
      if(!target.snow&&f.denseIce<.008)f.denseIce=0;
      f.ice=Math.max(f.snowMass,target.freezing?.35:target.rime?.45:0);
    }
    first=false;return {...f,...target, ...Object.fromEntries(keys.map(key=>[key,f[key]])),wet:f.wet,snowMass:f.snowMass,denseIce:f.denseIce,ice:f.ice,windTravel:f.windTravel,transitioning:f.transitioning};
  }
  return {update(nextTheme,nextScene){theme=nextTheme;scene=nextScene?.version===1?nextScene:null;if(!scene){clear();advance(0,0,Date.now(),true);}},advance,frame:()=>({...f}),
    pending:()=>!!scene&&(f.transitioning||f.wet>0||f.snowMass>0),clear(){scene=null;theme=null;clear();}};
}

export function cameraGeometry(boxWidth,boxHeight) {
  boxWidth=Math.max(1,boxWidth);boxHeight=Math.max(1,boxHeight);
  const mobile=boxWidth<=700,fit=mobile||boxWidth/boxHeight>2.11?'contain':'cover';
  const scale=mobile?boxWidth/1600:(fit==='cover'?Math.max:Math.min)(boxWidth/1600,boxHeight/1042);
  const width=1600*scale,height=1042*scale,left=(width-boxWidth)*.5,top=mobile?0:(height-boxHeight)*.52;
  return {width,height,left,top,scale,fit,boxWidth,boxHeight,mobile,
    visibleSource:{left:left/width,top:top/height,right:(left+boxWidth)/width,bottom:(top+boxHeight)/height}};
}

export function chooseVisibleSkyPoint(pixels,g,blocked=[],previous=null,random=Math.random) {
  if(!pixels||!g)return null;
  const points=[];
  for(let y=2;y<61;y+=2)for(let x=2;x<94;x+=2){
    const i=(y*96+x)*4,bright=.2126*pixels[i]+.7152*pixels[i+1]+.0722*pixels[i+2];
    if(bright<225||pixels[i+3]<230)continue;
    const nx=(x+.5)/96,ny=(y+.5)/63,visibleX=nx*g.width-g.left,visibleY=ny*g.height-g.top;
    const top=g.visibleTop||0,viewHeight=g.viewportHeight||g.boxHeight;
    if(visibleX<20||visibleX>g.boxWidth-20||visibleY<top+20||visibleY>Math.min(top+viewHeight-20,g.boxHeight-20,g.height*.65-g.top))continue;
    if(blocked.some(r=>visibleX>r.left-15&&visibleX<r.right+15&&visibleY>r.top-15&&visibleY<r.bottom+15))continue;
    points.push({x:nx,y:ny,visibleX,visibleY,maskVerified:true});
  }
  if(!points.length)return null;
  const separated=previous?points.filter(p=>Math.hypot((p.visibleX-previous.visibleX)/g.boxWidth,(p.visibleY-previous.visibleY)/g.boxHeight)>.22):points;
  const candidates=separated.length?separated:points,midpoint=candidates.reduce((sum,p)=>sum+p.visibleX,0)/candidates.length;
  const opposite=previous?candidates.filter(p=>previous.visibleX<midpoint?p.visibleX>=midpoint:p.visibleX<midpoint):candidates;
  const final=opposite.length?opposite:candidates;
  return {...final[Math.min(final.length-1,Math.floor(clamp(random())*final.length))]};
}

export {wrap};
