package com.relay.chat.realtime;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.relay.chat.auth.AuthContext;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;
import org.springframework.web.socket.CloseStatus;
import org.springframework.web.socket.TextMessage;
import org.springframework.web.socket.WebSocketSession;

import java.io.IOException;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;

/**
 * Connection registry: "which socket holds Bob's laptop?" In production this is Redis
 * (device_id → chat-server id) so any chat server can route to any other. With one
 * process it is two concurrent maps.
 */
@Component
public class ConnectionRegistry {
    private static final Logger log = LoggerFactory.getLogger(ConnectionRegistry.class);
    public static final CloseStatus REPLACED = new CloseStatus(4000, "replaced by a newer connection");

    private final Map<String, WebSocketSession> byDevice = new ConcurrentHashMap<>();
    private final Map<String, Set<String>> byUser = new ConcurrentHashMap<>();
    private final ObjectMapper mapper;

    public ConnectionRegistry(ObjectMapper mapper) {
        this.mapper = mapper;
    }

    static AuthContext auth(WebSocketSession s) {
        return (AuthContext) s.getAttributes().get(AuthContext.ATTRIBUTE);
    }

    /** @param session a thread-safe (decorated) session */
    public void register(WebSocketSession session) {
        AuthContext a = auth(session);
        WebSocketSession prev = byDevice.put(a.deviceId(), session);
        if (prev != null && prev != session && prev.isOpen()) {
            try { prev.close(REPLACED); } catch (IOException ignored) { }
        }
        byUser.computeIfAbsent(a.userId(), k -> ConcurrentHashMap.newKeySet()).add(a.deviceId());
    }

    /** Returns true if this session was the registered one for its device. */
    public boolean unregister(WebSocketSession session) {
        AuthContext a = auth(session);
        if (!byDevice.remove(a.deviceId(), session)) return false;
        byUser.computeIfPresent(a.userId(), (k, set) -> {
            set.remove(a.deviceId());
            return set.isEmpty() ? null : set;
        });
        return true;
    }

    public WebSocketSession socketFor(String deviceId) {
        return byDevice.get(deviceId);
    }

    public boolean isUserOnline(String userId) {
        Set<String> s = byUser.get(userId);
        return s != null && !s.isEmpty();
    }

    public List<String> devicesOnline(String userId) {
        Set<String> s = byUser.get(userId);
        return s == null ? List.of() : List.copyOf(s);
    }

    public boolean send(String deviceId, Object event) {
        WebSocketSession s = byDevice.get(deviceId);
        return s != null && sendTo(s, event);
    }

    public void sendToUser(String userId, Object event, String exceptDeviceId) {
        for (String d : devicesOnline(userId)) if (!d.equals(exceptDeviceId)) send(d, event);
    }

    public boolean sendTo(WebSocketSession s, Object event) {
        if (!s.isOpen()) return false;
        try {
            s.sendMessage(new TextMessage(mapper.writeValueAsString(event)));
            return true;
        } catch (JsonProcessingException e) {
            throw new IllegalStateException(e);
        } catch (IOException | RuntimeException e) {
            log.debug("send to {} failed: {}", s.getId(), e.getMessage());
            return false;
        }
    }

    public java.util.Collection<WebSocketSession> all() {
        return byDevice.values();
    }
}
