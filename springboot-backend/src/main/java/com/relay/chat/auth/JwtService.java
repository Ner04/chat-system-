package com.relay.chat.auth;

import com.relay.chat.config.AppProperties;
import io.jsonwebtoken.Claims;
import io.jsonwebtoken.JwtException;
import io.jsonwebtoken.Jwts;
import io.jsonwebtoken.security.Keys;
import org.springframework.stereotype.Service;

import javax.crypto.SecretKey;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.time.Duration;
import java.time.Instant;
import java.util.Date;

@Service
public class JwtService {
    private static final Duration TTL = Duration.ofDays(30);
    private final SecretKey key;

    public JwtService(AppProperties props) {
        try {
            // Hash the configured secret so any length gives a valid 256-bit HMAC key.
            byte[] digest = MessageDigest.getInstance("SHA-256").digest(props.jwtSecret().getBytes(StandardCharsets.UTF_8));
            this.key = Keys.hmacShaKeyFor(digest);
        } catch (NoSuchAlgorithmException e) {
            throw new IllegalStateException(e);
        }
    }

    public String issue(String userId, String deviceId) {
        Instant now = Instant.now();
        return Jwts.builder()
                .subject(userId)
                .claim("dev", deviceId)
                .issuedAt(Date.from(now))
                .expiration(Date.from(now.plus(TTL)))
                .signWith(key)
                .compact();
    }

    /** Returns null for a missing, expired or forged token. */
    public AuthContext verify(String token) {
        if (token == null || token.isBlank()) return null;
        try {
            Claims c = Jwts.parser().verifyWith(key).build().parseSignedClaims(token).getPayload();
            String dev = c.get("dev", String.class);
            return c.getSubject() == null || dev == null ? null : new AuthContext(c.getSubject(), dev);
        } catch (JwtException | IllegalArgumentException e) {
            return null;
        }
    }
}
