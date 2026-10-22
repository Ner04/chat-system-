package com.relay.chat;

import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.boot.context.properties.ConfigurationPropertiesScan;
import org.springframework.scheduling.annotation.EnableAsync;
import org.springframework.scheduling.annotation.EnableScheduling;

/**
 * Relay chat backend.
 *
 * gateway (auth + REST)  →  chat server (WebSocket, stateless router)
 *   →  message pipeline (validate → membership → dedup → seq → durable write → ack)
 *   →  bus (async fan-out)  →  connection registry  →  recipient devices / push
 */
@SpringBootApplication
@ConfigurationPropertiesScan
@EnableAsync
@EnableScheduling
public class ChatApplication {
    public static void main(String[] args) {
        SpringApplication.run(ChatApplication.class, args);
    }
}
