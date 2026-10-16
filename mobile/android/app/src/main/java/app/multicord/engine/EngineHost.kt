// Multicord for Android. Copyright (C) 2026 Multicord contributors. AGPL-3.0-or-later, see LICENSE at the repo root.
package app.multicord.engine

import android.annotation.SuppressLint
import android.content.Context
import android.net.Uri
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
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
import app.multicord.bridge.Validators
import app.multicord.bridge.Wire
import app.multicord.net.Body
import app.multicord.net.HttpBridge
import app.multicord.net.HttpRequest
import app.multicord.net.NetPolicy
import app.multicord.net.OkHttpTransport
import app.multicord.net.UrlPolicy
import app.multicord.secrets.ScopedSecrets
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

/** One module instance to run in an engine, as the desktop's EngineSpec and PlatformDef describe it. */
data class EngineSpec(
    /** Instance id ("matrix-native"): the engine's origin, Profile and secrets are this instance's. */
    val instanceId: String,
    /** Engine bundle id ("matrix"): assets/web/engines/<engine>.js. */
    val engine: String,
    val name: String,
    val url: String,
    /** When set, the only hosts the engine may reach. */
    val hosts: List<String>? = null,
    /** The instance's values for the module's declared settings, given to the engine with its info. */
    val settings: JsonObject? = null,
)

/** What the shell hears from an engine, already validated. */
interface EngineListener {
    /** An EngineEvent (servers, account, notification…), checked with isEngineEvent. */
    fun onEvent(host: EngineHost, event: JsonObject)

    /** Display state for the module's own view. */
    fun onRender(host: EngineHost, state: JsonObject)

    fun onHealth(host: EngineHost, state: String)
}

/**
 * Runs one module instance's engine: a WebView in a Profile of its own (its storage is this instance's
 * alone), showing a page served by this class from https://<instance>.engine.multicord.invalid/ with a CSP
 * that allows no network at all. The engine reaches the outside only through the EngineBridge, a
 * WebMessageListener restricted to that origin, and every message is bound to this host by the WebView it
 * arrived in (never by anything in it) and checked with the desktop's validators before anything happens:
 * its own secrets, HTTP and WebSockets checked against its own host policy, its own view.
 * This is src/main/engineHost.ts's EngineHub for one engine.
 */
@SuppressLint("SetJavaScriptEnabled")
class EngineHost(
    private val context: Context,
    val spec: EngineSpec,
    private val secrets: ScopedSecrets,
    /** Where the engine's WebView lives: it is attached (1x1, never seen) so that it keeps running. */
    private val container: ViewGroup,
    private val listener: EngineListener,
) {
    val origin = "https://${spec.instanceId}.engine.multicord.invalid"
    private val host = "${spec.instanceId}.engine.multicord.invalid"
    private val main = Handler(Looper.getMainLooper())
    private val network: ExecutorService = Executors.newFixedThreadPool(6)
    /** One thread, so an engine's secret writes and reads happen in the order it asked. */
    private val secretThread: ExecutorService = Executors.newSingleThreadExecutor()

    private var webView: WebView? = null
    private var proxy: JavaScriptReplyProxy? = null
    private var ready = false
    private val queue = ArrayDeque<Pair<String, JsonElement>>()
    /** The hosts the engine may reach now: the module's, or narrower once the engine locks itself. */
    private var allowed: List<String>? = spec.hosts
    private var crashes = 0
    private var readyAt = 0L
    private var stopped = false
    /** When the user last asked to attach files, or submitted a sign-in step, in the module's view. */
    var attachAskedAt = 0L
        private set
    var signInAskedAt = 0L
        private set

    private val sockets = EngineSockets(
        check = { url -> NetPolicy.checkUrl(url, UrlPolicy(listOf("wss:"), allowed))?.message },
        connect = OkHttpSockets({ main.post(it) })::connect,
        emit = { deliver("socket", it) },
    )

    /** The hosts the module's view may load from, as the engine may reach them now; null for any public host. */
    val allowedHosts: List<String>? get() = allowed

    fun start() {
        check(Looper.myLooper() == Looper.getMainLooper())
        stopped = false
        val view = WebView(context)
        // The Profile must be set before anything else touches the WebView.
        val profileName = "engine-${spec.instanceId}"
        val profile = ProfileStore.getInstance().getOrCreateProfile(profileName)
        WebViewCompat.setProfile(view, profileName)
        // HTTP goes through the bridge; the engine has no use for cookies.
        profile.cookieManager.setAcceptCookie(false)
        view.settings.apply {
            javaScriptEnabled = true
            // IndexedDB (Matrix's encryption keys) and localStorage, kept in this instance's Profile.
            domStorageEnabled = true
            allowFileAccess = false
            allowContentAccess = false
            setGeolocationEnabled(false)
            setSupportMultipleWindows(false)
            javaScriptCanOpenWindowsAutomatically = false
            mediaPlaybackRequiresUserGesture = true
            // The page is ours and loads nothing else; no URL lookups with a third party.
            safeBrowsingEnabled = false
        }
        view.webViewClient = Client()
        view.webChromeClient = object : WebChromeClient() {
            override fun onPermissionRequest(request: PermissionRequest) = request.deny()

            override fun onConsoleMessage(message: ConsoleMessage): Boolean {
                if (BuildConfig.DEBUG) Log.d(TAG, "[engine ${spec.instanceId}] ${message.messageLevel()} ${message.message().take(500)}")
                return true
            }
        }
        val origins = setOf(origin)
        WebViewCompat.addWebMessageListener(view, LISTENER, origins) { source, message, sourceOrigin, isMainFrame, replyProxy ->
            receive(source, message, sourceOrigin, isMainFrame, replyProxy)
        }
        WebViewCompat.addDocumentStartJavaScript(view, context.assets.open("bridge/engine.js").bufferedReader().use { it.readText() }, origins)
        container.addView(view, ViewGroup.LayoutParams(1, 1))
        view.alpha = 0f
        webView = view
        listener.onHealth(this, "starting")
        view.loadUrl("$origin/engine.html")
    }

    /** Stops the engine for good: its WebView, sockets and pending work. */
    fun destroy() {
        stopped = true
        sockets.closeAll()
        tearDown()
        network.shutdownNow()
        secretThread.shutdownNow()
    }

    private fun tearDown() {
        ready = false
        proxy = null
        webView?.let {
            container.removeView(it)
            it.destroy()
        }
        webView = null
    }

    // Engine -> host ---------------------------------------------------------------------------------------

    private fun receive(source: WebView, message: WebMessageCompat, sourceOrigin: Uri, isMainFrame: Boolean, replyProxy: JavaScriptReplyProxy) {
        // Only this engine's own page, in its top frame, speaks for this engine.
        if (source !== webView || !isMainFrame || sourceOrigin.toString() != origin) return
        if (message.type != WebMessageCompat.TYPE_STRING) return
        val parsed = Wire.parse(message.data ?: return) as? JsonObject ?: return
        proxy = replyProxy
        val body = parsed["body"]
        when ((parsed["k"] as? JsonPrimitive)?.content) {
            "req" -> {
                val id = parsed["id"] as? JsonPrimitive ?: return
                if (id.isString || id.content.toLongOrNull() == null) return
                if (!Validators.isEngineRequest(body)) return reply(replyProxy, id, Result.failure(IllegalArgumentException("Malformed engine request")))
                answer(body as JsonObject) { result -> reply(replyProxy, id, result) }
            }
            "emit" -> if (Validators.isEngineEvent(body)) listener.onEvent(this, body as JsonObject)
            "render" -> if (body is JsonObject) listener.onRender(this, body)
        }
    }

    private fun reply(to: JavaScriptReplyProxy, id: JsonPrimitive, result: Result<JsonElement?>) {
        // The page that asked is gone (reloaded or crashed): nobody waits for this answer.
        if (to !== proxy) return
        val message = HashMap<String, JsonElement>()
        message["k"] = JsonPrimitive("res")
        message["id"] = id
        message["ok"] = JsonPrimitive(result.isSuccess)
        result.onSuccess { value -> if (value != null) message["value"] = value }
        result.onFailure { error -> message["error"] = JsonPrimitive(error.message ?: "Request failed") }
        to.postMessage(JsonObject(message).toString())
    }

    /** Runs `work` off the main thread and hands its result back on it. */
    private fun off(executor: ExecutorService, done: (Result<JsonElement?>) -> Unit, work: () -> JsonElement?) {
        executor.execute {
            val result = runCatching(work)
            main.post { done(result) }
        }
    }

    private fun answer(request: JsonObject, done: (Result<JsonElement?>) -> Unit) {
        fun text(key: String) = (request[key] as JsonPrimitive).content
        when (text("type")) {
            "info" -> {
                // The engine asks first thing once loaded: from now on it can receive.
                ready = true
                readyAt = SystemClock.elapsedRealtime()
                listener.onHealth(this, "running")
                val info = LinkedHashMap<String, JsonElement>()
                info["id"] = JsonPrimitive(spec.instanceId)
                info["name"] = JsonPrimitive(spec.name)
                info["url"] = JsonPrimitive(spec.url)
                info["os"] = JsonPrimitive("android")
                spec.settings?.let { info["settings"] = it }
                done(Result.success(JsonObject(info)))
                while (queue.isNotEmpty() && ready) queue.removeFirst().let { (kind, body) -> post(kind, body) }
            }
            "secretLoad" -> off(secretThread, done) { secrets.load(text("key"))?.let(::JsonPrimitive) }
            "secretSave" -> off(secretThread, done) { secrets.save(text("key"), text("value")); null }
            "secretDelete" -> off(secretThread, done) { secrets.delete(text("key")); null }
            "http" -> {
                val r = request["request"] as JsonObject
                val body = r["body"]?.let { b -> if (b is JsonPrimitive) Body.Text(b.content) else Body.Bytes(Wire.decodeBytes(b) ?: return done(Result.failure(IllegalArgumentException("Malformed engine request")))) }
                val headers = (r["headers"] as JsonObject).mapValues { (it.value as JsonPrimitive).content }
                val http = HttpRequest((r["url"] as JsonPrimitive).content, (r["method"] as JsonPrimitive).content, headers, body)
                // Checked against the hosts allowed when the request was made.
                val policy = UrlPolicy(listOf("https:"), allowed)
                off(network, done) {
                    val response = HttpBridge.perform(OkHttpTransport(), http, policy)
                    JsonObject(mapOf(
                        "status" to JsonPrimitive(response.status),
                        "headers" to JsonObject(response.headers.mapValues { JsonPrimitive(it.value) }),
                        "body" to Wire.bytes(response.body),
                    ))
                }
            }
            "lockHosts" -> {
                val hosts = NetPolicy.narrowHosts(allowed, (request["hosts"] as JsonArray).map { (it as JsonPrimitive).content })
                if (hosts == null) return done(Result.failure(IllegalStateException("A host lock can only narrow what the engine may reach")))
                allowed = hosts
                done(Result.success(JsonArray(hosts.map(::JsonPrimitive))))
            }
            "socketOpen" -> done(runCatching {
                val protocols = (request["protocols"] as? JsonArray)?.map { (it as JsonPrimitive).content }
                JsonObject(mapOf("id" to JsonPrimitive(sockets.open(text("url"), protocols))))
            })
            "socketSend" -> done(runCatching {
                sockets.send(text("id"), Frame.of(request["data"]) ?: throw IllegalArgumentException("Malformed engine request"))
                null
            })
            "socketClose" -> {
                sockets.close(text("id"), (request["code"] as? JsonPrimitive)?.content?.toDouble()?.toInt(), (request["reason"] as? JsonPrimitive)?.content)
                done(Result.success(null))
            }
            // Picking files and single sign-on need the user's say-so in the view; not on this host yet.
            "pickFiles", "readFile", "ssoSignIn" -> done(Result.failure(UnsupportedOperationException("Not available in Multicord for Android yet")))
            else -> done(Result.failure(IllegalArgumentException("Malformed engine request")))
        }
    }

    // Host -> engine ---------------------------------------------------------------------------------------

    /** A shell command (EngineCommand), made by native code. */
    fun command(command: JsonObject) = deliver("command", command)

    /** A user action from the module's view, already checked with isNativeAction. */
    fun action(action: JsonObject) {
        when ((action["type"] as? JsonPrimitive)?.content) {
            // The file picker opens only for an attach the user just asked for in this view.
            "attach" -> attachAskedAt = SystemClock.elapsedRealtime()
            // Single sign-on starts only for a sign-in step the user just submitted in this view.
            "prompt" -> signInAskedAt = SystemClock.elapsedRealtime()
        }
        deliver("action", action)
    }

    /** Sends to the engine, or holds the message until it has loaded. */
    private fun deliver(kind: String, body: JsonElement) {
        if (ready && proxy != null) return post(kind, body)
        if (queue.size >= MAX_QUEUE) {
            Log.w(TAG, "[engine ${spec.instanceId}] dropped a $kind: too many waiting")
            return
        }
        queue.addLast(kind to body)
    }

    private fun post(kind: String, body: JsonElement) {
        proxy?.postMessage(JsonObject(mapOf("k" to JsonPrimitive(kind), "body" to body)).toString())
    }

    private inner class Client : WebViewClient() {
        override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse = serve(request.url, request.method)

        // An engine never navigates anywhere.
        override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest) = true

        override fun onPageStarted(view: WebView, url: String?, favicon: android.graphics.Bitmap?) {
            if (view !== webView) return
            // A reloading engine's sockets close with it; what it asked before goes unanswered.
            ready = false
            proxy = null
            sockets.closeAll()
        }

        override fun onRenderProcessGone(view: WebView, detail: RenderProcessGoneDetail): Boolean {
            if (view !== webView) return true
            sockets.closeAll()
            tearDown()
            if (stopped) return true
            crashes = if (readyAt > 0 && SystemClock.elapsedRealtime() - readyAt >= STABLE_MS) 1 else crashes + 1
            if (crashes > MAX_CRASHES) {
                Log.w(TAG, "[engine ${spec.instanceId}] stopped; crashed $MAX_CRASHES times in a row, not restarting")
                listener.onHealth(this@EngineHost, "stopped")
                return true
            }
            val delay = minOf(2000L shl (crashes - 1), 30_000L)
            Log.w(TAG, "[engine ${spec.instanceId}] renderer gone (crash: ${detail.didCrash()}); restarting in $delay ms")
            listener.onHealth(this@EngineHost, "starting")
            main.postDelayed({ if (!stopped && webView == null) start() }, delay)
            return true
        }
    }

    /** The engine's origin serves its page and bundle; nothing else exists there, and nothing else loads. */
    private fun serve(url: Uri, method: String): WebResourceResponse {
        if (url.scheme != "https" || url.host != host || url.port != -1 || method != "GET") return notFound()
        return when (url.path) {
            "/", "/engine.html" -> respond("text/html", ENGINE_PAGE.toByteArray().inputStream())
            "/engine.js" -> respond("text/javascript", context.assets.open("web/engines/${spec.engine}.js"))
            else -> notFound()
        }
    }

    private fun respond(type: String, data: java.io.InputStream, status: Int = 200, reason: String = "OK") =
        WebResourceResponse(type, "utf-8", status, reason, mapOf("Content-Security-Policy" to CSP, "X-Content-Type-Options" to "nosniff", "Cache-Control" to "no-store"), data)

    private fun notFound() = respond("text/plain", ByteArray(0).inputStream(), 404, "Not Found")

    companion object {
        const val TAG = "Multicord"
        private const val LISTENER = "multicordHost"
        /** Messages held for an engine that has not loaded yet, at most. */
        private const val MAX_QUEUE = 1000
        /** Crashes in a row before an engine is left stopped, and how long a run counts as stable (engineAdapter.ts). */
        private const val MAX_CRASHES = 5
        private const val STABLE_MS = 60_000L

        /** No network at all: HTTP and WebSockets go through the bridge. */
        private val CSP = listOf(
            "default-src 'none'",
            "script-src 'self' 'wasm-unsafe-eval'",
            "connect-src 'none'",
            "worker-src 'self' blob:",
            "img-src 'self' data: blob:",
            "base-uri 'none'",
            "form-action 'none'",
            "frame-ancestors 'none'",
        ).joinToString("; ")
        private const val ENGINE_PAGE = "<!doctype html><html><head><meta charset=\"utf-8\"><title>engine</title></head><body><script src=\"engine.js\"></script></body></html>"
    }
}
