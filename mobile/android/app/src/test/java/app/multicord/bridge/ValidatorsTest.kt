// Multicord for Android. Copyright (C) 2026 Multicord contributors. AGPL-3.0-or-later, see LICENSE at the repo root.
package app.multicord.bridge

import app.multicord.bridge.Limits.MAX_BODY_TEXT
import app.multicord.bridge.Limits.MAX_CLOSE_REASON
import app.multicord.bridge.Limits.MAX_DATA_IMAGE
import app.multicord.bridge.Limits.MAX_DIRECTS
import app.multicord.bridge.Limits.MAX_HTTP_BODY
import app.multicord.bridge.Limits.MAX_KEY
import app.multicord.bridge.Limits.MAX_LOCKED_HOSTS
import app.multicord.bridge.Limits.MAX_READ
import app.multicord.bridge.Limits.MAX_SECRET
import app.multicord.bridge.Limits.MAX_SERVERS
import app.multicord.bridge.Limits.MAX_SOCKET_FRAME
import app.multicord.bridge.Limits.MAX_SOCKET_PROTOCOL
import app.multicord.bridge.Limits.MAX_SOCKET_PROTOCOLS
import app.multicord.bridge.Limits.MAX_TEXT
import app.multicord.bridge.Validators.MAX_MESSAGE_LENGTH
import app.multicord.bridge.Validators.isEngineEvent
import app.multicord.bridge.Validators.isEngineRequest
import app.multicord.bridge.Validators.isHttpRequest
import app.multicord.bridge.Validators.isImageUrl
import app.multicord.bridge.Validators.isNativeAction
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** Kotlin values as JSON: maps, lists, strings, numbers, booleans, null, and ByteArrays as Wire envelopes. */
fun json(value: Any?): JsonElement = when (value) {
    null -> JsonNull
    is JsonElement -> value
    is String -> JsonPrimitive(value)
    is Number -> JsonPrimitive(value)
    is Boolean -> JsonPrimitive(value)
    is ByteArray -> Wire.bytes(value)
    is Map<*, *> -> JsonObject(value.entries.associate { (k, v) -> k as String to json(v) })
    is List<*> -> JsonArray(value.map(::json))
    else -> error("No JSON for $value")
}

fun obj(vararg pairs: Pair<String, Any?>): JsonElement = json(mapOf(*pairs))

/**
 * The cases of tests/shared/engine.test.ts and tests/shared/native.test.ts, for the requests, events and
 * actions this host handles, so the Kotlin port accepts and refuses exactly what the TypeScript does.
 */
class ValidatorsTest {
    private fun server(vararg over: Pair<String, Any?>) = mapOf("key" to "k", "name" to "n", "unread" to false, "mentions" to 0) + over
    private fun direct(vararg over: Pair<String, Any?>) = mapOf("key" to "k", "title" to "t", "lastActivity" to 1, "unread" to false, "mentions" to 0) + over
    private fun servers(s: Any?) = isEngineEvent(obj("type" to "servers", "servers" to listOf(s)))
    private fun directs(d: Any?) = isEngineEvent(obj("type" to "directs", "directs" to listOf(d)))
    private fun repeat(s: String, n: Int) = s.repeat(n)
    private fun cp(vararg codePoints: Int) = String(codePoints, 0, codePoints.size)

    @Test
    fun imageUrls() {
        assertTrue(isImageUrl(json("https://x.test/a.png")))
        for (t in listOf("png", "jpeg", "gif", "webp")) assertTrue(isImageUrl(json("data:image/$t;base64,QUJD==")))
        assertFalse(isImageUrl(json(5)))
        assertFalse(isImageUrl(json("http://x.test/a.png")))
        assertFalse(isImageUrl(json("https://x.test/" + repeat("a", 2000))))
        assertFalse(isImageUrl(json("data:image/svg+xml;base64,QUJD")))
        assertFalse(isImageUrl(json("data:image/png;base64,!!")))
        assertFalse(isImageUrl(json("data:image/png;base64," + repeat("A", MAX_DATA_IMAGE))))
    }

    @Test
    fun serverEvents() {
        assertTrue(servers(server("iconUrl" to "https://x.test/i.png", "kind" to "server", "expanded" to true, "color" to "#AbC123", "previewIconUrls" to listOf("https://x.test/i.png"))))
        assertTrue(servers(server("kind" to "group", "children" to listOf(server("key" to "c"), server("key" to "d", "kind" to "server")))))
        assertTrue(isEngineEvent(obj("type" to "servers", "servers" to emptyList<Any>())))
        val bad = listOf(
            "x", emptyList<Any>(), server("key" to ""), server("key" to repeat("k", MAX_KEY + 1)), server("name" to repeat("n", MAX_TEXT + 1)),
            server("iconUrl" to "http://x.test/i.png"), server("unread" to 1), server("mentions" to 1.5), server("mentions" to -1),
            server("kind" to "space"), server("children" to emptyList<Any>()), server("kind" to "group", "children" to "x"),
            server("kind" to "group", "children" to List(MAX_SERVERS + 1) { server() }), server("kind" to "group", "children" to listOf(server("key" to ""))),
            server("kind" to "group", "children" to listOf(server("kind" to "group", "children" to emptyList<Any>()))),
            server("kind" to "group", "children" to listOf(server("children" to listOf(server())))),
            server("expanded" to "yes"), server("color" to "#fff"), server("color" to 0xffffff), server("color" to "#gggggg"),
            server("previewIconUrls" to List(5) { "https://x.test/i.png" }), server("previewIconUrls" to listOf("http://x.test/i.png")),
            server("previewIconUrls" to "https://x.test/i.png"),
        )
        for (s in bad) assertFalse("$s", servers(s))
        assertTrue(servers(server("previewIconUrls" to List(4) { "https://x.test/i.png" })))
        assertFalse(isEngineEvent(obj("type" to "servers", "servers" to "x")))
        assertFalse(isEngineEvent(obj("type" to "servers", "servers" to List(MAX_SERVERS + 1) { server() })))
    }

    @Test
    fun directEvents() {
        assertTrue(directs(direct()))
        assertTrue(directs(direct("avatarUrl" to "https://x.test/a.png", "preview" to "hi")))
        for (d in listOf(null, direct("key" to ""), direct("title" to repeat("t", MAX_TEXT + 1)), direct("avatarUrl" to "http://x.test/a.png"),
            direct("lastActivity" to "1"), direct("preview" to repeat("p", MAX_BODY_TEXT + 1)), direct("unread" to "no"), direct("mentions" to -2))) {
            assertFalse("$d", directs(d))
        }
        assertFalse(isEngineEvent(obj("type" to "directs", "directs" to emptyMap<String, Any>())))
        assertFalse(isEngineEvent(obj("type" to "directs", "directs" to List(MAX_DIRECTS + 1) { direct() })))
    }

    @Test
    fun notificationsCallsAccountsBadges() {
        fun note(vararg over: Pair<String, Any?>) = obj("type" to "notification", "notification" to mapOf("title" to "t", "body" to "b", "target" to "x") + over)
        assertTrue(isEngineEvent(note()))
        assertTrue(isEngineEvent(note("railKey" to "r", "inView" to true)))
        assertFalse(isEngineEvent(obj("type" to "notification", "notification" to "x")))
        for (n in listOf(note("title" to repeat("t", MAX_TEXT + 1)), note("body" to repeat("b", MAX_BODY_TEXT + 1)), note("target" to ""), note("railKey" to ""), note("inView" to "yes"))) {
            assertFalse(isEngineEvent(n))
        }
        fun call(vararg over: Pair<String, Any?>) = obj("type" to "call", "call" to mapOf("conversationKey" to "c", "from" to "me", "video" to false) + over)
        assertTrue(isEngineEvent(call()))
        assertFalse(isEngineEvent(obj("type" to "call", "call" to null)))
        assertFalse(isEngineEvent(call("conversationKey" to "")))
        assertFalse(isEngineEvent(call("from" to repeat("f", MAX_TEXT + 1))))
        assertFalse(isEngineEvent(call("video" to 0)))
        for (state in listOf("signed-in", "signed-out", "unknown")) assertTrue(isEngineEvent(obj("type" to "account", "account" to mapOf("state" to state))))
        assertTrue(isEngineEvent(obj("type" to "account", "account" to mapOf("state" to "signed-in", "name" to "me"))))
        assertFalse(isEngineEvent(obj("type" to "account", "account" to mapOf("state" to "other"))))
        assertFalse(isEngineEvent(obj("type" to "account", "account" to mapOf("state" to "unknown", "name" to repeat("n", MAX_TEXT + 1)))))
        assertFalse(isEngineEvent(obj("type" to "account", "account" to "x")))
        assertTrue(isEngineEvent(obj("type" to "homeBadge", "badge" to mapOf("unread" to true, "mentions" to 2))))
        assertFalse(isEngineEvent(obj("type" to "homeBadge", "badge" to mapOf("unread" to 1, "mentions" to 2))))
        assertFalse(isEngineEvent(obj("type" to "homeBadge", "badge" to mapOf("unread" to true, "mentions" to -1))))
        assertFalse(isEngineEvent(obj("type" to "homeBadge", "badge" to null)))
    }

    @Test
    fun settingsStatusAndHealth() {
        assertTrue(isEngineEvent(obj("type" to "settingsStatus", "status" to mapOf("forgetApiId" to mapOf("text" to "Using your own.", "disabled" to false)))))
        assertFalse(isEngineEvent(obj("type" to "settingsStatus", "status" to mapOf("forgetApiId" to mapOf("text" to 5)))))
        assertFalse(isEngineEvent(obj("type" to "settingsStatus", "status" to mapOf("forgetApiId" to mapOf("other" to "x")))))
        assertFalse(isEngineEvent(obj("type" to "settingsStatus")))
        assertTrue(isEngineEvent(obj("type" to "health", "checks" to emptyList<Any>())))
        assertTrue(isEngineEvent(obj("type" to "health", "checks" to listOf(mapOf("name" to "API", "ok" to true), mapOf("name" to "Gateway", "ok" to false, "detail" to "Down")))))
        val bad = listOf(
            null, emptyMap<String, Any>(), listOf(mapOf("name" to "", "ok" to true)), listOf(mapOf("name" to "API", "ok" to "yes")),
            listOf(mapOf("name" to "API", "ok" to true, "detail" to 5)), listOf(mapOf("name" to repeat("x", 81), "ok" to true)),
            listOf(mapOf("name" to "API", "ok" to true, "detail" to repeat("x", 301))), List(9) { mapOf("name" to "API", "ok" to true) }, listOf(null),
        )
        for (checks in bad) assertFalse("$checks", isEngineEvent(if (checks == null) obj("type" to "health") else obj("type" to "health", "checks" to checks)))
        assertFalse(isEngineEvent(obj("type" to "nope")))
        for (v in listOf(null, "servers", 1, emptyList<Any>())) assertFalse(isEngineEvent(json(v)))
    }

    private fun http(vararg over: Pair<String, Any?>) = mapOf("url" to "https://x.test/", "method" to "GET", "headers" to emptyMap<String, Any>()) + over

    @Test
    fun httpRequests() {
        for (method in listOf("GET", "HEAD", "POST", "PUT", "PATCH", "DELETE")) assertTrue(isHttpRequest(json(http("method" to method))))
        assertTrue(isHttpRequest(json(http("headers" to mapOf("X-Custom-1" to "v"), "body" to "text"))))
        assertTrue(isHttpRequest(json(http("body" to ByteArray(3)))))
        assertTrue(isHttpRequest(json(http("headers" to (0 until 50).associate { "h$it" to "v" }))))
        val bad = listOf(
            "x", http("url" to ""), http("url" to repeat("h", 8193)), http("method" to "get"), http("method" to "TRACE"), http("method" to 1),
            http("headers" to emptyList<Any>()), http("headers" to mapOf("bad name" to "v")), http("headers" to mapOf("" to "v")),
            http("headers" to mapOf(repeat("h", 65) to "v")), http("headers" to mapOf("a" to 1)), http("headers" to mapOf("a" to repeat("v", 8193))),
            http("headers" to (0 until 51).associate { "h$it" to "v" }), http("body" to 5), http("body" to listOf(1)),
            // A broken bytes envelope is no body either.
            http("body" to mapOf(Wire.BYTES to "abc")), http("body" to mapOf(Wire.BYTES to "AAAA", "x" to 1)),
        )
        for (r in bad) assertFalse("$r", isHttpRequest(json(r)))
        assertFalse(isHttpRequest(json(http("body" to repeat("a", MAX_HTTP_BODY + 1)))))
        assertFalse(isHttpRequest(json(http("body" to ByteArray(MAX_HTTP_BODY + 1)))))
        assertTrue(isHttpRequest(json(http("body" to ByteArray(MAX_HTTP_BODY)))))
    }

    @Test
    fun simpleRequests() {
        for (r in listOf(obj("type" to "info"), obj("type" to "pickFiles"), obj("type" to "secretLoad", "key" to "k"), obj("type" to "secretDelete", "key" to "k"),
            obj("type" to "secretSave", "key" to "k", "value" to ""), obj("type" to "http", "request" to http()))) {
            assertTrue("$r", isEngineRequest(r))
        }
        assertFalse(isEngineRequest(obj("type" to "secretLoad", "key" to "")))
        assertFalse(isEngineRequest(obj("type" to "secretDelete")))
        assertFalse(isEngineRequest(obj("type" to "secretSave", "key" to "", "value" to "v")))
        assertFalse(isEngineRequest(obj("type" to "secretSave", "key" to "k")))
        assertFalse(isEngineRequest(obj("type" to "secretSave", "key" to "k", "value" to repeat("v", MAX_SECRET + 1))))
        assertTrue(isEngineRequest(obj("type" to "secretSave", "key" to "k", "value" to repeat("v", MAX_SECRET))))
        assertFalse(isEngineRequest(obj("type" to "http", "request" to http("url" to ""))))
        assertFalse(isEngineRequest(obj("type" to "nope")))
        for (v in listOf(null, "info", emptyList<Any>())) assertFalse(isEngineRequest(json(v)))
    }

    @Test
    fun readFileSsoAndHostLocks() {
        fun read(vararg over: Pair<String, Any?>) = json(mapOf("type" to "readFile", "handle" to "h", "start" to 0, "end" to 10) + over)
        assertTrue(isEngineRequest(read()))
        assertTrue(isEngineRequest(read("start" to 5, "end" to 5)))
        assertTrue(isEngineRequest(read("start" to 0, "end" to MAX_READ)))
        for (r in listOf(read("end" to MAX_READ + 1), read("start" to 6, "end" to 5), read("start" to -1), read("end" to 1.5), read("handle" to ""), read("handle" to repeat("h", 65)))) {
            assertFalse("$r", isEngineRequest(r))
        }
        assertTrue(isEngineRequest(obj("type" to "ssoSignIn", "url" to "https://hs.x.org/_matrix/client/v3/login/sso/redirect")))
        for (url in listOf("", 5, repeat("x", 2049))) assertFalse(isEngineRequest(obj("type" to "ssoSignIn", "url" to url)))
        assertTrue(isEngineRequest(obj("type" to "lockHosts", "hosts" to listOf("api.stoat.chat", "*.stoatusercontent.com"))))
        for (hosts in listOf(emptyList<Any>(), "x.com", listOf("localhost"), listOf("API.x.com"), listOf("*.*.x.com"), listOf("x.com/path"), listOf("https://x.com"), listOf(5), List(MAX_LOCKED_HOSTS + 1) { "x.com" })) {
            assertFalse("$hosts", isEngineRequest(obj("type" to "lockHosts", "hosts" to hosts)))
        }
    }

    @Test
    fun socketRequests() {
        assertTrue(isEngineRequest(obj("type" to "socketOpen", "url" to "wss://gateway.example/?v=1")))
        assertFalse(isEngineRequest(obj("type" to "socketOpen", "url" to "")))
        assertFalse(isEngineRequest(obj("type" to "socketOpen", "url" to repeat("x", 8193))))
        val good = listOf(listOf("binary"), listOf("v1.json", "x-a_b~c!#\$%&'*+^`|"), listOf(repeat("p", MAX_SOCKET_PROTOCOL)), List(MAX_SOCKET_PROTOCOLS) { "p$it" })
        for (protocols in good) assertTrue("$protocols", isEngineRequest(obj("type" to "socketOpen", "url" to "wss://a.example/", "protocols" to protocols)))
        val bad = listOf(emptyList<Any>(), "binary", listOf(""), listOf("a b"), listOf("a,b"), listOf("a/b"), listOf("a\"b"), listOf("caf" + cp(0xe9)), listOf(cp(10)),
            listOf(repeat("p", MAX_SOCKET_PROTOCOL + 1)), listOf("x", "x"), listOf(1), List(MAX_SOCKET_PROTOCOLS + 1) { "p$it" })
        for (protocols in bad) assertFalse("$protocols", isEngineRequest(obj("type" to "socketOpen", "url" to "wss://a.example/", "protocols" to protocols)))
        assertTrue(isEngineRequest(obj("type" to "socketSend", "id" to "1", "data" to "hello")))
        assertTrue(isEngineRequest(obj("type" to "socketSend", "id" to "1", "data" to byteArrayOf(1))))
        assertFalse(isEngineRequest(obj("type" to "socketSend", "id" to "1", "data" to repeat("x", MAX_SOCKET_FRAME + 1))))
        assertFalse(isEngineRequest(obj("type" to "socketSend", "id" to "1", "data" to ByteArray(MAX_SOCKET_FRAME + 1))))
        assertFalse(isEngineRequest(obj("type" to "socketSend", "id" to "1", "data" to listOf(1, 2))))
        assertFalse(isEngineRequest(obj("type" to "socketSend", "id" to "../1", "data" to "x")))
        assertFalse(isEngineRequest(obj("type" to "socketSend", "id" to 1, "data" to "x")))
        assertTrue(isEngineRequest(obj("type" to "socketClose", "id" to "1")))
        assertTrue(isEngineRequest(obj("type" to "socketClose", "id" to "1", "code" to 1000, "reason" to "bye")))
        assertTrue(isEngineRequest(obj("type" to "socketClose", "id" to "1", "code" to 4999, "reason" to repeat("r", MAX_CLOSE_REASON))))
        for (code in listOf(1001, 1006, 2999, 5000, 3000.5, "1000")) assertFalse("$code", isEngineRequest(obj("type" to "socketClose", "id" to "1", "code" to code)))
        assertFalse(isEngineRequest(obj("type" to "socketClose", "id" to "1", "reason" to repeat("r", MAX_CLOSE_REASON + 1))))
        assertFalse(isEngineRequest(obj("type" to "socketClose", "id" to "1", "reason" to cp(0xe9).repeat(62))))
        assertFalse(isEngineRequest(obj("type" to "socketClose", "id" to "1", "reason" to 5)))
    }

    @Test
    fun nativeActions() {
        val good = listOf(
            obj("type" to "ready"), obj("type" to "cancelMfa"), obj("type" to "loadOlder"), obj("type" to "typing"), obj("type" to "logout"),
            obj("type" to "login", "identity" to "a@b.c", "password" to "pw"), obj("type" to "mfa", "code" to "123456"), obj("type" to "select", "channelId" to "123"),
            obj("type" to "send", "content" to "hi"), obj("type" to "send", "content" to ""), obj("type" to "attach"), obj("type" to "removeAttachment", "index" to 0),
            obj("type" to "send", "content" to repeat("x", MAX_MESSAGE_LENGTH)), obj("type" to "send", "content" to "hi", "replyTo" to "5"),
            obj("type" to "edit", "messageId" to "5", "content" to "new"), obj("type" to "delete", "messageId" to "5"),
            obj("type" to "react", "messageId" to "5", "emoji" to cp(0x1f44d), "add" to true), obj("type" to "react", "messageId" to "5", "emoji" to "party:55", "add" to false),
            obj("type" to "createPost", "name" to "Idea", "content" to "body"), obj("type" to "mute", "channelId" to "5", "mute" to true),
            obj("type" to "archive", "channelId" to "5", "archive" to false), obj("type" to "joinVoice", "channelId" to "5"), obj("type" to "leaveVoice"),
            obj("type" to "voiceState", "mute" to true, "deaf" to false, "video" to false, "stream" to false), obj("type" to "voiceError", "message" to "ICE failed"),
            obj("type" to "voiceNotice", "message" to "No camera", "off" to "video"), obj("type" to "prompt", "id" to "homeserver", "values" to mapOf("server" to "matrix.org")),
            obj("type" to "cancelPrompt", "id" to "sign-in"), obj("type" to "select", "channelId" to "01ARZ3NDEKTSV4RRFFQ69G5FAV"),
            obj("type" to "joinAddress", "address" to "#room:matrix.org"), obj("type" to "loadMedia", "key" to "mxc:a.b_c-1"), obj("type" to "profile", "id" to "@me:matrix.org"),
            obj("type" to "createPoll", "question" to "Q?", "answers" to listOf("a", "b"), "multiple" to false), obj("type" to "vote", "messageId" to "5", "options" to listOf("a1", "b2")),
            obj("type" to "loadMembers", "offset" to 100_000), obj("type" to "thread"), obj("type" to "folder", "id" to "f_1"),
        )
        for (a in good) assertTrue("$a", isNativeAction(a))
        val bad = listOf(
            JsonNull, json("login"), obj("type" to "unknown"), obj("type" to "login", "identity" to "", "password" to "pw"),
            obj("type" to "login", "identity" to "a", "password" to repeat("x", 1025)), obj("type" to "login", "identity" to repeat("x", 321), "password" to "pw"),
            obj("type" to "mfa", "code" to ""), obj("type" to "mfa", "code" to 123456), obj("type" to "select", "channelId" to "../x"), obj("type" to "select"),
            obj("type" to "send", "content" to 5), obj("type" to "removeAttachment", "index" to 10), obj("type" to "removeAttachment", "index" to 1.5),
            obj("type" to "removeAttachment"), obj("type" to "send", "content" to repeat("x", MAX_MESSAGE_LENGTH + 1)), obj("type" to "send", "content" to "hi", "replyTo" to "x"),
            obj("type" to "edit", "messageId" to "5", "content" to " "), obj("type" to "edit", "messageId" to "5", "content" to cp(0xfeff)),
            obj("type" to "edit", "messageId" to "x", "content" to "new"), obj("type" to "delete"), obj("type" to "react", "messageId" to "5", "emoji" to "", "add" to true),
            obj("type" to "react", "messageId" to "5", "emoji" to repeat("x", 65), "add" to true), obj("type" to "react", "messageId" to "5", "emoji" to cp(0x1f44d)),
            obj("type" to "createPost", "name" to " ", "content" to "body"), obj("type" to "createPost", "name" to repeat("x", 101), "content" to "body"),
            obj("type" to "createPost", "name" to "Idea", "content" to ""), obj("type" to "mute", "channelId" to "x", "mute" to true), obj("type" to "mute", "channelId" to "5"),
            obj("type" to "archive", "channelId" to "5", "archive" to 1), obj("type" to "joinVoice", "channelId" to "x"),
            obj("type" to "voiceState", "mute" to true, "deaf" to false, "video" to false), obj("type" to "voiceError", "message" to ""),
            obj("type" to "voiceNotice", "message" to "x", "off" to "mute"), obj("type" to "joinAddress", "address" to "a b"), obj("type" to "joinAddress", "address" to "a" + cp(0x2028)),
            obj("type" to "joinAddress", "address" to "a" + cp(0x200b)), obj("type" to "createPoll", "question" to "Q", "answers" to listOf("a", " a"), "multiple" to false),
            obj("type" to "createPoll", "question" to "Q" + cp(7), "answers" to listOf("a", "b"), "multiple" to false), obj("type" to "vote", "messageId" to "5", "options" to listOf("a", "a")),
            obj("type" to "loadMembers", "offset" to 100_001), obj("type" to "prompt", "id" to "x", "values" to mapOf("bad-name" to "v")),
            obj("type" to "sendFile", "file" to mapOf("handle" to "h", "name" to "n", "size" to 1, "type" to "t")),
        )
        for (a in bad) assertFalse("$a", isNativeAction(a))
    }

    @Test
    fun wireBytes() {
        val bytes = byteArrayOf(0, 1, 2, -1)
        assertEquals(4, Wire.bytesLength(Wire.bytes(bytes)))
        assertTrue(Wire.decodeBytes(Wire.bytes(bytes))!!.contentEquals(bytes))
        assertEquals(null, Wire.decodeBytes(obj(Wire.BYTES to "!!!!")))
        assertEquals(null, Wire.parse("{"))
        assertEquals(json(mapOf("a" to 1)), Wire.parse("{\"a\":1}"))
        assertEquals(3, Validators.utf8Length("abc"))
        assertEquals(4, Validators.utf8Length(cp(0x1f44d)))
        // A lone surrogate, as TextEncoder writes it: U+FFFD.
        assertEquals(3, Validators.utf8Length(String(charArrayOf(0xd800.toChar()))))
    }
}
