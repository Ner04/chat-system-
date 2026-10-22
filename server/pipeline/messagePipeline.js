// Message pipeline / storage service.
//
//   Alice → socket → validate → membership check → dedup → assign seq
//         → DURABLE WRITE (w: majority) → ✓ ack → bus "message.stored" → async fan-out
//
// Persist first, then deliver: an accepted message is never lost even if every
// chat server dies right after the ack.
//
// The server only ever sees:
//   ciphertext + iv        – the message body, AES-256-GCM encrypted by the sender
//   keys[]                 – the per-message AES key, wrapped once for EVERY recipient
//                            device (and the sender's other devices) via ECDH
// It cannot read the content; it only relays and stores opaque bytes.
const config = require('../config');
const { db } = require('../db');
const bus = require('./bus');
const users = require('../services/users');

const B64 = /^[A-Za-z0-9+/=_-]+$/;

class PipelineError extends Error {
  constructor(code, message, extra = {}) { super(message || code); this.code = code; Object.assign(this, extra); }
}

function validate(msg) {
  const { message_id, chat_id, payload } = msg;
  if (typeof message_id !== 'string' || !/^[\w-]{8,64}$/.test(message_id)) throw new PipelineError('invalid_message_id');
  if (typeof chat_id !== 'string') throw new PipelineError('invalid_chat_id');
  if (!payload || typeof payload.ciphertext !== 'string' || typeof payload.iv !== 'string') throw new PipelineError('invalid_payload');
  if (!B64.test(payload.ciphertext) || !B64.test(payload.iv)) throw new PipelineError('invalid_payload', 'payload must be base64');
  if (payload.ciphertext.length > config.maxCiphertextBytes) throw new PipelineError('too_large');
  if (!Array.isArray(payload.keys) || !payload.keys.length) throw new PipelineError('invalid_keys');
  for (const k of payload.keys) {
    if (!k || typeof k.device_id !== 'string' || typeof k.wrapped_key !== 'string' || typeof k.iv !== 'string') throw new PipelineError('invalid_keys');
  }
}

/**
 * Accept one message from a sender device. Returns the stored message's { seq, duplicate }.
 */
async function accept(sender, msg) {
  validate(msg);

  // 1. Membership check before anything is stored ("reject bad traffic as early as possible").
  const chat = await db.chats.findOne({ _id: msg.chat_id }, { projection: { members: 1, type: 1 } });
  if (!chat || !chat.members.includes(sender.userId)) throw new PipelineError('not_a_member', 'You are not in this chat');

  // 2. Idempotency: at-least-once delivery means clients retry; dedup by message_id.
  const existing = await db.messages.findOne({ _id: msg.message_id }, { projection: { seq: 1, chat_id: 1, sender_device_id: 1 } });
  if (existing) {
    if (existing.sender_device_id !== sender.deviceId) throw new PipelineError('invalid_message_id');
    return { seq: existing.seq, chat_id: existing.chat_id, duplicate: true };
  }

  // 3. Every current device of every member must have a wrapped key, otherwise some
  //    device could never decrypt it. Tell the client to refresh its device list.
  const devices = await users.devicesFor(chat.members);
  const target = new Set(devices.map((d) => d.device_id));
  target.delete(sender.deviceId); // the sending device already has the plaintext
  const provided = new Map(msg.payload.keys.map((k) => [k.device_id, k]));
  const missing = [...target].filter((id) => !provided.has(id));
  if (missing.length) throw new PipelineError('devices_changed', 'Recipient devices changed; re-encrypt and resend', { missing });
  const keys = [...target].map((id) => ({ device_id: id, wrapped_key: provided.get(id).wrapped_key, iv: provided.get(id).iv }));
  // Keep a copy for the sending device too (so its own history can be re-fetched).
  if (provided.has(sender.deviceId)) keys.push({ device_id: sender.deviceId, ...pick(provided.get(sender.deviceId)) });

  // 4. Per-conversation sequence number (not a global counter – no global bottleneck).
  const now = new Date();
  const updated = await db.chats.findOneAndUpdate(
    { _id: chat._id },
    { $inc: { last_seq: 1 }, $set: { last_message_at: now } },
    { returnDocument: 'after', projection: { last_seq: 1 } },
  );
  const seq = updated.last_seq;

  // 5. Durable write (client has writeConcern majority). Only ciphertext lands here.
  const doc = {
    _id: msg.message_id,
    chat_id: chat._id,
    seq,
    sender_user_id: sender.userId,
    sender_device_id: sender.deviceId,
    ciphertext: msg.payload.ciphertext,
    iv: msg.payload.iv,
    keys,
    client_ts: Number.isFinite(msg.client_ts) ? new Date(msg.client_ts) : null,
    created_at: now,
    expires_at: new Date(now.getTime() + config.messageRetentionDays * 86400_000),
  };
  try {
    await db.messages.insertOne(doc);
  } catch (e) {
    if (e.code === 11000) {
      const again = await db.messages.findOne({ _id: msg.message_id });
      if (again) return { seq: again.seq, chat_id: again.chat_id, duplicate: true };
    }
    throw e;
  }

  // Sender has implicitly read everything up to its own message.
  await db.receipts.updateOne(
    { chat_id: chat._id, device_id: sender.deviceId },
    { $max: { delivered_seq: seq, read_seq: seq }, $set: { user_id: sender.userId } },
    { upsert: true },
  );

  // 6. Hand off to fan-out asynchronously.
  bus.publish('message.stored', { doc, members: chat.members });
  return { seq, chat_id: chat._id, duplicate: false };
}

const pick = (k) => ({ wrapped_key: k.wrapped_key, iv: k.iv });

// Shape a stored message for ONE device: include only that device's wrapped key.
function forDevice(doc, deviceId) {
  const key = doc.keys.find((k) => k.device_id === deviceId);
  if (!key) return null;
  return {
    message_id: doc._id,
    chat_id: doc.chat_id,
    seq: doc.seq,
    sender_user_id: doc.sender_user_id,
    sender_device_id: doc.sender_device_id,
    created_at: doc.created_at,
    payload: { ciphertext: doc.ciphertext, iv: doc.iv, key: pick(key) },
  };
}

// History / offline sync for one device. Uses $elemMatch so only that device's key is read.
async function messagesForDevice(deviceId, chatId, { afterSeq, beforeSeq, limit = 50 }) {
  const seq = {};
  if (afterSeq != null) seq.$gt = afterSeq;
  if (beforeSeq != null) seq.$lt = beforeSeq;
  const q = { chat_id: chatId, 'keys.device_id': deviceId, ...(Object.keys(seq).length ? { seq } : {}) };
  const sort = afterSeq != null ? { seq: 1 } : { seq: -1 };
  const docs = await db.messages
    .find(q, { projection: { ciphertext: 1, iv: 1, chat_id: 1, seq: 1, sender_user_id: 1, sender_device_id: 1, created_at: 1, keys: { $elemMatch: { device_id: deviceId } } } })
    .sort(sort).limit(Math.min(limit, 200)).toArray();
  docs.sort((a, b) => a.seq - b.seq);
  return docs.map((d) => forDevice(d, deviceId));
}

/**
 * Record a delivered/read high-water mark for one device. Returns null if nothing moved.
 */
async function recordReceipt(device, { chat_id, type, up_to_seq }) {
  if (!['delivered', 'read'].includes(type) || !Number.isInteger(up_to_seq) || up_to_seq < 1) throw new PipelineError('invalid_receipt');
  const chat = await db.chats.findOne({ _id: chat_id });
  if (!chat || !chat.members.includes(device.userId)) throw new PipelineError('not_a_member');
  const upTo = Math.min(up_to_seq, chat.last_seq);
  const set = type === 'read' ? { delivered_seq: upTo, read_seq: upTo } : { delivered_seq: upTo };
  const update = { $max: set, $set: { user_id: device.userId } };
  if (type === 'delivered') update.$setOnInsert = { read_seq: 0 };
  const before = await db.receipts.findOneAndUpdate(
    { chat_id, device_id: device.deviceId }, update, { upsert: true, returnDocument: 'before' },
  );
  const moved = !before || (before.delivered_seq || 0) < upTo || (type === 'read' && (before.read_seq || 0) < upTo);
  if (!moved) return null;
  bus.publish('receipt.recorded', { chat, device, type, up_to_seq: upTo });
  return { chat_id, type, up_to_seq: upTo };
}

module.exports = { accept, forDevice, messagesForDevice, recordReceipt, PipelineError };
