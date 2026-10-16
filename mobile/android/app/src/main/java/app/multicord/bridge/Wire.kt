// Multicord for Android. Copyright (C) 2026 Multicord contributors. AGPL-3.0-or-later, see LICENSE at the repo root.
package app.multicord.bridge

import java.util.Base64
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

/**
 * How messages cross between pages and native code: JSON text, as WebMessageListener carries strings.
 * A Uint8Array (HTTP bodies, socket frames) travels as `{"$b64": "<base64>"}`; the bridge scripts
 * (assets/bridge) turn it back into a Uint8Array on the page's side. On the desktop, Electron's
 * structured clone carries the same values.
 */
object Wire {
    /** The one key of a bytes envelope. */
    const val BYTES = "\$b64"

    /** Longest message accepted from a page: a body of MAX_HTTP_BODY as base64, and room for the rest. */
    const val MAX_MESSAGE = 80 * 1024 * 1024

    fun bytes(data: ByteArray): JsonObject = JsonObject(mapOf(BYTES to JsonPrimitive(Base64.getEncoder().encodeToString(data))))

    private fun base64Of(value: JsonElement?): String? {
        val obj = value as? JsonObject ?: return null
        if (obj.size != 1) return null
        val text = obj[BYTES] as? JsonPrimitive ?: return null
        return if (text.isString) text.content else null
    }

    /** The length of the bytes an envelope holds, without decoding them; null when it is no envelope. */
    fun bytesLength(value: JsonElement?): Int? {
        val text = base64Of(value) ?: return null
        if (text.length % 4 != 0) return null
        val padding = if (text.endsWith("==")) 2 else if (text.endsWith("=")) 1 else 0
        return text.length / 4 * 3 - padding
    }

    /** The bytes an envelope holds; null when it is none or its base64 is broken. */
    fun decodeBytes(value: JsonElement?): ByteArray? {
        val text = base64Of(value) ?: return null
        return try {
            Base64.getDecoder().decode(text)
        } catch (_: IllegalArgumentException) {
            null
        }
    }

    /** A message from a page, or null when it is too long or no JSON. */
    fun parse(text: String): JsonElement? {
        if (text.length > MAX_MESSAGE) return null
        return try {
            Json.parseToJsonElement(text)
        } catch (_: Exception) {
            null
        }
    }
}
