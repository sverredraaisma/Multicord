// Multicord for Android. Copyright (C) 2026 Multicord contributors. AGPL-3.0-or-later, see LICENSE at the repo root.
package app.multicord.discord

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.int
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Every case of tests/fixtures/discord-bridge-cases.json, the file tests/shared/discordCases.test.ts runs
 * against the TypeScript (copied in at build time by app/build.gradle.kts).
 */
class DiscordValidatorsTest {
    private val cases: JsonObject by lazy {
        val stream = javaClass.classLoader!!.getResourceAsStream("fixtures/discord-bridge-cases.json")
            ?: error("discord-bridge-cases.json is missing: the copyFixtures task copies it from tests/fixtures")
        Json.parseToJsonElement(stream.bufferedReader().readText()).jsonObject
    }

    private val limits: Map<String, Int> by lazy { cases["limits"]!!.jsonObject.mapValues { it.value.jsonPrimitive.int } }

    private fun count(value: JsonElement?): Int {
        val p = value!!.jsonPrimitive
        if (!p.isString) return p.int
        val match = Regex("^([A-Z_]+)([+-]1)?$").matchEntire(p.content) ?: error("Unknown count $p")
        return limits.getValue(match.groupValues[1]) + (match.groupValues[2].takeIf { it.isNotEmpty() }?.toInt() ?: 0)
    }

    /** Replaces {i} in every string of a value. */
    private fun indexed(value: JsonElement, i: Int): JsonElement = when {
        value is JsonPrimitive && value.isString -> JsonPrimitive(value.content.replace("{i}", "$i"))
        value is JsonArray -> JsonArray(value.map { indexed(it, i) })
        value is JsonObject -> JsonObject(value.mapValues { indexed(it.value, i) })
        else -> value
    }

    private fun expand(value: JsonElement): JsonElement {
        if (value is JsonArray) return JsonArray(value.map(::expand))
        if (value !is JsonObject) return value
        value["\$repeat"]?.let { return JsonPrimitive(it.jsonPrimitive.content.repeat(count(value["times"]))) }
        value["\$text"]?.let { parts ->
            val text = StringBuilder()
            for (part in parts.jsonArray) {
                val p = part.jsonPrimitive
                if (p.isString) text.append(p.content) else text.appendCodePoint(p.int)
            }
            return JsonPrimitive(text.toString())
        }
        value["\$list"]?.let { item -> return JsonArray((0 until count(value["times"])).map { expand(indexed(item, it)) }) }
        return JsonObject(value.mapValues { expand(it.value) })
    }

    private val validators: Map<String, (JsonElement) -> Boolean> = mapOf(
        "isDiscordState" to DiscordValidators::isDiscordState,
        "isBridgePayload" to DiscordValidators::isBridgePayload,
        "isRelayedNotification" to DiscordValidators::isRelayedNotification,
        "isDiscordTarget" to DiscordValidators::isDiscordTarget,
        "isDiscordPage" to { value -> DiscordValidators.isDiscordPage((value as? JsonPrimitive)?.takeIf { it.isString }?.content) },
    )

    @Test
    fun limitsMatch() {
        val own = mapOf(
            "MAX_GUILDS" to DiscordValidators.MAX_GUILDS, "MAX_DMS" to DiscordValidators.MAX_DMS, "MAX_CALLS" to DiscordValidators.MAX_CALLS,
            "MAX_STORES" to DiscordValidators.MAX_STORES, "MAX_DISCORD_TEXT" to DiscordValidators.MAX_DISCORD_TEXT,
            "MAX_FOLDER_PREVIEWS" to DiscordValidators.MAX_FOLDER_PREVIEWS, "MAX_FOLDER_GUILDS" to DiscordValidators.MAX_FOLDER_GUILDS,
            "MAX_NOTIFICATION_TITLE" to DiscordValidators.MAX_NOTIFICATION_TITLE, "MAX_NOTIFICATION_BODY" to DiscordValidators.MAX_NOTIFICATION_BODY,
        )
        assertEquals(own, limits)
    }

    @Test
    fun coversEveryValidator() {
        assertEquals(validators.keys, cases.keys - setOf("about", "limits"))
    }

    @Test
    fun everyCase() {
        val failed = ArrayList<String>()
        var ran = 0
        for ((name, validate) in validators) {
            val section = cases[name]!!.jsonObject
            for ((kind, expected) in listOf("valid" to true, "invalid" to false)) {
                for (case in section[kind]!!.jsonArray) {
                    ran++
                    if (validate(expand(case)) != expected) failed += "$name $kind: ${case.toString().take(200)}"
                }
            }
        }
        assertTrue("failed:\n${failed.joinToString("\n")}", failed.isEmpty())
        assertTrue("only $ran cases", ran > 150)
    }
}
