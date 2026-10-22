# Relay chat: Spring Boot backend

This is the full backend in Spring Boot 3.5 (Java 17+) with MongoDB. It exposes the same REST API and
WebSocket protocol as the Node server in `../server`, so the frontend in `../public` works without changes.
The build copies `../public` into the jar, so the app and the API come from one server.

## Run it

You need a JDK (17 or newer) and MongoDB.

```bash
# 1. MongoDB (pick one)
docker compose -f ../docker-compose.yml up -d
#   or: brew tap mongodb/brew && brew install mongodb-community && brew services start mongodb-community

# 2. Java, if `java -version` shows nothing or < 17
#   brew install openjdk@21

# 3. Start the backend (the first run downloads Maven and the dependencies)
cd springboot-backend
./mvnw spring-boot:run
```

Open http://localhost:8080 in two tabs and sign in with two different phone numbers. The OTP is shown
on screen in development and also written to the log.

To build a single runnable jar:

```bash
./mvnw -DskipTests package
java -jar target/chat-backend-1.0.0.jar
```

### Configuration (environment variables)

| Variable | Default | |
|---|---|---|
| `PORT` | `8080` | HTTP + WebSocket port |
| `MONGO_URI` | `mongodb://127.0.0.1:27017/chat_system` | Atlas URIs work too |
| `MONGO_DB` | `chat_system` | |
| `JWT_SECRET` | `dev-only-change-me` | set a long random value outside development |
| `DEV_OTP` | `true` | `false` stops returning the OTP in the API response |
| `MESSAGE_RETENTION_DAYS` | `30` | TTL for stored ciphertext |
| `BLOB_DIR` | `.data/blobs` | where encrypted media blobs are written |
| `ALLOWED_ORIGINS` | `*` | WebSocket origin patterns, comma-separated |

## Code map

```
com.relay.chat
├── ChatApplication            @EnableAsync (bus), @EnableScheduling (heartbeat)
├── config
│   ├── AppProperties          relay.* settings
│   ├── MongoConfig            w:majority writes + all indexes (unique (chat_id, seq), TTLs, …)
│   ├── AsyncConfig            "busExecutor": single worker = Kafka stand-in, keeps fan-out in order
│   ├── WebConfig              bearer-token interceptor on /v1/**
│   └── WebSocketConfig        WS /v1/connect + handshake auth
├── auth                       gateway: phone + OTP, device registration, JWT per DEVICE
├── users                      accounts, devices, public keys
├── chats                      direct chats, groups, admins, receipt aggregation (✓✓ / blue ✓✓)
├── media                      presigned upload/download of ENCRYPTED blobs
├── pipeline
│   ├── MessagePipeline        validate → membership → dedup → seq → durable write → ack
│   ├── MessageBus / Events    publish MessageStored, ReceiptRecorded, ChatUpdated
│   └── PipelineException      becomes a nack frame
├── realtime
│   ├── ChatWebSocketHandler   frames, offline sync on connect, heartbeat
│   ├── FanOutListener         @Async bus consumers: fan-out on write, receipts, chat updates
│   ├── ConnectionRegistry     device → socket (Redis in production)
│   ├── PresenceService        online / last seen / typing, in memory, subscription-based
│   └── NotificationService    "no socket → push" (logged)
└── model                      MongoDB documents + API views
```

### MongoDB collections

The documents and field names match the Node version, so both backends can share one database:
`users`, `otps`, `devices`, `chats`, `messages` (ciphertext + per-device wrapped keys only), `receipts`, `media`.
Spring Data also adds a `_class` field to the documents it writes.

## API

REST: `/v1/auth/register`, `/v1/auth/verify`, `/v1/users/me`, `/v1/devices/{id}`, `/v1/chats`,
`/v1/chats/direct`, `/v1/chats/{id}/devices`, `/v1/chats/{id}/messages`, `/v1/groups`,
`/v1/groups/{id}`, `/v1/groups/{id}/members`, `/v1/media/upload-url`, `/v1/media/{id}/download-url`,
and the presigned `/blobs/{id}`.

WebSocket `/v1/connect?token=…`: `send` → `ack`/`nack`, `message`, `receipt`, `read_sync`, `typing`,
`presence_subscribe` → `presence`, `chat_updated`, `sync_done`. See the main README for the full protocol.
