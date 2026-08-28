const http = require('http');
const { WebSocketServer } = require('ws');
const chokidar = require('chokidar');
const path = require('path');

const PORT = 9999;
const WATCH_DIR = path.resolve(__dirname, '../extension');

const clients = new Set();

// HTTP server — popup.js polls /status to show connection badge
const httpServer = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.url === '/status') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, files: watchedCount, clients: clients.size }));
  } else {
    res.writeHead(404);
    res.end();
  }
});

const wss = new WebSocketServer({ server: httpServer });

wss.on('connection', (ws) => {
  clients.add(ws);
  console.log(`[dev-server] client connected (${clients.size} total)`);
  ws.on('close', () => {
    clients.delete(ws);
    console.log(`[dev-server] client disconnected (${clients.size} total)`);
  });
});

let watchedCount = 0;

const watcher = chokidar.watch(WATCH_DIR, {
  ignored: /(^|[/\\])\../,   // ignore dotfiles
  persistent: true,
  ignoreInitial: true,
});

watcher.on('ready', () => {
  const watched = watcher.getWatched();
  watchedCount = Object.values(watched).reduce((sum, files) => sum + files.length, 0);
  console.log(`[dev-server] watching ${watchedCount} file(s) in ${WATCH_DIR}`);
});

function broadcast(file) {
  const msg = JSON.stringify({ type: 'reload', file });
  for (const ws of clients) {
    if (ws.readyState === ws.OPEN) ws.send(msg);
  }
}

watcher.on('change', (filePath) => {
  const rel = path.relative(WATCH_DIR, filePath);
  console.log(`[dev-server] changed: ${rel} — broadcasting reload to ${clients.size} client(s)`);
  broadcast(rel);
});

watcher.on('add', (filePath) => {
  watchedCount++;
  const rel = path.relative(WATCH_DIR, filePath);
  console.log(`[dev-server] added:   ${rel} — broadcasting reload to ${clients.size} client(s)`);
  broadcast(rel);
});

httpServer.listen(PORT, () => {
  console.log(`[dev-server] running on http://localhost:${PORT}`);
  console.log('[dev-server] load extension/  in Chrome (developer mode) then run: npm run dev');
});
