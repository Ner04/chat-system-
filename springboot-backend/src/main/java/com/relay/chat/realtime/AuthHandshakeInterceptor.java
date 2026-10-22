package com.relay.chat.realtime;

import com.relay.chat.auth.AuthContext;
import com.relay.chat.auth.AuthService;
import org.springframework.http.HttpStatus;
import org.springframework.http.server.ServerHttpRequest;
import org.springframework.http.server.ServerHttpResponse;
import org.springframework.stereotype.Component;
import org.springframework.web.socket.WebSocketHandler;
import org.springframework.web.socket.server.HandshakeInterceptor;
import org.springframework.web.util.UriComponentsBuilder;

import java.net.URLDecoder;
import java.nio.charset.StandardCharsets;
import java.util.Map;

/** Authenticates {@code WS /v1/connect?token=…} before the upgrade; rejects with 401 otherwise. */
@Component
public class AuthHandshakeInterceptor implements HandshakeInterceptor {
    private final AuthService auth;

    public AuthHandshakeInterceptor(AuthService auth) {
        this.auth = auth;
    }

    @Override
    public boolean beforeHandshake(ServerHttpRequest request, ServerHttpResponse response, WebSocketHandler handler,
                                   Map<String, Object> attributes) {
        String raw = UriComponentsBuilder.fromUri(request.getURI()).build().getQueryParams().getFirst("token");
        String token = raw == null ? null : URLDecoder.decode(raw, StandardCharsets.UTF_8);
        AuthContext ctx = auth.authenticate(token);
        if (ctx == null) {
            response.setStatusCode(HttpStatus.UNAUTHORIZED);
            return false;
        }
        attributes.put(AuthContext.ATTRIBUTE, ctx);
        return true;
    }

    @Override
    public void afterHandshake(ServerHttpRequest request, ServerHttpResponse response, WebSocketHandler handler, Exception ex) {
    }
}
