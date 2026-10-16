// Multicord for Android. Copyright (C) 2026 Multicord contributors. AGPL-3.0-or-later, see LICENSE at the repo root.
package app.multicord.shell

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
 * Every isShellCommand case of tests/fixtures/shell-bridge-cases.json, the file tests/mobile/protocol.test.ts
 * runs against the TypeScript (copied in at build time by app/build.gradle.kts).
 */
class ShellCommandsTest {
    private val cases: JsonObject by lazy {
        val stream = javaClass.classLoader!!.getResourceAsStream("fixtures/shell-bridge-cases.json")
            ?: error("shell-bridge-cases.json is missing: the copyFixtures task copies it from tests/fixtures")
        Json.parseToJsonElement(stream.bufferedReader().readText()).jsonObject
    }

    private val limits: Map<String, Int> by lazy { cases["limits"]!!.jsonObject.mapValues { it.value.jsonPrimitive.int } }

    private fun count(value: JsonElement?): Int {
        val p = value!!.jsonPrimitive
        if (!p.isString) return p.int
        val match = Regex("^([A-Z_]+)([+-]1)?$").matchEntire(p.content) ?: error("Unknown count $p")
        return limits.getValue(match.groupValues[1]) + (match.groupValues[2].takeIf { it.isNotEmpty() }?.toInt() ?: 0)
    }

    private fun expand(value: JsonElement): JsonElement {
        if (value is JsonArray) return JsonArray(value.map(::expand))
        if (value !is JsonObject) return value
        value["\$repeat"]?.let { return JsonPrimitive(it.jsonPrimitive.content.repeat(count(value["times"]))) }
        value["\$limit"]?.let { return JsonPrimitive(count(it)) }
        value["\$object"]?.let { pair ->
            val (key, item) = pair.jsonArray
            return JsonObject((0 until count(value["times"])).associate { key.jsonPrimitive.content.replace("{i}", "$it") to expand(item) })
        }
        return JsonObject(value.mapValues { expand(it.value) })
    }

    @Test
    fun limitsMatch() {
        val own = mapOf(
            "MAX_FILE" to ShellCommands.MAX_FILE, "MAX_COPY" to ShellCommands.MAX_COPY, "MAX_NAME" to ShellCommands.MAX_NAME,
            "MAX_URL" to ShellCommands.MAX_URL, "MAX_BADGE" to ShellCommands.MAX_BADGE, "MAX_EXIT" to ShellCommands.MAX_EXIT,
            "MAX_TEXT" to app.multicord.bridge.Limits.MAX_TEXT, "MAX_BODY_TEXT" to app.multicord.bridge.Limits.MAX_BODY_TEXT,
            "MAX_KEY" to app.multicord.bridge.Limits.MAX_KEY,
        )
        assertEquals(own, limits)
    }

    @Test
    fun everyCase() {
        val section = cases["isShellCommand"]!!.jsonObject
        val failed = ArrayList<String>()
        var ran = 0
        for ((kind, expected) in listOf("valid" to true, "invalid" to false)) {
            for (case in section[kind]!!.jsonArray) {
                ran++
                if (ShellCommands.isShellCommand(expand(case)) != expected) failed += "$kind: ${case.toString().take(200)}"
            }
        }
        assertTrue("failed:\n${failed.joinToString("\n")}", failed.isEmpty())
        assertTrue("only $ran cases", ran > 50)
    }
}
