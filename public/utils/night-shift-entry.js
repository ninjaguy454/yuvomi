import {canAccessNavModule} from '/permissions.js';
import {canEnterNightShift} from '/utils/night-shift-copy.js';

/** Only the current Dashboard owns this hidden entry. No preference or data writes. */
export function mountNightShiftEntry(container,{signal}={}){
  const events=new AbortController();let button=null,active=null,opening=null,disposed=false;
  const allowed=()=>!disposed&&container.isConnected&&canEnterNightShift({theme:document.documentElement.dataset.namedTheme,pathname:location.pathname,wallMode:document.documentElement.hasAttribute('data-wall-mode'),editing:!!container.querySelector('.dashboard-overview__header--editing'),dashboardAccess:canAccessNavModule('dashboard')});
  function close(){opening?.abort();opening=null;active?.destroy();active=null;}
  async function open(){
    if(!allowed()||active||opening)return;
    const action=new AbortController();opening=action;button?.setAttribute('aria-busy','true');
    try{
      const {openNightShiftConsole}=await import('/components/night-shift-console.js');
      if(action.signal.aborted||!allowed())return;
      const handle=await openNightShiftConsole({signal:action.signal,returnFocus:()=>button,onClose:()=>{if(opening===action)opening=null;active=null;button?.removeAttribute('aria-busy');}});
      if(action.signal.aborted||!allowed()){handle?.destroy();return;}
      active=handle;
    }catch(error){if(!action.signal.aborted)console.warn('[Night Shift]',error.message);}
    finally{if(opening===action)opening=null;button?.removeAttribute('aria-busy');}
  }
  function reconcile(){
    if(disposed)return;
    if(!container.isConnected){dispose();return;}
    const host=allowed()?container.querySelector('.dashboard-overview__tools'):null;
    if(!host){close();button?.remove();button=null;return;}
    if(button?.parentNode===host)return;
    button?.remove();button=document.createElement('button');button.type='button';button.className='btn btn--secondary btn--sm night-shift-entry';button.dataset.nightShiftEntry='';button.textContent='▣ CAM 01';button.setAttribute('aria-label','Night Shift');button.title='Night Shift';button.style.minHeight='44px';button.style.paddingInline='12px';button.style.fontFamily='ui-monospace,monospace';
    button.addEventListener('click',open,{signal:events.signal});host.append(button);
  }
  const content=new MutationObserver(reconcile),theme=new MutationObserver(reconcile),parent=new MutationObserver(reconcile);
  content.observe(container,{childList:true,subtree:true});theme.observe(document.documentElement,{attributes:true,attributeFilter:['data-named-theme','data-wall-mode']});if(container.parentNode)parent.observe(container.parentNode,{childList:true});
  function dispose(){if(disposed)return;disposed=true;close();events.abort();content.disconnect();theme.disconnect();parent.disconnect();signal?.removeEventListener('abort',dispose);button?.remove();button=null;}
  signal?.addEventListener('abort',dispose,{once:true});
  window.addEventListener('auth:context-ending',dispose,{signal:events.signal});window.addEventListener('vidamia:auth-context',()=>{close();reconcile();},{signal:events.signal});
  if(signal?.aborted)dispose();else reconcile();return dispose;
}
