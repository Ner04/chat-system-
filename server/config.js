// Central configuration. Every value can be overridden with an environment variable
// (see .env.example). Defaults are tuned for local development.
const path = require('path');
const fs = require('fs');

// Tiny .env loader so the project has no extra dependency for it.
const envFile = path.join(__dirname, '..', '.env');
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, '..', '.data'));

module.exports = {
  port: Number(process.env.PORT || 3000),
  // If MONGO_URI is unset we try mongodb://127.0.0.1:27017 and, failing that,
  // start an embedded MongoDB (mongodb-memory-server) persisted under .data/mongo.
  mongoUri: process.env.MONGO_URI || '',
  mongoDb: process.env.MONGO_DB || 'chat_system',
  jwtSecret: process.env.JWT_SECRET || 'dev-only-change-me',
  mediaSigningSecret: process.env.MEDIA_SECRET || process.env.JWT_SECRET || 'dev-only-media-secret',
  // In development the OTP is also returned in the API response and printed to the console.
  devOtp: process.env.NODE_ENV !== 'production',
  otpTtlSeconds: 5 * 60,
  // "Server is a relay, not an archive": undelivered/old ciphertext expires after N days.
  messageRetentionDays: Number(process.env.MESSAGE_RETENTION_DAYS || 30),
  maxDevicesPerUser: 5,
  maxGroupSize: 256,
  maxCiphertextBytes: 64 * 1024,
  maxMediaBytes: 25 * 1024 * 1024,
  heartbeatMs: 30_000,
  dataDir: DATA_DIR,
  blobDir: path.join(DATA_DIR, 'blobs'),
};
