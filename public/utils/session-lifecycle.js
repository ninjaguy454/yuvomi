// Cookies are shared across tabs; personal client state must end with them.
// Messages contain only a change marker, never user data, cookies or tokens.
const STORAGE_KEY = 'yuvomi-session-change';
const CHANNEL_NAME = 'yuvomi-session-change';
const source = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
const listeners = new Set();
const seen = new Set();
let channel = null;
let listening = false;
let revision = 0;

export function sessionRevision() { return revision; }

function receive(message) {
  if (!message || message.source === source || typeof message.id !== 'string'
      || !['login', 'logout'].includes(message.reason) || seen.has(message.id)) return;
  seen.add(message.id);
  if (seen.size > 32) seen.delete(seen.values().next().value);
  revision++;
  for (const listener of listeners) listener();
}

function startListening() {
  if (listening || typeof window === 'undefined') return;
  listening = true;
  window.addEventListener('storage', (event) => {
    if (event.key !== STORAGE_KEY || !event.newValue) return;
    try { receive(JSON.parse(event.newValue)); } catch { /* unrelated or malformed storage */ }
  });
  try {
    if (window.BroadcastChannel) {
      channel = new window.BroadcastChannel(CHANNEL_NAME);
      channel.addEventListener('message', (event) => receive(event.data));
    }
  } catch { /* storage events remain available */ }
}

export function watchSessionChanges(listener) {
  startListening();
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function broadcastSessionChange(reason) {
  if (!['login', 'logout'].includes(reason)) return;
  startListening();
  revision++;
  const message = { source, id: `${source}-${revision}`, reason };
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(message)); } catch { /* optional transport */ }
  try { channel?.postMessage(message); } catch { /* optional transport */ }
}
