package com.relay.chat.pipeline;

import com.relay.chat.auth.AuthContext;
import com.relay.chat.common.Ids;
import com.relay.chat.config.AppProperties;
import com.relay.chat.model.Chat;
import com.relay.chat.model.Message;
import com.relay.chat.model.Receipt;
import com.relay.chat.model.Views.DeviceView;
import com.relay.chat.model.Views.MessageView;
import com.relay.chat.model.WrappedKey;
import com.relay.chat.users.UserService;
import org.springframework.dao.DuplicateKeyException;
import org.springframework.data.domain.Sort;
import org.springframework.data.mongodb.core.FindAndModifyOptions;
import org.springframework.data.mongodb.core.MongoTemplate;
import org.springframework.data.mongodb.core.query.Criteria;
import org.springframework.data.mongodb.core.query.Query;
import org.springframework.data.mongodb.core.query.Update;
import org.springframework.stereotype.Service;

import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Set;
import java.util.regex.Pattern;

import static org.springframework.data.mongodb.core.query.Criteria.where;

/**
 * Message pipeline / storage service.
 *
 * <pre>
 *   socket → validate → membership check → dedup → assign seq
 *          → DURABLE WRITE (w: majority) → ✓ ack → bus MessageStored → async fan-out
 * </pre>
 *
 * Persist first, then deliver: once acked, a message survives even if every chat server dies.
 * The server only ever sees ciphertext and per-device wrapped keys; it cannot read content.
 */
@Service
public class MessagePipeline {
    private static final Pattern MESSAGE_ID = Pattern.compile("^[\\w-]{8,64}$");
    private static final Pattern B64 = Pattern.compile("^[A-Za-z0-9+/=_-]+$");

    private final MongoTemplate mongo;
    private final UserService users;
    private final MessageBus bus;
    private final AppProperties props;

    public MessagePipeline(MongoTemplate mongo, UserService users, MessageBus bus, AppProperties props) {
        this.mongo = mongo;
        this.users = users;
        this.bus = bus;
        this.props = props;
    }

    // ---- Frames from the client ---------------------------------------------------------
    public record KeyIn(String deviceId, String wrappedKey, String iv) {}

    public record PayloadIn(String ciphertext, String iv, List<KeyIn> keys) {}

    public record SendFrame(String messageId, String chatId, PayloadIn payload, Long clientTs) {}

    public record Accepted(String chatId, long seq, boolean duplicate) {}

    private void validate(SendFrame f) {
        if (f.messageId() == null || !MESSAGE_ID.matcher(f.messageId()).matches()) throw new PipelineException("invalid_message_id");
        if (f.chatId() == null) throw new PipelineException("invalid_chat_id");
        PayloadIn p = f.payload();
        if (p == null || p.ciphertext() == null || p.iv() == null) throw new PipelineException("invalid_payload");
        if (!B64.matcher(p.ciphertext()).matches() || !B64.matcher(p.iv()).matches()) {
            throw new PipelineException("invalid_payload", "payload must be base64");
        }
        if (p.ciphertext().length() > props.maxCiphertextChars()) throw new PipelineException("too_large", "Message is too large");
        if (p.keys() == null || p.keys().isEmpty()) throw new PipelineException("invalid_keys");
        for (KeyIn k : p.keys()) {
            if (k == null || k.deviceId() == null || k.wrappedKey() == null || k.iv() == null) throw new PipelineException("invalid_keys");
        }
    }

    /** Accept one message from a sender device. */
    public Accepted accept(AuthContext sender, SendFrame f) {
        validate(f);

        // 1. Membership check before anything is stored ("reject bad traffic as early as possible").
        Chat chat = mongo.findById(f.chatId(), Chat.class);
        if (chat == null || !chat.members.contains(sender.userId())) {
            throw new PipelineException("not_a_member", "You are not in this chat");
        }

        // 2. Idempotency: at-least-once delivery means clients retry; dedup by message_id.
        Message existing = mongo.findById(f.messageId(), Message.class);
        if (existing != null) {
            if (!Objects.equals(existing.senderDeviceId, sender.deviceId())) throw new PipelineException("invalid_message_id");
            return new Accepted(existing.chatId, existing.seq, true);
        }

        // 3. Every current device of every member must have a wrapped key, otherwise some
        //    device could never decrypt the message. Tell the client to refresh and re-encrypt.
        Set<String> target = new LinkedHashSet<>();
        for (DeviceView d : users.devicesFor(chat.members)) target.add(d.deviceId());
        target.remove(sender.deviceId()); // the sending device already has the plaintext
        Map<String, KeyIn> provided = new LinkedHashMap<>();
        for (KeyIn k : f.payload().keys()) provided.put(k.deviceId(), k);
        List<String> missing = target.stream().filter(id -> !provided.containsKey(id)).toList();
        if (!missing.isEmpty()) {
            throw new PipelineException("devices_changed", "Recipient devices changed; re-encrypt and resend", missing);
        }
        List<WrappedKey> keys = new ArrayList<>();
        for (String id : target) keys.add(new WrappedKey(id, provided.get(id).wrappedKey(), provided.get(id).iv()));
        // Keep a copy for the sending device too, so its own history can be re-fetched.
        KeyIn own = provided.get(sender.deviceId());
        if (own != null) keys.add(new WrappedKey(sender.deviceId(), own.wrappedKey(), own.iv()));

        // 4. Per-conversation sequence number (no global counter, no global bottleneck).
        Instant now = Ids.now();
        Chat updated = mongo.findAndModify(Query.query(where("id").is(chat.id)),
                new Update().inc("lastSeq", 1).set("lastMessageAt", now),
                FindAndModifyOptions.options().returnNew(true), Chat.class);
        long seq = updated.lastSeq;

        // 5. Durable write. Only ciphertext lands in MongoDB.
        Message m = new Message();
        m.id = f.messageId();
        m.chatId = chat.id;
        m.seq = seq;
        m.senderUserId = sender.userId();
        m.senderDeviceId = sender.deviceId();
        m.ciphertext = f.payload().ciphertext();
        m.iv = f.payload().iv();
        m.keys = keys;
        m.clientTs = f.clientTs() == null ? null : Instant.ofEpochMilli(f.clientTs());
        m.createdAt = now;
        m.expiresAt = now.plus(Duration.ofDays(props.messageRetentionDays()));
        try {
            mongo.insert(m);
        } catch (DuplicateKeyException e) {
            Message again = mongo.findById(f.messageId(), Message.class);
            if (again != null) return new Accepted(again.chatId, again.seq, true);
            throw e;
        }

        // The sender has implicitly delivered and read everything up to its own message.
        mongo.upsert(Query.query(where("chatId").is(chat.id).and("deviceId").is(sender.deviceId())),
                new Update().max("deliveredSeq", seq).max("readSeq", seq).set("userId", sender.userId()),
                Receipt.class);

        // 6. Hand off to fan-out asynchronously.
        bus.publish(new Events.MessageStored(m));
        return new Accepted(chat.id, seq, false);
    }

    /** History / offline sync for one device: only messages that carry a key for it. */
    public List<MessageView> messagesForDevice(String deviceId, String chatId, Long afterSeq, Long beforeSeq, int limit) {
        Criteria c = where("chatId").is(chatId).and("keys.deviceId").is(deviceId);
        if (afterSeq != null && beforeSeq != null) c = c.and("seq").gt(afterSeq).lt(beforeSeq);
        else if (afterSeq != null) c = c.and("seq").gt(afterSeq);
        else if (beforeSeq != null) c = c.and("seq").lt(beforeSeq);
        Sort sort = afterSeq != null ? Sort.by(Sort.Direction.ASC, "seq") : Sort.by(Sort.Direction.DESC, "seq");
        int n = Math.max(1, Math.min(limit, 500));
        List<Message> docs = new ArrayList<>(mongo.find(Query.query(c).with(sort).limit(n), Message.class));
        docs.sort(Comparator.comparingLong(d -> d.seq));
        return docs.stream().map(d -> MessageView.forDevice(d, deviceId)).filter(Objects::nonNull).toList();
    }

    /** Record a delivered/read high-water mark for one device. Returns false if nothing moved. */
    public boolean recordReceipt(AuthContext device, String chatId, String type, Long upToSeq) {
        if (!"delivered".equals(type) && !"read".equals(type)) throw new PipelineException("invalid_receipt");
        if (upToSeq == null || upToSeq < 1) throw new PipelineException("invalid_receipt");
        Chat chat = chatId == null ? null : mongo.findById(chatId, Chat.class);
        if (chat == null || !chat.members.contains(device.userId())) throw new PipelineException("not_a_member");
        long upTo = Math.min(upToSeq, chat.lastSeq);
        if (upTo < 1) return false;

        Update update = new Update().max("deliveredSeq", upTo).set("userId", device.userId());
        if ("read".equals(type)) update.max("readSeq", upTo);
        else update.setOnInsert("readSeq", 0L);
        Receipt before = mongo.findAndModify(
                Query.query(where("chatId").is(chatId).and("deviceId").is(device.deviceId())), update,
                FindAndModifyOptions.options().upsert(true).returnNew(false), Receipt.class);
        boolean moved = before == null || before.deliveredSeq < upTo || ("read".equals(type) && before.readSeq < upTo);
        if (!moved) return false;
        bus.publish(new Events.ReceiptRecorded(chat, device, type, upTo));
        return true;
    }
}
