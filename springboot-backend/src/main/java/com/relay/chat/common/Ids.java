package com.relay.chat.common;

import java.security.SecureRandom;
import java.time.Instant;
import java.time.temporal.ChronoUnit;
import java.util.Base64;
import java.util.regex.Pattern;

public final class Ids {
    private static final SecureRandom RANDOM = new SecureRandom();
    private static final Pattern PHONE = Pattern.compile("^\\+?\\d{6,15}$");

    private Ids() {}

    /** e.g. usr_Xy3…, 16 url-safe chars after the prefix. */
    public static String newId(String prefix) {
        byte[] b = new byte[12];
        RANDOM.nextBytes(b);
        return prefix + "_" + Base64.getUrlEncoder().withoutPadding().encodeToString(b);
    }

    /** Keep a leading + and digits; null if it doesn't look like a phone number. */
    public static String normalizePhone(String raw) {
        if (raw == null) return null;
        String p = raw.trim().replaceAll("[\\s\\-().]", "");
        if (!PHONE.matcher(p).matches()) return null;
        return p.startsWith("+") ? p : "+" + p;
    }

    public static SecureRandom random() { return RANDOM; }

    /** Current time at millisecond precision (what MongoDB stores and every browser parses). */
    public static Instant now() { return Instant.now().truncatedTo(ChronoUnit.MILLIS); }
}
