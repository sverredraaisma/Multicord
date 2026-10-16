// Multicord for Android. Copyright (C) 2026 Multicord contributors. AGPL-3.0-or-later, see LICENSE at the repo root.
package app.multicord.shell

import app.multicord.bridge.Limits
import app.multicord.bridge.Validators
import app.multicord.bridge.Validators.boolean
import app.multicord.bridge.Validators.number
import app.multicord.bridge.Validators.record
import app.multicord.bridge.Validators.string
import app.multicord.discord.DiscordValidators
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject

/**
 * What the shell page may tell native code (src/mobile/protocol.ts, isShellCommand), checked before
 * anything happens. The page is ours and holds no credentials, but it shows what engines report, so its
 * commands are checked like everything else: known shapes and sizes only, no keys native code would ignore.
 * Tested with the shared cases in tests/fixtures/shell-bridge-cases.json (ShellCommandsTest).
 */
object ShellCommands {
    const val MAX_FILE = 1024 * 1024
    const val MAX_COPY = 65_536
    const val MAX_NAME = 64
    const val MAX_URL = 2048
    const val MAX_BADGE = 1_000_000
    const val MAX_EXIT = 200
    val FILES = setOf("settings", "platforms", "order")
    /** The theme setting's values (src/shared/settings.ts, THEMES). */
    val THEMES = setOf("system", "light", "dark")
    private val INSTANCE_ID = Regex("^[a-z0-9][a-z0-9-]{0,31}$")
    /** A notification Discord's page relayed, by the number it gave it (isRelayedNotification). */
    private val NOTIFICATION_ID = Regex("^[0-9]{1,10}$")

    fun isInstanceId(value: JsonElement?): Boolean = value.string()?.let(INSTANCE_ID::matches) == true

    private fun only(v: JsonObject, vararg keys: String): Boolean = v.keys.all { it in keys }
    private fun text(value: JsonElement?, max: Int, min: Int = 0): Boolean = value.string()?.let { it.length in min..max } == true
    private fun count(value: JsonElement?, max: Double): Boolean =
        value.number()?.let { it.isFinite() && it == Math.floor(it) && it >= 0 && it <= max } == true
    private fun optional(value: JsonElement?, check: (JsonElement?) -> Boolean): Boolean = value == null || check(value)

    fun isShellCommand(value: JsonElement?): Boolean {
        val v = value.record() ?: return false
        return when (v["type"].string()) {
            "save" -> only(v, "type", "file", "text") && v["file"].string() in FILES && text(v["text"], MAX_FILE)
            "start" -> only(v, "type", "instance", "module", "name", "url", "settings") &&
                isInstanceId(v["instance"]) &&
                isInstanceId(v["module"]) &&
                text(v["name"], MAX_NAME, 1) &&
                text(v["url"], MAX_URL, 1) && Validators.isHttpsUrl(v["url"]) &&
                optional(v["settings"], Validators::isServiceSettingValues)
            "command" -> only(v, "type", "instance", "command") && isInstanceId(v["instance"]) && Validators.isEngineCommand(v["command"])
            "hostSettings" -> only(v, "type", "instance", "settings") && isInstanceId(v["instance"]) && Validators.isServiceSettingValues(v["settings"])
            "discordNavigate" -> only(v, "type", "instance", "target") && isInstanceId(v["instance"]) && DiscordValidators.isDiscordTarget(v["target"])
            "discordNotificationClick" -> only(v, "type", "instance", "id") && isInstanceId(v["instance"]) && v["id"].string()?.let(NOTIFICATION_ID::matches) == true
            "layout" -> only(v, "type", "instance", "overlay") && (v["instance"] is JsonNull || isInstanceId(v["instance"])) && v["overlay"].boolean() != null
            "viewSettings" -> only(v, "type", "instance", "mediaAutoLoad") && isInstanceId(v["instance"]) &&
                (v["mediaAutoLoad"] is JsonNull || count(v["mediaAutoLoad"], 9007199254740991.0))
            "notify" -> only(v, "type", "instance", "title", "body", "target", "railKey", "urgent") &&
                isInstanceId(v["instance"]) &&
                text(v["title"], Limits.MAX_TEXT) &&
                text(v["body"], Limits.MAX_BODY_TEXT) &&
                text(v["target"], Limits.MAX_KEY, 1) &&
                optional(v["railKey"]) { text(it, Limits.MAX_KEY, 1) } &&
                optional(v["urgent"]) { it.boolean() != null }
            "theme" -> only(v, "type", "theme") && v["theme"].string() in THEMES
            "badge" -> only(v, "type", "count") && count(v["count"], MAX_BADGE.toDouble())
            "clearSession", "forgetSecrets", "restartEngine" -> only(v, "type", "instance") && isInstanceId(v["instance"])
            "restart", "backUnhandled" -> only(v, "type")
            "copyText" -> only(v, "type", "text") && text(v["text"], MAX_COPY)
            else -> false
        }
    }
}
