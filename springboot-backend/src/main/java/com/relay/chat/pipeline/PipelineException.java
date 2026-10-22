package com.relay.chat.pipeline;

import java.util.List;

/** A rejected send/receipt. Becomes a {@code nack} (or {@code error}) frame on the socket. */
public class PipelineException extends RuntimeException {
    private final String code;
    private final List<String> missing;

    public PipelineException(String code, String message, List<String> missing) {
        super(message == null ? code : message);
        this.code = code;
        this.missing = missing;
    }

    public PipelineException(String code, String message) {
        this(code, message, null);
    }

    public PipelineException(String code) {
        this(code, code, null);
    }

    public String code() { return code; }
    public List<String> missing() { return missing; }
}
