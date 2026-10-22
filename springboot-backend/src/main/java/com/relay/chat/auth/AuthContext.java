package com.relay.chat.auth;

/** Who is calling: a user AND a specific device (the unit of delivery). */
public record AuthContext(String userId, String deviceId) {
    public static final String ATTRIBUTE = "auth";
}
