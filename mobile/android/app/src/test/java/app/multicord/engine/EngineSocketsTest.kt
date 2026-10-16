// Multicord for Android. Copyright (C) 2026 Multicord contributors. AGPL-3.0-or-later, see LICENSE at the repo root.
package app.multicord.engine

import app.multicord.bridge.Limits
import app.multicord.bridge.Validators
import app.multicord.net.NetPolicy
import app.multicord.net.UrlPolicy
import java.io.IOException
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

/** EngineSockets with a scripted network, as tests/core/engineSockets.test.ts tests the desktop's. */
class EngineSocketsTest {
    private class Fake(val url: String, val events: RelaySocketEvents, val protocols: List<String>?) : RelaySocket {
        val sent = ArrayList<Frame>()
        var closed: Pair<Int?, String?>? = null
        var buffered = 0L
        override fun send(frame: Frame) {
            sent.add(frame)
        }
        override fun close(code: Int?, reason: String?) {
            closed = code to reason
        }
        override val bufferedAmount get() = buffered
    }

    private val emitted = ArrayList<JsonObject>()
    private val opened = ArrayList<Fake>()
    private val policy = UrlPolicy(listOf("wss:"), listOf("*.example.com"))
    private val sockets = EngineSockets(
        check = { NetPolicy.checkUrl(it, policy)?.message },
        connect = { url, events, protocols -> Fake(url, events, protocols).also { opened.add(it) } },
        emit = { emitted.add(it) },
    )

    private fun JsonObject.text(key: String) = (this[key] as JsonPrimitive).content

    @Test
    fun opensRelaysAndCloses() {
        val id = sockets.open("wss://gw.example.com/?v=1", listOf("binary", "json"))
        assertEquals(listOf("binary", "json"), opened[0].protocols)
        // Frames before open are refused.
        assertThrows(IOException::class.java) { sockets.send(id, Frame.Text("early")) }
        opened[0].events.open("binary")
        assertEquals("open", emitted[0].text("type"))
        assertEquals("binary", emitted[0].text("protocol"))
        sockets.send(id, Frame.Text("hi"))
        assertEquals("hi", (opened[0].sent[0] as Frame.Text).text)
        opened[0].events.message(Frame.Binary(byteArrayOf(1, 2)))
        assertEquals("message", emitted[1].text("type"))
        // Every event the engine gets is one its own checks accept.
        for (event in emitted) assertTrue(event.toString(), isSocketEvent(event))
        sockets.close(id, 4000, "bye")
        assertEquals(4000 to "bye", opened[0].closed)
        assertEquals("close", emitted.last().text("type"))
        assertEquals("4000", emitted.last().text("code"))
        // Late events from a closed socket go nowhere.
        val count = emitted.size
        opened[0].events.message(Frame.Text("late"))
        opened[0].events.close(1000, "")
        assertEquals(count, emitted.size)
        assertEquals(0, sockets.size)
    }

    @Test
    fun reportsOnlyAnOfferedSubprotocol() {
        sockets.open("wss://gw.example.com/", listOf("a"))
        opened[0].events.open("b")
        assertEquals(null, emitted[0]["protocol"])
    }

    @Test
    fun refusesWhatThePolicyRefusesAndCapsSockets() {
        for (url in listOf("ws://gw.example.com/", "wss://evil.org/", "wss://127.0.0.1/", "wss://[::1]/", "https://gw.example.com/", "nope")) {
            assertThrows(url, IOException::class.java) { sockets.open(url, null) }
        }
        assertTrue(opened.isEmpty())
        repeat(Limits.MAX_SOCKETS) { sockets.open("wss://gw.example.com/", null) }
        assertThrows(IOException::class.java) { sockets.open("wss://gw.example.com/", null) }
        opened[0].events.close(1006, "")
        sockets.open("wss://gw.example.com/", null)
    }

    @Test
    fun capsFramesAndTheSendQueue() {
        val id = sockets.open("wss://gw.example.com/", null)
        opened[0].events.open(null)
        opened[0].buffered = Limits.MAX_SOCKET_QUEUE - 1L
        assertThrows(IOException::class.java) { sockets.send(id, Frame.Text("xx")) }
        sockets.send(id, Frame.Text("x"))
        opened[0].events.message(Frame.Binary(ByteArray(Limits.MAX_SOCKET_FRAME + 1)))
        assertEquals("1009", emitted.last().text("code"))
        assertEquals(null to null, opened[0].closed)
        assertEquals(0, sockets.size)
    }

    @Test
    fun closeAllTellsTheEngineNothing() {
        sockets.open("wss://gw.example.com/", null)
        sockets.open("wss://gw.example.com/", null)
        sockets.closeAll()
        assertTrue(opened.all { it.closed != null })
        assertTrue(emitted.isEmpty())
        assertThrows(IOException::class.java) { sockets.send("1", Frame.Text("x")) }
    }

    @Test
    fun aConnectorThatThrowsIsARefusal() {
        val failing = EngineSockets({ null }, { _, _, _ -> throw IllegalStateException("no network") }, { emitted.add(it) })
        val error = assertThrows(IOException::class.java) { failing.open("wss://gw.example.com/", null) }
        assertEquals("Socket refused: no network", error.message)
        assertEquals(0, failing.size)
    }

    /** isEngineSocketEvent from src/shared/engine.ts, which the engine runs on every event. */
    private fun isSocketEvent(event: JsonObject): Boolean {
        val id = event["id"] as? JsonPrimitive ?: return false
        if (!id.isString || !Regex("^[a-z0-9-]{1,64}$").matches(id.content)) return false
        return when (event.text("type")) {
            "open" -> event["protocol"] == null || Validators.isSocketProtocol(event["protocol"])
            "message" -> Validators.isFrame(event["data"])
            "close" -> event.text("code").toInt() in 1000..4999 && Validators.isText(event["reason"], Limits.MAX_CLOSE_REASON)
            else -> false
        }
    }
}
