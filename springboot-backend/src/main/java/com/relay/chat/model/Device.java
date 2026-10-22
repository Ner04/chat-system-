package com.relay.chat.model;

import org.springframework.data.mongodb.core.mapping.Document;
import org.springframework.data.mongodb.core.mapping.Field;
import org.springframework.data.mongodb.core.mapping.FieldType;
import org.springframework.data.mongodb.core.mapping.MongoId;

import java.time.Instant;

/** The unit of delivery: each device has its own key, queue cursor and socket. */
@Document("devices")
public class Device {
    @MongoId(FieldType.STRING) public String id;
    @Field("user_id") public String userId;
    public String name;
    @Field("public_key") public PublicKeyJwk publicKey;
    @Field("created_at") public Instant createdAt;
    @Field("last_seen") public Instant lastSeen;
}
