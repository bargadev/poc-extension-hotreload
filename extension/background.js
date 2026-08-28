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

function injectSidebar(tabId) {
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
