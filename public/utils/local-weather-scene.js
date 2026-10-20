import {cameraGeometry,chooseVisibleSkyPoint,createSceneDynamics,deriveNightSky,createSkyStars,wrap} from './local-weather-scene/model.js';
import {CARD_SELECTOR,createCardMaterials} from './local-weather-scene/materials.js';

const ASSET='/assets/weather/cole-';
const seeded=i=>{let value=i|0;value=Math.imul(value^(value>>>16),0x45d9f3b);value=Math.imul(value^(value>>>16),0x45d9f3b);return ((value^(value>>>16))>>>0)/4294967296;};

/** Mount household-owned decorative art. Weather validation and sound belong to callers. */
export function mountLocalWeatherScene({onFlash=()=>{}}={}) {
  const doc=globalThis.document,win=globalThis.window;
  // SSR and lightweight DOM hosts do not have a drawable surface.
  if(!doc?.body||typeof doc.createElement!=='function'||typeof doc.querySelectorAll!=='function'||!win?.requestAnimationFrame){
    let disposed=false;
    return {update(){},dispose(){disposed=true;},getStats:()=>({disposed,rafActive:false,listenerCount:0,observerCount:0,materialFaces:0,particles:0,artCamera:null})};
  }
  let disposed=false,raf=null,lastFrameAt=0,frameDue=0,time=0,geometry=null,frame=null,materials=null,resizeObserver=null;
  let focused=typeof doc.hasFocus==='function'?doc.hasFocus():true,parked=false,activeFlash=null,nextFlashAt=null,previousFlash=null,lastFlashAt=-Infinity,flashSerial=0;
  let maskPixels=null,canvasWidth=1,canvasHeight=1,canvasDirty=false,panOffset=0,starCount=0;
  const listeners=[],art=[],cloudTiles=[],drawTimes=[],frameIntervals=[],flashes=[];
  const stats={frames:0,callbacks:0,canvasUpdates:0,skyUpdates:0,particles:0,maxParticles:160};
  const dynamics=createSceneDynamics();
  const element=(name,className)=>{const node=doc.createElement(name);node.className=className;return node;};
  const stage=element('div','local-weather-scene');stage.setAttribute('aria-hidden','true');stage.dataset.phase='day';
  const scrollTail=element('span','local-weather-scroll-tail');scrollTail.setAttribute('aria-hidden','true');
  const stylesheet=doc.createElement('link');stylesheet.rel='stylesheet';stylesheet.href='/styles/local-weather-scene.css';
  const listen=(target,name,handler)=>{if(!target?.addEventListener)return;target.addEventListener(name,handler);listeners.push(()=>target.removeEventListener(name,handler));};
  const queryMedia=query=>typeof win.matchMedia==='function'?win.matchMedia(query):{matches:false};
  const reduced=queryMedia('(prefers-reduced-motion:reduce)'),transparency=queryMedia('(prefers-reduced-transparency:reduce)'),forced=queryMedia('(forced-colors:active)');
  const frozen=()=>disposed||parked||!focused||doc.hidden||reduced.matches||transparency.matches||forced.matches;
  const canvas=element('canvas','local-weather-atmosphere'),ctx=canvas.getContext?.('2d',{alpha:true});
  const maskCanvas=doc.createElement('canvas');maskCanvas.width=96;maskCanvas.height=63;
  const maskContext=maskCanvas.getContext?.('2d',{willReadFrequently:true}),maskImage=doc.createElement('img');
  const skyViewport=element('div','local-weather-sky-viewport'),world=element('div','local-weather-sky-world'),strip=element('div','local-weather-cloud-strip'),glow=element('div','local-weather-sky-glow');
  const nightWash=element('div','local-weather-night-wash'),stars=element('div','local-weather-stars');
  skyViewport.append(world);world.append(nightWash,stars,strip,glow);
  for(const grade of ['clear-night','clear-day','snow-night','snow-day']){
    const image=element('img','local-weather-art');image.alt='';image.draggable=false;image.dataset.grade=grade;
    image.width=1600;image.height=1042;image.decoding='async';image.src=ASSET+grade+'.webp';art.push(image);stage.append(image);listen(image,'load',resize);
  }
  for(let i=0;i<4;i++){const tile=element('img','local-weather-cloud-tile');tile.alt='';tile.draggable=false;tile.src=ASSET+'clouds.webp';strip.append(tile);cloudTiles.push(tile);}
  stage.append(skyViewport,canvas);doc.body.prepend(stage);doc.head?.append(stylesheet);
  doc.documentElement?.setAttribute('data-local-weather-scene','');
  const particles=Array.from({length:160},(_,i)=>({x:seeded(i+7),y:seeded(i+101),r:1+seeded(i+79)*2.5,speed:.11+seeded(i+31)*.15}));

  function stopFlash(){activeFlash=null;nextFlashAt=null;glow.style.opacity='0';}
  function stop(){if(raf!==null)win.cancelAnimationFrame(raf);raf=null;lastFrameAt=0;frameDue=0;}
  function runnable(){return !frozen()&&frame?.rich&&(frame.clouds>.003||frame.fog>.003||frame.rain>.003||frame.snow>.003||frame.hail>.003||frame.lightning||dynamics.pending());}
  function run(){
    stop();if(disposed)return;
    draw(time,frozen(),0);
    if(frozen()||!frame?.lightning)stopFlash();
    else if(nextFlashAt===null)nextFlashAt=performance.now()+2000+Math.random()*2000;
    if(runnable())raf=win.requestAnimationFrame(tick);
  }
  function resize(){
    if(disposed)return;
    const rect=stage.getBoundingClientRect();geometry=cameraGeometry(rect.width||win.innerWidth,rect.height||win.innerHeight);
    for(const image of art){image.style.objectFit=geometry.fit;image.style.objectPosition='50% 52%';}
    world.style.width=geometry.width+'px';world.style.height=geometry.height+'px';world.style.left=-geometry.left+'px';world.style.top=-geometry.top+'px';
    for(const tile of cloudTiles)tile.style.width=geometry.width+'px';
    const scale=Math.min(1,1280/geometry.boxWidth,800/geometry.boxHeight);
    canvasWidth=Math.max(1,Math.round(geometry.boxWidth*scale));canvasHeight=Math.max(1,Math.round(geometry.boxHeight*scale));
    canvas.width=canvasWidth;canvas.height=canvasHeight;canvasDirty=false;
    positionPan();
    run();
  }
  function positionPan(){
    if(disposed||!geometry)return;
    const extra=Math.max(0,geometry.boxHeight-win.innerHeight),host=doc.querySelector('.app-content');
    if(extra<1||geometry.mobile){scrollTail.remove();panOffset=0;}
    else if(host){
      if(scrollTail.parentNode!==host){host.append(scrollTail);panOffset=Math.min(extra,host.scrollTop);}
      let height=extra;
      for(let i=0;i<3;i++){
        scrollTail.style.height=height+'px';scrollTail.style.minHeight=height+'px';scrollTail.style.flex='0 0 '+height+'px';
        const missing=extra-(host.scrollHeight-host.clientHeight);if(missing<1)break;height+=missing;
      }
      panOffset=Math.min(extra,panOffset);
    }
    geometry.visibleTop=panOffset;geometry.viewportHeight=win.innerHeight;
    stage.style.transform=panOffset?'translate3d(0,'+(-panOffset)+'px,0)':'none';
  }
  function panScene(event){
    if(disposed||!geometry||!event.target?.matches?.('.app-content,.page-scrollport'))return;
    const extra=Math.max(0,geometry.boxHeight-win.innerHeight);if(extra<1)return;
    panOffset=Math.min(extra,Math.max(0,event.target.scrollTop||0));geometry.visibleTop=panOffset;
    stage.style.transform=panOffset?'translate3d(0,'+(-panOffset)+'px,0)':'none';
  }
  doc.addEventListener('scroll',panScene,true);listeners.push(()=>doc.removeEventListener('scroll',panScene,true));
  function blockedRects(){
    return [...doc.querySelectorAll(CARD_SELECTOR+',button,input,select,textarea,.nav-sidebar,.nav-bottom,.page-header,.dashboard-overview,.wall-dashboard__header,.modal-panel')]
      .filter(node=>!node.closest('[hidden]')).map(node=>{const r=node.getBoundingClientRect();return {left:r.left,top:r.top+panOffset,right:r.right,bottom:r.bottom+panOffset};}).filter(r=>r.right>r.left&&r.bottom>r.top);
  }
  function flash(now){
    if(frozen()||!frame?.lightning||!maskPixels||!geometry||now-lastFlashAt<5000)return;
    const spot=chooseVisibleSkyPoint(maskPixels,geometry,blockedRects(),previousFlash);
    if(!spot){nextFlashAt=now+10000;return;}
    previousFlash=spot;const duration=900+Math.random()*300,id=++flashSerial;
    activeFlash={...spot,start:now,duration,id};lastFlashAt=now;nextFlashAt=now+duration+9000+Math.random()*9000;
    flashes.push({...spot,id,at:now,duration});if(flashes.length>32)flashes.shift();
    const rx=Math.min(geometry.boxWidth*.38,520),ry=Math.min(geometry.boxHeight*.42,270);
    glow.style.background='radial-gradient(ellipse '+rx+'px '+ry+'px at '+spot.x*geometry.width+'px '+spot.y*geometry.height+'px,rgba(205,222,255,.92),rgba(176,196,235,.7) 30%,rgba(130,155,198,.35) 66%,transparent)';
    onFlash({id,delayMs:2000+Math.random()*2000});
  }
  function grades(){
    const snow=frame.coarseSnow?1:Math.max(0,Math.min(1,frame.snowMass*1.5+frame.snow*.15)),day=frame.daylight;
    // An opaque base prevents underpaint seams; these registered grades crossfade above it.
    const opacity={'clear-night':1,'clear-day':day,'snow-night':snow*(1-day),'snow-day':snow*day};
    for(const image of art)image.style.opacity=opacity[image.dataset.grade].toFixed(4);
    stage.dataset.phase=day<.25?'night':day>.75?'day':'twilight';stage.dataset.rich=String(frame.rich);
    stage.style.backgroundColor='rgb('+[29+(101-29)*day,42+(94-42)*day,48+(78-48)*day].map(Math.round).join(',')+')';
    strip.style.opacity=frame.clouds.toFixed(4);strip.style.filter='brightness('+(.55+day*.45).toFixed(3)+')';
    const nightSky=deriveNightSky(frame);nightWash.style.opacity=nightSky.darkness.toFixed(4);stars.style.opacity=nightSky.stars.toFixed(4);
  }
  function draw(t,still,dt){
    if(disposed)return;
    frame=dynamics.advance(dt,t,Date.now(),still);grades();
    if(frame.clouds>.003&&!still&&geometry){const offset=-(1-wrap(frame.windTravel*.015))*geometry.width;strip.style.transform='translate3d('+offset.toFixed(2)+'px,0,0)';stats.skyUpdates++;}
    materials?.update(frame,t,still,forced.matches||transparency.matches||!frame.rich);
    const now=performance.now();
    if(!still&&frame.lightning){if(!activeFlash&&nextFlashAt!==null&&now>=nextFlashAt)flash(now);if(activeFlash){const progress=(now-activeFlash.start)/activeFlash.duration;if(progress>=1){activeFlash=null;glow.style.opacity='0';}else glow.style.opacity=(Math.sin(Math.max(0,progress)*Math.PI)**2*(frame.daylight<.5?.44:.28)).toFixed(4);}}
    else stopFlash();
    if(disposed||!frame||!ctx)return;
    if(still||!frame.rich||frame.rain+frame.snow+frame.hail+frame.fog<.003){stats.particles=0;if(canvasDirty){ctx.clearRect(0,0,canvasWidth,canvasHeight);canvasDirty=false;}return;}
    const start=performance.now();ctx.clearRect(0,0,canvasWidth,canvasHeight);canvasDirty=true;stats.canvasUpdates++;
    const scale=canvasWidth/geometry.boxWidth,w=canvasWidth,h=canvasHeight,night=frame.daylight<.5;
    ctx.save();ctx.beginPath();ctx.rect(Math.max(0,-geometry.left*scale),Math.max(0,-geometry.top*scale),Math.min(w,geometry.width*scale),Math.min(h,geometry.height*scale));ctx.clip();
    if(frame.fog>.003){
      const sceneH=Math.min(h,geometry.height*scale),wash=ctx.createLinearGradient(0,sceneH*.3,0,sceneH*.85);
      wash.addColorStop(0,'transparent');wash.addColorStop(.45,'rgba(228,240,235,.13)');wash.addColorStop(1,'transparent');ctx.globalAlpha=frame.fog*(night?.7:1);ctx.fillStyle=wash;ctx.fillRect(0,sceneH*.3,w,sceneH*.55);
      for(let i=0;i<3;i++){const x=(wrap(i*.39+frame.windTravel*.012)*1.4-.25)*w,y=sceneH*(.44+i*.06),g=ctx.createRadialGradient(x,y,1,x,y,w*.42);g.addColorStop(0,'rgba(221,234,233,.12)');g.addColorStop(1,'transparent');ctx.fillStyle=g;ctx.fillRect(0,sceneH*.3,w,sceneH*.5);}
    }
    const total=frame.rain+frame.snow+frame.hail,count=Math.min(160,Math.ceil(frame.rain*80+frame.snow*72+frame.hail*32));stats.particles=count;
    for(let i=0;i<count;i++){
      const p=particles[i],part=seeded(i+213)*total,asSnow=part<frame.snow,asHail=part>=frame.snow+frame.rain,speed=asSnow?p.speed*.18:asHail?p.speed*1.1:p.speed*2;
      const x=wrap(p.x+frame.windTravel*(asSnow?.08:.1))*w,y=wrap(p.y+t*speed)*h;
      ctx.globalAlpha=(asSnow?.65:asHail?.75:.35)*Math.min(1,total);ctx.fillStyle=night?'#deecf1':'#eff9fa';ctx.strokeStyle=night?'#cddfea':'#dbeef1';
      if(asSnow&&!frame.sleet&&!frame.grains){ctx.beginPath();ctx.arc(x+Math.sin(t+p.x*8)*4,y,p.r,0,Math.PI*2);ctx.fill();}
      else if(asSnow||asHail)ctx.fillRect(x,y,asHail?2.6:1.8,asHail?3.4:2.2);
      else{ctx.lineWidth=frame.drizzle?.5:.7;const length=frame.drizzle?6:14;ctx.beginPath();ctx.moveTo(x,y);ctx.lineTo(x-frame.windX*8,y-length);ctx.stroke();}
    }
    ctx.restore();drawTimes.push(performance.now()-start);if(drawTimes.length>256)drawTimes.shift();
  }
  function tick(now){
    raf=null;stats.callbacks++;if(!runnable()){run();return;}
    const period=1000/30;if(!frameDue)frameDue=now;
    if(now+.5>=frameDue){const dt=lastFrameAt?Math.min(.08,(now-lastFrameAt)/1000):period/1000;
      if(lastFrameAt){frameIntervals.push(now-lastFrameAt);if(frameIntervals.length>256)frameIntervals.shift();}
      lastFrameAt=now;time+=dt;draw(time,false,dt);stats.frames++;frameDue+=period;if(frameDue<now-period)frameDue=now+period;
    }
    if(runnable())raf=win.requestAnimationFrame(tick);
  }
  listen(maskImage,'load',()=>{
    if(disposed||!maskContext)return;
    try{
      maskContext.drawImage(maskImage,0,0,96,63);maskPixels=maskContext.getImageData(0,0,96,63).data;
      if(typeof doc.createElementNS==='function'){
        const points=createSkyStars(maskPixels),svg=doc.createElementNS('http://www.w3.org/2000/svg','svg');
        svg.setAttribute('viewBox','0 0 1600 1042');svg.setAttribute('preserveAspectRatio','none');svg.setAttribute('aria-hidden','true');svg.setAttribute('focusable','false');
        for(const point of points){const circle=doc.createElementNS('http://www.w3.org/2000/svg','circle');circle.setAttribute('cx',String(point.x*1600));circle.setAttribute('cy',String(point.y*1042));circle.setAttribute('r',String(point.radius));circle.setAttribute('fill','#e9f3ff');circle.setAttribute('fill-opacity',String(point.opacity));svg.append(circle);}
        stars.replaceChildren(svg);starCount=points.length;
      }
    }catch{maskPixels=null;stars.replaceChildren();starCount=0;}
  });maskImage.src=ASSET+'sky-mask.webp';
  listen(stylesheet,'load',resize);
  listen(win,'resize',resize);
  listen(doc,'visibilitychange',()=>{stopFlash();run();});
  listen(win,'blur',()=>{focused=false;stopFlash();run();});
  listen(win,'focus',()=>{focused=true;run();});
  listen(win,'pagehide',()=>{parked=true;stopFlash();run();});
  listen(win,'pageshow',()=>{parked=false;run();});
  for(const media of [reduced,transparency,forced])listen(media,'change',()=>{stopFlash();run();});
  materials=createCardMaterials({document:doc,window:win,onChange:()=>{if(disposed)return;positionPan();if(frame)materials?.update(frame,time,frozen(),forced.matches||transparency.matches||!frame.rich);}});
  if(typeof win.ResizeObserver==='function'){resizeObserver=new win.ResizeObserver(resize);resizeObserver.observe(stage);}
  resize();
  return {
    update({theme=null,scene=null}={}){
      if(disposed)return;
      // The normalizer owns the strict v1 contract; missing facts erase richer residue.
      dynamics.update(theme,scene);stage.dataset.provider=scene?.version===1?scene.provider||'':'';stage.dataset.code=scene?.version===1?String(scene.condition_code??''):'';
      stopFlash();run();
    },
    dispose(){
      if(disposed)return;disposed=true;stop();stopFlash();dynamics.clear();frame=null;materials?.dispose();resizeObserver?.disconnect();resizeObserver=null;
      for(const remove of listeners)remove();listeners.length=0;
      stage.remove();scrollTail.remove();stylesheet.remove();doc.documentElement?.removeAttribute('data-local-weather-scene');
      for(const image of [...art,...cloudTiles,maskImage])image.removeAttribute('src');art.length=0;cloudTiles.length=0;maskPixels=null;previousFlash=null;geometry=null;
      stars.replaceChildren();starCount=0;
      canvas.width=1;canvas.height=1;maskCanvas.width=1;maskCanvas.height=1;particles.length=0;flashes.length=0;stats.particles=0;
    },
    getStats(){
      const materialStats=materials?.getStats()||{materialFaces:0,observerCount:0},sorted=[...drawTimes].sort((a,b)=>a-b);
      return {...stats,...materialStats,disposed,rafActive:raf!==null,listenerCount:listeners.length,observerCount:materialStats.observerCount+Number(!!resizeObserver),artCamera:geometry?{...geometry,visibleSource:{...geometry.visibleSource}}:null,
        scene:frame?{...frame,wind:frame.wind?{...frame.wind}:null}:null,skyPickerReady:!!maskPixels,skyStars:starCount,starOpacity:Number(stars.style.opacity)||0,nightSkyDarkness:Number(nightWash.style.opacity)||0,flashes:flashes.map(value=>({...value})),flashActive:!!activeFlash,flashAlpha:Number(glow.style.opacity)||0,nextFlashAt,
        drawMs:[...drawTimes],frameIntervals:[...frameIntervals],p95DrawMs:sorted[Math.floor(sorted.length*.95)]||0,fpsTarget:30,
        canvas:{width:canvas.width,height:canvas.height,bytes:canvas.width*canvas.height*4},smokeAnchor:null,windowLights:false};
    }
  };
}
