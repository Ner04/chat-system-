package com.relay.chat.model;

import java.time.Instant;
import java.util.List;

/** API response shapes. Jackson's SNAKE_CASE naming turns userId into user_id, etc. */
public final class Views {
    private Views() {}

    public record UserView(String userId, String phone, String name) {
        public static UserView of(User u) {
            return new UserView(u.id, u.phone, u.name != null ? u.name : u.phone);
        }
    }

    public record DeviceView(String deviceId, String userId, String name, PublicKeyJwk publicKey) {
        public static DeviceView of(Device d) {
            return new DeviceView(d.id, d.userId, d.name, d.publicKey);
        }
    }

    public record ChatView(String chatId, String type, String name, List<UserView> members, List<String> admins,
                           long lastSeq, Instant lastMessageAt, long deliveredUpTo, long readUpTo,
                           Long myReadSeq, Long myDeliveredSeq, Long unread) {
    }

    public record KeyView(String wrappedKey, String iv) {}

    public record PayloadView(String ciphertext, String iv, KeyView key) {}

    /** A message shaped for ONE device: only that device's wrapped key is included. */
    public record MessageView(String messageId, String chatId, long seq, String senderUserId, String senderDeviceId,
                              Instant createdAt, PayloadView payload) {
        public static MessageView forDevice(Message m, String deviceId) {
            for (WrappedKey k : m.keys) {
                if (deviceId.equals(k.deviceId)) {
                    return new MessageView(m.id, m.chatId, m.seq, m.senderUserId, m.senderDeviceId, m.createdAt,
                            new PayloadView(m.ciphertext, m.iv, new KeyView(k.wrappedKey, k.iv)));
                }
            }
            return null;
        }
    }
}
