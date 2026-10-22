// REST API (gateway → services). Matches the HLD API design.
const express = require('express');
const auth = require('./gateway/auth');
const users = require('./services/users');
const chats = require('./services/chats');
const media = require('./services/media');
const pipeline = require('./pipeline/messagePipeline');
const { ah, HttpError, publicUser } = require('./util');

const r = express.Router();
const json = express.json({ limit: '64kb' });

// Simple in-memory rate limit for OTP requests (per phone + IP).
const otpHits = new Map();
function otpLimit(req, _res, next) {
  const key = `${req.ip}:${req.body?.phone}`;
  const now = Date.now();
  const hits = (otpHits.get(key) || []).filter((t) => now - t < 10 * 60_000);
  if (hits.length >= 5) return next(new HttpError(429, 'rate_limited', 'Too many codes requested. Wait a few minutes.'));
  otpHits.set(key, [...hits, now]);
  next();
}

// --- Auth -------------------------------------------------------------------
r.post('/v1/auth/register', json, otpLimit, ah(async (req, res) => res.json(await auth.requestOtp(req.body?.phone))));
r.post('/v1/auth/verify', json, ah(async (req, res) => res.json(await auth.verifyOtp(req.body || {}))));

// Everything below needs a token.
r.use('/v1', ah(auth.requireAuth));

// --- Users & devices --------------------------------------------------------
r.get('/v1/users/me', ah(async (req, res) => res.json({ ...publicUser(await users.getUser(req.auth.userId)), device_id: req.auth.deviceId })));
r.patch('/v1/users/me', json, ah(async (req, res) => res.json(await users.updateName(req.auth.userId, req.body?.name))));
r.get('/v1/devices/:id', ah(async (req, res) => {
  const d = await users.getDevice(req.params.id);
  if (!d) throw new HttpError(404, 'device_not_found');
  res.json(d);
}));

// --- Chats ------------------------------------------------------------------
r.get('/v1/chats', ah(async (req, res) => res.json(await chats.listChats(req.auth.userId, req.auth.deviceId))));
r.post('/v1/chats/direct', json, ah(async (req, res) => res.json(await chats.openDirect(req.auth.userId, req.body?.phone))));
r.get('/v1/chats/:id/devices', ah(async (req, res) => {
  const chat = await chats.getChatForMember(req.params.id, req.auth.userId);
  res.json(await users.devicesFor(chat.members));
}));
r.get('/v1/chats/:id/messages', ah(async (req, res) => {
  await chats.getChatForMember(req.params.id, req.auth.userId);
  const num = (v) => (v == null || v === '' ? undefined : Number(v));
  res.json(await pipeline.messagesForDevice(req.auth.deviceId, req.params.id, {
    beforeSeq: num(req.query.before), afterSeq: num(req.query.after), limit: num(req.query.limit) || 50,
  }));
}));

// --- Groups -----------------------------------------------------------------
r.post('/v1/groups', json, ah(async (req, res) => res.json(await chats.createGroup(req.auth.userId, req.body || {}))));
r.get('/v1/groups/:id', ah(async (req, res) => res.json(await chats.describe(await chats.getChatForMember(req.params.id, req.auth.userId), req.auth.userId))));
r.post('/v1/groups/:id/members', json, ah(async (req, res) => res.json(await chats.addMember(req.auth.userId, req.params.id, req.body?.phone))));
r.delete('/v1/groups/:id/members/:userId', ah(async (req, res) => res.json(await chats.removeMember(req.auth.userId, req.params.id, req.params.userId))));

// --- Media ------------------------------------------------------------------
r.post('/v1/media/upload-url', json, ah(async (req, res) => res.json(await media.createUpload(req.auth.userId, req.body || {}))));
r.get('/v1/media/:id/download-url', ah(async (req, res) => res.json(await media.downloadUrl(req.params.id))));

// Blob storage endpoints (presigned – no bearer token, the signature is the auth).
const blobs = express.Router();
blobs.put('/blobs/:id', ah(async (req, res) => res.json(await media.storeBlob(req.params.id, req.query, req))));
blobs.get('/blobs/:id', (req, res, next) => {
  try {
    const stream = media.openBlob(req.params.id, req.query);
    res.set({ 'Content-Type': 'application/octet-stream', 'Cache-Control': 'private, max-age=3600' });
    stream.pipe(res);
  } catch (e) { next(e); }
});

module.exports = { api: r, blobs };
