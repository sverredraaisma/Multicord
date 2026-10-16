// Multicord for Android. Copyright (C) 2026 Multicord contributors. AGPL-3.0-or-later, see LICENSE at the repo root.
package app.multicord.background

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.util.Log
import app.multicord.shell.ShellFiles
import java.io.File
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

/**
 * "Start with your phone" (the settings page's launchAtLogin, off by default): after the phone has
 * started, or after Multicord was updated (which stops its process), the background service starts,
 * and with it the Hub, the shell page and the services, without a screen. Nothing starts when the
 * setting is off.
 *
 * Android 12 and later refuse most foreground-service starts from the background, but BOOT_COMPLETED,
 * LOCKED_BOOT_COMPLETED and MY_PACKAGE_REPLACED are exemptions. Android 15 takes BOOT_COMPLETED's
 * exemption away for some types (dataSync, camera, mediaPlayback, phoneCall, mediaProjection,
 * microphone); specialUse is not among them, so ConnectionService may start here. BOOT_COMPLETED comes
 * after the user first unlocks the phone, when app-private storage (the settings file, the secrets) can
 * be read; LOCKED_BOOT_COMPLETED is not asked for, as nothing could be read before that.
 *
 * Exported because the system sends these; both are protected broadcasts, which no other app can send.
 */
class BootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action !in ACTIONS) return
        val pending = goAsync()
        Thread {
            try {
                val settings = ShellFiles(File(context.filesDir, "shell")).read("settings")
                if (!startsWithPhone(settings)) return@Thread
                Log.i(TAG, "Starting with the phone (${intent.action})")
                context.startForegroundService(Intent(context, ConnectionService::class.java))
            } catch (error: Exception) {
                Log.w(TAG, "Could not start with the phone: ${error.message}")
            } finally {
                pending.finish()
            }
        }.start()
    }

    companion object {
        private const val TAG = "Multicord"
        val ACTIONS = setOf(Intent.ACTION_BOOT_COMPLETED, Intent.ACTION_MY_PACKAGE_REPLACED)

        /** Whether the shell's settings file (core's settings, as JSON) turns "Start with your phone" on. */
        fun startsWithPhone(settings: String?): Boolean {
            if (settings == null) return false
            val general = try {
                (Json.parseToJsonElement(settings) as? JsonObject)?.get("general") as? JsonObject
            } catch (_: Exception) {
                null
            }
            val value = general?.get("launchAtLogin") as? JsonPrimitive ?: return false
            return !value.isString && value.content == "true"
        }
    }
}
