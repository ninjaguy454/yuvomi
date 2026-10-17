// Only this decorative rim moves. The host card/content is never rewritten.
export const CARD_SELECTOR='.activity-card,.note-card,.week-event,.day-event,.month-day__event,.allday-event,.agenda-event,.cal-task-chip';
const MAX_FACES=72;
const MAX_ACTIVE_FACES=6;

function frostMarkup(width,height,index){
  let seed=140126+index*773;
  const random=()=>{seed=(seed*1664525+1013904223)>>>0;return seed/4294967296;},point=(x,y)=>x.toFixed(1)+' '+y.toFixed(1);
  let stems='',ferns='',plates='';
  for(let side=0;side<4;side++)for(let i=0;i<8;i++){
    const along=(i+.25+random()*.5)/8,depth=8+random()*5;
    const x=side===0?0:side===1?width:width*along,y=side===2?0:side===3?height:height*along;
    const angle=side===0?0:side===1?Math.PI:side===2?Math.PI/2:-Math.PI/2;
    const tx=x+Math.cos(angle)*depth,ty=y+Math.sin(angle)*depth;
    stems+='M'+point(x,y)+'L'+point(tx,ty);
    for(let j=1;j<=4;j++)for(const sign of[-1,1]){
      const fx=x+(tx-x)*j/5,fy=y+(ty-y)*j/5,wing=(1-j/5)*depth*.65;
      ferns+='M'+point(fx,fy)+'l'+point(Math.cos(angle+sign*Math.PI/3)*wing,Math.sin(angle+sign*Math.PI/3)*wing);
    }
    plates+='M'+point(x,y)+'L'+point(x+Math.cos(angle-.48)*depth,y+Math.sin(angle-.48)*depth)+'L'+point(tx,ty)+'Z';
  }
  return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 '+width+' '+height+'" preserveAspectRatio="none" aria-hidden="true"><path class="local-weather-ice-plates" d="'+plates+'"/><path class="local-weather-ice-stems" d="'+stems+'"/><path class="local-weather-ice-ferns" d="'+ferns+'"/></svg>';
}

export function createCardMaterials({document:doc,window:win,onChange}){
  let disposed=false,pending=null,index=0;
  const rows=new Map(),stats={materialUpdates:0,frostBuilds:0,frostBuildMs:0,snowReleaseEvents:0,activeMaterialFaces:0,activeWaterBeads:0,activeSnowPatches:0,activeSnowFragments:0};
  const make=className=>{const node=doc.createElement('span');node.className=className;node.setAttribute('aria-hidden','true');return node;};
  const sizeObserver=typeof win.ResizeObserver==='function'?new win.ResizeObserver(entries=>{
    for(const entry of entries){const row=rows.get(entry.target);if(!row)continue;const size=entry.borderBoxSize?.[0];resizeRow(row,size?.inlineSize??entry.target.offsetWidth,size?.blockSize??entry.target.offsetHeight);}
    onChange();
  }):null;
  const intersectionObserver=typeof win.IntersectionObserver==='function'?new win.IntersectionObserver(entries=>{
    if(disposed)return;
    for(const entry of entries){const row=rows.get(entry.target);if(row)row.visible=entry.isIntersecting;}
    onChange();
  }):null;
  function resizeRow(row,width,height){
    width=Math.max(1,Math.round(width));height=Math.max(1,Math.round(height));
    if(row.width===width&&row.height===height)return;
    row.width=width;row.height=height;
  }
  function buildFrost(row){
    const key=row.width+'x'+row.height;if(row.frostKey===key)return;
    const start=performance.now();row.frost.innerHTML=frostMarkup(row.width,row.height,row.index);row.frostKey=key;stats.frostBuilds++;stats.frostBuildMs+=performance.now()-start;
  }
  function remove(row){sizeObserver?.unobserve(row.node);intersectionObserver?.unobserve(row.node);row.rim.remove();if(row.addedPosition)row.node.classList.remove('local-weather-card-host');rows.delete(row.node);}
  function reconcile(){
    pending=null;if(disposed)return;
    for(const row of rows.values())if(!row.node.isConnected)remove(row);
    const cards=doc.querySelectorAll(CARD_SELECTOR);
    for(const node of cards){
      if(rows.has(node)||rows.size>=MAX_FACES||node.closest('.kanban-card--ghost,.modal,.modal-overlay,[hidden]'))continue;
      const rim=make('local-weather-card-rim'),frost=make('local-weather-frost');rim.append(frost);
      const rect=node.getBoundingClientRect();
      const row={node,rim,frost,index:index++,width:0,height:0,beads:[],patches:[],active:false,visible:rect.bottom>0&&rect.top<win.innerHeight&&rect.right>0&&rect.left<win.innerWidth,addedPosition:win.getComputedStyle(node).position==='static'};
      if(row.addedPosition)node.classList.add('local-weather-card-host');
      for(let i=0;i<4;i++){
        const bead=make('local-weather-water-bead');bead.style[i%2?'right':'left']=(1+i%2)+'px';bead.style.width=(6+(i%3))+'px';bead.style.height=(9+(i%3)*2)+'px';rim.append(bead);
        row.beads.push({node:bead,speed:.08+i*.015,phase:(row.index*.19+i*.24)%1});
      }
      for(let i=0;i<1;i++){
        const patch=make('local-weather-snow-catch');patch.style.left=(10+i*55)+'%';rim.append(patch);
        const fragments=[];for(let j=0;j<2;j++){const fragment=make('local-weather-snow-fragment');patch.append(fragment);fragments.push(fragment);}
        row.patches.push({node:patch,fragments,caughtAt:null,releaseStart:null});
      }
      node.append(rim);rows.set(node,row);resizeRow(row,node.offsetWidth,node.offsetHeight);sizeObserver?.observe(node);intersectionObserver?.observe(node);
    }
    onChange();
  }
  const mutationObserver=typeof win.MutationObserver==='function'?new win.MutationObserver(entries=>{
    if(disposed||pending!==null)return;
    if(!entries.some(entry=>[...entry.addedNodes,...entry.removedNodes].some(node=>node.nodeType===1&&!node.classList?.contains('local-weather-card-rim')&&!node.closest?.('.local-weather-scene,.local-weather-card-rim'))))return;
    pending=win.requestAnimationFrame(reconcile);
  }):null;
  mutationObserver?.observe(doc.body,{childList:true,subtree:true});
  function update(frame,time,still,disabled){
    if(disposed)return;
    const wet=disabled?0:Math.max(Math.min(1,frame.rain),frame.wet),ice=disabled?0:frame.ice,snow=disabled?0:frame.snowMass;
    stats.activeMaterialFaces=0;stats.activeWaterBeads=0;stats.activeSnowPatches=0;stats.activeSnowFragments=0;
    for(const row of rows.values()){
      const active=row.visible&&stats.activeMaterialFaces<MAX_ACTIVE_FACES&&(wet>.015||ice>.015);
      if(!active){if(row.active){row.rim.dataset.active='false';row.active=false;}continue;}
      row.active=true;row.rim.dataset.active='true';stats.activeMaterialFaces++;
      const key=wet.toFixed(3)+'|'+Math.min(1,ice*1.5).toFixed(3);
      if(row.lastState!==key){row.rim.style.setProperty('--lws-wet',wet.toFixed(3));row.rim.style.setProperty('--lws-ice',Math.min(1,ice*1.5).toFixed(3));row.lastState=key;}
      if(ice>.015)buildFrost(row);
      if(wet>.015){stats.activeWaterBeads+=row.beads.length;for(const bead of row.beads){const age=(time*bead.speed+bead.phase)%1,y=age*(row.height+20)-10;bead.node.style.transform='translate3d('+(frame.windX*1.5).toFixed(2)+'px,'+y.toFixed(2)+'px,0)';}}
      for(const patch of row.patches){
        if(snow<=.015){patch.caughtAt=null;patch.releaseStart=null;patch.node.style.opacity='0';for(const fragment of patch.fragments)fragment.style.opacity='0';continue;}
        stats.activeSnowPatches++;
        patch.caughtAt??=time;
        if(!still&&frame.snow>0&&frame.gust>.62&&time-patch.caughtAt>5+row.index*.45&&patch.releaseStart===null){patch.releaseStart=time;patch.releaseWind=frame.windX;stats.snowReleaseEvents++;}
        const u=!still&&patch.releaseStart!==null?Math.min(1,(time-patch.releaseStart)/1.5):0;
        if(u>=1){patch.releaseStart=null;patch.caughtAt=time;}
        patch.node.style.opacity=(Math.min(1,snow*2)*.82*(u>0?(1-u)**2:1)).toFixed(3);
        patch.node.style.transform=u>0?'translate3d('+((patch.releaseWind||0)*u*18).toFixed(2)+'px,'+(-u*4).toFixed(2)+'px,0)':'none';
        for(const [j,fragment]of patch.fragments.entries()){const alpha=u>0?Math.sin(u*Math.PI)*.6:0;fragment.style.opacity=alpha.toFixed(3);fragment.style.transform=u>0?'translate3d('+((patch.releaseWind||0)*u*(8+j*7)).toFixed(2)+'px,'+(-u*(2+j*2)).toFixed(2)+'px,0)':'none';if(alpha>.01)stats.activeSnowFragments++;}
      }
    }
    if(!still&&stats.activeMaterialFaces)stats.materialUpdates++;
  }
  reconcile();
  return {update,reconcile,dispose(){if(disposed)return;disposed=true;if(pending!==null)win.cancelAnimationFrame(pending);pending=null;mutationObserver?.disconnect();sizeObserver?.disconnect();intersectionObserver?.disconnect();for(const row of [...rows.values()])remove(row);stats.activeMaterialFaces=0;stats.activeWaterBeads=0;stats.activeSnowPatches=0;stats.activeSnowFragments=0;},
    getStats:()=>({...stats,materialFaces:rows.size,maxMaterialFaces:MAX_FACES,maxActiveMaterialFaces:MAX_ACTIVE_FACES,maxWaterBeads:24,maxSnowPatches:6,maxSnowFragments:12,observerCount:disposed?0:Number(!!sizeObserver)+Number(!!mutationObserver)+Number(!!intersectionObserver),swayingCards:0,maxSwayDegrees:0,materialInteractionActive:false})};
}
