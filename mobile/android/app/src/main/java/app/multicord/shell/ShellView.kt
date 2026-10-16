// Multicord for Android. Copyright (C) 2026 Multicord contributors. AGPL-3.0-or-later, see LICENSE at the repo root.
package app.multicord.shell

import android.annotation.SuppressLint
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.util.Log
import android.view.ViewGroup
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
import app.multicord.net.NetPolicy
import app.multicord.net.UrlPolicy
import java.io.InputStream
import java.net.InetAddress
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

/**
 * The shell WebView: our own pages (for this milestone, the native chat view of one module instance),
 * served from https://shell.multicord.invalid in a Profile of its own. It holds no service credentials. It
 * gets display state from the engine whose view it shows, and its user actions go to native code, which
 * checks them and hands them to that engine alone. What the view loads from the network (pictures, media)
 * may come only from public hosts the engine itself may reach, as on the desktop.
 */
@SuppressLint("SetJavaScriptEnabled")
class ShellView(
    private val context: Context,
    private val container: ViewGroup,
    /** An action from the view, not yet validated: the caller checks it with isNativeAction. */
    private val onAction: (JsonElement?) -> Unit,
    /** The hosts the shown module's engine may reach now; null for any public host. */
    private val viewHosts: () -> List<String>?,
) {
    private var webView: WebView? = null
    private var proxy: JavaScriptReplyProxy? = null

    fun start() {
        val view = WebView(context)
        ProfileStore.getInstance().getOrCreateProfile(PROFILE)
        WebViewCompat.setProfile(view, PROFILE)
        view.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            allowFileAccess = false
            allowContentAccess = false
            setGeolocationEnabled(false)
            setSupportMultipleWindows(false)
            javaScriptCanOpenWindowsAutomatically = false
            safeBrowsingEnabled = false
        }
        view.webViewClient = Client()
        view.webChromeClient = object : WebChromeClient() {
            // Calls (camera, microphone) come in a later milestone; until then the view gets nothing.
            override fun onPermissionRequest(request: PermissionRequest) = request.deny()

            override fun onConsoleMessage(message: ConsoleMessage): Boolean {
                if (BuildConfig.DEBUG) Log.d(TAG, "[shell] ${message.messageLevel()} ${message.message().take(500)}")
                return true
            }
        }
        val world = BridgeScripts.install(context, view, LISTENER, CHANNEL, "bridge/shell.js", setOf(ORIGIN)) { source, message, sourceOrigin, isMainFrame, replyProxy ->
            if (source !== webView || !isMainFrame || sourceOrigin.toString() != ORIGIN) return@install
            if (message.type != WebMessageCompat.TYPE_STRING) return@install
            val parsed = Wire.parse(message.data ?: return@install) as? JsonObject ?: return@install
            proxy = replyProxy
            if ((parsed["k"] as? JsonPrimitive)?.content == "act") onAction(parsed["body"])
        }
        Log.i(TAG, "[shell] bridge relay in the $world")
        container.addView(view, 0, ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
        webView = view
        view.loadUrl("$ORIGIN/native.html")
    }

    /** The shown engine's display state, for the view. */
    fun showState(state: JsonObject) {
        proxy?.postMessage(JsonObject(mapOf("k" to JsonPrimitive("state"), "body" to state)).toString())
    }

    fun destroy() {
        webView?.let {
            container.removeView(it)
            it.destroy()
        }
        webView = null
        proxy = null
    }

    private inner class Client : WebViewClient() {
        override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? = serve(request.url, request.method)

        // The view never navigates; links open in the user's browser, https only.
        override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
            val url = request.url
            if (url.scheme == "https" && request.hasGesture()) {
                try {
                    context.startActivity(Intent(Intent.ACTION_VIEW, url).addCategory(Intent.CATEGORY_BROWSABLE).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
                } catch (error: Exception) {
                    Log.w(TAG, "No browser for a link: ${error.message}")
                }
            }
            return true
        }

        override fun onPageStarted(view: WebView, url: String?, favicon: android.graphics.Bitmap?) {
            if (view === webView) proxy = null
        }

        override fun onRenderProcessGone(view: WebView, detail: RenderProcessGoneDetail): Boolean {
            if (view !== webView) return true
            Log.w(TAG, "[shell] renderer gone (crash: ${detail.didCrash()}); reloading")
            destroy()
            start()
            return true
        }
    }

    /**
     * Our own files from the shell's origin; https pictures and media from public hosts the engine may reach
     * (the WebView loads those itself); nothing else.
     */
    private fun serve(url: Uri, method: String): WebResourceResponse? {
        if (url.scheme == "https" && url.host == HOST) {
            val path = url.path ?: return notFound()
            val file = FILES[path] ?: return notFound()
            if (method != "GET" || url.port != -1) return notFound()
            return respond(file.second, context.assets.open("web/shell/${file.first}"))
        }
        val text = url.toString()
        if (NetPolicy.checkUrl(text, UrlPolicy(listOf("https:"), viewHosts())) != null || !resolvesPublicly(url.host)) return blocked()
        return null
    }

    /** Whether a name resolves to public addresses only. The WebView resolves it again when it loads. */
    private fun resolvesPublicly(host: String?): Boolean {
        if (host.isNullOrEmpty()) return false
        if (host.startsWith("[") || host.all { it.isDigit() || it == '.' }) return true
        return try {
            InetAddress.getAllByName(host).all(NetPolicy::isPublicAddress)
        } catch (_: Exception) {
            // It does not resolve: the load fails on its own.
            true
        }
    }

    private fun respond(type: String, data: InputStream, status: Int = 200, reason: String = "OK") =
        WebResourceResponse(type, "utf-8", status, reason, mapOf("Content-Security-Policy" to CSP, "X-Content-Type-Options" to "nosniff"), data)

    private fun notFound() = respond("text/plain", ByteArray(0).inputStream(), 404, "Not Found")

    private fun blocked() = respond("text/plain", ByteArray(0).inputStream(), 403, "Forbidden")

    companion object {
        private const val TAG = "Multicord"
        private const val HOST = "shell.multicord.invalid"
        const val ORIGIN = "https://$HOST"
        private const val PROFILE = "shell"
        private const val LISTENER = "multicordShell"
        /** The events shell.js and the relay exchange (shell.js has the same name). */
        private const val CHANNEL = "multicord-shell"

        /** What the shell's origin serves: path -> (asset under web/shell, type). */
        private val FILES = mapOf(
            "/native.html" to ("native.html" to "text/html"),
            "/native.js" to ("native.js" to "text/javascript"),
            "/native.css" to ("native.css" to "text/css"),
            "/shell.css" to ("shell.css" to "text/css"),
            "/audio/rnnoise-worklet.js" to ("audio/rnnoise-worklet.js" to "text/javascript"),
            "/livekit-e2ee-worker.js" to ("livekit-e2ee-worker.js" to "text/javascript"),
        )

        /**
         * Added to native.html's own policy (both apply): no network connections from the view for now
         * (calls come later), pictures and media over https or inline.
         */
        private val CSP = listOf(
            "default-src 'self'",
            "script-src 'self' 'wasm-unsafe-eval'",
            "style-src 'self'",
            "img-src 'self' https: data: blob:",
            "media-src 'self' https: data: blob:",
            "connect-src 'self' data: blob:",
            "worker-src 'self'",
            "object-src 'none'",
            "frame-src 'none'",
            "base-uri 'none'",
            "form-action 'none'",
            "frame-ancestors 'none'",
        ).joinToString("; ")
    }
}
