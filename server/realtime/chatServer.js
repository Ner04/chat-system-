// Chat server: the long-lived WebSocket endpoint  WS /v1/connect?token=…
// Stateless apart from the open sockets: it routes, it stores nothing itself.
//
// Client → server
//   send       { message_id, chat_id, payload, client_ts }
//   receipt    { chat_id, receipt_type: delivered|read, up_to_seq }
//   typing     { chat_id }
//   presence_subscribe { chat_id | null }
// Server → client
//   ack        { message_id, chat_id, seq }                 ✓  (stored by server)
//   nack       { message_id, error, missing? }
//   message    { message_id, chat_id, seq, sender_*, payload }
//   receipt    { chat_id, delivered_up_to, read_up_to }      ✓✓ / blue ✓✓ (high-water marks)
//   read_sync  { chat_id, up_to_seq }                        self-sync across my devices
//   chat_updated { chat_id }   presence { … }   typing { … }   sync_done { count }
const { WebSocketServer } = require('ws');
const config = require('../config');
const { db } = require('../db');
const auth = require('../gateway/auth');
const bus = require('../pipeline/bus');
const pipeline = require('../pipeline/messagePipeline');
const chats = require('../services/chats');
const users = require('../services/users');
const registry = require('./connectionRegistry');
const presence = require('./presence');
const notifications = require('./notifications');

function attach(server) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: config.maxCiphertextBytes * 4 });

  server.on('upgrade', async (req, socket, head) => {
    const url = new URL(req.url, 'http://x');
    if (url.pathname !== '/v1/connect') return socket.destroy();
    const a = auth.verifyToken(url.searchParams.get('token') || '');
    const dev = a && await db.devices.findOne({ _id: a.deviceId, user_id: a.userId }, { projection: { _id: 1 } });
    if (!dev) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      return socket.destroy();
    }
    wss.handleUpgrade(req, socket, head, (ws) => { ws.auth = a; wss.emit('connection', ws); });
  });

  wss.on('connection', async (ws) => {
    const me = ws.auth;
    const wasOnline = registry.isUserOnline(me.userId);
    registry.register(ws);
    presence.heartbeat(me.userId);
    users.touchDevice(me.deviceId).catch(() => {});
    if (!wasOnline) presence.broadcast(me.userId);
    ws.isAlive = true;
    ws.queue = Promise.resolve();

    ws.on('pong', () => { ws.isAlive = true; presence.heartbeat(me.userId); });
    ws.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(raw); } catch { return reply(ws, { type: 'error', error: 'bad_json' }); }
      // Process each socket's frames strictly in order: the sender's order becomes the seq order.
      ws.queue = ws.queue.then(() => handle(ws, msg)).catch((e) => {
        console.error('[ws] handler error', e);
        reply(ws, { type: 'error', error: 'internal' });
      });
    });
    ws.on('close', () => {
      if (registry.unregister(ws)) {
        presence.unsubscribe(me.deviceId);
        presence.heartbeat(me.userId);
        if (!registry.isUserOnline(me.userId)) presence.broadcast(me.userId);
      }
    });

    // Offline sync: push everything after this device's cursor, per chat.
    try {
      const count = await syncDevice(ws);
      reply(ws, { type: 'sync_done', count });
    } catch (e) { console.error('[ws] sync failed', e); }
  });

  // Heartbeat (~30s). A socket that misses a pong is dead → offline.
  const timer = setInterval(() => {
    for (const ws of wss.clients) {
      if (!ws.isAlive) { ws.terminate(); continue; }
      ws.isAlive = false;
      ws.ping();
    }
  }, config.heartbeatMs);
  wss.on('close', () => clearInterval(timer));

  subscribeToBus();
  return wss;
}

const reply = (ws, ev) => ws.readyState === 1 && ws.send(JSON.stringify(ev));

async function syncDevice(ws) {
  const { userId, deviceId } = ws.auth;
  const myChats = await db.chats.find({ members: userId }, { projection: { last_seq: 1 } }).toArray();
  const cursors = Object.fromEntries((await db.receipts.find({ device_id: deviceId }).toArray()).map((r) => [r.chat_id, r.delivered_seq || 0]));
  let count = 0;
  for (const c of myChats) {
    const after = cursors[c._id] || 0;
    if (c.last_seq <= after) continue;
    // "I have up to 1200" → "here's 1201 → 1600"
    const msgs = await pipeline.messagesForDevice(deviceId, c._id, { afterSeq: after, limit: 500 });
    for (const m of msgs) { reply(ws, { type: 'message', ...m, backlog: true }); count++; }
  }
  return count;
}

async function handle(ws, msg) {
  const me = ws.auth;
  switch (msg.type) {
    case 'send': {
      try {
        const { seq, chat_id, duplicate } = await pipeline.accept(me, msg);
        reply(ws, { type: 'ack', message_id: msg.message_id, chat_id, seq, duplicate });
      } catch (e) {
        if (!(e instanceof pipeline.PipelineError)) throw e;
        reply(ws, { type: 'nack', message_id: msg.message_id, error: e.code, message: e.message, missing: e.missing });
      }
      break;
    }
    case 'receipt': {
      try {
        await pipeline.recordReceipt(me, { chat_id: msg.chat_id, type: msg.receipt_type, up_to_seq: msg.up_to_seq });
      } catch (e) {
        if (!(e instanceof pipeline.PipelineError)) throw e;
        reply(ws, { type: 'error', error: e.code });
      }
      break;
    }
    case 'typing': {
      const chat = await db.chats.findOne({ _id: msg.chat_id }, { projection: { members: 1 } });
      if (chat?.members.includes(me.userId)) presence.typing(me, chat);
      break;
    }
    case 'presence_subscribe': {
      if (!msg.chat_id) { presence.unsubscribe(me.deviceId); break; }
      const chat = await db.chats.findOne({ _id: msg.chat_id }, { projection: { members: 1, type: 1 } });
      if (!chat?.members.includes(me.userId)) break;
      // Presence is only exposed for direct chats (groups would leak a lot of it).
      presence.subscribe(me.deviceId, chat.type === 'direct' ? chat.members.filter((m) => m !== me.userId) : []);
      break;
    }
    case 'ping':
      presence.heartbeat(me.userId);
      reply(ws, { type: 'pong' });
      break;
    default:
      reply(ws, { type: 'error', error: 'unknown_type' });
  }
}

function subscribeToBus() {
  // Async fan-out on WRITE: one stored message → every target device.
  bus.subscribe('message.stored', async ({ doc }) => {
    for (const { device_id } of doc.keys) {
      if (device_id === doc.sender_device_id) continue;
      const ev = { type: 'message', ...pipeline.forDevice(doc, device_id) };
      if (!registry.send(device_id, ev)) notifications.notifyOffline(device_id, doc.chat_id); // no socket → push
    }
  });

  // Receipts: recompute the high-water marks and tell everyone in the chat.
  bus.subscribe('receipt.recorded', async ({ chat, device, type, up_to_seq }) => {
    const fresh = await db.chats.findOne({ _id: chat._id });
    const summaryFor = await chats.receiptSummary(fresh);
    for (const m of fresh.members) {
      if (m === device.userId) continue;
      registry.sendToUser(m, { type: 'receipt', chat_id: chat._id, ...summaryFor(m) });
    }
    if (type === 'read') {
      // Self-sync: read on laptop → phone clears its unread badge too.
      registry.sendToUser(device.userId, { type: 'read_sync', chat_id: chat._id, up_to_seq }, device.deviceId);
    }
  });

  bus.subscribe('chat.updated', async ({ chat_id, members }) => {
    for (const m of members) registry.sendToUser(m, { type: 'chat_updated', chat_id });
  });
}

module.exports = { attach };
