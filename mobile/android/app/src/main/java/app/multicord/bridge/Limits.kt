// Multicord for Android. Copyright (C) 2026 Multicord contributors. AGPL-3.0-or-later, see LICENSE at the repo root.
package app.multicord.bridge

/** The engine protocol's limits, as src/shared/engine.ts (and src/shared/native.ts, settings.ts) set them. */
object Limits {
    const val MAX_LOCKED_HOSTS = 16
    const val MAX_SERVERS = 1000
    const val MAX_DIRECTS = 500
    const val MAX_KEY = 200
    const val MAX_TEXT = 200
    const val MAX_BODY_TEXT = 2000
    const val MAX_HEALTH_CHECKS = 8
    const val MAX_HEALTH_NAME = 80
    const val MAX_HEALTH_DETAIL = 300
    const val MAX_DATA_IMAGE = 200_000
    const val MAX_SECRET = 16_384
    const val MAX_HTTP_BODY = 50 * 1024 * 1024
    const val MAX_READ = 16 * 1024 * 1024
    const val MAX_SOCKETS = 8
    const val MAX_SOCKET_FRAME = 16 * 1024 * 1024
    const val MAX_SOCKET_QUEUE = 32 * 1024 * 1024
    const val MAX_CLOSE_REASON = 123
    const val MAX_SOCKET_PROTOCOLS = 8
    const val MAX_SOCKET_PROTOCOL = 64
    const val MAX_HEADERS = 50

    // src/shared/settings.ts
    const val MAX_SERVICE_FIELDS = 16
    const val MAX_STATUS_TEXT = 500
}
