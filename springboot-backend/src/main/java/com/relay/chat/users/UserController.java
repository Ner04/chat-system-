package com.relay.chat.users;

import com.relay.chat.auth.AuthContext;
import com.relay.chat.model.Views.DeviceView;
import com.relay.chat.model.Views.UserView;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PatchMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestAttribute;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RestController;

import java.util.LinkedHashMap;
import java.util.Map;

@RestController
public class UserController {
    private final UserService users;

    public UserController(UserService users) {
        this.users = users;
    }

    public record NameRequest(String name) {}

    @GetMapping("/v1/users/me")
    public Map<String, Object> me(@RequestAttribute(AuthContext.ATTRIBUTE) AuthContext auth) {
        UserView u = UserView.of(users.get(auth.userId()));
        Map<String, Object> res = new LinkedHashMap<>();
        res.put("user_id", u.userId());
        res.put("phone", u.phone());
        res.put("name", u.name());
        res.put("device_id", auth.deviceId());
        return res;
    }

    @PatchMapping("/v1/users/me")
    public UserView rename(@RequestAttribute(AuthContext.ATTRIBUTE) AuthContext auth, @RequestBody NameRequest body) {
        return users.updateName(auth.userId(), body == null ? null : body.name());
    }

    @GetMapping("/v1/devices/{id}")
    public DeviceView device(@PathVariable("id") String id) {
        return users.device(id);
    }
}
