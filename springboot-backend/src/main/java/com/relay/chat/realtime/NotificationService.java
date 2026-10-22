package com.relay.chat.realtime;

import jakarta.annotation.PreDestroy;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;

import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;

/**
 * Notification layer. With no live socket, the real system asks FCM/APNs to wake the app; the
 * app then connects, syncs and sends the delivery ACK itself (a push is NOT a delivery).
 * Here the push is logged, and a burst of messages is collapsed into one push per second.
 */
@Service
public class NotificationService {
    private static final Logger log = LoggerFactory.getLogger(NotificationService.class);
    private final Map<String, AtomicInteger> pending = new ConcurrentHashMap<>();
    private final ScheduledExecutorService timer = Executors.newSingleThreadScheduledExecutor(r -> {
        Thread t = new Thread(r, "push");
        t.setDaemon(true);
        return t;
    });

    public void notifyOffline(String deviceId, String chatId) {
        AtomicInteger n = pending.computeIfAbsent(deviceId, k -> new AtomicInteger());
        if (n.incrementAndGet() == 1) {
            timer.schedule(() -> {
                AtomicInteger c = pending.remove(deviceId);
                log.info("[push] would wake {}: {} new message(s) (latest chat {})", deviceId, c == null ? 1 : c.get(), chatId);
            }, 1, TimeUnit.SECONDS);
        }
    }

    @PreDestroy
    void stop() {
        timer.shutdownNow();
    }
}
