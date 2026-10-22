package com.relay.chat.model;

import org.springframework.data.mongodb.core.mapping.Document;
import org.springframework.data.mongodb.core.mapping.Field;
import org.springframework.data.mongodb.core.mapping.FieldType;
import org.springframework.data.mongodb.core.mapping.MongoId;

import java.time.Instant;
import java.util.ArrayList;
import java.util.List;

/**
 * A stored message. The server only holds ciphertext: the body is AES-256-GCM encrypted by
 * the sender, and the message key is wrapped once per recipient device in {@link #keys}.
 * _id is the client-generated message_id, which makes retries idempotent.
 */
@Document("messages")
public class Message {
    @MongoId(FieldType.STRING) public String id;
    @Field("chat_id") public String chatId;
    public long seq;
    @Field("sender_user_id") public String senderUserId;
    @Field("sender_device_id") public String senderDeviceId;
    public String ciphertext;
    public String iv;
    public List<WrappedKey> keys = new ArrayList<>();
    @Field("client_ts") public Instant clientTs;
    @Field("created_at") public Instant createdAt;
    @Field("expires_at") public Instant expiresAt;
}
