package com.relay.chat.realtime;

import com.relay.chat.chats.ChatService;
import com.relay.chat.model.Chat;
import com.relay.chat.model.Message;
import com.relay.chat.model.Views.MessageView;
import com.relay.chat.model.WrappedKey;
import com.relay.chat.pipeline.Events;
import org.springframework.context.event.EventListener;
import org.springframework.data.mongodb.core.MongoTemplate;
import org.springframework.scheduling.annotation.Async;
import org.springframework.stereotype.Component;

import java.util.LinkedHashMap;
import java.util.Map;
import java.util.function.Function;

/** Bus consumers: fan-out on WRITE, receipt broadcast and chat updates. */
@Component
public class FanOutListener {
    private final ConnectionRegistry registry;
    private final NotificationService notifications;
    private final ChatService chats;
    private final ChatWebSocketHandler handler;
    private final MongoTemplate mongo;

    public FanOutListener(ConnectionRegistry registry, NotificationService notifications, ChatService chats,
                          ChatWebSocketHandler handler, MongoTemplate mongo) {
        this.registry = registry;
        this.notifications = notifications;
        this.chats = chats;
        this.handler = handler;
        this.mongo = mongo;
    }

    /** One stored message → every target device. No socket → push notification. */
    @Async("busExecutor")
    @EventListener
    public void onMessageStored(Events.MessageStored e) {
        Message m = e.message();
        for (WrappedKey k : m.keys) {
            if (k.deviceId.equals(m.senderDeviceId)) continue;
            Map<String, Object> ev = handler.messageEvent(MessageView.forDevice(m, k.deviceId));
            if (!registry.send(k.deviceId, ev)) notifications.notifyOffline(k.deviceId, m.chatId);
        }
    }

    /** Recompute the high-water marks and tell everyone in the chat. */
    @Async("busExecutor")
    @EventListener
    public void onReceipt(Events.ReceiptRecorded e) {
        Chat fresh = mongo.findById(e.chat().id, Chat.class);
        if (fresh == null) return;
        Function<String, ChatService.Summary> summaryFor = chats.receiptSummary(fresh);
        for (String member : fresh.members) {
            if (member.equals(e.device().userId())) continue;
            ChatService.Summary s = summaryFor.apply(member);
            Map<String, Object> ev = new LinkedHashMap<>();
            ev.put("type", "receipt");
            ev.put("chat_id", fresh.id);
            ev.put("delivered_up_to", s.deliveredUpTo());
            ev.put("read_up_to", s.readUpTo());
            registry.sendToUser(member, ev, null);
        }
        if ("read".equals(e.type())) {
            // Self-sync: read on the laptop → the phone clears its unread badge too.
            Map<String, Object> ev = new LinkedHashMap<>();
            ev.put("type", "read_sync");
            ev.put("chat_id", fresh.id);
            ev.put("up_to_seq", e.upToSeq());
            registry.sendToUser(e.device().userId(), ev, e.device().deviceId());
        }
    }

    @Async("busExecutor")
    @EventListener
    public void onChatUpdated(Events.ChatUpdated e) {
        Map<String, Object> ev = Map.of("type", "chat_updated", "chat_id", e.chatId());
        for (String member : e.members()) registry.sendToUser(member, ev, null);
    }
}
