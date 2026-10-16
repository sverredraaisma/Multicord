// Multicord for Android. Copyright (C) 2026 Multicord contributors. AGPL-3.0-or-later, see LICENSE at the repo root.
package app.multicord.engine

import app.multicord.net.EngineNet
import app.multicord.net.WebUrl
import java.io.IOException
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okio.ByteString
import okio.ByteString.Companion.toByteString

/**
 * Opens the sockets EngineSockets has allowed, on OkHttp with the engines' client (PublicDns refuses names
 * that resolve to local or private addresses when the connection is made; no proxy, no cookies). Its events
 * are handed to `post`, which runs them on the thread EngineSockets lives on. On the desktop the engine's
 * relay page does this job (src/main/webSockets.ts).
 */
class OkHttpSockets(
    private val post: (Runnable) -> Unit,
    private val client: OkHttpClient = EngineNet.client,
) {
    fun connect(url: String, events: RelaySocketEvents, protocols: List<String>?): RelaySocket {
        val parsed = WebUrl.parse(url) ?: throw IOException("not a valid URL")
        val httpUrl = EngineNet.toHttpUrl(parsed) ?: throw IOException("not a valid URL")
        val request = Request.Builder().url(httpUrl).apply {
            if (!protocols.isNullOrEmpty()) header("Sec-WebSocket-Protocol", protocols.joinToString(", "))
        }.build()
        var done = false
        fun finish(code: Int, reason: String) = post(Runnable {
            if (done) return@Runnable
            done = true
            events.close(code, reason)
        })
        val socket = client.newWebSocket(request, object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) {
                val chosen = response.header("Sec-WebSocket-Protocol")
                post(Runnable { if (!done) events.open(chosen) })
            }

            override fun onMessage(webSocket: WebSocket, text: String) = post(Runnable { if (!done) events.message(Frame.Text(text)) })

            override fun onMessage(webSocket: WebSocket, bytes: ByteString) {
                val data = bytes.toByteArray()
                post(Runnable { if (!done) events.message(Frame.Binary(data)) })
            }

            override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
                // Answer the server's close, as a browser does.
                webSocket.close(1000, null)
            }

            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) = finish(code, reason)

            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) = finish(1006, "")
        })
        return object : RelaySocket {
            override fun send(frame: Frame) {
                when (frame) {
                    is Frame.Text -> socket.send(frame.text)
                    is Frame.Binary -> socket.send(frame.bytes.toByteString())
                }
            }

            override fun close(code: Int?, reason: String?) {
                done = true
                try {
                    if (!socket.close(code ?: 1000, reason)) socket.cancel()
                } catch (_: IllegalArgumentException) {
                    socket.cancel()
                }
            }

            override val bufferedAmount: Long get() = socket.queueSize()
        }
    }
}
