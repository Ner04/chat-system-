package com.relay.chat.chats;

import com.relay.chat.common.ApiException;
import com.relay.chat.common.Ids;
import com.relay.chat.config.AppProperties;
import com.relay.chat.model.Chat;
import com.relay.chat.model.Message;
import com.relay.chat.model.Receipt;
import com.relay.chat.model.User;
import com.relay.chat.model.Views.ChatView;
import com.relay.chat.model.Views.UserView;
import com.relay.chat.pipeline.Events;
import com.relay.chat.pipeline.MessageBus;
import com.relay.chat.users.UserService;
import org.springframework.data.domain.Sort;
import org.springframework.data.mongodb.core.MongoTemplate;
import org.springframework.data.mongodb.core.query.Query;
import org.springframework.data.mongodb.core.query.Update;
import org.springframework.stereotype.Service;

import java.time.Instant;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.function.Function;

import static org.springframework.data.mongodb.core.query.Criteria.where;

/** Chat + group service: membership, admins, receipt aggregation. */
@Service
public class ChatService {
    private final MongoTemplate mongo;
    private final UserService users;
    private final MessageBus bus;
    private final AppProperties props;

    public ChatService(MongoTemplate mongo, UserService users, MessageBus bus, AppProperties props) {
        this.mongo = mongo;
        this.users = users;
        this.bus = bus;
        this.props = props;
    }

    public record Summary(long deliveredUpTo, long readUpTo) {}

    public Chat getForMember(String chatId, String userId) {
        Chat chat = mongo.findById(chatId, Chat.class);
        if (chat == null || !chat.members.contains(userId)) throw ApiException.notFound("chat_not_found", "Chat not found");
        return chat;
    }

    public ChatView openDirect(String userId, String phone) {
        User other = users.findByPhone(phone);
        if (other.id.equals(userId)) throw ApiException.badRequest("self_chat", "You can't start a chat with yourself");
        List<String> pair = new ArrayList<>(List.of(userId, other.id));
        pair.sort(null);
        String directKey = String.join("|", pair);
        Instant now = Ids.now();
        mongo.upsert(Query.query(where("type").is(Chat.DIRECT).and("directKey").is(directKey)),
                new Update().setOnInsert("id", Ids.newId("cht")).setOnInsert("members", pair)
                        .setOnInsert("admins", List.of()).setOnInsert("lastSeq", 0L)
                        .setOnInsert("createdAt", now).setOnInsert("lastMessageAt", now),
                Chat.class);
        Chat chat = mongo.findOne(Query.query(where("type").is(Chat.DIRECT).and("directKey").is(directKey)), Chat.class);
        bus.publish(new Events.ChatUpdated(chat.id, chat.members));
        return describe(chat, userId, null);
    }

    public record GroupRequest(String name, List<String> members) {}

    public ChatView createGroup(String userId, GroupRequest req) {
        String title = req == null || req.name() == null ? "" : req.name().trim();
        if (title.isEmpty()) throw ApiException.badRequest("invalid_name", "Give the group a name");
        if (title.length() > 60) title = title.substring(0, 60);
        Set<String> ids = new LinkedHashSet<>();
        ids.add(userId);
        if (req.members() != null) for (String phone : req.members()) ids.add(users.findByPhone(phone).id);
        if (ids.size() > props.maxGroupSize()) {
            throw ApiException.badRequest("group_too_large", "Groups are capped at " + props.maxGroupSize() + " members");
        }
        Instant now = Ids.now();
        Chat chat = new Chat();
        chat.id = Ids.newId("grp");
        chat.type = Chat.GROUP;
        chat.name = title;
        chat.members = new ArrayList<>(ids);
        chat.admins = new ArrayList<>(List.of(userId));
        chat.createdBy = userId;
        chat.lastSeq = 0;
        chat.createdAt = now;
        chat.lastMessageAt = now;
        mongo.insert(chat);
        bus.publish(new Events.ChatUpdated(chat.id, chat.members));
        return describe(chat, userId, null);
    }

    public ChatView addMember(String userId, String groupId, String phone) {
        Chat chat = getForMember(groupId, userId);
        if (!Chat.GROUP.equals(chat.type)) throw ApiException.badRequest("not_group", "This is not a group");
        if (!chat.admins.contains(userId)) throw ApiException.forbidden("not_admin", "Only group admins can add people");
        User u = users.findByPhone(phone);
        if (chat.members.size() >= props.maxGroupSize()) throw ApiException.badRequest("group_too_large", "This group is full");
        mongo.updateFirst(Query.query(where("id").is(groupId)), new Update().addToSet("members", u.id), Chat.class);
        Chat updated = mongo.findById(groupId, Chat.class);
        bus.publish(new Events.ChatUpdated(groupId, updated.members));
        return describe(updated, userId, null);
    }

    public Map<String, Object> removeMember(String userId, String groupId, String targetId) {
        Chat chat = getForMember(groupId, userId);
        if (!Chat.GROUP.equals(chat.type)) throw ApiException.badRequest("not_group", "This is not a group");
        if (!targetId.equals(userId) && !chat.admins.contains(userId)) {
            throw ApiException.forbidden("not_admin", "Only group admins can remove people");
        }
        mongo.updateFirst(Query.query(where("id").is(groupId)),
                new Update().pull("members", targetId).pull("admins", targetId), Chat.class);
        Chat updated = mongo.findById(groupId, Chat.class);
        // A group with members but no admin promotes the oldest remaining member.
        if (!updated.members.isEmpty() && updated.admins.isEmpty()) {
            mongo.updateFirst(Query.query(where("id").is(groupId)),
                    new Update().set("admins", List.of(updated.members.get(0))), Chat.class);
        }
        // Removed member's devices stop receiving keys for new messages immediately, because
        // senders only encrypt for current members' devices ("rotate on leave").
        List<String> notify = new ArrayList<>(updated.members);
        notify.add(targetId);
        bus.publish(new Events.ChatUpdated(groupId, notify));
        return Map.of("ok", true);
    }

    /**
     * Aggregates receipts into the two numbers a viewer needs. Per member: MAX over their devices
     * (first device ack wins). Then MIN over every other member (group ✓✓ means EVERYONE got it).
     */
    public Function<String, Summary> receiptSummary(Chat chat) {
        Map<String, long[]> perUser = new HashMap<>();
        for (Receipt r : mongo.find(Query.query(where("chatId").is(chat.id)), Receipt.class)) {
            long[] cur = perUser.computeIfAbsent(r.userId, k -> new long[2]);
            cur[0] = Math.max(cur[0], r.deliveredSeq);
            cur[1] = Math.max(cur[1], r.readSeq);
        }
        return viewerId -> {
            long delivered = Long.MAX_VALUE;
            long read = Long.MAX_VALUE;
            boolean any = false;
            for (String m : chat.members) {
                if (m.equals(viewerId)) continue;
                any = true;
                long[] v = perUser.getOrDefault(m, new long[2]);
                delivered = Math.min(delivered, v[0]);
                read = Math.min(read, v[1]);
            }
            return any ? new Summary(delivered, read) : new Summary(0, 0);
        };
    }

    public ChatView describe(Chat chat, String viewerId, Receipt mine) {
        List<UserView> members = users.usersByIds(chat.members);
        Summary s = receiptSummary(chat).apply(viewerId);
        String name = Chat.GROUP.equals(chat.type) ? chat.name
                : members.stream().filter(m -> !m.userId().equals(viewerId)).map(UserView::name).findFirst().orElse("Chat");
        Long myRead = null;
        Long myDelivered = null;
        Long unread = null;
        if (mine != null) {
            myRead = mine.readSeq;
            myDelivered = mine.deliveredSeq;
            unread = chat.lastSeq > mine.readSeq
                    ? mongo.count(Query.query(where("chatId").is(chat.id).and("seq").gt(mine.readSeq)
                    .and("senderUserId").ne(viewerId)), Message.class)
                    : 0L;
        }
        return new ChatView(chat.id, chat.type, name, members, chat.admins == null ? List.of() : chat.admins,
                chat.lastSeq, chat.lastMessageAt, s.deliveredUpTo(), s.readUpTo(), myRead, myDelivered, unread);
    }

    public List<ChatView> listChats(String userId, String deviceId) {
        List<Chat> chats = mongo.find(Query.query(where("members").is(userId))
                .with(Sort.by(Sort.Direction.DESC, "lastMessageAt")).limit(200), Chat.class);
        Map<String, Receipt> cursor = new HashMap<>();
        for (Receipt r : mongo.find(Query.query(where("deviceId").is(deviceId)), Receipt.class)) cursor.put(r.chatId, r);
        List<ChatView> out = new ArrayList<>();
        for (Chat c : chats) {
            Receipt mine = cursor.get(c.id);
            if (mine == null) {
                mine = new Receipt();
                mine.chatId = c.id;
            }
            out.add(describe(c, userId, mine));
        }
        return out;
    }
}
