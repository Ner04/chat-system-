package com.relay.chat.model;

/** Public half of a device's ECDH P-256 key, as a JWK. The private key never leaves the device. */
public record PublicKeyJwk(String kty, String crv, String x, String y) {
}
