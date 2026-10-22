# Relay — an end-to-end encrypted chat system

A small, runnable version of the WhatsApp high-level design: phone + OTP login,
1:1 and group chats, offline delivery, ✓ / ✓✓ / blue ✓✓ receipts, multi-device,
typing and online presence, and encrypted photos/files. Messages are encrypted in
the browser, and MongoDB only ever stores ciphertext.

There are two interchangeable backends with the same API, WebSocket protocol and MongoDB schema:

- **Spring Boot** in `springboot-backend/`. See [its README](springboot-backend/README.md):
  `cd springboot-backend && ./mvnw spring-boot:run`, then open http://localhost:8080
- **Node.js** in `server/` (below)

Both serve the same frontend from `public/`.

## Run it (Node.js backend)

You need Node.js 18 or newer.

```bash
cd chat-system
npm install
npm start            # → http://localhost:3000
```

**MongoDB:** the server uses the first of these that works:

1. `MONGO_URI` from `.env` (copy `.env.example` → `.env`). Atlas works too.
2. A MongoDB running on `localhost:27017`, e.g. `docker compose up -d`
   or `brew tap mongodb/brew && brew install mongodb-community && brew services start mongodb-community`.
3. If neither is there, an embedded MongoDB is downloaded on first start and stored under `.data/mongo`.
   This is fine for trying it out. Use 1 or 2 for anything you want to keep.

**Try it with two people on one machine:** open `http://localhost:3000` in two
tabs (or a normal and a private window) and sign in with two different phone numbers.
In development mode the OTP is shown on screen and printed in the server console.
Start a chat with the other number, and turn on **Show what the server sees** to
see the ciphertext that is actually stored in MongoDB.

## How it maps to the design

```
 browser (device)                                   server
 ───────────────                                    ──────
 ECDH key pair per device ──── public key ────►  gateway/auth.js        phone+OTP, JWT per DEVICE
 encrypt once (AES-GCM),                         realtime/chatServer.js WS /v1/connect (stateless router)
 wrap key per device       ──── WS send ───────►  pipeline/messagePipeline.js
                                                    membership check → dedup(message_id) → seq per chat
                                                    → durable write (w:majority) → ✓ ack
                                                  pipeline/bus.js        Kafka stand-in, async fan-out
 decrypt with own key      ◄─── WS message ─────  connectionRegistry.js  device → socket (Redis in prod)
                                                  notifications.js      no socket → push (logged)
 receipts: high-water mark ──── WS receipt ────►  receipts: max per user's devices, min across members
                                                  presence.js           online/typing, memory + TTL, never disk
 encrypted bytes           ──── PUT presigned ─►  services/media.js     blob storage (.data/blobs), signed URLs
```

| Design point | Where |
|---|---|
| Persist first, then deliver | `messagePipeline.accept` writes with `w: majority` before acking ✓ and publishing to the bus |
| Seq is per conversation, not global | `chats.last_seq` `$inc`; unique index `(chat_id, seq)` |
| Sender's order is respected | each socket's frames are processed serially |
| At-least-once, dedup by `message_id` | client retries un-acked messages on reconnect; `_id = message_id` |
| Device is the unit of delivery | token = device; keys wrapped per device; cursor per device |
| ✓✓ = at least one device of each member; group ✓✓ = everyone | `chats.receiptSummary` |
| Self-sync read state | `read_sync` event to your other devices |
| Offline queue + cursor | on connect, server pushes `seq > delivered_seq` for that device |
| Reject early | membership check before any write |
| Presence is disposable | in-memory only, subscription-based (only the open chat) |
| Media bypasses the message path | encrypted blob upload; the key + hash + thumbnail ride inside the encrypted message |
| New device = empty history | a device can only fetch messages that carry a key wrapped for it |

## MongoDB collections

| Collection | What's in it |
|---|---|
| `users` | `_id`, `phone`, `name` |
| `devices` | `_id`, `user_id`, `name`, `public_key` (public half only) |
| `chats` | `type` (`direct`/`group`), `members`, `admins`, `name`, `last_seq` |
| `messages` | `_id` (= client message_id), `chat_id`, `seq`, `sender_*`, **`ciphertext`**, `iv`, `keys[]` (`device_id`, `wrapped_key`, `iv`), `expires_at` |
| `receipts` | `(chat_id, device_id)` → `delivered_seq`, `read_seq` |
| `otps`, `media` | short-lived; TTL indexes clean them up |

A stored message looks like this:

```json
{
  "_id": "064b0177-43d1-43eb-aa22-94ec481cf35b",
  "chat_id": "grp_XoMlzeR0D1maZ_MF",
  "seq": 2,
  "ciphertext": "RlC9V0mlgnuGkb23TkZfsdH/+cKe12zf3fF1OZIRJ+at…",
  "iv": "eYxu9t12elLboB9V",
  "keys": [
    { "device_id": "dev_HgmojG_XSvdToIFx", "wrapped_key": "gLVLZFDHIcYb6zKO…", "iv": "g1eXnAGcIfrc+Dqo" },
    { "device_id": "dev_k1zw8-Mq_yKGwoA2", "wrapped_key": "3QMPRUSrhZX/d36R…", "iv": "rSW3RVYWvbqO3FlU" }
  ],
  "expires_at": "2026-11-20T02:46:05.034Z"
}
```

### Encryption

- Each browser makes an ECDH P-256 key pair. The private key stays in `localStorage`, and only the public key is uploaded.
- For every message: a random AES-256-GCM key encrypts the body once, and that key is wrapped for each
  recipient device (and your own other devices) with `HKDF(ECDH(my_private, their_public))`, so the cost is members × devices.
- The ciphertext is bound to `chat_id | message_id | sender_device_id` as AES-GCM additional data.
- Files are encrypted with their own key before upload, and a SHA-256 of the ciphertext is checked on download.

## API

```
POST   /v1/auth/register            { phone }                 → OTP sent (dev: dev_otp in response)
POST   /v1/auth/verify              { phone, otp, device }    → { token, user_id, device_id }
GET    /v1/users/me     PATCH /v1/users/me { name }
GET    /v1/chats                    list with unread + receipt high-water marks
POST   /v1/chats/direct             { phone }
GET    /v1/chats/:id/devices        public keys of every member device
GET    /v1/chats/:id/messages       ?before=seq | ?after=seq &limit
POST   /v1/groups                   { name, members[] }
GET    /v1/groups/:id
POST   /v1/groups/:id/members       { phone }
DELETE /v1/groups/:id/members/:user_id
POST   /v1/media/upload-url         { size } → { media_id, upload_url }
GET    /v1/media/:id/download-url   → { url }

WS /v1/connect?token=…
  → send     { message_id, chat_id, payload: { ciphertext, iv, keys[] } }
  ← ack      { message_id, chat_id, seq }                       ✓
  ← message  { message_id, chat_id, seq, sender_*, payload }
  → receipt  { chat_id, receipt_type: delivered|read, up_to_seq }
  ← receipt  { chat_id, delivered_up_to, read_up_to }           ✓✓ / blue ✓✓
  ← read_sync, chat_updated, presence, typing, sync_done
  → typing { chat_id }   → presence_subscribe { chat_id }
```

## Simplifications (and what you'd change for production)

- **Single process.** The bus is an in-process EventEmitter and the connection registry is a Map.
  To run several chat servers, put Kafka or Redis Streams behind `pipeline/bus.js` and Redis behind `connectionRegistry.js`.
- **Retention.** The design deletes a message once every device has it. Here encrypted messages are kept for
  `MESSAGE_RETENTION_DAYS` (default 30) via a TTL index, so a browser can reload its history from the server. The server still can't read any of it.
- **Groups** use per-device key wrapping instead of Signal-style sender keys, and there is no forward secrecy (no ratchet).
  Removed members stop getting keys for new messages straight away.
- **OTP** is logged instead of sent by SMS. Push is logged instead of sent through FCM/APNs; the browser shows a
  notification when the tab is in the background.
- **Device keys** live in `localStorage`. Clearing site data makes a new device, which starts with an empty history.
- Out of scope, as in the design: calls, status/stories, payments, blocking.
# chat-system-
