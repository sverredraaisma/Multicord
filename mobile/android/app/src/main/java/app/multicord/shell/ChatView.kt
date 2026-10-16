// Multicord for Android. Copyright (C) 2026 Multicord contributors. AGPL-3.0-or-later, see LICENSE at the repo root.
package app.multicord.shell

import android.content.Context
import android.net.Uri
import android.os.Handler
import android.os.Looper
import android.util.Log
import android.webkit.ConsoleMessage
import android.webkit.PermissionRequest
import android.webkit.RenderProcessGoneDetail
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.webkit.JavaScriptReplyProxy
import androidx.webkit.ProfileStore
import androidx.webkit.WebMessageCompat
import androidx.webkit.WebViewCompat
import app.multicord.BuildConfig
import app.multicord.bridge.BridgeScripts
import app.multicord.bridge.Wire
import app.multicord.call.AudioRoute
import app.multicord.call.Call
import app.multicord.engine.OkHttpSockets
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.longOrNull

/**
 * One instance's chat view: Multicord's native chat view (native.html), served from
 * https://<instance>.view.multicord.invalid in a Profile of its own (as the desktop gives each service its
 * own session), so no instance's view shares storage or an origin with another's, the shell page's or any
 * engine's. It holds no service credentials. It gets display state from its own engine only, and its user
 * actions go to native code, which checks them and hands them to that engine alone. What it loads from the
 * network (pictures, media) may come only from public hosts its engine may reach, as on the desktop; its
 * calls' WebSockets are opened by native code with the same policy as the engine's own (ViewSockets).
 */
class ChatView(
    private val context: Context,
    val instanceId: String,
    /** An action from the view, not yet validated: the caller checks it with isNativeAction. */
    private val onAction: (JsonElement?) -> Unit,
    /** The view's answer to a back press: whether it used it. */
    private val onBack: (id: Long, handled: Boolean) -> Unit,
    /** The hosts this instance's engine may reach now; null for any public host. */
    private val viewHosts: () -> List<String>?,
    /** The page asks for the camera or microphone (a call); the caller decides (CallPolicy) and grants or denies. */
    private val onPermission: (PermissionRequest) -> Unit,
    /** The user picked where the call plays, not yet checked: the caller takes only a route it offered. */
    private val onRoute: (AudioRoute) -> Unit,
) {
    private val host = "$instanceId.view.multicord.invalid"
    /** The view's own origin: the only one its permission requests may come from. */
    val origin = "https://$host"
    var webView: WebView? = null
        private set
    private var proxy: JavaScriptReplyProxy? = null
    /** What the view shows, kept for a view that (re)loads: its engine's last state, and its media limit. */
    private var state: JsonObject? = null
    private var media: JsonElement? = null
    private var routes: JsonObject? = null
    private val main = Handler(Looper.getMainLooper())
    /** The view's call sockets (LiveKit's signalling): opened here, only while its engine reports a call. */
    private val sockets = ViewSockets(
        hosts = viewHosts,
        inCall = { Call.of(instanceId, state) != null },
        connect = OkHttpSockets({ main.post(it) })::connect,
        emit = { post("socket", it) },
    )

    /** Whether the view's page is up and can answer (a back press, say). */
    val ready: Boolean get() = proxy != null

    fun start() {
        val view = WebView(context)
        val profile = profileName(instanceId)
        ProfileStore.getInstance().getOrCreateProfile(profile)
        WebViewCompat.setProfile(view, profile)
        Pages.configure(view)
        view.webViewClient = Client()
        view.webChromeClient = object : WebChromeClient() {
            // Calls: the camera and microphone, as CallPolicy allows them for this view's own call.
            override fun onPermissionRequest(request: PermissionRequest) = onPermission(request)

            override fun onConsoleMessage(message: ConsoleMessage): Boolean {
                if (BuildConfig.DEBUG) Log.d(TAG, "[view $instanceId] ${message.messageLevel()} ${message.message().take(500)}")
                return true
            }
        }
        val world = BridgeScripts.install(context, view, LISTENER, CHANNEL, "bridge/view.js", setOf(origin)) { source, message, sourceOrigin, isMainFrame, replyProxy ->
            if (source !== webView || !isMainFrame || sourceOrigin.toString() != origin) return@install
            if (message.type != WebMessageCompat.TYPE_STRING) return@install
            val parsed = Wire.parse(message.data ?: return@install) as? JsonObject ?: return@install
            if (proxy !== replyProxy) {
                proxy = replyProxy
                // A view that has just loaded gets what it missed.
                media?.let { post("media", it) }
                state?.let { post("state", it) }
                routes?.let { post("routes", it) }
            }
            when ((parsed["k"] as? JsonPrimitive)?.content) {
                "act" -> onAction(parsed["body"])
                "route" -> AudioRoute.of((parsed["route"] as? JsonPrimitive)?.takeIf { it.isString }?.content)?.let(onRoute)
                "socket" -> {
                    val n = (parsed["n"] as? JsonPrimitive)?.takeIf { !it.isString }?.longOrNull?.takeIf { it in 1..MAX_REQUEST } ?: return@install
                    val answer = sockets.handle(parsed["body"])
                    answer.exceptionOrNull()?.let { Log.w(TAG, "[view $instanceId] socket request refused: ${it.message}") }
                    send(socketDone(n, answer))
                }
                "back" -> {
                    val id = (parsed["id"] as? JsonPrimitive)?.takeIf { !it.isString }?.longOrNull ?: return@install
                    onBack(id, (parsed["handled"] as? JsonPrimitive)?.content == "true")
                }
            }
        }
        Log.i(TAG, "[view $instanceId] bridge relay in the $world")
        webView = view
        view.loadUrl("$origin/native.html")
    }

    /** The engine's display state, for the view. */
    fun showState(state: JsonObject) {
        this.state = state
        post("state", state)
    }

    /** The service's limit for media that loads by itself, in bytes; JsonNull for any size. */
    fun mediaAutoLoad(limit: JsonElement) {
        media = limit
        post("media", limit)
    }

    /** Where the view's call plays now and where it could (AudioRoute.report). */
    fun audioRoutes(report: JsonObject) {
        routes = report
        post("routes", report)
    }

    /** Asks the view whether it can go back; it answers through onBack with this id. */
    fun back(id: Long) {
        send(JsonObject(mapOf("k" to JsonPrimitive("back"), "id" to JsonPrimitive(id))))
    }

    private fun post(kind: String, body: JsonElement) {
        send(JsonObject(mapOf("k" to JsonPrimitive(kind), "body" to body)))
    }

    /** To the view's page, while it is up. */
    private fun send(message: JsonObject) {
        proxy?.postMessage(message.toString())
    }

    fun destroy() {
        sockets.closeAll()
        webView?.let {
            (it.parent as? android.view.ViewGroup)?.removeView(it)
            it.destroy()
        }
        webView = null
        proxy = null
    }

    private inner class Client : WebViewClient() {
        override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? = serve(request.url, request.method)

        override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
            Pages.openOutside(context, request)
            return true
        }

        override fun onPageStarted(view: WebView, url: String?, favicon: android.graphics.Bitmap?) {
            if (view !== webView) return
            proxy = null
            // The page that opened them is gone.
            sockets.closeAll()
        }

        override fun onRenderProcessGone(view: WebView, detail: RenderProcessGoneDetail): Boolean {
            if (view !== webView) return true
            Log.w(TAG, "[view $instanceId] renderer gone (crash: ${detail.didCrash()}); reloading")
            val parent = view.parent as? android.view.ViewGroup
            val at = parent?.indexOfChild(view) ?: -1
            val params = view.layoutParams
            destroy()
            start()
            if (parent != null) parent.addView(webView, at, params)
            return true
        }
    }

    /** Our own files on the view's origin; https pictures and media from public hosts the engine may reach; nothing else. */
    private fun serve(url: Uri, method: String): WebResourceResponse? {
        val hosts = viewHosts()
        val csp = ViewCsp.of(hosts)
        if (url.scheme == "https" && url.host == host) return Pages.serve(context, FILES, url, method, csp)
        if (!Pages.mayLoad(url, hosts)) return Pages.blocked(csp)
        return null
    }

    companion object {
        private const val TAG = "Multicord"
        private const val LISTENER = "multicordView"
        /** The events view.js and the relay exchange (view.js has the same name). */
        private const val CHANNEL = "multicord-view"

        /** Socket requests are numbered by the page from 1; as Number.MAX_SAFE_INTEGER. */
        private const val MAX_REQUEST = 9007199254740991L

        /** The answer to the view's socket request number `n`. */
        fun socketDone(n: Long, answer: Result<JsonElement?>): JsonObject {
            val fields = mutableMapOf<String, JsonElement>("k" to JsonPrimitive("socketDone"), "n" to JsonPrimitive(n), "ok" to JsonPrimitive(answer.isSuccess))
            answer.onSuccess { fields["value"] = it ?: JsonNull }
            answer.onFailure { fields["error"] = JsonPrimitive(it.message ?: "Socket request failed") }
            return JsonObject(fields)
        }

        /** The Profile an instance's chat view keeps its web storage in. */
        fun profileName(instanceId: String) = "view-$instanceId"

        /** What a view's origin serves: path -> (asset under web/shell, type). */
        private val FILES = mapOf(
            "/native.html" to ("native.html" to "text/html"),
            "/native.js" to ("native.js" to "text/javascript"),
            "/native.css" to ("native.css" to "text/css"),
            "/shell.css" to ("shell.css" to "text/css"),
            "/audio/rnnoise-worklet.js" to ("audio/rnnoise-worklet.js" to "text/javascript"),
            "/livekit-e2ee-worker.js" to ("livekit-e2ee-worker.js" to "text/javascript"),
        )
    }
}
