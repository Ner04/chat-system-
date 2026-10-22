package com.relay.chat.media;

import com.relay.chat.auth.AuthContext;
import jakarta.servlet.http.HttpServletRequest;
import org.springframework.core.io.FileSystemResource;
import org.springframework.core.io.Resource;
import org.springframework.http.CacheControl;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestAttribute;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import java.io.IOException;
import java.time.Duration;
import java.util.Map;

@RestController
public class MediaController {
    private final MediaService media;

    public MediaController(MediaService media) {
        this.media = media;
    }

    public record UploadRequest(String mime, Long size) {}

    @PostMapping("/v1/media/upload-url")
    public Map<String, String> uploadUrl(@RequestAttribute(AuthContext.ATTRIBUTE) AuthContext auth, @RequestBody UploadRequest body) {
        return media.createUpload(auth.userId(), body == null ? null : body.size());
    }

    @GetMapping("/v1/media/{id}/download-url")
    public Map<String, String> downloadUrl(@PathVariable("id") String id) {
        return media.downloadUrl(id);
    }

    // Blob storage endpoints: presigned, so no bearer token – the signature is the auth.
    @PutMapping("/blobs/{id}")
    public Map<String, Object> put(@PathVariable("id") String id, @RequestParam(name = "exp", required = false) String exp,
                                   @RequestParam(name = "sig", required = false) String sig, HttpServletRequest req) throws IOException {
        return media.storeBlob(id, exp, sig, req.getInputStream());
    }

    @GetMapping("/blobs/{id}")
    public ResponseEntity<Resource> get(@PathVariable("id") String id, @RequestParam(name = "exp", required = false) String exp,
                                        @RequestParam(name = "sig", required = false) String sig) {
        Resource file = new FileSystemResource(media.openBlob(id, exp, sig));
        return ResponseEntity.ok()
                .contentType(MediaType.APPLICATION_OCTET_STREAM)
                .cacheControl(CacheControl.maxAge(Duration.ofHours(1)).cachePrivate())
                .body(file);
    }
}
