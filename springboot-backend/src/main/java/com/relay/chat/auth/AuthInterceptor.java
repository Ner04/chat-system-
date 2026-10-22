package com.relay.chat.auth;

import com.relay.chat.common.ApiException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import org.springframework.stereotype.Component;
import org.springframework.web.servlet.HandlerInterceptor;

/** Requires {@code Authorization: Bearer <token>} on every /v1 route except /v1/auth/**. */
@Component
public class AuthInterceptor implements HandlerInterceptor {
    private final AuthService auth;

    public AuthInterceptor(AuthService auth) {
        this.auth = auth;
    }

    @Override
    public boolean preHandle(HttpServletRequest req, HttpServletResponse res, Object handler) {
        if ("OPTIONS".equalsIgnoreCase(req.getMethod())) return true;
        String header = req.getHeader("Authorization");
        String token = header != null && header.startsWith("Bearer ") ? header.substring(7) : null;
        AuthContext ctx = auth.authenticate(token);
        if (ctx == null) throw ApiException.unauthorized("unauthorized", "Sign in again");
        req.setAttribute(AuthContext.ATTRIBUTE, ctx);
        return true;
    }
}
