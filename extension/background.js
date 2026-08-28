const WS_URL = 'ws://localhost:9999';
let socket = null;

function connect() {
  if (socket && socket.readyState === WebSocket.OPEN) return;

  socket = new WebSocket(WS_URL);

  socket.onopen = () => {
    console.log('[HotReload] Connected to dev server');
  };

  socket.onmessage = (event) => {
    const msg = JSON.parse(event.data);
    if (msg.type === 'reload') {
      console.log('[HotReload] File changed:', msg.file, '— reloading extension');
      chrome.runtime.reload();
    }
  };

  socket.onclose = () => {
    console.log('[HotReload] Disconnected — will retry on next alarm');
    socket = null;
  };

  socket.onerror = () => {
    socket = null;
  };
}

// Keep service worker alive + reconnect on each alarm tick
chrome.alarms.create('hotreload-keepalive', { periodInMinutes: 0.1 });

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'hotreload-keepalive') {
    connect();
  }
});

// Initial connection
connect();
