package com.relay.chat.model;

import org.springframework.data.mongodb.core.mapping.Document;
import org.springframework.data.mongodb.core.mapping.Field;
import org.springframework.data.mongodb.core.mapping.FieldType;
import org.springframework.data.mongodb.core.mapping.MongoId;

import java.time.Instant;

/** One pending code per phone (_id = phone). Removed by a TTL index on expires_at. */
@Document("otps")
public class Otp {
    @MongoId(FieldType.STRING) public String id;
    @Field("code_hash") public String codeHash;
    public int attempts;
    @Field("expires_at") public Instant expiresAt;
}
