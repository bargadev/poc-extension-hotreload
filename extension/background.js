const WS_URL = 'ws://localhost:9999';
let socket = null;

function connect() {
  if (socket && socket.readyState === WebSocket.OPEN) return;
  socket = new WebSocket(WS_URL);
  socket.onopen  = () => console.log('[HotReload] Connected');
  socket.onmessage = (event) => {
    try {
      const msg = JSON.parse(event.data);
      // Only handle non-sidebar file changes here (sidebar handled by content.js)
      if (msg.type === 'reload' && msg.file !== 'googlemeet.inline.js') {
        chrome.runtime.reload();
      }
    } catch (_) {}
  };
  socket.onclose = () => { socket = null; };
  socket.onerror = () => { socket = null; };
}

// Alarm keeps SW alive and reconnects WebSocket
chrome.alarms.create('hotreload-keepalive', { periodInMinutes: 0.1 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'hotreload-keepalive') connect();
});
connect();

function isMeetCall(url) {
  return url && /meet\.google\.com\/[a-z]/.test(url);
}

function injectViewportOverride(tabId) {
  chrome.scripting.executeScript({
    target: { tabId },
    world:  'MAIN',
    func:   () => {
      if (window.__extMeetViewportOverride) return;
      window.__extMeetViewportOverride = true;
      const desc = Object.getOwnPropertyDescriptor(window, 'innerWidth');
      const orig = desc?.get;
      Object.defineProperty(window, 'innerWidth', {
        get() {
          const w = orig ? orig.call(window) : (desc?.value ?? screen.width);
          return document.body.classList.contains('ext-sidebar-on') ? w - 320 : w;
        },
        configurable: true,
      });
      const ret = () => window.innerWidth;
      document.documentElement.__defineGetter__?.('clientWidth', ret);
      document.body.__defineGetter__?.('clientWidth', ret);
    },
  }).catch((e) => console.warn('[MeetSidebar] viewport override failed:', e.message));
}

function injectSidebar(tabId) {
  injectViewportOverride(tabId);
  chrome.scripting.executeScript({
    target: { tabId },
    files:  ['googlemeet.inline.js'],
  }).catch((e) => console.warn('[MeetSidebar] inject failed:', e.message));
}

// Content script sends this when googlemeet.inline.js changes
chrome.runtime.onMessage.addListener((msg, sender) => {
  if (msg.type === 'reinject-sidebar' && sender.tab?.id) {
    injectSidebar(sender.tab.id);
  }
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === 'complete' && isMeetCall(tab.url)) injectSidebar(tabId);
});

function injectExisting() {
  chrome.tabs.query({ url: 'https://meet.google.com/*' }, (tabs) => {
    tabs.forEach((tab) => { if (isMeetCall(tab.url)) injectSidebar(tab.id); });
  });
}

injectExisting();
