const WS_URL = 'ws://localhost:9999';
let socket = null;

function connect() {
  if (socket && socket.readyState === WebSocket.OPEN) return;
  socket = new WebSocket(WS_URL);
  socket.onmessage = (event) => {
    try {
      const msg = JSON.parse(event.data);
      if (msg.type === 'reload' && msg.file === 'googlemeet.inline.js') {
        chrome.runtime.sendMessage({ type: 'reinject-sidebar' });
      }
    } catch (_) {}
  };
  socket.onclose = () => { socket = null; setTimeout(connect, 2000); };
  socket.onerror = () => { socket = null; };
}

connect();
