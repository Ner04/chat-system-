// End-to-end encryption, done entirely in the browser with WebCrypto.
//
// • Every DEVICE has its own ECDH P-256 key pair. The private key never leaves this
//   browser (localStorage); only the public key is uploaded.
// • To send, we create a fresh AES-256-GCM key, encrypt the message once, then wrap
//   that key separately for every recipient device (and our own other devices):
//       kek = HKDF(ECDH(my_private, their_public))   →   AES-GCM(kek, message_key)
//   so the cost is members × devices, exactly as in the design.
// • The ciphertext is bound to chat_id | message_id | sender_device_id as AES-GCM
//   additional data, so the server can't move a message into another chat.
// • Media is encrypted with its own random key BEFORE upload; the key rides inside
//   the (encrypted) message, so blob storage only ever holds an opaque lump.
const subtle = crypto.subtle;
const enc = new TextEncoder();
const dec = new TextDecoder();

export const b64 = {
  from(buf) {
    const bytes = new Uint8Array(buf);
    let s = '';
    for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(s);
  },
  to(str) {
    const s = atob(str);
    const out = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
    return out;
  },
};

const storeKey = (phone) => `relay.device.${phone}`;

// One key pair per (browser, phone number). Returns { device_id?, privateKey, publicJwk }.
export async function loadOrCreateDevice(phone) {
  let saved = null;
  try { saved = JSON.parse(localStorage.getItem(storeKey(phone)) || 'null'); } catch { /* ignore */ }
  if (saved?.privateJwk) {
    const privateKey = await subtle.importKey('jwk', saved.privateJwk, { name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);
    return { device_id: saved.device_id, privateKey, publicJwk: saved.publicJwk };
  }
  const pair = await subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const privateJwk = await subtle.exportKey('jwk', pair.privateKey);
  const { kty, crv, x, y } = await subtle.exportKey('jwk', pair.publicKey);
  const publicJwk = { kty, crv, x, y };
  try { localStorage.setItem(storeKey(phone), JSON.stringify({ privateJwk, publicJwk })); } catch { /* private mode */ }
  return { device_id: null, privateKey: pair.privateKey, publicJwk };
}

export function rememberDeviceId(phone, deviceId) {
  try {
    const saved = JSON.parse(localStorage.getItem(storeKey(phone)) || '{}');
    saved.device_id = deviceId;
    localStorage.setItem(storeKey(phone), JSON.stringify(saved));
  } catch { /* ignore */ }
}

// ---- Key-encryption keys, cached per remote device -------------------------
const kekCache = new Map();
let myPrivateKey = null;
export function useDeviceKey(privateKey) { myPrivateKey = privateKey; kekCache.clear(); }

async function kekFor(deviceId, publicJwk) {
  const cacheKey = `${deviceId}:${publicJwk.x}`;
  if (kekCache.has(cacheKey)) return kekCache.get(cacheKey);
  const p = (async () => {
    const pub = await subtle.importKey('jwk', publicJwk, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
    const shared = await subtle.deriveBits({ name: 'ECDH', public: pub }, myPrivateKey, 256);
    const hkdf = await subtle.importKey('raw', shared, 'HKDF', false, ['deriveKey']);
    return subtle.deriveKey(
      { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(32), info: enc.encode('relay/kek/v1') },
      hkdf, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'],
    );
  })();
  kekCache.set(cacheKey, p);
  return p;
}

const aad = (chatId, messageId, senderDeviceId) => enc.encode(`${chatId}|${messageId}|${senderDeviceId}`);

/**
 * Encrypt a message body for a list of devices [{ device_id, public_key }].
 * Returns the payload sent over the socket: { ciphertext, iv, keys: [{ device_id, wrapped_key, iv }] }.
 */
export async function encryptMessage(body, { chatId, messageId, senderDeviceId }, devices) {
  const msgKey = await subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt']);
  const rawKey = await subtle.exportKey('raw', msgKey);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await subtle.encrypt({ name: 'AES-GCM', iv, additionalData: aad(chatId, messageId, senderDeviceId) }, msgKey, enc.encode(JSON.stringify(body)));
  const keys = await Promise.all(devices.map(async (d) => {
    const kiv = crypto.getRandomValues(new Uint8Array(12));
    const wrapped = await subtle.encrypt({ name: 'AES-GCM', iv: kiv }, await kekFor(d.device_id, d.public_key), rawKey);
    return { device_id: d.device_id, wrapped_key: b64.from(wrapped), iv: b64.from(kiv) };
  }));
  return { ciphertext: b64.from(ct), iv: b64.from(iv), keys };
}

/** Decrypt a message received for this device, given the sender device's public key. */
export async function decryptMessage(m, senderPublicJwk) {
  const kek = await kekFor(m.sender_device_id, senderPublicJwk);
  const rawKey = await subtle.decrypt({ name: 'AES-GCM', iv: b64.to(m.payload.key.iv) }, kek, b64.to(m.payload.key.wrapped_key));
  const msgKey = await subtle.importKey('raw', rawKey, 'AES-GCM', false, ['decrypt']);
  const pt = await subtle.decrypt(
    { name: 'AES-GCM', iv: b64.to(m.payload.iv), additionalData: aad(m.chat_id, m.message_id, m.sender_device_id) },
    msgKey, b64.to(m.payload.ciphertext),
  );
  return JSON.parse(dec.decode(pt));
}

// ---- Media -------------------------------------------------------------------
export async function encryptFile(buffer) {
  const key = await subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt']);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await subtle.encrypt({ name: 'AES-GCM', iv }, key, buffer);
  const hash = await subtle.digest('SHA-256', ct);
  return { bytes: ct, key: b64.from(await subtle.exportKey('raw', key)), iv: b64.from(iv), sha256: b64.from(hash) };
}

export async function decryptFile(buffer, { key, iv, sha256 }) {
  if (sha256) {
    const got = b64.from(await subtle.digest('SHA-256', buffer));
    if (got !== sha256) throw new Error('media hash mismatch');
  }
  const k = await subtle.importKey('raw', b64.to(key), 'AES-GCM', false, ['decrypt']);
  return subtle.decrypt({ name: 'AES-GCM', iv: b64.to(iv) }, k, buffer);
}
