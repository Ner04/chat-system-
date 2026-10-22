// Gateway layer: phone + OTP login, device registration, JWT issue/verify.
// The token identifies a DEVICE (the unit of delivery), not just an account.
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const config = require('../config');
const { db } = require('../db');
const { newId, normalizePhone, HttpError } = require('../util');

const hash = (s) => crypto.createHash('sha256').update(s).digest('hex');

async function requestOtp(rawPhone) {
  const phone = normalizePhone(rawPhone);
  if (!phone) throw new HttpError(400, 'invalid_phone', 'Enter a phone number with 6–15 digits, e.g. +919876543210');
  const otp = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
  await db.otps.updateOne(
    { _id: phone },
    { $set: { code_hash: hash(otp + phone), attempts: 0, expires_at: new Date(Date.now() + config.otpTtlSeconds * 1000) } },
    { upsert: true },
  );
  // A real system hands this to an SMS provider.
  console.log(`[auth] OTP for ${phone}: ${otp}`);
  return { phone, otp_sent: true, ...(config.devOtp ? { dev_otp: otp } : {}) };
}

function validPublicKey(jwk) {
  return jwk && typeof jwk === 'object' && jwk.kty === 'EC' && jwk.crv === 'P-256'
    && typeof jwk.x === 'string' && typeof jwk.y === 'string' && !jwk.d; // never accept a private key
}

async function verifyOtp({ phone: rawPhone, otp, device }) {
  const phone = normalizePhone(rawPhone);
  if (!phone || typeof otp !== 'string') throw new HttpError(400, 'invalid_request');
  const rec = await db.otps.findOne({ _id: phone });
  if (!rec || rec.expires_at < new Date()) throw new HttpError(401, 'otp_expired', 'That code has expired. Request a new one.');
  if (rec.attempts >= 5) throw new HttpError(429, 'too_many_attempts', 'Too many wrong codes. Request a new one.');
  if (rec.code_hash !== hash(otp.trim() + phone)) {
    await db.otps.updateOne({ _id: phone }, { $inc: { attempts: 1 } });
    throw new HttpError(401, 'otp_invalid', 'That code is not right. Check it and try again.');
  }
  await db.otps.deleteOne({ _id: phone });

  if (!device || !validPublicKey(device.public_key)) throw new HttpError(400, 'invalid_device', 'A device public key (ECDH P-256 JWK) is required');

  // Upsert the account.
  const now = new Date();
  await db.users.updateOne({ phone }, { $setOnInsert: { _id: newId('usr'), phone, name: null, created_at: now } }, { upsert: true });
  const user = await db.users.findOne({ phone });

  // Re-use the device if the client still holds its key pair, otherwise register a new one.
  let dev = device.device_id
    ? await db.devices.findOne({ _id: device.device_id, user_id: user._id, 'public_key.x': device.public_key.x })
    : null;
  if (!dev) {
    const count = await db.devices.countDocuments({ user_id: user._id });
    if (count >= config.maxDevicesPerUser) {
      // Drop the least recently seen device to stay under the cap.
      const oldest = await db.devices.find({ user_id: user._id }).sort({ last_seen: 1 }).limit(1).next();
      await db.devices.deleteOne({ _id: oldest._id });
      await db.receipts.deleteMany({ device_id: oldest._id });
    }
    dev = {
      _id: newId('dev'),
      user_id: user._id,
      name: String(device.name || 'Browser').slice(0, 60),
      public_key: { kty: 'EC', crv: 'P-256', x: device.public_key.x, y: device.public_key.y },
      created_at: now,
      last_seen: now,
    };
    await db.devices.insertOne(dev);
  }

  const token = jwt.sign({ sub: user._id, dev: dev._id }, config.jwtSecret, { expiresIn: '30d' });
  return { token, user_id: user._id, device_id: dev._id, is_new_device: dev.created_at === now, name: user.name };
}

function verifyToken(token) {
  try {
    const p = jwt.verify(token, config.jwtSecret);
    return { userId: p.sub, deviceId: p.dev };
  } catch {
    return null;
  }
}

// Express middleware: Authorization: Bearer <token>
async function requireAuth(req, _res, next) {
  const m = (req.headers.authorization || '').match(/^Bearer (.+)$/);
  const auth = m && verifyToken(m[1]);
  if (!auth) return next(new HttpError(401, 'unauthorized', 'Sign in again'));
  // The device must still exist (it may have been evicted).
  const dev = await db.devices.findOne({ _id: auth.deviceId, user_id: auth.userId }, { projection: { _id: 1 } });
  if (!dev) return next(new HttpError(401, 'device_revoked', 'This device was signed out. Sign in again.'));
  req.auth = auth;
  next();
}

module.exports = { requestOtp, verifyOtp, verifyToken, requireAuth };
