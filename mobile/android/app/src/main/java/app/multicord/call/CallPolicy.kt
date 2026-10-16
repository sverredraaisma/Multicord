// Multicord for Android. Copyright (C) 2026 Multicord contributors. AGPL-3.0-or-later, see LICENSE at the repo root.
package app.multicord.call

import android.Manifest
import android.content.pm.ServiceInfo
import androidx.annotation.RequiresApi
import android.webkit.PermissionRequest
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

/**
 * A call one chat view is in, as its engine's display state says (NativeVoiceSession in src/shared/native.ts):
 * connected to its voice server (a LiveKit address and grant), with or without the user's camera on.
 */
data class Call(val instance: String, val channelName: String, val video: Boolean) {
    companion object {
        private const val MAX_NAME = 100

        /**
         * The call in an engine's display state, or null: only a chat screen whose voice session has its
         * server's address and grant (a call still connecting has no microphone or camera yet).
         */
        fun of(instance: String, state: JsonObject?): Call? {
            if (state == null || text(state["screen"]) != "chat") return null
            val voice = state["voice"] as? JsonObject ?: return null
            if (text(voice["url"]).isNullOrEmpty() || text(voice["token"]).isNullOrEmpty()) return null
            val name = text(voice["channelName"])?.take(MAX_NAME)?.ifBlank { null } ?: "a call"
            val video = (voice["video"] as? JsonPrimitive)?.takeIf { !it.isString }?.content == "true"
            return Call(instance, name, video)
        }

        private fun text(value: Any?): String? = (value as? JsonPrimitive)?.takeIf { it.isString }?.content
    }
}

/**
 * What a chat view's calls may use, decided from the call its own engine reports. Nothing is granted on the
 * strength of a page asking: the microphone only while that view's instance is in a call the user joined
 * (joinVoice comes from a tap in the view), the camera only while the user turned it on in that call, and
 * each only for the view's own origin and only once Android's runtime permission is held.
 */
object CallPolicy {
    /** The Android permission each grantable WebView resource needs. */
    val ANDROID_PERMISSIONS = mapOf(
        PermissionRequest.RESOURCE_AUDIO_CAPTURE to Manifest.permission.RECORD_AUDIO,
        PermissionRequest.RESOURCE_VIDEO_CAPTURE to Manifest.permission.CAMERA,
    )

    /** The resources of a view's request that may be granted (once Android's permission is held), else none. */
    fun grantable(resources: List<String>, origin: String?, viewOrigin: String, call: Call?): List<String> {
        if (call == null || origin?.trimEnd('/') != viewOrigin) return emptyList()
        return resources.filter {
            it == PermissionRequest.RESOURCE_AUDIO_CAPTURE || (it == PermissionRequest.RESOURCE_VIDEO_CAPTURE && call.video)
        }.distinct()
    }

    /**
     * The background service's types: specialUse always (the connections), microphone while in a call and
     * camera while a call has video, each only with its runtime permission held, as Android 14 requires
     * before a service may claim it. Asked only on Android 14 (API 34) and later; before that the service
     * starts without types (ConnectionService).
     */
    @RequiresApi(34)
    fun serviceTypes(calls: Collection<Call>, microphone: Boolean, camera: Boolean): Int {
        var types = ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE
        if (calls.isEmpty()) return types
        if (microphone) types = types or ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE
        if (camera && calls.any { it.video }) types = types or ServiceInfo.FOREGROUND_SERVICE_TYPE_CAMERA
        return types
    }
}
