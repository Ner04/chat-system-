package com.relay.chat.pipeline;

import com.relay.chat.auth.AuthContext;
import com.relay.chat.model.Chat;
import com.relay.chat.model.Message;

import java.util.List;

/** Topics on the message bus. */
public final class Events {
    private Events() {}

    /** A message was durably stored and acked; fan it out to every target device. */
    public record MessageStored(Message message) {}

    /** A device moved its delivered/read high-water mark. */
    public record ReceiptRecorded(Chat chat, AuthContext device, String type, long upToSeq) {}

    /** Membership or metadata changed; members should refresh chats and device keys. */
    public record ChatUpdated(String chatId, List<String> members) {}
}
