package com.relay.chat.auth;

import com.relay.chat.common.ApiException;
import com.relay.chat.common.Ids;
import com.relay.chat.config.AppProperties;
import com.relay.chat.model.Device;
import com.relay.chat.model.Otp;
import com.relay.chat.model.PublicKeyJwk;
import com.relay.chat.model.Receipt;
import com.relay.chat.model.User;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.data.domain.Sort;
import org.springframework.data.mongodb.core.MongoTemplate;
import org.springframework.data.mongodb.core.query.Query;
import org.springframework.data.mongodb.core.query.Update;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.time.Instant;
import java.util.HexFormat;
import java.util.LinkedHashMap;
import java.util.Map;

import static org.springframework.data.mongodb.core.query.Criteria.where;

/** Gateway: phone + OTP login and device registration. */
@Service
public class AuthService {
    private static final Logger log = LoggerFactory.getLogger(AuthService.class);

    private final MongoTemplate mongo;
    private final JwtService jwt;
    private final AppProperties props;

    public AuthService(MongoTemplate mongo, JwtService jwt, AppProperties props) {
        this.mongo = mongo;
        this.jwt = jwt;
        this.props = props;
    }

    public record DeviceRequest(String deviceId, PublicKeyJwk publicKey, String name) {}

    public record VerifyRequest(String phone, String otp, DeviceRequest device) {}

    public record VerifyResponse(String token, String userId, String deviceId, boolean isNewDevice, String name) {}

    public Map<String, Object> requestOtp(String rawPhone) {
        String phone = Ids.normalizePhone(rawPhone);
        if (phone == null) {
            throw ApiException.badRequest("invalid_phone", "Enter a phone number with 6–15 digits, e.g. +919876543210");
        }
        String otp = String.format("%06d", Ids.random().nextInt(1_000_000));
        mongo.upsert(Query.query(where("id").is(phone)),
                new Update().set("codeHash", sha256(otp + phone)).set("attempts", 0)
                        .set("expiresAt", Instant.now().plusSeconds(props.otpTtlSeconds())),
                Otp.class);
        // A real system hands this to an SMS provider.
        log.info("[auth] OTP for {}: {}", phone, otp);
        Map<String, Object> res = new LinkedHashMap<>();
        res.put("phone", phone);
        res.put("otp_sent", true);
        if (props.devOtp()) res.put("dev_otp", otp);
        return res;
    }

    public VerifyResponse verifyOtp(VerifyRequest req) {
        String phone = Ids.normalizePhone(req == null ? null : req.phone());
        if (phone == null || req.otp() == null) throw ApiException.badRequest("invalid_request", "Phone and code are required");

        Otp rec = mongo.findById(phone, Otp.class);
        if (rec == null || rec.expiresAt.isBefore(Instant.now())) {
            throw ApiException.unauthorized("otp_expired", "That code has expired. Request a new one.");
        }
        if (rec.attempts >= 5) {
            throw new ApiException(HttpStatus.TOO_MANY_REQUESTS, "too_many_attempts", "Too many wrong codes. Request a new one.");
        }
        if (!rec.codeHash.equals(sha256(req.otp().trim() + phone))) {
            mongo.updateFirst(Query.query(where("id").is(phone)), new Update().inc("attempts", 1), Otp.class);
            throw ApiException.unauthorized("otp_invalid", "That code is not right. Check it and try again.");
        }
        mongo.remove(Query.query(where("id").is(phone)), Otp.class);

        DeviceRequest dreq = req.device();
        if (dreq == null || !validPublicKey(dreq.publicKey())) {
            throw ApiException.badRequest("invalid_device", "A device public key (ECDH P-256 JWK) is required");
        }

        Instant now = Ids.now();
        mongo.upsert(Query.query(where("phone").is(phone)),
                new Update().setOnInsert("id", Ids.newId("usr")).setOnInsert("createdAt", now),
                User.class);
        User user = mongo.findOne(Query.query(where("phone").is(phone)), User.class);

        // Re-use the device if the browser still holds its key pair, otherwise register a new one.
        Device dev = null;
        boolean isNew = false;
        if (dreq.deviceId() != null) {
            dev = mongo.findOne(Query.query(where("id").is(dreq.deviceId()).and("userId").is(user.id)
                    .and("publicKey.x").is(dreq.publicKey().x())), Device.class);
        }
        if (dev == null) {
            long count = mongo.count(Query.query(where("userId").is(user.id)), Device.class);
            if (count >= props.maxDevicesPerUser()) {
                // Drop the least recently seen device to stay under the cap.
                Device oldest = mongo.findOne(Query.query(where("userId").is(user.id))
                        .with(Sort.by(Sort.Direction.ASC, "lastSeen")).limit(1), Device.class);
                if (oldest != null) {
                    mongo.remove(Query.query(where("id").is(oldest.id)), Device.class);
                    mongo.remove(Query.query(where("deviceId").is(oldest.id)), Receipt.class);
                }
            }
            dev = new Device();
            dev.id = Ids.newId("dev");
            dev.userId = user.id;
            String name = dreq.name() == null || dreq.name().isBlank() ? "Browser" : dreq.name().trim();
            dev.name = name.length() > 60 ? name.substring(0, 60) : name;
            PublicKeyJwk k = dreq.publicKey();
            dev.publicKey = new PublicKeyJwk("EC", "P-256", k.x(), k.y()); // never store anything else (e.g. "d")
            dev.createdAt = now;
            dev.lastSeen = now;
            mongo.insert(dev);
            isNew = true;
        }
        return new VerifyResponse(jwt.issue(user.id, dev.id), user.id, dev.id, isNew, user.name);
    }

    /** Validates a token and that its device still exists (it may have been evicted). */
    public AuthContext authenticate(String token) {
        AuthContext ctx = jwt.verify(token);
        if (ctx == null) return null;
        boolean exists = mongo.exists(Query.query(where("id").is(ctx.deviceId()).and("userId").is(ctx.userId())), Device.class);
        return exists ? ctx : null;
    }

    private static boolean validPublicKey(PublicKeyJwk k) {
        return k != null && "EC".equals(k.kty()) && "P-256".equals(k.crv())
                && k.x() != null && !k.x().isBlank() && k.y() != null && !k.y().isBlank();
    }

    static String sha256(String s) {
        try {
            return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(s.getBytes(StandardCharsets.UTF_8)));
        } catch (NoSuchAlgorithmException e) {
            throw new IllegalStateException(e);
        }
    }
}
