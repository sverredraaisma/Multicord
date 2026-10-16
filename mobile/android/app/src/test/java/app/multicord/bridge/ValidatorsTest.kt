// Multicord for Android. Copyright (C) 2026 Multicord contributors. AGPL-3.0-or-later, see LICENSE at the repo root.
package app.multicord.bridge

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
 * Every case of tests/fixtures/engine-validator-cases.json, the file the desktop's
 * tests/shared/validatorCases.test.ts runs too (copied in at build time by app/build.gradle.kts), so the
 * Kotlin port accepts and refuses exactly what the TypeScript does. A case that fails is named in the message.
 */
class ValidatorsTest {
    private val cases: JsonObject by lazy {
        val stream = javaClass.classLoader!!.getResourceAsStream("fixtures/engine-validator-cases.json")
            ?: error("engine-validator-cases.json is missing: the copyFixtures task copies it from tests/fixtures")
        Json.parseToJsonElement(stream.bufferedReader().readText()).jsonObject
    }

    private val limits: Map<String, Int> by lazy { cases["limits"]!!.jsonObject.mapValues { it.value.jsonPrimitive.int } }

    /** A count: a number, or a limit's name with an optional +1 or -1. */
    private fun count(value: JsonElement?): Int {
        val p = value!!.jsonPrimitive
        if (!p.isString) return p.int
        val match = Regex("^([A-Z_]+)([+-]1)?$").matchEntire(p.content) ?: error("Unknown count $p")
        val base = limits[match.groupValues[1]] ?: error("Unknown limit $p")
        return base + (match.groupValues[2].takeIf { it.isNotEmpty() }?.toInt() ?: 0)
    }

    /** Replaces {i} in every string of a value. */
    private fun indexed(value: JsonElement, i: Int): JsonElement = when {
        value is JsonPrimitive && value.isString -> JsonPrimitive(value.content.replace("{i}", "$i"))
        value is JsonArray -> JsonArray(value.map { indexed(it, i) })
        value is JsonObject -> JsonObject(value.entries.associate { (k, v) -> k.replace("{i}", "$i") to indexed(v, i) })
        else -> value
    }

    private fun text(value: JsonElement): String = (expand(value) as JsonPrimitive).content

    /** A fixture value with its expansions made, as tests/shared/validatorCases.test.ts makes them. */
    private fun expand(value: JsonElement): JsonElement {
        if (value is JsonArray) return JsonArray(value.map(::expand))
        if (value !is JsonObject) return value
        value["\$repeat"]?.let { return JsonPrimitive(text(it).repeat(count(value["times"]))) }
        value["\$bytes"]?.let { return Wire.bytes(ByteArray(count(it))) }
        value["\$limit"]?.let { return JsonPrimitive(count(it)) }
        value["\$text"]?.let { parts ->
            return JsonPrimitive(parts.jsonArray.joinToString("") { part ->
                if (part is JsonPrimitive && !part.isString) String(Character.toChars(part.int)) else text(part)
            })
        }
        value["\$list"]?.let { item -> return JsonArray(List(count(value["times"])) { expand(indexed(item, it)) }) }
        value["\$object"]?.let { pair ->
            val (key, item) = pair.jsonArray
            return JsonObject((0 until count(value["times"])).associate { text(indexed(key, it)) to expand(indexed(item, it)) })
        }
        return JsonObject(value.mapValues { expand(it.value) })
    }

    private val validators: Map<String, (JsonElement?) -> Boolean> = mapOf(
        "isImageUrl" to Validators::isImageUrl,
        "isEngineEvent" to Validators::isEngineEvent,
        "isHttpRequest" to Validators::isHttpRequest,
        "isEngineRequest" to Validators::isEngineRequest,
        "isNativeAction" to Validators::isNativeAction,
    )

    @Test
    fun limitsMatch() {
        val own = mapOf(
            "MAX_KEY" to Limits.MAX_KEY, "MAX_TEXT" to Limits.MAX_TEXT, "MAX_BODY_TEXT" to Limits.MAX_BODY_TEXT,
            "MAX_SERVERS" to Limits.MAX_SERVERS, "MAX_DIRECTS" to Limits.MAX_DIRECTS, "MAX_DATA_IMAGE" to Limits.MAX_DATA_IMAGE,
            "MAX_SECRET" to Limits.MAX_SECRET, "MAX_HTTP_BODY" to Limits.MAX_HTTP_BODY, "MAX_READ" to Limits.MAX_READ,
            "MAX_LOCKED_HOSTS" to Limits.MAX_LOCKED_HOSTS, "MAX_SOCKET_FRAME" to Limits.MAX_SOCKET_FRAME,
            "MAX_SOCKET_PROTOCOLS" to Limits.MAX_SOCKET_PROTOCOLS, "MAX_SOCKET_PROTOCOL" to Limits.MAX_SOCKET_PROTOCOL,
            "MAX_CLOSE_REASON" to Limits.MAX_CLOSE_REASON, "MAX_MESSAGE_LENGTH" to Validators.MAX_MESSAGE_LENGTH,
            "MAX_MEMBER_OFFSET" to Validators.MAX_MEMBER_OFFSET, "MAX_SEARCH_QUERY" to Validators.MAX_SEARCH_QUERY,
            "MAX_GIF_QUERY" to Validators.MAX_GIF_QUERY, "MAX_JOIN_ADDRESS" to Validators.MAX_JOIN_ADDRESS,
            "MAX_POLL_OPTIONS" to Validators.MAX_POLL_OPTIONS, "MAX_NEW_POLL_QUESTION" to Validators.MAX_NEW_POLL_QUESTION,
        )
        assertEquals(own, limits)
    }

    @Test
    fun everyCase() {
        assertEquals(validators.keys, cases.keys - setOf("about", "limits"))
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
        // The fixture is not empty or cut short.
        assertTrue("only $ran cases", ran > 300)
    }

    @Test
    fun wireBytes() {
        val bytes = byteArrayOf(0, 1, 2, -1)
        assertEquals(4, Wire.bytesLength(Wire.bytes(bytes)))
        assertTrue(Wire.decodeBytes(Wire.bytes(bytes))!!.contentEquals(bytes))
        assertEquals(null, Wire.decodeBytes(JsonObject(mapOf(Wire.BYTES to JsonPrimitive("!!!!")))))
        assertEquals(null, Wire.parse("{"))
        assertEquals(JsonObject(mapOf("a" to JsonPrimitive(1))), Wire.parse("{\"a\":1}"))
        assertEquals(3, Validators.utf8Length("abc"))
        assertEquals(4, Validators.utf8Length(String(Character.toChars(0x1f44d))))
        // A lone surrogate, as TextEncoder writes it: U+FFFD.
        assertEquals(3, Validators.utf8Length(String(charArrayOf(0xd800.toChar()))))
    }
}
