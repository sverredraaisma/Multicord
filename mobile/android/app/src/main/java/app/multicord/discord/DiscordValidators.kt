// Multicord for Android. Copyright (C) 2026 Multicord contributors. AGPL-3.0-or-later, see LICENSE at the repo root.
package app.multicord.discord

import app.multicord.bridge.Validators
import app.multicord.bridge.Validators.boolean
import app.multicord.bridge.Validators.record
import app.multicord.bridge.Validators.string
import app.multicord.net.WebUrl
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull

/**
 * The desktop's checks on what Discord's page reports (src/shared/ipc.ts), ported to Kotlin: native code runs
 * them on every message from the Discord view before it passes anything to the shell page, as the desktop's
 * main process does with the Discord view's IPC (src/main/modules/discord.ts). isBridgePayload is the
 * preload's check on the store bridge's output, isDiscordTarget the check on navigation sent to the page.
 *
 * They mirror the TypeScript line by line and are tested with the same cases (DiscordValidatorsTest, with the
 * shared fixture tests/fixtures/discord-bridge-cases.json).
 */
object DiscordValidators {
    const val MAX_GUILDS = 1000
    const val MAX_DMS = 200
    const val MAX_CALLS = 20
    const val MAX_STORES = 20
    const val MAX_DISCORD_TEXT = 200
    const val MAX_FOLDER_PREVIEWS = 4
    const val MAX_FOLDER_GUILDS = 200
    const val MAX_NOTIFICATION_TITLE = 200
    const val MAX_NOTIFICATION_BODY = 2000

    private val SNOWFLAKE = Regex("^[0-9]{1,20}$")
    private val COLOR = Regex("^#[0-9a-fA-F]{6}$")
    private val STORE_NAME = Regex("^[A-Za-z]{1,40}$")
    private val NOTIFICATION_ID = Regex("^[0-9]{1,10}$")

    /**
     * Control, line-separator and bidirectional characters (UNSAFE_TEXT): page text must not carry them. As code
     * points, so the source holds none of them.
     */
    private fun isUnsafe(c: Char): Boolean {
        val code = c.code
        return code <= 0x1f || code in 0x7f..0x9f || code == 0x061c || code == 0x200e || code == 0x200f ||
            code == 0x2028 || code == 0x2029 || code in 0x202a..0x202e || code in 0x2066..0x2069
    }

    private fun isText(value: JsonElement?, max: Int): Boolean = value.string()?.let { it.length <= max } == true
    private fun list(value: JsonElement?, max: Int, item: (JsonElement?) -> Boolean): Boolean =
        value is JsonArray && value.size <= max && value.all(item)

    private fun optional(value: JsonElement?, check: (JsonElement?) -> Boolean): Boolean = value == null || check(value)
    private fun isOptionalColor(value: JsonElement?): Boolean = value == null || value.string()?.let(COLOR::matches) == true

    /** Message text from Discord's page: one non-empty line, capped, with nothing that could reorder or break the text around it. */
    fun isPreviewText(value: JsonElement?): Boolean =
        value.string()?.let { it.isNotEmpty() && it.length <= MAX_DISCORD_TEXT && it.none(::isUnsafe) } == true

    fun isSnowflake(value: JsonElement?): Boolean = value.string()?.let(SNOWFLAKE::matches) == true

    private fun isSnowflakeText(value: String): Boolean = SNOWFLAKE.matches(value)

    fun isTitleBadge(value: JsonElement?): Boolean {
        val v = value.record() ?: return false
        return v["unread"].boolean() != null && Validators.isCount(v["mentions"])
    }

    fun isDiscordGuild(value: JsonElement?): Boolean {
        val v = value.record() ?: return false
        return isSnowflake(v["id"]) &&
            v["name"].string() != null &&
            optional(v["iconUrl"], Validators::isHttpsUrl) &&
            v["unread"].boolean() != null &&
            Validators.isCount(v["mentions"]) &&
            optional(v["folderId"], ::isSnowflake)
    }

    fun isDiscordFolder(value: JsonElement?): Boolean {
        val v = value.record() ?: return false
        return isSnowflake(v["id"]) &&
            isText(v["name"], MAX_DISCORD_TEXT) &&
            isOptionalColor(v["color"]) &&
            v["expanded"].boolean() != null &&
            v["unread"].boolean() != null &&
            Validators.isCount(v["mentions"]) &&
            list(v["iconUrls"], MAX_FOLDER_PREVIEWS, Validators::isHttpsUrl) &&
            Validators.isCount(v["index"])
    }

    fun isDiscordDm(value: JsonElement?): Boolean {
        val v = value.record() ?: return false
        return isSnowflake(v["id"]) &&
            isText(v["title"], MAX_DISCORD_TEXT) &&
            optional(v["avatarUrl"], Validators::isHttpsUrl) &&
            v["unread"].boolean() != null &&
            Validators.isCount(v["mentions"]) &&
            Validators.isCount(v["lastActivity"]) &&
            optional(v["preview"], ::isPreviewText)
    }

    fun isGuildInfo(value: JsonElement?): Boolean {
        val v = value.record() ?: return false
        return isSnowflake(v["id"]) &&
            isText(v["name"], MAX_DISCORD_TEXT) &&
            optional(v["iconUrl"], Validators::isHttpsUrl) &&
            optional(v["unread"]) { it.boolean() != null } &&
            optional(v["mentions"], Validators::isCount)
    }

    fun isLayoutEntry(value: JsonElement?): Boolean {
        val v = value.record() ?: return false
        return optional(v["folderId"], ::isSnowflake) &&
            optional(v["name"]) { isText(it, MAX_DISCORD_TEXT) } &&
            isOptionalColor(v["color"]) &&
            optional(v["expanded"]) { it.boolean() != null } &&
            list(v["guildIds"], MAX_FOLDER_GUILDS, ::isSnowflake)
    }

    /** Absent, null (nobody signed in) or a name. */
    private fun isDiscordUser(value: JsonElement?): Boolean =
        value == null || value is JsonNull || value.record()?.let { isText(it["name"], MAX_DISCORD_TEXT) } == true

    private fun isDiscordCallList(value: JsonElement?): Boolean =
        value == null || list(value, MAX_CALLS) { call ->
            val c = call.record()
            c != null && isSnowflake(c["channelId"]) && isText(c["from"], MAX_DISCORD_TEXT)
        }

    private fun isStoreList(value: JsonElement?): Boolean =
        value == null || list(value, MAX_STORES) { it.string()?.let(STORE_NAME::matches) == true }

    fun isBridgePayload(value: JsonElement?): Boolean {
        val v = value.record() ?: return false
        return isDiscordUser(v["user"]) &&
            isDiscordCallList(v["calls"]) &&
            isStoreList(v["stores"]) &&
            list(v["dms"], MAX_DMS, ::isDiscordDm) &&
            list(v["guilds"], MAX_GUILDS, ::isGuildInfo) &&
            optional(v["layout"]) { list(it, MAX_GUILDS, ::isLayoutEntry) }
    }

    /** What the Discord view reports: its guilds, badge and, once the store bridge has found Discord's stores, DMs and more. */
    fun isDiscordState(value: JsonElement?): Boolean {
        val v = value.record() ?: return false
        return list(v["guilds"], MAX_GUILDS, ::isDiscordGuild) &&
            isTitleBadge(v["badge"]) &&
            isDiscordUser(v["user"]) &&
            isDiscordCallList(v["calls"]) &&
            optional(v["health"]) { health ->
                val h = health.record()
                h != null && h["guildBar"].boolean() != null && isStoreList(h["stores"])
            } &&
            optional(v["dms"]) { list(it, MAX_DMS, ::isDiscordDm) } &&
            optional(v["folders"]) { list(it, MAX_GUILDS, ::isDiscordFolder) }
    }

    /** A notification Discord's page wanted to show, which the shell page shows instead. */
    fun isRelayedNotification(value: JsonElement?): Boolean {
        val v = value.record() ?: return false
        return v["id"].string()?.let(NOTIFICATION_ID::matches) == true &&
            isText(v["title"], MAX_NOTIFICATION_TITLE) &&
            isText(v["body"], MAX_NOTIFICATION_BODY)
    }

    /** Where the shell page may send Discord's page: home, a guild, a DM, a folder (to open or close) or a guild's channel. */
    fun isDiscordTarget(value: JsonElement?): Boolean {
        val s = value.string() ?: return false
        if (s.startsWith("dm:")) return isSnowflakeText(s.removePrefix("dm:"))
        if (s.startsWith("folder:")) return isSnowflakeText(s.removePrefix("folder:"))
        if (s.startsWith("channel:")) {
            val parts = s.removePrefix("channel:").split("/")
            return parts.size == 2 && isSnowflakeText(parts[0]) && isSnowflakeText(parts[1])
        }
        return s == "home" || isSnowflakeText(s)
    }

    /** Whether a page is Discord's own: https on discord.com or a subdomain such as ptb.discord.com. */
    fun isDiscordPage(url: String?): Boolean {
        val parsed = url?.let { WebUrl.parse(it) } ?: return false
        val host = parsed.hostname
        return parsed.protocol == "https:" && (host == "discord.com" || host.endsWith(".discord.com"))
    }
}
