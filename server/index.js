// Entry point: gateway (HTTP + auth) → chat server (WebSocket) → pipeline → MongoDB.
const http = require('http');
const path = require('path');
const express = require('express');
const config = require('./config');
const { connect, close } = require('./db');

async function main() {
  await connect();
  const { api, blobs } = require('./routes');
  const chatServer = require('./realtime/chatServer');

  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 'loopback');
  app.use((req, res, next) => {
    res.set({ 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' });
    next();
  });
  app.get('/healthz', (_req, res) => res.json({ ok: true }));
  app.use(blobs);
  app.use(api);
  app.use(express.static(path.join(__dirname, '..', 'public')));

  // JSON errors for the API.
  app.use((err, _req, res, _next) => {
    const status = err.status || 500;
    if (status >= 500) console.error(err);
    res.status(status).json({ error: err.code || 'internal', message: status >= 500 ? 'Something went wrong on the server' : err.message });
  });

  const server = http.createServer(app);
  chatServer.attach(server);
  server.listen(config.port, () => console.log(`[http] chat system on http://localhost:${config.port}`));

  const shutdown = async () => {
    console.log('\n[http] shutting down…');
    server.close();
    await close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((e) => {
  console.error('Failed to start:', e);
  process.exit(1);
});
