// MongoDB connection + collection/index setup.
//
// Collections
//   users     – account (phone, name)                          shard key in prod: _id (user_id)
//   otps      – one-time codes, TTL-expired                     never long-lived
//   devices   – one row per device, holds its PUBLIC key        shard key in prod: user_id
//   chats     – direct + group chats, members, per-chat seq     shard key in prod: _id (chat/group id)
//   messages  – ENCRYPTED messages only (ciphertext + per-device wrapped keys)
//   receipts  – per (chat, device) high-water marks: delivered_seq / read_seq
//   media     – metadata of encrypted blobs in blob storage
const net = require('net');
const fs = require('fs');
const path = require('path');
const { MongoClient } = require('mongodb');
const config = require('./config');

let client;
let embedded;
const db = {};

function portOpen(host, port, timeout = 1200) {
  return new Promise((resolve) => {
    const s = net.connect({ host, port });
    const done = (ok) => { s.destroy(); resolve(ok); };
    s.setTimeout(timeout, () => done(false));
    s.once('connect', () => done(true));
    s.once('error', () => done(false));
  });
}

async function resolveUri() {
  if (config.mongoUri) return config.mongoUri;
  if (await portOpen('127.0.0.1', 27017)) return 'mongodb://127.0.0.1:27017';
  console.log('[db] No MONGO_URI and nothing on localhost:27017 – starting embedded MongoDB (first run downloads it)…');
  const { MongoMemoryServer } = require('mongodb-memory-server-core');
  const dbPath = path.join(config.dataDir, 'mongo');
  fs.mkdirSync(dbPath, { recursive: true });
  embedded = await MongoMemoryServer.create({ instance: { dbPath, storageEngine: 'wiredTiger', port: 27018 } });
  return embedded.getUri();
}

async function connect() {
  const uri = await resolveUri();
  client = new MongoClient(uri, { writeConcern: { w: 'majority' } });
  await client.connect();
  const d = client.db(config.mongoDb);
  Object.assign(db, {
    client,
    users: d.collection('users'),
    otps: d.collection('otps'),
    devices: d.collection('devices'),
    chats: d.collection('chats'),
    messages: d.collection('messages'),
    receipts: d.collection('receipts'),
    media: d.collection('media'),
  });

  await Promise.all([
    db.users.createIndex({ phone: 1 }, { unique: true }),
    db.otps.createIndex({ expires_at: 1 }, { expireAfterSeconds: 0 }),
    db.devices.createIndex({ user_id: 1 }),
    db.chats.createIndex({ members: 1, last_message_at: -1 }),
    db.chats.createIndex({ direct_key: 1 }, { unique: true, partialFilterExpression: { type: 'direct' } }),
    // Ordering is PER CONVERSATION: (chat_id, seq) is unique.
    db.messages.createIndex({ chat_id: 1, seq: 1 }, { unique: true }),
    // Lets a device pull only the messages that were encrypted for it.
    db.messages.createIndex({ 'keys.device_id': 1, chat_id: 1, seq: 1 }),
    db.messages.createIndex({ expires_at: 1 }, { expireAfterSeconds: 0 }),
    db.receipts.createIndex({ chat_id: 1, device_id: 1 }, { unique: true }),
    db.receipts.createIndex({ device_id: 1 }),
    db.media.createIndex({ expires_at: 1 }, { expireAfterSeconds: 0 }),
  ]);
  console.log(`[db] connected to ${uri.replace(/\/\/[^@]*@/, '//***@')} db=${config.mongoDb}`);
  return db;
}

async function close() {
  await client?.close();
  await embedded?.stop({ doCleanup: false });
}

module.exports = { db, connect, close };
