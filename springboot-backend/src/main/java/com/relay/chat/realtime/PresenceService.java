package com.relay.chat.realtime;

import com.relay.chat.auth.AuthContext;
import com.relay.chat.model.Chat;
import org.springframework.stereotype.Service;

import java.time.Instant;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;

/**
 * Presence layer: online / last seen / typing. Memory only (Redis with TTL in production),
 * never written to disk: it's worthless in 60s and losing it costs nothing.
 *
 * Delivery is subscription-based: a device only gets presence for the users in the chat it
 * has open, which turns "everyone in my contacts" into 0–2 recipients.
 */
@Service
public class PresenceService {
    private final ConnectionRegistry registry;
    private final Map<String, Instant> lastSeen = new ConcurrentHashMap<>();
    private final Map<String, Set<String>> subscribers = new ConcurrentHashMap<>(); // watched user → devices
    private final Map<String, Set<String>> subscriptionOf = new ConcurrentHashMap<>(); // device → watched users
    private final Map<String, Long> lastTyping = new ConcurrentHashMap<>();

    public PresenceService(ConnectionRegistry registry) {
        this.registry = registry;
    }

    public Map<String, Object> state(String userId) {
        Map<String, Object> ev = new LinkedHashMap<>();
        ev.put("type", "presence");
        ev.put("user_id", userId);
        ev.put("online", registry.isUserOnline(userId));
        Instant seen = lastSeen.get(userId);
        ev.put("last_seen", seen == null ? null : seen.toString());
        return ev;
    }

    public void heartbeat(String userId) {
        lastSeen.put(userId, Instant.now());
    }

    public void broadcast(String userId) {
        Map<String, Object> ev = state(userId);
        for (String dev : subscribers.getOrDefault(userId, Set.of())) registry.send(dev, ev);
    }

    public void subscribe(String deviceId, List<String> userIds) {
        unsubscribe(deviceId);
        Set<String> set = ConcurrentHashMap.newKeySet();
        set.addAll(userIds);
        subscriptionOf.put(deviceId, set);
        for (String u : set) {
            subscribers.computeIfAbsent(u, k -> ConcurrentHashMap.newKeySet()).add(deviceId);
            registry.send(deviceId, state(u));
        }
    }

    public void unsubscribe(String deviceId) {
        Set<String> watched = subscriptionOf.remove(deviceId);
        if (watched == null) return;
        for (String u : watched) {
            Set<String> subs = subscribers.get(u);
            if (subs != null) subs.remove(deviceId);
        }
    }

    /**
     * Typing is ephemeral: never stored, receivers expire it after ~5s, and it is throttled
     * to one event per 2s per device and chat. Only devices with the chat open receive it.
     */
    public void typing(AuthContext sender, Chat chat) {
        String key = sender.deviceId() + ":" + chat.id;
        long now = System.currentTimeMillis();
        Long prev = lastTyping.get(key);
        if (prev != null && now - prev < 2000) return;
        lastTyping.put(key, now);
        Map<String, Object> ev = new LinkedHashMap<>();
        ev.put("type", "typing");
        ev.put("chat_id", chat.id);
        ev.put("user_id", sender.userId());
        for (String dev : subscribers.getOrDefault(sender.userId(), Set.of())) {
            var s = registry.socketFor(dev);
            if (s == null) continue;
            String viewer = ConnectionRegistry.auth(s).userId();
            if (!viewer.equals(sender.userId()) && chat.members.contains(viewer)) registry.send(dev, ev);
        }
    }
}
