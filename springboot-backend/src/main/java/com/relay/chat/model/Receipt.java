package com.relay.chat.model;

import org.springframework.data.annotation.Id;
import org.springframework.data.mongodb.core.mapping.Document;
import org.springframework.data.mongodb.core.mapping.Field;

/** High-water marks for one device in one chat: "delivered up to seq N", "read up to seq M". */
@Document("receipts")
public class Receipt {
    @Id public String id;
    @Field("chat_id") public String chatId;
    @Field("device_id") public String deviceId;
    @Field("user_id") public String userId;
    @Field("delivered_seq") public long deliveredSeq;
    @Field("read_seq") public long readSeq;
}
