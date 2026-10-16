// Multicord for Android. Copyright (C) 2026 Multicord contributors. AGPL-3.0-or-later, see LICENSE at the repo root.
package app.multicord.shell

import app.multicord.bridge.Validators
import app.multicord.engine.EngineSockets
import app.multicord.engine.Frame
import app.multicord.engine.RelaySocket
import app.multicord.engine.RelaySocketEvents
import app.multicord.net.NetPolicy
import app.multicord.net.UrlPolicy
import java.io.IOException
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

/**
 * A chat view's WebSockets: those its calls need (LiveKit's signalling to the voice server). A WebView shows
 * a page's own WebSockets to no request hook, so the view has none (its CSP allows no wss:); its page's
 * WebSocket is one native code opens and relays instead (relayWebSockets in src/renderer, view.js), with the
 * rules an engine's sockets have (EngineSockets: at most MAX_SOCKETS, frames within MAX_SOCKET_FRAME, no more
 * than MAX_SOCKET_QUEUE waiting) and its policy: wss only, to the hosts the view's engine may reach when the
 * socket opens (a host lock the engine set since the page loaded applies at once), public addresses only (the
 * engines' client resolves through PublicDns when it connects), and only while that engine reports a call.
 * WebRTC's media is not a WebSocket (UDP through ICE, or TURN) and does not pass here. Not thread-safe: use
 * it on one thread, the one the connect function delivers events on.
 */
class ViewSockets(
    /** The hosts the view's engine may reach now; null for any public host. Asked at each open. */
    private val hosts: () -> List<String>?,
    /** Whether the view's engine reports a call in progress now (Call.of); sockets open only then. */
    private val inCall: () -> Boolean,
    connect: (url: String, events: RelaySocketEvents, protocols: List<String>?) -> RelaySocket,
    /** Sends the view a socket event, shaped as an EngineSocketEvent. */
    emit: (JsonObject) -> Unit,
) {
    private val sockets = EngineSockets(check = ::refusal, connect = connect, emit = emit)

    val size get() = sockets.size

    /** Why the view may not open a socket to `url` now, or null. */
    fun refusal(url: String): String? {
        if (!inCall()) return "no call in progress"
        return NetPolicy.checkUrl(url, UrlPolicy(listOf("wss:"), hosts()))?.message
    }

    /**
     * A socket request from the view (socketOpen, socketSend or socketClose, as an engine sends them), not yet
     * checked: what to answer, or a failure with the reason (a malformed request among them).
     */
    fun handle(request: JsonElement?): Result<JsonElement?> = runCatching {
        if (!Validators.isEngineRequest(request)) throw IOException("Malformed socket request")
        request as JsonObject
        fun text(key: String) = (request[key] as JsonPrimitive).content
        when (text("type")) {
            "socketOpen" -> {
                val protocols = (request["protocols"] as? JsonArray)?.map { (it as JsonPrimitive).content }
                JsonObject(mapOf("id" to JsonPrimitive(sockets.open(text("url"), protocols))))
            }
            "socketSend" -> {
                sockets.send(text("id"), Frame.of(request["data"]) ?: throw IOException("Malformed socket request"))
                null
            }
            "socketClose" -> {
                sockets.close(text("id"), (request["code"] as? JsonPrimitive)?.content?.toDouble()?.toInt(), (request["reason"] as? JsonPrimitive)?.content)
                null
            }
            // Secrets, HTTP, host locks and the rest are an engine's, never a view's.
            else -> throw IOException("Not a socket request")
        }
    }

    /** Closes every socket without telling the view: it reloads or goes away. */
    fun closeAll() = sockets.closeAll()
}
