package com.relay.chat.config;

import org.springframework.boot.context.properties.ConfigurationProperties;

/** All tunables live under {@code relay.*} in application.yml. */
@ConfigurationProperties(prefix = "relay")
public record AppProperties(
        String jwtSecret,
        String mediaSecret,
        boolean devOtp,
        int otpTtlSeconds,
        int messageRetentionDays,
        int maxDevicesPerUser,
        int maxGroupSize,
        int maxCiphertextChars,
        long maxMediaBytes,
        long heartbeatMs,
        String blobDir,
        String allowedOrigins) {
}
