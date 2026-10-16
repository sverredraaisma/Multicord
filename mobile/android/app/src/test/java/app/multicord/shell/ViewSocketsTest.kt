// Multicord for Android. Copyright (C) 2026 Multicord contributors. AGPL-3.0-or-later, see LICENSE at the repo root.
package app.multicord.shell

import app.multicord.bridge.Limits
import app.multicord.bridge.Wire
import app.multicord.engine.Frame
import app.multicord.engine.RelaySocket
import app.multicord.engine.RelaySocketEvents
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** A chat view's call sockets: the engine sockets' rules, with the engine's hosts as they are at each open and only during a call. */
class ViewSocketsTest {
    private class Fake(val url: String, val events: RelaySocketEvents, val protocols: List<String>?) : RelaySocket {
        val sent = ArrayList<Frame>()
        var closed: Pair<Int?, String?>? = null
        override fun send(frame: Frame) {
            sent.add(frame)
        }
        override fun close(code: Int?, reason: String?) {
            closed = code to reason
        }
        override val bufferedAmount get() = 0L
    }

    private var hosts: List<String>? = listOf("*.livekit.example", "matrix.example")
    private var inCall = true
    private val opened = ArrayList<Fake>()
    private val emitted = ArrayList<JsonObject>()
    private val sockets = ViewSockets(
        hosts = { hosts },
        inCall = { inCall },
        connect = { url, events, protocols -> Fake(url, events, protocols).also { opened.add(it) } },
        emit = { emitted.add(it) },
    )

    private fun request(vararg fields: Pair<String, JsonElement>) = JsonObject(fields.toMap())
    private fun open(url: String, protocols: List<String>? = null) = sockets.handle(
        if (protocols == null) request("type" to JsonPrimitive("socketOpen"), "url" to JsonPrimitive(url))
        else request("type" to JsonPrimitive("socketOpen"), "url" to JsonPrimitive(url), "protocols" to JsonArray(protocols.map(::JsonPrimitive))),
    )
    private fun idOf(answer: Result<JsonElement?>) = ((answer.getOrThrow() as JsonObject)["id"] as JsonPrimitive).content
    private fun JsonObject.text(key: String) = (this[key] as JsonPrimitive).content

    @Test
    fun opensRelaysAndClosesACallsSignallingSocket() {
        val id = idOf(open("wss://eu.livekit.example/rtc?access_token=t", listOf("lk")))
        assertEquals("wss://eu.livekit.example/rtc?access_token=t", opened[0].url)
        assertEquals(listOf("lk"), opened[0].protocols)
        opened[0].events.open("lk")
        assertEquals("open", emitted[0].text("type"))
        assertEquals(id, emitted[0].text("id"))
        assertEquals("lk", emitted[0].text("protocol"))
        // Binary frames both ways, as LiveKit's protobuf signalling has them.
        assertNull(sockets.handle(request("type" to JsonPrimitive("socketSend"), "id" to JsonPrimitive(id), "data" to Wire.bytes(byteArrayOf(8, 1)))).getOrThrow())
        assertTrue((opened[0].sent[0] as Frame.Binary).bytes.contentEquals(byteArrayOf(8, 1)))
        opened[0].events.message(Frame.Binary(byteArrayOf(3)))
        assertEquals("message", emitted[1].text("type"))
        assertEquals(Wire.bytes(byteArrayOf(3)), emitted[1]["data"])
        assertNull(sockets.handle(request("type" to JsonPrimitive("socketClose"), "id" to JsonPrimitive(id), "code" to JsonPrimitive(1000), "reason" to JsonPrimitive("bye"))).getOrThrow())
        assertEquals(1000 to "bye", opened[0].closed)
        assertEquals("close", emitted.last().text("type"))
        assertEquals(0, sockets.size)
    }

    @Test
    fun onlyDuringACall() {
        inCall = false
        assertEquals("Socket refused: no call in progress", open("wss://eu.livekit.example/rtc").exceptionOrNull()!!.message)
        assertTrue(opened.isEmpty())
        inCall = true
        assertTrue(open("wss://eu.livekit.example/rtc").isSuccess)
    }

    @Test
    fun wssOnlyToPublicHostsTheEngineMayReach() {
        for (url in listOf(
            "ws://eu.livekit.example/rtc",
            "https://eu.livekit.example/rtc",
            "wss://elsewhere.example/rtc",
            "wss://127.0.0.1/rtc",
            "wss://[::1]/rtc",
            "wss://10.0.0.2/rtc",
            "wss://sfu.local/rtc",
            "wss://user:pass@eu.livekit.example/rtc",
            "not a url",
        )) {
            assertNotNull(url, open(url).exceptionOrNull())
        }
        assertTrue(opened.isEmpty())
        // Any public host where the engine may reach any.
        hosts = null
        assertTrue(open("wss://sfu.anywhere.example/rtc").isSuccess)
        assertNotNull(open("wss://192.168.1.1/rtc").exceptionOrNull())
    }

    @Test
    fun theEnginesHostsAsTheyAreWhenEachSocketOpens() {
        assertTrue(open("wss://matrix.example/rtc").isSuccess)
        // The engine locked itself since: the next socket follows the lock at once, not at the view's next load.
        hosts = listOf("*.livekit.example")
        assertNotNull(open("wss://matrix.example/rtc").exceptionOrNull())
        assertTrue(open("wss://eu.livekit.example/rtc").isSuccess)
    }

    @Test
    fun theEngineSocketCaps() {
        repeat(Limits.MAX_SOCKETS) { assertTrue(open("wss://eu.livekit.example/rtc").isSuccess) }
        assertNotNull(open("wss://eu.livekit.example/rtc").exceptionOrNull())
        assertEquals(Limits.MAX_SOCKETS, opened.size)
        // A frame over MAX_SOCKET_FRAME closes its socket with 1009.
        opened[0].events.open(null)
        opened[0].events.message(Frame.Text("x".repeat(Limits.MAX_SOCKET_FRAME + 1)))
        assertEquals("1009", emitted.last().text("code"))
        sockets.closeAll()
        assertEquals(0, sockets.size)
        assertTrue(opened.all { it.closed != null || it === opened[0] })
    }

    @Test
    fun onlyWellFormedSocketRequests() {
        val id = idOf(open("wss://eu.livekit.example/rtc"))
        val bad = listOf(
            null,
            JsonNull,
            JsonPrimitive("socketOpen"),
            request("type" to JsonPrimitive("socketOpen")),
            request("type" to JsonPrimitive("socketOpen"), "url" to JsonPrimitive("wss://eu.livekit.example"), "protocols" to JsonArray(listOf(JsonPrimitive("a b")))),
            // Before the socket is open, and to a socket that is not there.
            request("type" to JsonPrimitive("socketSend"), "id" to JsonPrimitive(id), "data" to JsonPrimitive("early")),
            request("type" to JsonPrimitive("socketSend"), "id" to JsonPrimitive("99"), "data" to JsonPrimitive("x")),
            request("type" to JsonPrimitive("socketClose"), "id" to JsonPrimitive(id), "code" to JsonPrimitive(1006)),
            // An engine's requests are no view's.
            request("type" to JsonPrimitive("secretLoad"), "key" to JsonPrimitive("token")),
            request("type" to JsonPrimitive("lockHosts"), "hosts" to JsonArray(listOf(JsonPrimitive("evil.example")))),
            request("type" to JsonPrimitive("info")),
        )
        for (request in bad) assertNotNull(request.toString(), sockets.handle(request).exceptionOrNull())
        assertEquals(1, sockets.size)
        assertEquals(listOf("*.livekit.example", "matrix.example"), hosts)
    }

    @Test
    fun answersTheViewByRequestNumber() {
        assertEquals("""{"k":"socketDone","n":3,"ok":true,"value":{"id":"1"}}""", ChatView.socketDone(3, Result.success(JsonObject(mapOf("id" to JsonPrimitive("1"))))).toString())
        assertEquals("""{"k":"socketDone","n":4,"ok":true,"value":null}""", ChatView.socketDone(4, Result.success(null)).toString())
        assertEquals("""{"k":"socketDone","n":5,"ok":false,"error":"Socket refused: no call in progress"}""", ChatView.socketDone(5, Result.failure(java.io.IOException("Socket refused: no call in progress"))).toString())
    }
}
