import { api } from '/api.js';
import { esc } from '/utils/html.js';
import { clearApiCache } from '/sw-register.js';
import { concealPersonalContext } from '/utils/device-context.js';
import { broadcastSessionChange } from '/utils/session-lifecycle.js';

export async function render(container) {
  let disposed = false, timer;
  container.innerHTML = `<main class="auth-page"><section class="auth-form"><h1>Pair as household device</h1><p>Pair this browser as a shared display with its own restricted permissions. An administrator approves the code on their personal device in Household Settings → Devices.</p><p>If this browser is signed in personally, finishing pairing signs out only this browser and clears its personal content. Other devices remain signed in.</p><button type="button" class="btn btn--primary" data-pair-start>Show pairing code</button><p role="alert" data-pair-error></p><div data-pair-status aria-live="polite"></div><a href="/login" data-link>Cancel</a></section></main>`;
  const error = message => { container.querySelector('[data-pair-error]').textContent = message; };
  const status = container.querySelector('[data-pair-status]');
  const showCode = response => { status.innerHTML = `<h2>Pairing code</h2><p class="device-pair-code" data-pair-code>${esc(response.code)}</p><p>Expires ${esc(new Date(response.expiresAt).toLocaleTimeString())}. Keep this page open.</p>`; };
  async function poll() {
    try {
      const state = await api.get('/device/pair');
      if (disposed) return;
      if (state.status === 'approved' || state.approved) {
        status.innerHTML = `<h2>Ready to pair ${esc(state.name || state.device?.name || 'this display')}</h2><p>This replaces this browser’s personal session with the approved device permissions.</p><button type="button" class="btn btn--primary" data-pair-claim>Confirm and use household device</button>`;
        status.querySelector('[data-pair-claim]').onclick = async () => {
          try {
            await api.post('/device/pair/claim', { confirm_transition: true });
            try { sessionStorage.removeItem('vidamia-pairing-display'); } catch {}
            concealPersonalContext(); clearApiCache();
            try { localStorage.removeItem('yuvomi-wall-mode'); } catch {}
            broadcastSessionChange('device');
            location.replace('/device');
          } catch (err) { error(err.message); }
        };
        return;
      }
      if (state.status === 'expired') { error('This pairing code expired. Generate a new code.'); return; }
    } catch (err) { if (!disposed) error(err.message); }
    if (!disposed) timer = setTimeout(poll, 2500);
  }
  container.querySelector('[data-pair-start]').onclick = async () => {
    clearTimeout(timer);
    error('');
    try {
      const response = await api.post('/device/pair', { confirm_transition: true });
      if (disposed) return;
      try { sessionStorage.setItem('vidamia-pairing-display',JSON.stringify({code:response.code,expiresAt:response.expiresAt})); } catch {}
      showCode(response);
      timer = setTimeout(poll, 1500);
    } catch (err) { error(err.message); }
  };
  try {
    const saved=JSON.parse(sessionStorage.getItem('vidamia-pairing-display')||'null');
    if(saved?.expiresAt>Date.now()){showCode(saved);timer=setTimeout(poll,500);}
  }catch{}
  return () => { disposed = true; clearTimeout(timer); };
}
