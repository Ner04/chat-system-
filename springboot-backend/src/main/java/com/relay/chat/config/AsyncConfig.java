package com.relay.chat.config;

import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.scheduling.concurrent.ThreadPoolTaskExecutor;

/**
 * The message bus executor. In the HLD this is Kafka between the storage service and the
 * chat servers. Here events are handed to a single worker thread, so fan-out happens after
 * the sender is acked, and in the order messages were stored.
 */
@Configuration
public class AsyncConfig {
    @Bean(name = "busExecutor")
    public ThreadPoolTaskExecutor busExecutor() {
        ThreadPoolTaskExecutor ex = new ThreadPoolTaskExecutor();
        ex.setCorePoolSize(1);
        ex.setMaxPoolSize(1);
        ex.setThreadNamePrefix("bus-");
        ex.initialize();
        return ex;
    }
}
