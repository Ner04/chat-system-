package com.relay.chat.model;

import org.springframework.data.mongodb.core.mapping.Field;

/** The per-message AES key, encrypted ("wrapped") for one device. */
public class WrappedKey {
    @Field("device_id") public String deviceId;
    @Field("wrapped_key") public String wrappedKey;
    public String iv;

    public WrappedKey() {}

    public WrappedKey(String deviceId, String wrappedKey, String iv) {
        this.deviceId = deviceId;
        this.wrappedKey = wrappedKey;
        this.iv = iv;
    }
}
