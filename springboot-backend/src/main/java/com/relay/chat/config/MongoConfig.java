package com.relay.chat.config;

import com.mongodb.WriteConcern;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.bson.Document;
import org.springframework.boot.autoconfigure.mongo.MongoClientSettingsBuilderCustomizer;
import org.springframework.boot.context.event.ApplicationReadyEvent;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.context.event.EventListener;
import org.springframework.data.domain.Sort;
import org.springframework.data.mongodb.core.MongoTemplate;
import org.springframework.data.mongodb.core.index.Index;
import org.springframework.data.mongodb.core.index.IndexOperations;
import org.springframework.data.mongodb.core.index.PartialIndexFilter;
import org.springframework.data.mongodb.core.query.Criteria;

import java.time.Duration;

/**
 * MongoDB setup.
 *
 * Collections: users, otps, devices, chats, messages (ciphertext only), receipts, media.
 * Every write is acknowledged by a majority ("an accepted message must never be lost").
 */
@Configuration
public class MongoConfig {
    private static final Logger log = LoggerFactory.getLogger(MongoConfig.class);
    private final MongoTemplate mongo;

    public MongoConfig(MongoTemplate mongo) {
        this.mongo = mongo;
    }

    @Bean
    public static MongoClientSettingsBuilderCustomizer majorityWrites() {
        return builder -> builder.writeConcern(WriteConcern.MAJORITY);
    }

    /** Index names use the raw MongoDB field names (snake_case). */
    @EventListener(ApplicationReadyEvent.class)
    public void createIndexes() {
        IndexOperations users = mongo.indexOps("users");
        users.ensureIndex(new Index().on("phone", Sort.Direction.ASC).unique());

        mongo.indexOps("otps").ensureIndex(new Index().on("expires_at", Sort.Direction.ASC).expire(Duration.ZERO));

        mongo.indexOps("devices").ensureIndex(new Index().on("user_id", Sort.Direction.ASC));

        IndexOperations chats = mongo.indexOps("chats");
        chats.ensureIndex(new Index().on("members", Sort.Direction.ASC).on("last_message_at", Sort.Direction.DESC));
        chats.ensureIndex(new Index().on("direct_key", Sort.Direction.ASC).unique()
                .partial(PartialIndexFilter.of(Criteria.where("type").is("direct"))));

        IndexOperations messages = mongo.indexOps("messages");
        // Ordering is PER CONVERSATION: (chat_id, seq) is unique.
        messages.ensureIndex(new Index().on("chat_id", Sort.Direction.ASC).on("seq", Sort.Direction.ASC).unique());
        // Lets a device pull only messages that were encrypted for it.
        messages.ensureIndex(new Index().on("keys.device_id", Sort.Direction.ASC).on("chat_id", Sort.Direction.ASC).on("seq", Sort.Direction.ASC));
        messages.ensureIndex(new Index().on("expires_at", Sort.Direction.ASC).expire(Duration.ZERO));

        IndexOperations receipts = mongo.indexOps("receipts");
        receipts.ensureIndex(new Index().on("chat_id", Sort.Direction.ASC).on("device_id", Sort.Direction.ASC).unique());
        receipts.ensureIndex(new Index().on("device_id", Sort.Direction.ASC));

        mongo.indexOps("media").ensureIndex(new Index().on("expires_at", Sort.Direction.ASC).expire(Duration.ZERO));

        Document info = mongo.getDb().runCommand(new Document("buildInfo", 1));
        log.info("MongoDB {} ready, database '{}', indexes ensured", info.getString("version"), mongo.getDb().getName());
    }
}
