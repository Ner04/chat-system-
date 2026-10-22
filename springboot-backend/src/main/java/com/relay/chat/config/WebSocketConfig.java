package com.relay.chat.config;

import com.relay.chat.realtime.AuthHandshakeInterceptor;
import com.relay.chat.realtime.ChatWebSocketHandler;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.web.socket.config.annotation.EnableWebSocket;
import org.springframework.web.socket.config.annotation.WebSocketConfigurer;
import org.springframework.web.socket.config.annotation.WebSocketHandlerRegistry;
import org.springframework.web.socket.server.standard.ServletServerContainerFactoryBean;

@Configuration
@EnableWebSocket
public class WebSocketConfig implements WebSocketConfigurer {
    private final ChatWebSocketHandler handler;
    private final AuthHandshakeInterceptor authInterceptor;
    private final AppProperties props;

    public WebSocketConfig(ChatWebSocketHandler handler, AuthHandshakeInterceptor authInterceptor, AppProperties props) {
        this.handler = handler;
        this.authInterceptor = authInterceptor;
        this.props = props;
    }

    @Override
    public void registerWebSocketHandlers(WebSocketHandlerRegistry registry) {
        registry.addHandler(handler, "/v1/connect")
                .addInterceptors(authInterceptor)
                .setAllowedOriginPatterns(props.allowedOrigins().split(","));
    }

    @Bean
    public ServletServerContainerFactoryBean webSocketContainer() {
        ServletServerContainerFactoryBean c = new ServletServerContainerFactoryBean();
        c.setMaxTextMessageBufferSize(512 * 1024);
        c.setMaxSessionIdleTimeout(120_000L);
        return c;
    }
}
