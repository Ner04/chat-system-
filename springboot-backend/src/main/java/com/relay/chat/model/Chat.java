package com.relay.chat.model;

import org.springframework.data.mongodb.core.mapping.Document;
import org.springframework.data.mongodb.core.mapping.Field;
import org.springframework.data.mongodb.core.mapping.FieldType;
import org.springframework.data.mongodb.core.mapping.MongoId;

import java.time.Instant;
import java.util.ArrayList;
import java.util.List;

/** A direct chat or a group. last_seq is the per-conversation sequence counter. */
@Document("chats")
public class Chat {
    public static final String DIRECT = "direct";
    public static final String GROUP = "group";

    @MongoId(FieldType.STRING) public String id;
    public String type;
    public String name;
    @Field("direct_key") public String directKey;
    public List<String> members = new ArrayList<>();
    public List<String> admins = new ArrayList<>();
    @Field("created_by") public String createdBy;
    @Field("last_seq") public long lastSeq;
    @Field("created_at") public Instant createdAt;
    @Field("last_message_at") public Instant lastMessageAt;
}
