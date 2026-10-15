import {Game,ROOMS,NIGHT_SECONDS} from '/utils/night-shift-game.js';
import {createScreamSamples} from '/utils/night-shift-scream.js';
import {nightShiftCopy,nightShiftSettings,nightShiftSettingsKey} from '/utils/night-shift-copy.js';
import {deviceBootstrap} from '/utils/device-context.js';
import {getLocale} from '/i18n.js';
import {attachOverlay,dropOverlay} from '/utils/overlay-history.js';
const MARKUP="<svg class=\"crew-symbols\" xmlns=\"http://www.w3.org/2000/svg\" aria-hidden=\"true\"><defs><symbol id=\"ns-crew-bear\" viewBox=\"0 0 100 110\"><circle cx=\"20\" cy=\"40\" r=\"13\" fill=\"#936436\" stroke=\"#291d17\" stroke-width=\"3\"/><circle cx=\"80\" cy=\"40\" r=\"13\" fill=\"#936436\" stroke=\"#291d17\" stroke-width=\"3\"/><circle cx=\"20\" cy=\"40\" r=\"7\" fill=\"#cc985d\"/><circle cx=\"80\" cy=\"40\" r=\"7\" fill=\"#cc985d\"/><path d=\"M20 57C20 20 80 20 80 57v18c0 37-60 37-60 0Z\" fill=\"#b57b3f\" stroke=\"#291d17\" stroke-width=\"3\"/><path d=\"M30 25h40M36 25V9h28v16\" fill=\"#222825\" stroke=\"#161a18\" stroke-width=\"4\"/><path d=\"M37 21h26\" stroke=\"#b2764c\" stroke-width=\"3\"/><path d=\"m29 45 14-2m14 0 14 2\" stroke=\"#36281c\" stroke-width=\"4\"/><ellipse cx=\"37\" cy=\"55\" rx=\"8\" ry=\"10\" fill=\"#e6d6ad\"/><ellipse cx=\"63\" cy=\"55\" rx=\"8\" ry=\"10\" fill=\"#e6d6ad\"/><circle cx=\"38\" cy=\"56\" r=\"3.5\" fill=\"#273c46\"/><circle cx=\"62\" cy=\"56\" r=\"3.5\" fill=\"#273c46\"/><ellipse cx=\"50\" cy=\"77\" rx=\"23\" ry=\"15\" fill=\"#dfab6a\"/><ellipse cx=\"50\" cy=\"70\" rx=\"9\" ry=\"6\" fill=\"#2b241c\"/><path d=\"M37 81q13 11 26 0\" fill=\"none\" stroke=\"#4b3323\" stroke-width=\"2.5\"/><path d=\"m32 105 17-9v13l-17-4m36 0-17-9v13Z\" fill=\"#252925\"/><circle cx=\"50\" cy=\"103\" r=\"4\" fill=\"#33392e\"/></symbol><symbol id=\"ns-crew-bunny\" viewBox=\"0 0 100 130\"><path d=\"M26 56C10 16 15 0 26 4s21 28 20 47M55 51C55 18 65-4 76 4s8 37-6 55\" fill=\"#8674ad\" stroke=\"#322a45\" stroke-width=\"3\"/><path d=\"M26 41c-6-22-5-26-1-27m43 26 5-25\" stroke=\"#b9a5c8\" stroke-width=\"8\" stroke-linecap=\"round\"/><path d=\"M18 80C16 29 84 30 82 80v17c0 35-64 35-64 0Z\" fill=\"#8674ad\" stroke=\"#322a45\" stroke-width=\"3\"/><ellipse cx=\"36\" cy=\"74\" rx=\"8\" ry=\"10\" fill=\"#eee3ca\"/><ellipse cx=\"64\" cy=\"74\" rx=\"8\" ry=\"10\" fill=\"#eee3ca\"/><circle cx=\"37\" cy=\"75\" r=\"3\" fill=\"#5c485c\"/><circle cx=\"63\" cy=\"75\" r=\"3\" fill=\"#5c485c\"/><ellipse cx=\"50\" cy=\"99\" rx=\"23\" ry=\"14\" fill=\"#b6a9c1\"/><path d=\"m42 88 8 7 8-7Z\" fill=\"#3e344b\"/><path d=\"M37 102q13 8 26 0\" stroke=\"#51445f\" stroke-width=\"2\" fill=\"none\"/><path d=\"m34 128 16-9 16 9v-15l-16 7-16-7Z\" fill=\"#a65053\"/></symbol><symbol id=\"ns-crew-chicken\" viewBox=\"0 0 100 110\"><path d=\"m44 27-8-20 13 10L56 3l5 16 12-8-8 19\" fill=\"#d7ba50\" stroke=\"#5d5226\" stroke-width=\"2\"/><path d=\"M18 65C14 14 87 14 82 65v20c0 27-64 27-64 0Z\" fill=\"#d7ba50\" stroke=\"#5d5226\" stroke-width=\"3\"/><ellipse cx=\"36\" cy=\"53\" rx=\"9\" ry=\"11\" fill=\"#f5edd3\"/><ellipse cx=\"64\" cy=\"53\" rx=\"9\" ry=\"11\" fill=\"#f5edd3\"/><circle cx=\"38\" cy=\"56\" r=\"4\" fill=\"#795677\"/><circle cx=\"62\" cy=\"56\" r=\"4\" fill=\"#795677\"/><path d=\"M29 76q21-31 42 0-20 29-42 0Z\" fill=\"#cf7d37\" stroke=\"#86502a\" stroke-width=\"2\"/><path d=\"M32 77h36\" stroke=\"#633e27\" stroke-width=\"2\"/><path d=\"M28 97q22 10 44 0l5 13H23Z\" fill=\"#e4dec6\"/><path d=\"M40 106h20\" stroke=\"#bd8d42\" stroke-width=\"3\"/></symbol><symbol id=\"ns-crew-fox\" viewBox=\"0 0 100 115\"><path d=\"m23 50-7-36 29 21m13-1 24-22-1 40\" fill=\"#b96b4f\" stroke=\"#502d2a\" stroke-width=\"3\"/><path d=\"M19 58c0-41 66-42 64 0l-5 25-28 19-28-19Z\" fill=\"#b96b4f\" stroke=\"#502d2a\" stroke-width=\"3\"/><path d=\"m24 25 3 16 10-6m29 0 10 6 1-17\" fill=\"#d5ac88\"/><ellipse cx=\"36\" cy=\"61\" rx=\"9\" ry=\"11\" fill=\"#e6d6b8\"/><circle cx=\"37\" cy=\"63\" r=\"4\" fill=\"#7c894c\"/><path d=\"m26 47 48 17\" stroke=\"#272924\" stroke-width=\"4\"/><ellipse cx=\"65\" cy=\"62\" rx=\"11\" ry=\"12\" fill=\"#272924\"/><path d=\"M26 86q24-27 48 0l-24 14Z\" fill=\"#e0b78d\"/><path d=\"m43 80 7 9 7-9Z\" fill=\"#372b27\"/><path d=\"M35 91q15 9 29-1\" fill=\"none\" stroke=\"#743f2c\" stroke-width=\"2\"/><path d=\"M38 105h24v10H38Z\" fill=\"#b96b4f\"/></symbol><symbol id=\"ns-dread-bear\" viewBox=\"0 0 100 110\"><use href=\"#ns-crew-bear\" width=\"100\" height=\"110\"/><path d=\"M21 43 28 87m51-43-9 44\" stroke=\"#211d1b\" stroke-width=\"2\" opacity=\".8\"/><ellipse cx=\"36\" cy=\"55\" rx=\"11\" ry=\"13\" fill=\"#101210\"/><ellipse cx=\"64\" cy=\"55\" rx=\"11\" ry=\"13\" fill=\"#101210\"/><circle cx=\"36\" cy=\"56\" r=\"2.8\" fill=\"#ffe6a4\"/><circle cx=\"64\" cy=\"56\" r=\"2.8\" fill=\"#ffe6a4\"/><path d=\"M27 72q23-12 46 0v15q-23 14-46 0Z\" fill=\"#110f0e\" stroke=\"#55402f\" stroke-width=\"2\"/><path d=\"M31 72h7v8h-7zm10-1h7v9h-7zm11 0h7v9h-7zm11 1h7v8h-7zM32 90h7v-7h-7zm11 2h7v-9h-7zm11 0h7v-9h-7zm11-2h6v-7h-6z\" fill=\"#b9b495\"/><path d=\"M24 37 43 44m14 0 20-7\" stroke=\"#362c23\" stroke-width=\"5\"/><circle cx=\"23\" cy=\"66\" r=\"2\" fill=\"#4e5043\"/><circle cx=\"78\" cy=\"66\" r=\"2\" fill=\"#4e5043\"/></symbol><symbol id=\"ns-dread-bunny\" viewBox=\"0 0 100 130\"><use href=\"#ns-crew-bunny\" width=\"100\" height=\"130\"/><path d=\"M21 43 28 87m51-43-9 44\" stroke=\"#211d1b\" stroke-width=\"2\" opacity=\".8\"/><ellipse cx=\"36\" cy=\"74\" rx=\"11\" ry=\"13\" fill=\"#101210\"/><ellipse cx=\"64\" cy=\"74\" rx=\"11\" ry=\"13\" fill=\"#101210\"/><circle cx=\"36\" cy=\"75\" r=\"2.8\" fill=\"#ffe6a4\"/><circle cx=\"64\" cy=\"75\" r=\"2.8\" fill=\"#ffe6a4\"/><path d=\"M27 96q23-12 46 0v15q-23 14-46 0Z\" fill=\"#110f0e\" stroke=\"#55402f\" stroke-width=\"2\"/><path d=\"M31 96h7v8h-7zm10-1h7v9h-7zm11 0h7v9h-7zm11 1h7v8h-7zM32 114h7v-7h-7zm11 2h7v-9h-7zm11 0h7v-9h-7zm11-2h6v-7h-6z\" fill=\"#b9b495\"/><path d=\"M24 56 43 63m14 0 20-7\" stroke=\"#362c23\" stroke-width=\"5\"/><circle cx=\"23\" cy=\"90\" r=\"2\" fill=\"#4e5043\"/><circle cx=\"78\" cy=\"90\" r=\"2\" fill=\"#4e5043\"/></symbol><symbol id=\"ns-dread-chicken\" viewBox=\"0 0 100 110\"><use href=\"#ns-crew-chicken\" width=\"100\" height=\"110\"/><path d=\"M21 43 28 87m51-43-9 44\" stroke=\"#211d1b\" stroke-width=\"2\" opacity=\".8\"/><ellipse cx=\"36\" cy=\"53\" rx=\"11\" ry=\"13\" fill=\"#101210\"/><ellipse cx=\"64\" cy=\"53\" rx=\"11\" ry=\"13\" fill=\"#101210\"/><circle cx=\"36\" cy=\"54\" r=\"2.8\" fill=\"#ffe6a4\"/><circle cx=\"64\" cy=\"54\" r=\"2.8\" fill=\"#ffe6a4\"/><path d=\"M27 74q23-12 46 0v15q-23 14-46 0Z\" fill=\"#110f0e\" stroke=\"#55402f\" stroke-width=\"2\"/><path d=\"M31 74h7v8h-7zm10-1h7v9h-7zm11 0h7v9h-7zm11 1h7v8h-7zM32 92h7v-7h-7zm11 2h7v-9h-7zm11 0h7v-9h-7zm11-2h6v-7h-6z\" fill=\"#b9b495\"/><path d=\"M24 35 43 42m14 0 20-7\" stroke=\"#362c23\" stroke-width=\"5\"/><circle cx=\"23\" cy=\"68\" r=\"2\" fill=\"#4e5043\"/><circle cx=\"78\" cy=\"68\" r=\"2\" fill=\"#4e5043\"/></symbol><symbol id=\"ns-dread-fox\" viewBox=\"0 0 100 115\"><use href=\"#ns-crew-fox\" width=\"100\" height=\"115\"/><path d=\"M21 43 28 87m51-43-9 44\" stroke=\"#211d1b\" stroke-width=\"2\" opacity=\".8\"/><ellipse cx=\"36\" cy=\"61\" rx=\"11\" ry=\"13\" fill=\"#101210\"/><ellipse cx=\"64\" cy=\"61\" rx=\"11\" ry=\"13\" fill=\"#101210\"/><circle cx=\"36\" cy=\"62\" r=\"2.8\" fill=\"#ffe6a4\"/><circle cx=\"64\" cy=\"62\" r=\"2.8\" fill=\"#ffe6a4\"/><path d=\"M27 83q23-12 46 0v15q-23 14-46 0Z\" fill=\"#110f0e\" stroke=\"#55402f\" stroke-width=\"2\"/><path d=\"M31 83h7v8h-7zm10-1h7v9h-7zm11 0h7v9h-7zm11 1h7v8h-7zM32 101h7v-7h-7zm11 2h7v-9h-7zm11 0h7v-9h-7zm11-2h6v-7h-6z\" fill=\"#b9b495\"/><path d=\"M24 43 43 50m14 0 20-7\" stroke=\"#362c23\" stroke-width=\"5\"/><circle cx=\"23\" cy=\"77\" r=\"2\" fill=\"#4e5043\"/><circle cx=\"78\" cy=\"77\" r=\"2\" fill=\"#4e5043\"/></symbol></defs></svg>\n  <div class=\"console-header\"><div><p class=\"eyebrow\">NIGHT 02</p><h2 id=\"ns-console-title\">Night Shift</h2></div><button id=\"ns-exit\" class=\"quiet\">Exit <kbd>Esc</kbd></button></div>\n  <section id=\"ns-briefing\" class=\"briefing sparse-briefing\"><div class=\"title-crew\" aria-hidden=\"true\"><svg viewBox=\"0 0 100 130\"><use href=\"#ns-dread-bunny\"></use></svg><svg viewBox=\"0 0 100 130\"><use href=\"#ns-dread-bear\"></use></svg><svg viewBox=\"0 0 100 130\"><use href=\"#ns-dread-chicken\"></use></svg><svg viewBox=\"0 0 100 130\"><use href=\"#ns-dread-fox\"></use></svg></div><div class=\"brief-copy\"><p class=\"eyebrow\">NIGHT 02</p><h3>Night Shift</h3><button id=\"ns-start\" class=\"primary\">Start</button></div></section>\n  <section id=\"ns-play\" hidden>\n    <div class=\"hud\"><div><small>SHIFT 02</small><strong id=\"ns-hour\">12 AM</strong></div><div class=\"power-wrap\"><div><small>POWER</small><strong id=\"ns-power\">100%</strong></div><meter id=\"ns-power-meter\" min=\"0\" max=\"100\" low=\"20\" value=\"100\" aria-label=\"Power remaining\"></meter></div><button id=\"ns-pause\" class=\"quiet\">Pause <kbd>P</kbd></button></div>\n    <div class=\"play-grid\"><div class=\"camera-column\"><div class=\"camera-frame\"><div class=\"camera-label\"><span id=\"ns-camera-title\">CAM 01 / MAIN STAGE</span><span id=\"ns-feed-status\">● LIVE FEED</span></div><svg id=\"ns-scene\" class=\"scene\" viewBox=\"0 0 720 420\" role=\"img\" aria-labelledby=\"ns-scene-description\"><title id=\"ns-scene-description\">Main stage</title><defs><pattern id=\"ns-floor-check\" width=\"56\" height=\"56\" patternUnits=\"userSpaceOnUse\"><rect width=\"56\" height=\"56\" fill=\"#7c8163\"></rect><path d=\"M0 0h28v28H0zm28 28h28v28H28z\" fill=\"#222c24\"></path></pattern><linearGradient id=\"ns-vignette\"><stop stop-color=\"#000\" stop-opacity=\".4\"></stop><stop offset=\".5\" stop-color=\"#000\" stop-opacity=\"0\"></stop><stop offset=\"1\" stop-color=\"#000\" stop-opacity=\".4\"></stop></linearGradient></defs><g id=\"ns-room-art\"></g><g id=\"ns-scene-bots\"></g><rect width=\"720\" height=\"420\" fill=\"url(#ns-vignette)\" pointer-events=\"none\"></rect><path d=\"M18 45V18h27m630 0h27v27M18 375v27h27m630 0h27v-27\" stroke=\"#cad0aa\" fill=\"none\" opacity=\".65\"></path></svg><div id=\"ns-monitor-down\" class=\"monitor-down\" hidden aria-label=\"Monitor lowered\"><span aria-hidden=\"true\">▣</span></div><div class=\"camera-caption\"><span id=\"ns-camera-caption\">No movement in view.</span><span id=\"ns-elapsed\">00:00 / 01:30</span></div></div><button id=\"ns-monitor\" class=\"monitor-button\" aria-pressed=\"true\">Lower monitor <kbd>C</kbd></button><div class=\"shutters\"><button id=\"ns-left-shutter\" aria-pressed=\"false\"><span class=\"door-tag\">WEST / <kbd>A</kbd></span><strong>Left shutter: OPEN</strong><span id=\"ns-left-warning\" aria-hidden=\"true\">●</span></button><button id=\"ns-right-shutter\" aria-pressed=\"false\"><span class=\"door-tag\">EAST / <kbd>D</kbd></span><strong>Right shutter: OPEN</strong><span id=\"ns-right-warning\" aria-hidden=\"true\">●</span></button></div><p id=\"ns-motion-log\" class=\"motion-log sr-only\" role=\"status\" aria-live=\"polite\">Shift started. Check the cameras.</p></div>\n    <aside class=\"map-panel\" aria-label=\"Camera map\"><div class=\"camera-map\"><svg viewBox=\"0 0 300 340\" preserveAspectRatio=\"none\" aria-hidden=\"true\"><path d=\"M150 40V124M50 125H250M50 125V250H90V306M250 125V250H210V306M250 35V125\" fill=\"none\" stroke=\"#69735a\" stroke-width=\"4\"/></svg><button data-camera=\"stage\" class=\"map-stage\" aria-label=\"Camera 01, Stage, keyboard 1\" aria-pressed=\"true\"><small>CAM 01 / <kbd>1</kbd></small>Stage</button><button data-camera=\"dining\" class=\"map-dining\" aria-label=\"Camera 02, Dining, keyboard 2\" aria-pressed=\"false\"><small>CAM 02 / <kbd>2</kbd></small>Dining</button><button data-camera=\"west\" class=\"map-west\" aria-label=\"Camera 03, West, keyboard 3\" aria-pressed=\"false\"><small>CAM 03 / <kbd>3</kbd></small>West</button><button data-camera=\"east\" class=\"map-east\" aria-label=\"Camera 04, East, keyboard 4\" aria-pressed=\"false\"><small>CAM 04 / <kbd>4</kbd></small>East</button><button data-camera=\"store\" class=\"map-store\" aria-label=\"Camera 05, Cove, keyboard 5\" aria-pressed=\"false\"><small>CAM 05 / <kbd>5</kbd></small>Cove</button><div class=\"map-office\">OFFICE</div></div></aside></div>\n  </section>\n  <section id=\"ns-paused\" class=\"pause-screen\" hidden><h3>Paused</h3><button id=\"ns-resume\" class=\"primary\">Resume</button></section>\n  <section id=\"ns-result\" class=\"result\" hidden><div id=\"ns-scare\" class=\"scare gentle\" aria-hidden=\"true\"><svg viewBox=\"0 0 100 130\"><use id=\"ns-scare-face\" href=\"#ns-dread-bunny\"></use></svg></div><p class=\"eyebrow\" id=\"ns-result-label\">GAME OVER</p><h3 id=\"ns-result-title\">Bonnie</h3><p id=\"ns-result-copy\" class=\"sr-only\"></p><div class=\"result-actions\"><button id=\"ns-restart\" class=\"primary\">Restart</button><button id=\"ns-result-exit\" class=\"quiet\">Exit</button></div></section><div id=\"ns-attack-overlay\" class=\"attack-overlay\" hidden aria-hidden=\"true\"><svg viewBox=\"0 0 100 130\"><use id=\"ns-attack-face\" href=\"#ns-dread-bunny\"></use></svg></div>\n  <footer class=\"console-footer\"><label class=\"option\"><input id=\"ns-gentle\" type=\"checkbox\"><span>Gentle</span></label><label class=\"option\"><input id=\"ns-sound\" type=\"checkbox\"><span>Sound + scream</span></label><label class=\"volume\"><span>Volume</span><input id=\"ns-volume\" type=\"range\" min=\"0\" max=\"35\" value=\"15\" aria-label=\"Game sound volume\"></label><span id=\"ns-sound-note\" class=\"sr-only\">Sound off · game settings stay in this preview</span></footer>\n";
export async function openNightShiftConsole({signal,user,returnFocus,onClose=()=>{}}={}){
  if(signal?.aborted)return null;
  const sheet=document.createElement('link');sheet.rel='stylesheet';sheet.href='/styles/night-shift-game.css';sheet.dataset.nightShiftStyle='';
  let cancelStyle;
  try{await new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>finish(Error('Night Shift stylesheet unavailable')),8000);
    const finish=(error)=>{clearTimeout(timer);sheet.onload=null;sheet.onerror=null;signal?.removeEventListener('abort',cancelStyle);error?reject(error):resolve();};
    cancelStyle=()=>finish(Error('Night Shift opening cancelled'));
    sheet.onload=()=>finish();sheet.onerror=()=>finish(Error('Night Shift stylesheet unavailable'));
    signal?.addEventListener('abort',cancelStyle,{once:true});document.head.append(sheet);
  });}catch(error){sheet.remove();if(signal?.aborted)return null;throw error;}
  if(signal?.aborted){sheet.remove();return null;}
  const dialog=document.createElement('dialog');dialog.id='ns-game';dialog.className='ns-console';dialog.dataset.nightShiftConsole='';dialog.dir='ltr';dialog.setAttribute('aria-labelledby','ns-console-title');dialog.innerHTML=MARKUP;
  const $=id=>dialog.querySelector('#ns-'+id);
  const events=new AbortController();const listen=(target,type,callback,options={})=>target.addEventListener(type,callback,{...options,signal:events.signal});
  // Browser chrome, rotation and the visual viewport can change without a page render.
  let viewportFrame=0;
  function fitViewport(){
    const viewport=window.visualViewport,width=viewport?.width||innerWidth,height=viewport?.height||innerHeight;
    for(const [name,value]of Object.entries({width,height,left:viewport?.offsetLeft||0,top:viewport?.offsetTop||0}))dialog.style.setProperty('--ns-viewport-'+name,value+'px');
    const style=getComputedStyle(dialog),safe=name=>parseFloat(style.getPropertyValue('--ns-safe-'+name))||0;
    const usableWidth=width-safe('left')-safe('right'),usableHeight=height-safe('top')-safe('bottom');
    dialog.dataset.layout=usableWidth>=720||usableWidth>usableHeight*1.15?'wide':'portrait';
    dialog.toggleAttribute('data-short',usableHeight<560&&usableWidth>=460);
    dialog.toggleAttribute('data-tight',usableHeight<480);
    dialog.scrollTop=0;dialog.scrollLeft=0;
  }
  function queueViewport(){cancelAnimationFrame(viewportFrame);viewportFrame=requestAnimationFrame(()=>{viewportFrame=0;fitViewport();});}
  listen(window,'resize',queueViewport);
  if(window.visualViewport){listen(window.visualViewport,'resize',queueViewport);listen(window.visualViewport,'scroll',queueViewport);}
  const copy=nightShiftCopy(getLocale());
  const text=(id,value)=>{const node=$(id);const child=[...node.childNodes].find(n=>n.nodeType===3);if(child)child.nodeValue=value;};
  for(const [id,key]of [['start','start'],['exit','exit'],['result-exit','exit'],['restart','restart'],['pause','pause'],['resume','resume']])text(id,copy[key]);
  $('gentle').nextElementSibling.textContent=copy.gentle;$('sound').nextElementSibling.textContent=copy.sound;$('volume').previousElementSibling.textContent=copy.volume;
  $('volume').setAttribute('aria-label',copy.volume);
  const settingsKey=nightShiftSettingsKey(user?.kind==='device'?deviceBootstrap():{user});
  let settings=nightShiftSettings(null);
  try{if(settingsKey)settings=nightShiftSettings(localStorage.getItem(settingsKey));}catch{/* Local storage is optional. */}
  $('sound').checked=settings.sound;$('gentle').checked=settings.gentle;$('volume').value=settings.volume;
  function saveSettings(){
    if(!settingsKey)return;
    try{localStorage.setItem(settingsKey,JSON.stringify({version:1,...nightShiftSettings({sound:$('sound').checked,gentle:$('gentle').checked,volume:Number($('volume').value)})}));}catch{/* Play never depends on persistence. */}
  }
  dialog.querySelectorAll('[data-camera]').forEach(button=>{const child=[...button.childNodes].find(n=>n.nodeType===3);if(child)child.nodeValue=copy.rooms[button.dataset.camera];button.setAttribute('aria-label','CAM '+ROOMS.find(r=>r.id===button.dataset.camera).code+' '+copy.rooms[button.dataset.camera]);});
  let destroyed=false,overlayToken=null;
  function destroy(){
    if(destroyed)return;destroyed=true;events.abort();signal?.removeEventListener('abort',destroy);
    cancelAnimationFrame(frame);cancelAnimationFrame(viewportFrame);frame=0;hideAttack();silence();audio?.close().catch(()=>{});game.exit();
    if(dialog.open)dialog.close();dialog.remove();sheet.remove();if(overlayToken!==null)dropOverlay(overlayToken);
    onClose();const target=typeof returnFocus==='function'?returnFocus():returnFocus;if(target?.isConnected)target.focus({preventScroll:true});
  }

  const game = new Game(17);
  const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
  let frame = 0, last = 0, lastPaint = 0, sceneKey = '', lastPhase = 'ready';
  let previousRooms = '', audio = null, activeVoices = new Set(), attackTimer=0;
  const scenery = {
    stage: '<rect width="720" height="420" fill="#364029"/><path d="M0 0h110v340H0zm610 0h110v340H610z" fill="#66503a"/><path d="M25 0v340m30-340v340m30-340v340m550-340v340m30-340v340m30-340v340" stroke="#977b51" stroke-width="9" opacity=".5"/><path d="M110 35q250 65 500 0" fill="none" stroke="#b7ad69" stroke-width="4"/><path d="m150 48 15 30 15-22m95 6 15 30 15-26m95-4 15 30 15-33m85-9 15 26 15-33" fill="#a4b783"/><rect y="345" width="720" height="75" fill="url(#ns-floor-check)"/><path d="M100 343h520" stroke="#a9ad78" stroke-width="7"/>',
    dining: '<rect width="720" height="420" fill="#293329"/><path d="M0 55h720v32H0" fill="#647357"/><path d="M0 290h720v130H0" fill="url(#ns-floor-check)"/><rect x="290" y="90" width="150" height="194" fill="#101c15" stroke="#6a7b57" stroke-width="5"/><g fill="#766144" stroke="#b59b63" stroke-width="4"><ellipse cx="155" cy="320" rx="115" ry="37"/><ellipse cx="571" cy="317" rx="110" ry="36"/></g><path d="M155 355v65m416-65v65" stroke="#b29c63" stroke-width="9"/><g fill="#cfbd82"><path d="m120 300 7-22 7 22zm43 20 7-22 7 22zm388-14 7-22 7 22z"/></g>',
    west: '<rect width="720" height="420" fill="#19281d"/><path d="M0 0 285 80v220L0 420z" fill="#374c34"/><path d="m720 0-285 80v220l285 120z" fill="#30432e"/><path d="M0 420 285 300h150l285 120z" fill="url(#ns-floor-check)"/><rect x="285" y="80" width="150" height="220" fill="#0b1510" stroke="#5a7250" stroke-width="5"/><path d="M0 95 285 140m150 0 285-45M0 120 285 160m150 0 285-40" stroke="#9faa6c" stroke-width="9"/><path d="M80 130v155l100-48V161z" fill="#786348" stroke="#ac9364" stroke-width="3"/>',
    east: '<rect width="720" height="420" fill="#1e281c"/><path d="M0 0 285 80v220L0 420z" fill="#4a4632"/><path d="m720 0-285 80v220l285 120z" fill="#393e2a"/><path d="M0 420 285 300h150l285 120z" fill="url(#ns-floor-check)"/><rect x="285" y="80" width="150" height="220" fill="#111810" stroke="#788056" stroke-width="5"/><path d="M0 95 285 140m150 0 285-45M0 120 285 160m150 0 285-40" stroke="#a49a6c" stroke-width="9"/><path d="M537 160v85l95 43V133z" fill="#756147" stroke="#ae976a" stroke-width="3"/>',
    store: '<rect width="720" height="420" fill="#303b2c"/><rect y="320" width="720" height="100" fill="url(#ns-floor-check)"/><g fill="#584c35" stroke="#859069" stroke-width="5"><path d="M45 80h210v250H45zm440 0h190v250H485"/><path d="M45 160h210m-210 80h210m230-80h190m-190 80h190" fill="none"/></g><g fill="#a38c61" stroke="#50432e" stroke-width="3"><rect x="70" y="114" width="63" height="45"/><rect x="155" y="194" width="63" height="45"/><rect x="510" y="194" width="125" height="45"/></g><path d="M300 110h118v210H300" fill="#172218" stroke="#61734a" stroke-width="4"/>'
  };
  function silence() {
    for (const voice of activeVoices) {try {voice.stop();} catch {} }
    activeVoices.clear();
  }
  let resultPointer=null;
  function hideAttack(){clearTimeout(attackTimer);attackTimer=0;$('attack-overlay').hidden=true;resultPointer=null;for(const id of ['restart','result-exit'])$(id).disabled=false;}
  function finishAttack(){hideAttack();if(!destroyed&&game.state.phase==='lost')$('restart').focus({preventScroll:true});}
  function gentleEncounter(){hideAttack();silence();$('scare').classList.add('gentle');$('scare-face').setAttribute('href','#ns-crew-'+(game.state.scareBot||'bear'));}
  function unlockAudio() {
    if (!$('sound').checked || Number($('volume').value) === 0) return;
    try {audio ||= new (window.AudioContext || window.webkitAudioContext)(); audio.resume().catch(() => {});} catch { $('sound').checked = false; }
  }
  function cue(kind) {
    if (!audio || !$('sound').checked || game.state.phase === 'ready' || Number($('volume').value) === 0) return;
    try {
      if(kind==='scream'){
        silence();
        const samples=createScreamSamples(audio.sampleRate),buffer=audio.createBuffer(1,samples.length,audio.sampleRate);
        buffer.copyToChannel(samples,0);
        const source=audio.createBufferSource(),gain=audio.createGain();source.buffer=buffer;
        gain.gain.value=Number($('volume').value)/100*.3;
        source.connect(gain);gain.connect(audio.destination);activeVoices.add(source);
        source.onended=()=>{activeVoices.delete(source);source.disconnect();gain.disconnect();};source.start();return;
      }
      const oscillator = audio.createOscillator(), gain = audio.createGain(), now = audio.currentTime;
      const duration = kind === 'end' ? .24 : kind==='move' ? .18 : .08;
      oscillator.type = kind==='move' ? 'triangle' : 'sine';
      oscillator.frequency.setValueAtTime(kind === 'end' ? 140 : kind==='move'?82:260, now);
      oscillator.frequency.exponentialRampToValueAtTime(kind === 'end' ? 70 : kind==='move'?48:140, now + duration);
      gain.gain.setValueAtTime(0, now); gain.gain.linearRampToValueAtTime(Number($('volume').value) / 100 * .06, now + .012);
      gain.gain.exponentialRampToValueAtTime(.0001, now + duration);
      oscillator.connect(gain); gain.connect(audio.destination); oscillator.start(); oscillator.stop(now + duration);
      activeVoices.add(oscillator); oscillator.onended = () => {activeVoices.delete(oscillator); oscillator.disconnect(); gain.disconnect();};
    } catch { /* Sound availability never blocks play. */ }
  }
  function settingsText() {
    $('sound-note').textContent = $('sound').checked ? 'Game sound and scream on' : 'Game sound off';
  }
  function closeGame(){destroy();}
  function paintScene() {
    const s = game.state, room = ROOMS.find(room => room.id === s.camera), bots = s.bots.filter(bot => bot.room === s.camera);
    const key = s.camera + ':' + bots.map(b => b.id).join();
    if (sceneKey !== key) {
      sceneKey = key; $('room-art').innerHTML = scenery[s.camera];
      $('scene-bots').innerHTML = bots.map((bot, i) => {
        const hall = ['west','east'].includes(s.camera);
        const x = hall ? 248+i*65 : s.camera === 'stage' ? 140+i*145 : s.camera === 'store' ? 292 : 235 + i * 145;
        const y = hall ? 82 : s.camera === 'stage' ? 133 : 134;
        return '<use href="#ns-dread-'+bot.id+'" x="'+x+'" y="'+y+'" width="'+(hall ? 220 : 140)+'" height="'+(hall ? 280 : 215)+'"/>';
      }).join('');
    }
    $('scene-description').textContent = room.name + '. ' + (bots.length ? bots.map(b=>b.name).join(' and ') + ' in view.' : 'No moving bot in view.');
    $('camera-title').textContent = 'CAM ' + room.code + ' / ' + copy.rooms[s.camera].toUpperCase();
    const foxy=s.bots.find(b=>b.id==='fox');
    $('camera-caption').textContent = s.monitor ? (s.camera==='store' ? 'Foxy / '+Math.round(foxy.pressure)+'%' : bots.map(b=>b.name).join(' / ') || '—') : '—';
    $('monitor-down').hidden = s.monitor; $('feed-status').textContent = s.monitor ? '● LIVE FEED' : '○ STANDBY';
    $('scene').setAttribute('aria-hidden', String(!s.monitor));
    dialog.querySelectorAll('[data-camera]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.camera === s.camera)));
    $('monitor').setAttribute('aria-pressed', String(s.monitor));
    $('monitor').innerHTML = (s.monitor ? copy.lowerMonitor : copy.raiseMonitor) + ' <kbd>C</kbd>';
  }
  function paint() {
    const s = game.state;
    dialog.dataset.phase = s.phase;
    $('briefing').hidden = s.phase !== 'ready'; $('play').hidden = s.phase !== 'playing';
    $('paused').hidden = s.phase !== 'paused'; $('result').hidden = !['won','lost'].includes(s.phase);
    if (s.phase === 'playing') {
      const hour = Math.floor(s.elapsed / 15); $('hour').textContent = (hour === 0 ? '12' : hour) + ' AM';
      $('power').textContent = Math.ceil(s.power) + '%'; $('power-meter').value = s.power;
      $('elapsed').textContent = Math.floor(s.elapsed / 60).toString().padStart(2,'0') + ':' + Math.floor(s.elapsed % 60).toString().padStart(2,'0') + ' / 01:30';
      for (const side of ['left','right']) {
        const threats=s.bots.filter(bot=>bot.room===side+'-door'),button=$(side+'-shutter');
        button.setAttribute('aria-pressed',String(s.shutters[side]));button.classList.toggle('threat',threats.length>0);
        button.querySelector('strong').textContent=(side==='left'?copy.left:copy.right)+' / '+(s.shutters[side]?copy.closed:copy.open);
        button.setAttribute('aria-label',(s.shutters[side]?'Open':'Close')+' '+side+' shutter'+(threats.length?' — '+threats.map(b=>b.name).join(', ')+' at doorway':''));
        $(side+'-warning').textContent='●';
      }
      const positions = s.bots.map(bot=>bot.room).join('|');
      if (previousRooms && previousRooms !== positions) {
        const doorBot = s.bots.find(bot=>bot.room.endsWith('-door'));
        $('motion-log').textContent = doorBot ? doorBot.name + ' at the ' + doorBot.side + ' doorway. Close that shutter now.' : 'Camera motion detected. Check the crew’s routes.';
        cue('move');
      }
      previousRooms = positions; paintScene();
    }
    if (lastPhase !== s.phase) {
      if (s.phase === 'paused') {silence(); audio?.suspend().catch(() => {}); $('resume').focus();}
      if (['won','lost'].includes(s.phase)) {
        $('result').classList.toggle('won', s.phase === 'won');
        const gentle=$('gentle').checked||reducedMotion.matches;
        $('scare').classList.toggle('gentle', gentle);
        $('scare-face').setAttribute('href',(gentle?'#ns-crew-':'#ns-dread-')+(s.scareBot || 'bear'));
        $('result-label').textContent = s.phase === 'won' ? 'SHIFT COMPLETE / ALL CLEAR' : 'SHIFT ENDED / CREW ENCOUNTER';
        $('result-title').textContent = s.phase === 'won' ? copy.win : s.bots.find(b=>b.id===s.scareBot)?.name || 'Freddy';
        $('result-copy').textContent = s.phase === 'won' ? 'Shift complete.' : s.reason === 'power' ? 'Power depleted.' : 'A character entered the office.';
        if(s.phase==='lost'&&!gentle){
          resultPointer=null;for(const id of ['restart','result-exit'])$(id).disabled=true;
          $('attack-face').setAttribute('href','#ns-dread-'+s.scareBot);$('attack-overlay').hidden=false;
          $('attack-overlay').dataset.shownAt=String(performance.now());cue('scream');
          attackTimer=setTimeout(finishAttack,1200);
        }else cue('end');
        dialog.scrollTop=0;if($('attack-overlay').hidden)$('restart').focus({preventScroll:true});
      }
      lastPhase = s.phase;
    }
  }
  function tick(now) {
    if (!dialog.open || game.state.phase !== 'playing') {frame = 0; return;}
    game.step(Math.min(.1, Math.max(0,(now-last)/1000))); last = now;
    if (now-lastPaint > 80 || game.state.phase !== 'playing') {paint(); lastPaint=now;}
    if (game.state.phase === 'playing') frame = requestAnimationFrame(tick); else frame=0;
  }
  function run() {cancelAnimationFrame(frame); last=performance.now(); lastPaint=0; frame=requestAnimationFrame(tick);}
  function start() {
    hideAttack();silence(); game.start(); sceneKey=''; previousRooms=''; $('motion-log').textContent='Shift started.';
    unlockAudio(); paint(); dialog.scrollTop=0; $('monitor').focus({preventScroll:true}); run();
  }
  function pause() {hideAttack();silence();audio?.suspend().catch(()=>{});game.pause();cancelAnimationFrame(frame);frame=0;paint();}
  function resume() {game.resume(); unlockAudio(); paint(); dialog.scrollTop=0; $('monitor').focus({preventScroll:true}); run();}
  function shutter(side) {game.setShutter(side,!game.state.shutters[side]); cue('switch'); paint();}
  function monitor() {game.setMonitor(!game.state.monitor); cue('switch'); paint();}
  listen($('exit'),'click',closeGame);
  listen(dialog,'cancel', event=>{event.preventDefault();closeGame();});
  listen(dialog,'close',()=>{if(game.state.phase!=='ready')closeGame();});
  listen($('start'),'click',start);
  // A touch begun on the old camera/control must not activate a newly revealed action.
  for(const [id,action]of [['restart',start],['result-exit',closeGame]]){
    const button=$(id);
    listen(button,'pointerdown',event=>{resultPointer=!button.disabled&&['won','lost'].includes(game.state.phase)?{button,pointerId:event.pointerId}:null;});
    listen(button,'pointercancel',()=>{resultPointer=null;});
    listen(button,'click',event=>{const fresh=event.detail===0||resultPointer?.button===button;resultPointer=null;if(fresh&&!button.disabled&&$('attack-overlay').hidden&&['won','lost'].includes(game.state.phase))action();});
  }
  listen($('pause'),'click',pause); listen($('resume'),'click',resume);
  listen($('left-shutter'),'click',()=>shutter('left')); listen($('right-shutter'),'click',()=>shutter('right'));
  listen($('monitor'),'click',monitor);
  dialog.querySelectorAll('[data-camera]').forEach(button=>listen(button,'click',()=>{game.selectCamera(button.dataset.camera);cue('switch');paint();}));
  listen($('sound'),'change',()=>{saveSettings();if(!$('sound').checked){silence();audio?.suspend().catch(()=>{});} else if(game.state.phase==='playing')unlockAudio(); settingsText();});
  listen($('gentle'),'change',()=>{saveSettings();if($('gentle').checked)gentleEncounter();});
  listen(reducedMotion,'change',()=>{if(reducedMotion.matches)gentleEncounter();});
  listen($('volume'),'input',()=>{saveSettings();silence();if(game.state.phase==='playing')unlockAudio();});
  listen(document,'visibilitychange',()=>{if(document.hidden && dialog.open)pause();});
  listen(window,'blur',()=>{if(dialog.open)pause();});
  listen(document,'keydown',event=>{
    if(!dialog.open)return;
    event.stopPropagation();
    if(event.repeat || event.altKey || event.ctrlKey || event.metaKey || event.target instanceof HTMLInputElement)return;
    const key=event.key.toLowerCase();
    if(key==='p' && ['playing','paused'].includes(game.state.phase)){event.preventDefault();game.state.phase==='playing'?pause():resume();return;}
    if(game.state.phase!=='playing')return;
    if(['a','d','c','1','2','3','4','5'].includes(key))event.preventDefault();
    if(key==='a')shutter('left'); if(key==='d')shutter('right'); if(key==='c')monitor();
    if(/^[1-5]$/.test(key)){game.selectCamera(ROOMS[Number(key)-1].id);paint();}
  },{capture:true});
  settingsText(); paint();
  signal?.addEventListener('abort',destroy,{once:true});
  document.body.append(dialog);fitViewport();overlayToken=attachOverlay(dialog,destroy);dialog.showModal();$('start').focus({preventScroll:true});
  return {destroy};
}
