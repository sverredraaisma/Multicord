// Multicord for Android. Copyright (C) 2026 Multicord contributors. AGPL-3.0-or-later, see LICENSE at the repo root.
package app.multicord.engine

import android.annotation.SuppressLint
import android.content.Context
import android.net.Uri
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
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
import app.multicord.bridge.Validators
import app.multicord.bridge.Wire
import app.multicord.net.Body
import app.multicord.net.HttpBridge
import app.multicord.net.HttpRequest
import app.multicord.net.NetPolicy
import app.multicord.net.OkHttpTransport
import app.multicord.net.PublicSuffixList
import app.multicord.net.UrlPolicy
import app.multicord.net.VoiceHostGrant
import app.multicord.secrets.ScopedSecrets
import app.multicord.sso.Sso
import app.multicord.sso.SsoBroker
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
    /** Keep the engine's web storage (IndexedDB) on disk; otherwise its Profile is cleared at every start. */
    val storage: Boolean = false,
    /** The engine may add one voice host for its WebSockets once signed in (ModuleManifest.voiceHost). */
    val voiceHost: Boolean = false,
)

/** What an engine may ask of the screen: only right after the user asked for it in the engine's view. */
interface EngineUi {
    /**
     * Opens the system's document picker; `done` gets the picked documents' URIs (none when the user
     * cancelled). False when a picker is already open or there is none.
     */
    fun pickDocuments(done: (List<String>) -> Unit): Boolean

    /** Opens an address in the user's browser (a Custom Tab where there is one); false when there is none. */
    fun openBrowser(url: String): Boolean
}

/** What the shell hears from an engine, already validated. */
interface EngineListener {
    /** An EngineEvent (servers, account, notification…), checked with isEngineEvent. */
    fun onEvent(host: EngineHost, event: JsonObject)

    /** Display state for the module's own view. */
    fun onRender(host: EngineHost, state: JsonObject)

    /** "starting", "running" or "stopped", with the restarts so far and why it last stopped. */
    fun onHealth(host: EngineHost, state: String, restarts: Int, lastExit: String?)
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
    private val listener: EngineListener,
    private val ui: EngineUi,
    documents: DocumentSource = ContentDocuments(context.contentResolver),
    /** Where single sign-on waits for the browser; one request at a time for the whole app. */
    private val sso: SsoBroker = Sso.broker,
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
    /** Its one voice host, for its WebSockets alone (EngineHub.addVoiceHost). */
    private val voiceHost = VoiceHostGrant(spec.voiceHost)
    /** Whether the engine last said the user is signed in (its account event). */
    private var signedIn = false
    /** Core's restart policy: crashes in a row, back-off, and when to leave the engine stopped. */
    private val restartPolicy = RestartPolicy()
    /** Counts starts, so a delayed restart that a newer start overtook does nothing. */
    private var starts = 0
    private var restarts = 0
    private var lastExit: String? = null
    private var readyAt = 0L
    /** The settings the engine gets with its info: the spec's, then each settings command's. */
    private var settings: JsonObject? = spec.settings
    private var stopped = false
    /** When the user last asked to attach files, or submitted a sign-in step, in the module's view. */
    var attachAskedAt = 0L
        private set
    var signInAskedAt = 0L
        private set

    /** The files the user picked for this engine, by handle. */
    private val picked = PickedFiles(documents)

    private val sockets = EngineSockets(
        check = { url -> NetPolicy.checkUrl(url, UrlPolicy(listOf("wss:"), voiceHost.socketHosts(allowed)))?.message },
        connect = OkHttpSockets({ main.post(it) })::connect,
        emit = { deliver("socket", it) },
    )

    /** The hosts the module's view may load from, as the engine may reach them now; null for any public host. */
    val allowedHosts: List<String>? get() = allowed

    fun start() {
        check(Looper.myLooper() == Looper.getMainLooper())
        stopped = false
        readyAt = 0L
        val view = WebView(context)
        // The Profile must be set before anything else touches the WebView.
        val profileName = profileName(spec.instanceId)
        val profile = ProfileStore.getInstance().getOrCreateProfile(profileName)
        // Without storage the engine starts afresh each time, as its in-memory session does on the desktop.
        if (!spec.storage && !clearedOnce) {
            clearedOnce = true
            profile.webStorage.deleteAllData()
        }
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
        val world = BridgeScripts.install(context, view, LISTENER, CHANNEL, "bridge/engine.js", setOf(origin)) { source, message, sourceOrigin, isMainFrame, replyProxy ->
            receive(source, message, sourceOrigin, isMainFrame, replyProxy)
        }
        Log.i(TAG, "[engine ${spec.instanceId}] bridge relay in the $world")
        // Never on screen: the page runs without a window, and its renderer stays important while the app runs.
        view.setRendererPriorityPolicy(WebView.RENDERER_PRIORITY_IMPORTANT, false)
        webView = view
        health("starting")
        view.loadUrl("$origin/engine.html")
    }

    /** Stops the engine for good: its WebView, sockets and pending work. */
    fun destroy() {
        stopped = true
        sso.cancel(this)
        sockets.closeAll()
        picked.clear()
        tearDown()
        network.shutdownNow()
        secretThread.shutdownNow()
    }

    /**
     * Starts the engine again because the user asked (Settings, Restart): one left stopped after crashing
     * repeatedly, or one that runs but seems stuck. It gets a fresh crash count; the app and the other
     * engines keep running. Its sockets close and its pending requests go unanswered, as on a reload.
     */
    fun restart() {
        check(Looper.myLooper() == Looper.getMainLooper())
        if (stopped) return
        Log.i(TAG, "[engine ${spec.instanceId}] restarting at the user's request")
        sso.cancel(this)
        sockets.closeAll()
        picked.clear()
        attachAskedAt = 0L
        signInAskedAt = 0L
        tearDown()
        restartPolicy.reset()
        starts++
        start()
    }

    private fun tearDown() {
        ready = false
        proxy = null
        webView?.destroy()
        webView = null
    }

    private fun health(state: String) = listener.onHealth(this, state, restarts, lastExit)

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
            "emit" -> if (Validators.isEngineEvent(body)) {
                body as JsonObject
                if ((body["type"] as? JsonPrimitive)?.content == "account") signedIn = ((body["account"] as? JsonObject)?.get("state") as? JsonPrimitive)?.content == "signed-in"
                listener.onEvent(this, body)
            }
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
                health("running")
                val info = LinkedHashMap<String, JsonElement>()
                info["id"] = JsonPrimitive(spec.instanceId)
                info["name"] = JsonPrimitive(spec.name)
                info["url"] = JsonPrimitive(spec.url)
                info["os"] = JsonPrimitive("android")
                settings?.let { info["settings"] = it }
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
                voiceHost.narrowed(hosts) { suffixes(context) }
                done(Result.success(JsonArray(hosts.map(::JsonPrimitive))))
            }
            "addVoiceHost" -> done(voiceHost.add(allowed, signedIn, text("host")) { suffixes(context) }.map(::JsonPrimitive))
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
            "pickFiles" -> pickFiles(done)
            "readFile" -> {
                val handle = text("handle")
                val start = (request["start"] as JsonPrimitive).content.toDouble().toLong()
                val end = (request["end"] as JsonPrimitive).content.toDouble().toLong()
                off(network, done) { Wire.bytes(picked.read(handle, start, end)) }
            }
            "ssoSignIn" -> ssoSignIn(text("url"), done)
            else -> done(Result.failure(IllegalArgumentException("Malformed engine request")))
        }
    }

    /**
     * The system's document picker, only right after the user asked to attach in this engine's view, once
     * per ask (engineHost.ts): an engine cannot open pickers on its own. The picked files get handles this
     * engine alone can read.
     */
    private fun pickFiles(done: (Result<JsonElement?>) -> Unit) {
        val asked = attachAskedAt
        if (asked == 0L || SystemClock.elapsedRealtime() - asked > ASK_WINDOW_MS) {
            return done(Result.failure(IllegalStateException("Files can only be picked when the user asks to attach")))
        }
        attachAskedAt = 0L
        val opened = ui.pickDocuments { documents ->
            if (stopped) return@pickDocuments
            if (documents.isEmpty()) return@pickDocuments done(Result.success(JsonArray(emptyList())))
            off(network, done) { JsonArray(picked.add(documents).map(PickedFile::toJson)) }
        }
        if (!opened) done(Result.failure(IllegalStateException("No file picker could be opened")))
    }

    /**
     * Single sign-on, as EngineHub.ssoSignIn: only within ASK_WINDOW_MS after the user submitted a sign-in step
     * in this engine's view, once per submit, to a homeserver SSO address on a host the engine may reach. The
     * browser comes back through SsoRedirectActivity; the token is the answer to this engine's request only.
     */
    private fun ssoSignIn(url: String, done: (Result<JsonElement?>) -> Unit) {
        val asked = signInAskedAt
        if (asked == 0L || SystemClock.elapsedRealtime() - asked > ASK_WINDOW_MS) {
            return done(Result.failure(IllegalStateException("Single sign-on starts only when the user signs in")))
        }
        signInAskedAt = 0L
        val refused = if (SsoBroker.isSsoUrl(url)) NetPolicy.checkUrl(url, UrlPolicy(listOf("https:"), allowed))?.message else "it is no single sign-on address"
        if (refused != null) return done(Result.failure(IllegalStateException("Single sign-on refused: $refused")))
        val target = sso.begin(url, this) { result ->
            if (!stopped) done(result.map { JsonObject(mapOf("loginToken" to JsonPrimitive(it))) })
        } ?: return done(Result.failure(IllegalStateException("Single sign-on refused: it is no single sign-on address")))
        if (!ui.openBrowser(target)) sso.cancel(this, "No browser could be opened")
    }

    // Host -> engine ---------------------------------------------------------------------------------------

    /** A command from the shell page (EngineCommand), already checked with isEngineCommand. */
    fun command(command: JsonObject) {
        // The values the engine gets with its info from now on, e.g. after it restarts.
        if ((command["type"] as? JsonPrimitive)?.content == "settings") settings = command["values"] as? JsonObject
        deliver("command", command)
    }

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
            lastExit = if (detail.didCrash()) "crashed" else "killed"
            val delay = restartPolicy.crashed(if (readyAt > 0) SystemClock.elapsedRealtime() - readyAt else null)
            if (delay == null) {
                Log.w(TAG, "[engine ${spec.instanceId}] stopped; crashed ${RestartPolicy.MAX_CRASHES} times in a row, not restarting until the user restarts it")
                health("stopped")
                return true
            }
            Log.w(TAG, "[engine ${spec.instanceId}] renderer gone (crash: ${detail.didCrash()}); restarting in $delay ms")
            restarts++
            health("starting")
            val generation = ++starts
            main.postDelayed({ if (!stopped && webView == null && generation == starts) start() }, delay)
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

    private var clearedOnce = false

    companion object {
        const val TAG = "Multicord"

        /** The Profile an instance's engine keeps its web storage in. */
        fun profileName(instanceId: String) = "engine-$instanceId"
        private const val LISTENER = "multicordHost"
        /** The events engine.js and the relay exchange (engine.js has the same name). */
        private const val CHANNEL = "multicord-engine"
        /** Messages held for an engine that has not loaded yet, at most. */
        private const val MAX_QUEUE = 1000
        /** How long after the user's attach click, or sign-in submit, the engine may open the picker or the browser (engineHost.ts). */
        const val ASK_WINDOW_MS = 10_000L

        private var suffixList: PublicSuffixList? = null

        /** The Public Suffix List the build bundles (web/mobile/public_suffix_list.dat), read once, on the main thread, when a voice host is first asked for. */
        private fun suffixes(context: Context): PublicSuffixList =
            suffixList ?: PublicSuffixList(context.assets.open("web/mobile/public_suffix_list.dat").bufferedReader().use { it.readText() }).also { suffixList = it }

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
