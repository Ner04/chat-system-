const crypto = require('crypto');

const newId = (prefix) => `${prefix}_${crypto.randomBytes(12).toString('base64url')}`;

// Very small phone normaliser: keep a leading + and digits.
function normalizePhone(raw) {
  if (typeof raw !== 'string') return null;
  const p = raw.trim().replace(/[\s\-().]/g, '');
  return /^\+?\d{6,15}$/.test(p) ? (p.startsWith('+') ? p : `+${p}`) : null;
}

class HttpError extends Error {
  constructor(status, code, message) { super(message || code); this.status = status; this.code = code; }
}

// Wrap async express handlers so thrown errors reach the error middleware.
const ah = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

const publicUser = (u) => u && { user_id: u._id, phone: u.phone, name: u.name || u.phone };

module.exports = { newId, normalizePhone, HttpError, ah, publicUser };
