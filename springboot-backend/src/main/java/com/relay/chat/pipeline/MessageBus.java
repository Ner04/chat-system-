package com.relay.chat.pipeline;

import org.springframework.context.ApplicationEventPublisher;
import org.springframework.stereotype.Component;

/**
 * Message bus. In the HLD this is Kafka; here it is Spring's event publisher, with listeners
 * running on the single-threaded "busExecutor" (@Async), so the producer never waits for fan-out.
 * Replacing it with Kafka only touches this class and the listeners.
 */
@Component
public class MessageBus {
    private final ApplicationEventPublisher publisher;

    public MessageBus(ApplicationEventPublisher publisher) {
        this.publisher = publisher;
    }

    public void publish(Object event) {
        publisher.publishEvent(event);
    }
}
