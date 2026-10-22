package com.relay.chat.chats;

import com.relay.chat.auth.AuthContext;
import com.relay.chat.model.Chat;
import com.relay.chat.model.Views.ChatView;
import com.relay.chat.model.Views.DeviceView;
import com.relay.chat.model.Views.MessageView;
import com.relay.chat.pipeline.MessagePipeline;
import com.relay.chat.users.UserService;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestAttribute;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import java.util.List;
import java.util.Map;

@RestController
public class ChatController {
    private final ChatService chats;
    private final UserService users;
    private final MessagePipeline pipeline;

    public ChatController(ChatService chats, UserService users, MessagePipeline pipeline) {
        this.chats = chats;
        this.users = users;
        this.pipeline = pipeline;
    }

    public record PhoneRequest(String phone) {}

    // --- Chats ----------------------------------------------------------------
    @GetMapping("/v1/chats")
    public List<ChatView> list(@RequestAttribute(AuthContext.ATTRIBUTE) AuthContext auth) {
        return chats.listChats(auth.userId(), auth.deviceId());
    }

    @PostMapping("/v1/chats/direct")
    public ChatView direct(@RequestAttribute(AuthContext.ATTRIBUTE) AuthContext auth, @RequestBody PhoneRequest body) {
        return chats.openDirect(auth.userId(), body == null ? null : body.phone());
    }

    @GetMapping("/v1/chats/{id}/devices")
    public List<DeviceView> devices(@RequestAttribute(AuthContext.ATTRIBUTE) AuthContext auth, @PathVariable("id") String id) {
        Chat chat = chats.getForMember(id, auth.userId());
        return users.devicesFor(chat.members);
    }

    /** History / sync for THIS device: ?before=seq or ?after=seq, &limit (max 200). */
    @GetMapping("/v1/chats/{id}/messages")
    public List<MessageView> messages(@RequestAttribute(AuthContext.ATTRIBUTE) AuthContext auth, @PathVariable("id") String id,
                                      @RequestParam(name = "before", required = false) Long before,
                                      @RequestParam(name = "after", required = false) Long after,
                                      @RequestParam(name = "limit", required = false, defaultValue = "50") int limit) {
        chats.getForMember(id, auth.userId());
        return pipeline.messagesForDevice(auth.deviceId(), id, after, before, limit);
    }

    // --- Groups ---------------------------------------------------------------
    @PostMapping("/v1/groups")
    public ChatView createGroup(@RequestAttribute(AuthContext.ATTRIBUTE) AuthContext auth, @RequestBody ChatService.GroupRequest body) {
        return chats.createGroup(auth.userId(), body);
    }

    @GetMapping("/v1/groups/{id}")
    public ChatView group(@RequestAttribute(AuthContext.ATTRIBUTE) AuthContext auth, @PathVariable("id") String id) {
        return chats.describe(chats.getForMember(id, auth.userId()), auth.userId(), null);
    }

    @PostMapping("/v1/groups/{id}/members")
    public ChatView addMember(@RequestAttribute(AuthContext.ATTRIBUTE) AuthContext auth, @PathVariable("id") String id,
                              @RequestBody PhoneRequest body) {
        return chats.addMember(auth.userId(), id, body == null ? null : body.phone());
    }

    @DeleteMapping("/v1/groups/{id}/members/{userId}")
    public Map<String, Object> removeMember(@RequestAttribute(AuthContext.ATTRIBUTE) AuthContext auth, @PathVariable("id") String id,
                                            @PathVariable("userId") String userId) {
        return chats.removeMember(auth.userId(), id, userId);
    }
}
