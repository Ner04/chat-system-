package com.relay.chat.model;

import org.springframework.data.mongodb.core.mapping.Document;
import org.springframework.data.mongodb.core.mapping.Field;
import org.springframework.data.mongodb.core.mapping.FieldType;
import org.springframework.data.mongodb.core.mapping.MongoId;

import java.time.Instant;

/** Account. Shard key in production: _id (user_id). */
@Document("users")
public class User {
    @MongoId(FieldType.STRING) public String id;
    public String phone;
    public String name;
    @Field("created_at") public Instant createdAt;
}
