package com.relay.chat.model;

import org.springframework.data.mongodb.core.mapping.Document;
import org.springframework.data.mongodb.core.mapping.Field;
import org.springframework.data.mongodb.core.mapping.FieldType;
import org.springframework.data.mongodb.core.mapping.MongoId;

import java.time.Instant;

/** Metadata for an encrypted blob in blob storage. The key is never here – it rides inside the message. */
@Document("media")
public class Media {
    @MongoId(FieldType.STRING) public String id;
    public String uploader;
    @Field("declared_size") public long declaredSize;
    public boolean uploaded;
    public long size;
    public String sha256;
    @Field("created_at") public Instant createdAt;
    @Field("expires_at") public Instant expiresAt;
}
