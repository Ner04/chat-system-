package com.relay.chat.auth;

import com.relay.chat.common.ApiException;
import jakarta.servlet.http.HttpServletRequest;
import org.springframework.http.HttpStatus;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import java.util.ArrayDeque;
import java.util.Deque;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

@RestController
@RequestMapping("/v1/auth")
public class AuthController {
    private final AuthService auth;
    /** Tiny in-memory rate limit for OTP requests: 5 per (ip, phone) per 10 minutes. */
    private final Map<String, Deque<Long>> otpHits = new ConcurrentHashMap<>();

    public AuthController(AuthService auth) {
        this.auth = auth;
    }

    public record RegisterRequest(String phone) {}

    @PostMapping("/register")
    public Map<String, Object> register(@RequestBody RegisterRequest body, HttpServletRequest req) {
        String key = req.getRemoteAddr() + ":" + (body == null ? null : body.phone());
        long now = System.currentTimeMillis();
        Deque<Long> hits = otpHits.computeIfAbsent(key, k -> new ArrayDeque<>());
        synchronized (hits) {
            while (!hits.isEmpty() && now - hits.peekFirst() > 10 * 60_000) hits.pollFirst();
            if (hits.size() >= 5) {
                throw new ApiException(HttpStatus.TOO_MANY_REQUESTS, "rate_limited", "Too many codes requested. Wait a few minutes.");
            }
            hits.addLast(now);
        }
        return auth.requestOtp(body == null ? null : body.phone());
    }

    @PostMapping("/verify")
    public AuthService.VerifyResponse verify(@RequestBody AuthService.VerifyRequest body) {
        return auth.verifyOtp(body);
    }
}
