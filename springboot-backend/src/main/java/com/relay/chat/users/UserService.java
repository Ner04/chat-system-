package com.relay.chat.users;

import com.relay.chat.common.ApiException;
import com.relay.chat.common.Ids;
import com.relay.chat.model.Device;
import com.relay.chat.model.User;
import com.relay.chat.model.Views.DeviceView;
import com.relay.chat.model.Views.UserView;
import org.springframework.data.mongodb.core.MongoTemplate;
import org.springframework.data.mongodb.core.query.Query;
import org.springframework.data.mongodb.core.query.Update;
import org.springframework.stereotype.Service;

import java.time.Instant;
import java.util.Collection;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

import static org.springframework.data.mongodb.core.query.Criteria.where;

/** User service: accounts, devices and their public keys. */
@Service
public class UserService {
    private final MongoTemplate mongo;

    public UserService(MongoTemplate mongo) {
        this.mongo = mongo;
    }

    public User get(String userId) {
        return mongo.findById(userId, User.class);
    }

    public UserView updateName(String userId, String name) {
        String clean = name == null ? "" : name.trim();
        if (clean.isEmpty()) throw ApiException.badRequest("invalid_name", "Enter a name");
        if (clean.length() > 40) clean = clean.substring(0, 40);
        mongo.updateFirst(Query.query(where("id").is(userId)), new Update().set("name", clean), User.class);
        return UserView.of(get(userId));
    }

    public User findByPhone(String rawPhone) {
        String phone = Ids.normalizePhone(rawPhone);
        if (phone == null) throw ApiException.badRequest("invalid_phone", "Enter a valid phone number");
        User u = mongo.findOne(Query.query(where("phone").is(phone)), User.class);
        if (u == null) throw ApiException.notFound("user_not_found", phone + " hasn't joined yet. Ask them to sign in once first.");
        return u;
    }

    /** Users by id, in the same order as {@code ids}. */
    public List<UserView> usersByIds(List<String> ids) {
        Map<String, User> byId = new HashMap<>();
        for (User u : mongo.find(Query.query(where("id").in(ids)), User.class)) byId.put(u.id, u);
        return ids.stream().map(byId::get).filter(u -> u != null).map(UserView::of).toList();
    }

    /**
     * Every device of the given users, with public keys: what a sender needs to wrap the
     * message key once per device ("cost = members × devices").
     */
    public List<DeviceView> devicesFor(Collection<String> userIds) {
        return mongo.find(Query.query(where("userId").in(userIds)), Device.class).stream().map(DeviceView::of).toList();
    }

    public DeviceView device(String deviceId) {
        Device d = mongo.findById(deviceId, Device.class);
        if (d == null) throw ApiException.notFound("device_not_found", "Device not found");
        return DeviceView.of(d);
    }

    public void touchDevice(String deviceId) {
        mongo.updateFirst(Query.query(where("id").is(deviceId)), new Update().set("lastSeen", Ids.now()), Device.class);
    }
}
