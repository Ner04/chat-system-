package com.relay.chat.media;

import com.relay.chat.common.ApiException;
import com.relay.chat.common.Ids;
import com.relay.chat.config.AppProperties;
import com.relay.chat.model.Media;
import org.springframework.data.mongodb.core.MongoTemplate;
import org.springframework.data.mongodb.core.query.Query;
import org.springframework.data.mongodb.core.query.Update;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;

import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.security.GeneralSecurityException;
import java.security.MessageDigest;
import java.time.Duration;
import java.time.Instant;
import java.util.Base64;
import java.util.HexFormat;
import java.util.Map;
import java.util.regex.Pattern;

import static org.springframework.data.mongodb.core.query.Criteria.where;

/**
 * Media service, following the HLD's presigned-URL flow:
 * <pre>
 *   POST /v1/media/upload-url        → { media_id, upload_url }  (signed, 10 minutes)
 *   PUT  upload_url                  ← ENCRYPTED bytes (server never sees plaintext or the key)
 *   GET  /v1/media/{id}/download-url → { url }                   (a CDN URL in production)
 * </pre>
 * "Blob storage" is a local folder here; swap {@link #blobPath} for S3/GCS.
 */
@Service
public class MediaService {
    private static final Pattern MEDIA_ID = Pattern.compile("^med_[\\w-]+$");

    private final MongoTemplate mongo;
    private final AppProperties props;
    private final Path blobDir;
    private final SecretKeySpec signingKey;

    public MediaService(MongoTemplate mongo, AppProperties props) throws IOException {
        this.mongo = mongo;
        this.props = props;
        this.blobDir = Paths.get(props.blobDir()).toAbsolutePath();
        Files.createDirectories(blobDir);
        this.signingKey = new SecretKeySpec(props.mediaSecret().getBytes(StandardCharsets.UTF_8), "HmacSHA256");
    }

    private String sign(String id, String op, long exp) {
        try {
            Mac mac = Mac.getInstance("HmacSHA256");
            mac.init(signingKey);
            byte[] sig = mac.doFinal((id + ":" + op + ":" + exp).getBytes(StandardCharsets.UTF_8));
            return Base64.getUrlEncoder().withoutPadding().encodeToString(sig);
        } catch (GeneralSecurityException e) {
            throw new IllegalStateException(e);
        }
    }

    private String signedUrl(String id, String op, long ttlSeconds) {
        long exp = Instant.now().getEpochSecond() + ttlSeconds;
        return "/blobs/" + id + "?op=" + op + "&exp=" + exp + "&sig=" + sign(id, op, exp);
    }

    private void checkSignature(String id, String op, String exp, String sig) {
        long expires;
        try {
            expires = Long.parseLong(exp);
        } catch (NumberFormatException | NullPointerException e) {
            throw ApiException.forbidden("bad_signature", "Invalid or expired link");
        }
        boolean ok = MEDIA_ID.matcher(id).matches() && expires >= Instant.now().getEpochSecond() && sig != null
                && MessageDigest.isEqual(sign(id, op, expires).getBytes(StandardCharsets.UTF_8), sig.getBytes(StandardCharsets.UTF_8));
        if (!ok) throw ApiException.forbidden("bad_signature", "Invalid or expired link");
    }

    private Path blobPath(String id) {
        return blobDir.resolve(id);
    }

    public Map<String, String> createUpload(String userId, Long size) {
        if (size == null || size <= 0 || size > props.maxMediaBytes()) {
            throw ApiException.badRequest("invalid_size", "Files must be under " + props.maxMediaBytes() / 1024 / 1024 + " MB");
        }
        Media m = new Media();
        m.id = Ids.newId("med");
        m.uploader = userId;
        m.declaredSize = size;
        m.uploaded = false;
        m.createdAt = Ids.now();
        m.expiresAt = m.createdAt.plus(Duration.ofDays(props.messageRetentionDays()));
        mongo.insert(m);
        return Map.of("media_id", m.id, "upload_url", signedUrl(m.id, "put", 600));
    }

    public Map<String, Object> storeBlob(String id, String exp, String sig, InputStream body) throws IOException {
        checkSignature(id, "put", exp, sig);
        Media meta = mongo.findById(id, Media.class);
        if (meta == null || meta.uploaded) throw new ApiException(HttpStatus.CONFLICT, "already_uploaded", "Already uploaded");
        long limit = meta.declaredSize + 1024;
        long bytes = 0;
        MessageDigest sha;
        try {
            sha = MessageDigest.getInstance("SHA-256");
        } catch (GeneralSecurityException e) {
            throw new IllegalStateException(e);
        }
        Path tmp = blobDir.resolve(id + ".part");
        try (OutputStream out = Files.newOutputStream(tmp)) {
            byte[] buf = new byte[64 * 1024];
            int n;
            while ((n = body.read(buf)) != -1) {
                bytes += n;
                if (bytes > limit) throw new ApiException(HttpStatus.PAYLOAD_TOO_LARGE, "too_large", "File is larger than declared");
                sha.update(buf, 0, n);
                out.write(buf, 0, n);
            }
        } catch (ApiException | IOException e) {
            Files.deleteIfExists(tmp);
            throw e;
        }
        Files.move(tmp, blobPath(id));
        String hash = HexFormat.of().formatHex(sha.digest());
        mongo.updateFirst(Query.query(where("id").is(id)),
                new Update().set("uploaded", true).set("size", bytes).set("sha256", hash), Media.class);
        return Map.of("media_id", id, "size", bytes, "sha256", hash);
    }

    public Map<String, String> downloadUrl(String id) {
        Media meta = mongo.findOne(Query.query(where("id").is(id).and("uploaded").is(true)), Media.class);
        if (meta == null || !Files.exists(blobPath(id))) {
            throw ApiException.notFound("media_missing", "This media file appears to be missing");
        }
        return Map.of("url", signedUrl(id, "get", 3600));
    }

    public Path openBlob(String id, String exp, String sig) {
        checkSignature(id, "get", exp, sig);
        Path p = blobPath(id);
        if (!Files.exists(p)) throw ApiException.notFound("media_missing", "This media file appears to be missing");
        return p;
    }
}
