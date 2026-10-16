// Multicord for Android. Copyright (C) 2026 Multicord contributors. AGPL-3.0-or-later, see LICENSE at the repo root.
package app.multicord.engine

import app.multicord.bridge.Limits
import app.multicord.bridge.Wire
import java.io.IOException
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

/** A WebSocket frame: text, or bytes. Its size counts characters or bytes, as MAX_SOCKET_FRAME does. */
sealed class Frame {
    abstract val size: Int

    class Text(val text: String) : Frame() {
        override val size get() = text.length
    }

    class Binary(val bytes: ByteArray) : Frame() {
        override val size get() = bytes.size
    }

    /** As an EngineSocketEvent's or socketSend's `data`. */
    fun toJson(): JsonElement = when (this) {
        is Text -> JsonPrimitive(text)
        is Binary -> Wire.bytes(bytes)
    }

    companion object {
        /** A validated socketSend `data`; null for anything else. */
        fun of(data: JsonElement?): Frame? {
            if (data is JsonPrimitive && data.isString) return Text(data.content)
            return Wire.decodeBytes(data)?.let(::Binary)
        }
    }
}

/** One socket the host opened. */
interface RelaySocket {
    fun send(frame: Frame)

    /** Without a code: closes as the engine would expect a browser to, with 1000. */
    fun close(code: Int? = null, reason: String? = null)

    /** What is waiting to be sent, as for MAX_SOCKET_QUEUE. */
    val bufferedAmount: Long
}

/** What the host reports of a socket it opened; delivered on the thread EngineSockets runs on. */
interface RelaySocketEvents {
    /** `protocol`: the subprotocol the server chose, if any. */
    fun open(protocol: String?)
    fun message(frame: Frame)

    /** Once, when the socket is closed for good or could not connect. */
    fun close(code: Int, reason: String)
}

/**
 * One engine's bridged WebSockets: the native side of bridgeWebSocket (src/engine/runtime.ts), ported from
 * src/core/engineSockets.ts with its rules and caps. The host opens each socket itself, only where the
 * engine's policy allows, and relays frames both ways: at most MAX_SOCKETS at a time, frames within
 * MAX_SOCKET_FRAME, and no more than MAX_SOCKET_QUEUE waiting to be sent. The engine names sockets only by
 * the ids handed out here, so it can never reach another engine's. Not thread-safe: use it on one thread.
 */
class EngineSockets(
    /** Why the engine may not open a socket to `url` now, or null. */
    private val check: (url: String) -> String?,
    private val connect: (url: String, events: RelaySocketEvents, protocols: List<String>?) -> RelaySocket,
    /** Sends the engine an EngineSocketEvent. */
    private val emit: (JsonObject) -> Unit,
) {
    private class Entry {
        var socket: RelaySocket? = null
        var open = false
    }

    private val sockets = LinkedHashMap<String, Entry>()
    private var next = 0

    val size get() = sockets.size

    /** Opens a socket and answers with its id; throws when it is refused. */
    @Throws(IOException::class)
    fun open(url: String, protocols: List<String>?): String {
        if (sockets.size >= Limits.MAX_SOCKETS) throw IOException("An engine may have at most ${Limits.MAX_SOCKETS} sockets open")
        check(url)?.let { throw IOException("Socket refused: $it") }
        val id = (++next).toString()
        val entry = Entry()
        sockets[id] = entry
        fun live() = sockets[id] === entry
        try {
            entry.socket = connect(url, object : RelaySocketEvents {
                override fun open(protocol: String?) {
                    if (!live()) return
                    entry.open = true
                    // Only a subprotocol the engine offered, as a page's WebSocket would allow.
                    val chosen = protocol?.takeIf { protocols?.contains(it) == true }
                    emit(event("open", id, if (chosen != null) mapOf("protocol" to JsonPrimitive(chosen)) else emptyMap()))
                }

                override fun message(frame: Frame) {
                    if (!live()) return
                    if (frame.size <= Limits.MAX_SOCKET_FRAME) return emit(event("message", id, mapOf("data" to frame.toJson())))
                    sockets.remove(id)
                    entry.socket?.close()
                    emit(closeEvent(id, TOO_BIG, "Frame too large"))
                }

                override fun close(code: Int, reason: String) {
                    if (!live()) return
                    sockets.remove(id)
                    emit(closeEvent(id, code, reason))
                }
            }, protocols)
        } catch (error: Exception) {
            sockets.remove(id)
            throw IOException("Socket refused: ${error.message}")
        }
        return id
    }

    @Throws(IOException::class)
    fun send(id: String, frame: Frame) {
        val entry = sockets[id]
        if (entry == null || !entry.open) throw IOException("No such open socket")
        val socket = entry.socket!!
        if (socket.bufferedAmount + frame.size > Limits.MAX_SOCKET_QUEUE) throw IOException("The socket's send queue is full")
        socket.send(frame)
    }

    /** Closes one of the engine's sockets; the engine hears of it as a close event. */
    fun close(id: String, code: Int?, reason: String?) {
        val entry = sockets.remove(id) ?: return
        entry.socket?.close(code, reason)
        emit(closeEvent(id, code ?: 1000, reason ?: ""))
    }

    /** Closes every socket without telling the engine, e.g. when it reloads or goes away. */
    fun closeAll() {
        val entries = sockets.values.toList()
        sockets.clear()
        for (entry in entries) entry.socket?.close()
    }

    private fun event(type: String, id: String, extra: Map<String, JsonElement>): JsonObject =
        JsonObject(mapOf("type" to JsonPrimitive(type), "id" to JsonPrimitive(id)) + extra)

    private fun closeEvent(id: String, code: Int, reason: String) =
        event("close", id, mapOf("code" to JsonPrimitive(code), "reason" to JsonPrimitive(reason)))

    private companion object {
        /** The close code the engine hears when a frame was too large, as a WebSocket would report it. */
        const val TOO_BIG = 1009
    }
}
