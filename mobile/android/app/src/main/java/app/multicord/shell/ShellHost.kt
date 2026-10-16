// Multicord for Android. Copyright (C) 2026 Multicord contributors. AGPL-3.0-or-later, see LICENSE at the repo root.
package app.multicord.shell

import android.content.Context
import android.graphics.Color
import android.net.Uri
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
import app.multicord.bridge.Validators.record
import app.multicord.bridge.Validators.string
import app.multicord.bridge.Wire
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.longOrNull

/**
 * The shell WebView: the page that runs src/core (dist/mobile/shell.html: the registry, the settings and
 * an EngineAdapter per service, the bar, the drawer and the settings page), served from
 * https://shell.multicord.invalid in a Profile of its own. It is the only page with the shell bridge
 * (assets/bridge/shell.js, listener "multicordShellHost", that origin only); no engine and no chat view has it.
 * It holds no service credentials and connects nowhere (connect-src 'none'). Native code hears from it only
 * ShellCommands, each checked with [ShellCommands.isShellCommand], and the one boot request.
 */
class ShellHost(
    private val context: Context,
    /** A command the page sent, already checked. */
    private val onCommand: (JsonObject) -> Unit,
    /** The page's boot request: the answer goes to `reply`. */
    private val onBoot: (reply: (Result<JsonElement>) -> Unit) -> Unit,
) {
    var webView: WebView? = null
        private set
    private var proxy: JavaScriptReplyProxy? = null

    fun start() {
        val view = WebView(context)
        ProfileStore.getInstance().getOrCreateProfile(PROFILE)
        WebViewCompat.setProfile(view, PROFILE)
        Pages.configure(view)
        // The page is see-through over a chat view while its drawer is open; it paints its own background otherwise.
        view.setBackgroundColor(Color.TRANSPARENT)
        // Core runs here, also while the app is in the background.
        view.setRendererPriorityPolicy(WebView.RENDERER_PRIORITY_IMPORTANT, false)
        view.webViewClient = Client()
        view.webChromeClient = object : WebChromeClient() {
            override fun onPermissionRequest(request: PermissionRequest) = request.deny()

            override fun onConsoleMessage(message: ConsoleMessage): Boolean {
                if (BuildConfig.DEBUG) Log.d(TAG, "[shell] ${message.messageLevel()} ${message.message().take(500)}")
                return true
            }
        }
        val world = BridgeScripts.install(context, view, LISTENER, CHANNEL, "bridge/shell.js", setOf(ORIGIN)) { source, message, sourceOrigin, isMainFrame, replyProxy ->
            if (source !== webView || !isMainFrame || sourceOrigin.toString() != ORIGIN) return@install
            if (message.type != WebMessageCompat.TYPE_STRING) return@install
            val parsed = Wire.parse(message.data ?: return@install).record() ?: return@install
            proxy = replyProxy
            receive(parsed, replyProxy)
        }
        Log.i(TAG, "[shell] bridge relay in the $world")
        webView = view
        view.loadUrl("$ORIGIN/shell.html")
    }

    private fun receive(message: JsonObject, from: JavaScriptReplyProxy) {
        when (message["k"].string()) {
            "req" -> {
                val id = (message["id"] as? JsonPrimitive)?.takeIf { !it.isString }?.longOrNull ?: return
                val body = message["body"].record()
                if (body == null || body.size != 1 || body["type"].string() != "boot") return answer(from, id, Result.failure(IllegalArgumentException("Unknown request")))
                onBoot { result -> answer(from, id, result) }
            }
            "cmd" -> {
                val body = message["body"]
                if (!ShellCommands.isShellCommand(body)) {
                    Log.w(TAG, "[shell] dropped a malformed command")
                    return
                }
                onCommand(body as JsonObject)
            }
        }
    }

    private fun answer(to: JavaScriptReplyProxy, id: Long, result: Result<JsonElement>) {
        if (to !== proxy) return
        val message = HashMap<String, JsonElement>()
        message["k"] = JsonPrimitive("res")
        message["id"] = JsonPrimitive(id)
        message["ok"] = JsonPrimitive(result.isSuccess)
        result.onSuccess { message["value"] = it }
        result.onFailure { message["error"] = JsonPrimitive(it.message ?: "Request failed") }
        to.postMessage(JsonObject(message).toString())
    }

    /** A NativeEvent for the page (src/mobile/protocol.ts), which checks it with isNativeEvent. */
    fun event(body: JsonObject) {
        proxy?.postMessage(JsonObject(mapOf("k" to JsonPrimitive("event"), "body" to body)).toString())
    }

    /** Loads the page again: core starts over and starts the services as its settings say. */
    fun reload() {
        proxy = null
        webView?.loadUrl("$ORIGIN/shell.html")
    }

    fun destroy() {
        webView?.let {
            (it.parent as? android.view.ViewGroup)?.removeView(it)
            it.destroy()
        }
        webView = null
        proxy = null
    }

    /** Called when the page's renderer went away and a new WebView took its place. */
    var onReplaced: (() -> Unit)? = null

    private inner class Client : WebViewClient() {
        override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? = serve(request.url, request.method)

        override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
            Pages.openOutside(context, request)
            return true
        }

        override fun onPageStarted(view: WebView, url: String?, favicon: android.graphics.Bitmap?) {
            if (view === webView) proxy = null
        }

        override fun onRenderProcessGone(view: WebView, detail: RenderProcessGoneDetail): Boolean {
            if (view !== webView) return true
            Log.w(TAG, "[shell] renderer gone (crash: ${detail.didCrash()}); starting the page again")
            destroy()
            start()
            onReplaced?.invoke()
            return true
        }
    }

    /** Our own files; https pictures (services' icons) from public hosts; nothing else. */
    private fun serve(url: Uri, method: String): WebResourceResponse? {
        if (url.scheme == "https" && url.host == HOST) return Pages.serve(context, FILES, url, method, CSP)
        if (!Pages.mayLoad(url, null)) return Pages.blocked(CSP)
        return null
    }

    companion object {
        private const val TAG = "Multicord"
        private const val HOST = "shell.multicord.invalid"
        const val ORIGIN = "https://$HOST"
        const val PROFILE = "shell"
        /** The native listener's name in its world; not the page's API (window.multicordShell), which it would hide. */
        private const val LISTENER = "multicordShellHost"
        /** The events shell.js and the relay exchange (shell.js has the same name). */
        private const val CHANNEL = "multicord-shell"

        private val FILES = mapOf(
            "/shell.html" to ("mobile/shell.html" to "text/html"),
            "/shell.js" to ("mobile/shell.js" to "text/javascript"),
            "/mobile.css" to ("mobile/mobile.css" to "text/css"),
            "/shell.css" to ("shell.css" to "text/css"),
            "/settings.css" to ("settings.css" to "text/css"),
            "/messages.css" to ("messages.css" to "text/css"),
        )

        /** Added to shell.html's own policy (both apply): no connections, pictures over https or inline. */
        private val CSP = listOf(
            "default-src 'self'",
            "script-src 'self'",
            "style-src 'self'",
            "img-src 'self' https: data:",
            "media-src 'none'",
            "connect-src 'none'",
            "worker-src 'none'",
            "object-src 'none'",
            "frame-src 'none'",
            "base-uri 'none'",
            "form-action 'none'",
            "frame-ancestors 'none'",
        ).joinToString("; ")
    }
}
