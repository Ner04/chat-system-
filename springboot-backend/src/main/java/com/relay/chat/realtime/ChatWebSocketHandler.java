package com.relay.chat.realtime;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.relay.chat.auth.AuthContext;
import com.relay.chat.model.Chat;
import com.relay.chat.model.Receipt;
import com.relay.chat.model.Views.MessageView;
import com.relay.chat.pipeline.MessagePipeline;
import com.relay.chat.pipeline.MessagePipeline.Accepted;
import com.relay.chat.pipeline.MessagePipeline.SendFrame;
import com.relay.chat.pipeline.PipelineException;
import com.relay.chat.users.UserService;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.data.mongodb.core.MongoTemplate;
import org.springframework.data.mongodb.core.query.Query;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;
import org.springframework.web.socket.CloseStatus;
import org.springframework.web.socket.PingMessage;
import org.springframework.web.socket.PongMessage;
import org.springframework.web.socket.TextMessage;
import org.springframework.web.socket.WebSocketSession;
import org.springframework.web.socket.handler.ConcurrentWebSocketSessionDecorator;
import org.springframework.web.socket.handler.TextWebSocketHandler;

import java.io.IOException;
import java.nio.ByteBuffer;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicBoolean;

import static org.springframework.data.mongodb.core.query.Criteria.where;

/**
 * Chat server: the long-lived {@code WS /v1/connect?token=…}. It routes and stores nothing itself.
 *
 * <pre>
 * Client → server   send {message_id, chat_id, payload, client_ts}
 *                   receipt {chat_id, receipt_type: delivered|read, up_to_seq}
 *                   typing {chat_id}   presence_subscribe {chat_id|null}   ping
 * Server → client   ack {message_id, chat_id, seq}            ✓ stored by server
 *                   nack {message_id, error, message, missing}
 *                   message {message_id, chat_id, seq, sender_*, payload}
 *                   receipt {chat_id, delivered_up_to, read_up_to}   ✓✓ / blue ✓✓
 *                   read_sync, chat_updated, presence, typing, sync_done, pong, error
 * </pre>
 *
 * Frames from one socket are handled one at a time, in order, so the sender's order
 * becomes the seq order.
 */
@Component
public class ChatWebSocketHandler extends TextWebSocketHandler {
    private static final Logger log = LoggerFactory.getLogger(ChatWebSocketHandler.class);
    private static final String ALIVE = "alive";

    private final ObjectMapper mapper;
    private final MongoTemplate mongo;
    private final MessagePipeline pipeline;
    private final ConnectionRegistry registry;
    private final PresenceService presence;
    private final UserService users;
    /** raw session id → thread-safe decorated session (fan-out writes come from other threads). */
    private final Map<String, WebSocketSession> sessions = new ConcurrentHashMap<>();

    public ChatWebSocketHandler(ObjectMapper mapper, MongoTemplate mongo, MessagePipeline pipeline,
                                ConnectionRegistry registry, PresenceService presence, UserService users) {
        this.mapper = mapper;
        this.mongo = mongo;
        this.pipeline = pipeline;
        this.registry = registry;
        this.presence = presence;
        this.users = users;
    }

    @Override
    public void afterConnectionEstablished(WebSocketSession raw) {
        WebSocketSession ws = new ConcurrentWebSocketSessionDecorator(raw, 10_000, 1024 * 1024);
        sessions.put(raw.getId(), ws);
        AuthContext me = ConnectionRegistry.auth(raw);
        raw.getAttributes().put(ALIVE, new AtomicBoolean(true));

        boolean wasOnline = registry.isUserOnline(me.userId());
        registry.register(ws);
        presence.heartbeat(me.userId());
        users.touchDevice(me.deviceId());
        if (!wasOnline) presence.broadcast(me.userId());

        // Offline sync: push everything after this device's cursor, per chat.
        try {
            int count = syncDevice(ws, me);
            reply(ws, Map.of("type", "sync_done", "count", count));
        } catch (RuntimeException e) {
            log.error("sync failed for {}", me.deviceId(), e);
        }
    }

    /** "I have up to 1200" → "here's 1201 → 1600", for every chat of this user. */
    private int syncDevice(WebSocketSession ws, AuthContext me) {
        List<Chat> chats = mongo.find(Query.query(where("members").is(me.userId())), Chat.class);
        Map<String, Long> cursors = new HashMap<>();
        for (Receipt r : mongo.find(Query.query(where("deviceId").is(me.deviceId())), Receipt.class)) {
            cursors.put(r.chatId, r.deliveredSeq);
        }
        int count = 0;
        for (Chat c : chats) {
            long after = cursors.getOrDefault(c.id, 0L);
            if (c.lastSeq <= after) continue;
            for (MessageView m : pipeline.messagesForDevice(me.deviceId(), c.id, after, null, 500)) {
                Map<String, Object> ev = messageEvent(m);
                ev.put("backlog", true);
                reply(ws, ev);
                count++;
            }
        }
        return count;
    }

    @SuppressWarnings("unchecked")
    public Map<String, Object> messageEvent(MessageView m) {
        Map<String, Object> ev = new LinkedHashMap<>();
        ev.put("type", "message");
        ev.putAll(mapper.convertValue(m, Map.class));
        return ev;
    }

    @Override
    protected void handleTextMessage(WebSocketSession raw, TextMessage message) {
        WebSocketSession ws = sessions.getOrDefault(raw.getId(), raw);
        AuthContext me = ConnectionRegistry.auth(raw);
        JsonNode frame;
        try {
            frame = mapper.readTree(message.getPayload());
        } catch (IOException e) {
            reply(ws, Map.of("type", "error", "error", "bad_json"));
            return;
        }
        try {
            handle(ws, me, frame);
        } catch (RuntimeException e) {
            log.error("ws handler error", e);
            reply(ws, Map.of("type", "error", "error", "internal"));
        }
    }

    private void handle(WebSocketSession ws, AuthContext me, JsonNode frame) {
        String type = frame.path("type").asText("");
        switch (type) {
            case "send" -> {
                String messageId = frame.path("message_id").asText(null);
                try {
                    SendFrame f = mapper.treeToValue(frame, SendFrame.class);
                    Accepted a = pipeline.accept(me, f);
                    Map<String, Object> ack = new LinkedHashMap<>();
                    ack.put("type", "ack");
                    ack.put("message_id", messageId);
                    ack.put("chat_id", a.chatId());
                    ack.put("seq", a.seq());
                    ack.put("duplicate", a.duplicate());
                    reply(ws, ack);
                } catch (PipelineException e) {
                    Map<String, Object> nack = new LinkedHashMap<>();
                    nack.put("type", "nack");
                    nack.put("message_id", messageId);
                    nack.put("error", e.code());
                    nack.put("message", e.getMessage());
                    if (e.missing() != null) nack.put("missing", e.missing());
                    reply(ws, nack);
                } catch (IOException e) {
                    Map<String, Object> nack = new LinkedHashMap<>();
                    nack.put("type", "nack");
                    nack.put("message_id", messageId);
                    nack.put("error", "invalid_payload");
                    reply(ws, nack);
                }
            }
            case "receipt" -> {
                try {
                    Long upTo = frame.path("up_to_seq").canConvertToLong() ? frame.path("up_to_seq").asLong() : null;
                    pipeline.recordReceipt(me, frame.path("chat_id").asText(null), frame.path("receipt_type").asText(null), upTo);
                } catch (PipelineException e) {
                    reply(ws, Map.of("type", "error", "error", e.code()));
                }
            }
            case "typing" -> {
                Chat chat = findChat(frame.path("chat_id").asText(null));
                if (chat != null && chat.members.contains(me.userId())) presence.typing(me, chat);
            }
            case "presence_subscribe" -> {
                String chatId = frame.path("chat_id").asText(null);
                if (chatId == null || chatId.isEmpty() || frame.path("chat_id").isNull()) {
                    presence.unsubscribe(me.deviceId());
                    return;
                }
                Chat chat = findChat(chatId);
                if (chat == null || !chat.members.contains(me.userId())) return;
                // Presence is only exposed for direct chats (groups would leak a lot of it).
                List<String> watch = Chat.DIRECT.equals(chat.type)
                        ? chat.members.stream().filter(m -> !m.equals(me.userId())).toList()
                        : List.of();
                presence.subscribe(me.deviceId(), watch);
            }
            case "ping" -> {
                presence.heartbeat(me.userId());
                reply(ws, Map.of("type", "pong"));
            }
            default -> reply(ws, Map.of("type", "error", "error", "unknown_type"));
        }
    }

    private Chat findChat(String chatId) {
        return chatId == null ? null : mongo.findById(chatId, Chat.class);
    }

    @Override
    protected void handlePongMessage(WebSocketSession raw, PongMessage message) {
        Object alive = raw.getAttributes().get(ALIVE);
        if (alive instanceof AtomicBoolean a) a.set(true);
        presence.heartbeat(ConnectionRegistry.auth(raw).userId());
    }

    @Override
    public void handleTransportError(WebSocketSession raw, Throwable exception) {
        log.debug("transport error on {}: {}", raw.getId(), exception.getMessage());
    }

    @Override
    public void afterConnectionClosed(WebSocketSession raw, CloseStatus status) {
        WebSocketSession ws = sessions.remove(raw.getId());
        AuthContext me = ConnectionRegistry.auth(raw);
        if (ws != null && registry.unregister(ws)) {
            presence.unsubscribe(me.deviceId());
            presence.heartbeat(me.userId());
            if (!registry.isUserOnline(me.userId())) presence.broadcast(me.userId());
        }
    }

    /** Heartbeat (~30s). A socket that missed the last pong is dead → offline. */
    @Scheduled(fixedRateString = "${relay.heartbeat-ms}")
    public void heartbeat() {
        for (WebSocketSession ws : sessions.values()) {
            AtomicBoolean alive = (AtomicBoolean) ws.getAttributes().get(ALIVE);
            try {
                if (alive != null && !alive.getAndSet(false)) {
                    ws.close(CloseStatus.SESSION_NOT_RELIABLE);
                    continue;
                }
                ws.sendMessage(new PingMessage(ByteBuffer.allocate(0)));
            } catch (IOException | RuntimeException e) {
                log.debug("heartbeat failed for {}", ws.getId());
            }
        }
    }

    private void reply(WebSocketSession ws, Object event) {
        registry.sendTo(ws, event);
    }
}
