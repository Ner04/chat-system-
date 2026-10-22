// Media service. Mirrors the HLD's presigned-URL flow:
//   POST /v1/media/upload-url  -> { media_id, upload_url }   (signed, short-lived)
//   PUT  upload_url            <- ENCRYPTED bytes (server never sees plaintext or the key)
//   GET  /v1/media/:id/download-url -> { url }               (a CDN URL in production)
// "Blob storage" here is a local folder; swap for S3/GCS by changing put/get.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const config = require('../config');
const { db } = require('../db');
const { newId, HttpError } = require('../util');

fs.mkdirSync(config.blobDir, { recursive: true });

const sign = (id, op, exp) => crypto.createHmac('sha256', config.mediaSigningSecret).update(`${id}:${op}:${exp}`).digest('base64url');
const signedUrl = (id, op, ttlSec) => {
  const exp = Math.floor(Date.now() / 1000) + ttlSec;
  return `/blobs/${id}?op=${op}&exp=${exp}&sig=${sign(id, op, exp)}`;
};
function checkSig(id, op, exp, sig) {
  if (!/^med_[\w-]+$/.test(id) || Number(exp) < Date.now() / 1000) return false;
  const want = Buffer.from(sign(id, op, exp));
  const got = Buffer.from(String(sig || ''));
  return want.length === got.length && crypto.timingSafeEqual(want, got);
}
const blobPath = (id) => path.join(config.blobDir, id);

async function createUpload(userId, { size }) {
  const n = Number(size);
  if (!Number.isFinite(n) || n <= 0 || n > config.maxMediaBytes) throw new HttpError(400, 'invalid_size', `Files must be under ${config.maxMediaBytes / 1024 / 1024} MB`);
  const id = newId('med');
  await db.media.insertOne({
    _id: id, uploader: userId, declared_size: n, uploaded: false, created_at: new Date(),
    expires_at: new Date(Date.now() + config.messageRetentionDays * 86400_000),
  });
  return { media_id: id, upload_url: signedUrl(id, 'put', 600) };
}

async function storeBlob(id, query, stream) {
  if (!checkSig(id, 'put', query.exp, query.sig)) throw new HttpError(403, 'bad_signature');
  const meta = await db.media.findOne({ _id: id });
  if (!meta || meta.uploaded) throw new HttpError(409, 'already_uploaded');
  let bytes = 0;
  const hash = crypto.createHash('sha256');
  await new Promise((resolve, reject) => {
    const out = fs.createWriteStream(blobPath(id));
    stream.on('data', (c) => {
      bytes += c.length; hash.update(c);
      if (bytes > meta.declared_size + 1024) { stream.destroy(); out.destroy(); reject(new HttpError(413, 'too_large')); }
    });
    stream.pipe(out);
    out.on('finish', resolve);
    out.on('error', reject);
    stream.on('error', reject);
  });
  const sha256 = hash.digest('hex');
  await db.media.updateOne({ _id: id }, { $set: { uploaded: true, size: bytes, sha256 } });
  return { media_id: id, size: bytes, sha256 };
}

async function downloadUrl(id) {
  const meta = await db.media.findOne({ _id: id, uploaded: true });
  if (!meta || !fs.existsSync(blobPath(id))) throw new HttpError(404, 'media_missing', 'This media file appears to be missing');
  return { url: signedUrl(id, 'get', 3600) };
}

function openBlob(id, query) {
  if (!checkSig(id, 'get', query.exp, query.sig)) throw new HttpError(403, 'bad_signature');
  if (!fs.existsSync(blobPath(id))) throw new HttpError(404, 'media_missing');
  return fs.createReadStream(blobPath(id));
}

module.exports = { createUpload, storeBlob, downloadUrl, openBlob };
