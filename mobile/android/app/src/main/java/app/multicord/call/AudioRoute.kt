// Multicord for Android. Copyright (C) 2026 Multicord contributors. AGPL-3.0-or-later, see LICENSE at the repo root.
package app.multicord.call

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

/** Where a call plays (AudioRoute in src/shared/native.ts, by its wire name). */
enum class AudioRoute(val wire: String) {
    EARPIECE("earpiece"),
    SPEAKER("speaker"),
    WIRED("wired"),
    BLUETOOTH("bluetooth");

    companion object {
        /** A route by its wire name, as a view asks for it; null for anything else. */
        fun of(name: String?): AudioRoute? = entries.firstOrNull { it.wire == name }

        /**
         * The route a call uses: the one the user chose while it is still there; otherwise a headset (Bluetooth,
         * then wired) when one is connected, as phone calls do; otherwise the earpiece for a voice call and the
         * loudspeaker for a video call (the phone is held away to see it), or whichever of them the device has.
         * Null when the device reports no route at all.
         */
        fun pick(available: Set<AudioRoute>, chosen: AudioRoute?, video: Boolean): AudioRoute? {
            if (chosen != null && chosen in available) return chosen
            for (route in listOf(BLUETOOTH, WIRED)) if (route in available) return route
            val order = if (video) listOf(SPEAKER, EARPIECE) else listOf(EARPIECE, SPEAKER)
            return order.firstOrNull { it in available }
        }

        /** What the view hears (isAudioRoutes): the route in use and those available, in a fixed order. */
        fun report(current: AudioRoute, available: Set<AudioRoute>): JsonObject = JsonObject(mapOf(
            "current" to JsonPrimitive(current.wire),
            "available" to JsonArray(entries.filter { it in available || it == current }.map { JsonPrimitive(it.wire) }),
        ))
    }
}
