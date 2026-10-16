// Multicord Android spike (phase 0). Copyright (C) 2026 Multicord contributors.
// AGPL-3.0-or-later, see LICENSE at the repo root.
package app.multicord.spike

import android.Manifest
import android.annotation.SuppressLint
import android.app.Activity
import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Typeface
import android.net.Uri
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.view.View
import android.webkit.ConsoleMessage
import android.webkit.PermissionRequest
import android.webkit.RenderProcessGoneDetail
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Button
import android.widget.LinearLayout
import android.widget.TextView
import androidx.webkit.ProfileStore
import androidx.webkit.UserAgentMetadata
import androidx.webkit.WebMessageCompat
import androidx.webkit.WebMessagePortCompat
import androidx.webkit.WebSettingsCompat
import androidx.webkit.WebViewAssetLoader
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import org.json.JSONObject
import java.util.concurrent.atomic.AtomicInteger

/**
 * One WebView in a Profile of its own, with the spike's document-start scripts and message listener
 * restricted to a single origin, and camera/microphone granted only to that origin.
 */
class WebActivity : Activity() {
    /** What the WebView shows: the origin everything is restricted to, its Profile, where to start. */
    private data class Target(
        val section: String,
        val origin: String,
        val profile: String,
        val startUrl: String,
        /** Hosts that may load inside the WebView; other https links go to the browser. */
        val navigableHosts: Set<String>,
        /** Whether the origin is ours, served from assets/ by WebViewAssetLoader (no server, no network). */
        val servesAssets: Boolean,
    )

    private val assetLoader by lazy {
        WebViewAssetLoader.Builder()
            .addPathHandler("/assets/", WebViewAssetLoader.AssetsPathHandler(this))
            .build()
    }

    private lateinit var target: Target
    private lateinit var webView: WebView
    private lateinit var logPanel: TextView
    private var pendingPermission: PermissionRequest? = null
    private val main = Handler(Looper.getMainLooper())
    /** Spike 0.5: whether this WebView gets the USB camera (camera page always; Discord when ticked). */
    private var usbCamera = false
    private var usbSink: PortSink? = null
    private val onLog: () -> Unit = { if (logPanel.visibility == View.VISIBLE) logPanel.text = SpikeLog.tail(12) }

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        target = targetFrom(intent)
        val desktopUa = intent.getBooleanExtra(EXTRA_DESKTOP_UA, false)
        usbCamera = intent.getBooleanExtra(EXTRA_USB_CAMERA, false)
        if (usbCamera) UsbCamera.init(this)

        webView = WebView(this)
        // The Profile must be set before anything else touches the WebView.
        if (Features.isSupported(WebViewFeature.MULTI_PROFILE)) {
            ProfileStore.getInstance().getOrCreateProfile(target.profile)
            WebViewCompat.setProfile(webView, target.profile)
            SpikeLog.add(target.section, "WebView uses Profile \"${WebViewCompat.getProfile(webView).name}\"")
        } else {
            SpikeLog.add(target.section, "MULTI_PROFILE missing: WebView uses the default profile")
        }

        webView.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            mediaPlaybackRequiresUserGesture = false
            allowFileAccess = false
            allowContentAccess = false
            mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
            setSupportMultipleWindows(false)
            builtInZoomControls = true
            displayZoomControls = false
        }
        if (desktopUa) useDesktopUserAgent()

        installListener()
        installScripts()
        webView.webViewClient = Client()
        webView.webChromeClient = Chrome()

        val root = Ui.column(this)
        root.addView(Ui.row(this,
            button("Reload") { webView.reload() },
            button("Log") { toggleLog() },
            button("Close") { finish() },
        ))
        root.addView(webView, LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, 0, 1f))
        logPanel = TextView(this).apply {
            typeface = Typeface.MONOSPACE
            textSize = 10f
            visibility = View.GONE
            setTextIsSelectable(true)
        }
        root.addView(logPanel)
        setContentView(Ui.withInsets(root))
        SpikeLog.listen(onLog)

        webView.loadUrl(target.startUrl)
    }

    override fun onDestroy() {
        SpikeLog.unlisten(onLog)
        disconnectUsbCamera()
        pendingPermission?.deny()
        pendingPermission = null
        webView.destroy()
        super.onDestroy()
    }

    private fun button(label: String, action: () -> Unit): View =
        Button(this).apply {
            text = label
            isAllCaps = false
            setOnClickListener { action() }
        }

    private fun toggleLog() {
        logPanel.visibility = if (logPanel.visibility == View.VISIBLE) View.GONE else View.VISIBLE
        onLog()
    }

    /** A desktop Chrome user agent on Linux with the WebView's own Chrome major, and matching client hints. */
    private fun useDesktopUserAgent() {
        val settings = webView.settings
        val major = Regex("Chrome/(\\d+)").find(settings.userAgentString)?.groupValues?.get(1) ?: "140"
        settings.userAgentString =
            "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/$major.0.0.0 Safari/537.36"
        settings.useWideViewPort = true
        settings.loadWithOverviewMode = true
        val hints = if (Features.isSupported(WebViewFeature.USER_AGENT_METADATA)) {
            val current = WebSettingsCompat.getUserAgentMetadata(settings)
            WebSettingsCompat.setUserAgentMetadata(
                settings,
                UserAgentMetadata.Builder(current).setMobile(false).setPlatform("Linux").setModel("").build(),
            )
            "client hints set to desktop"
        } else {
            "USER_AGENT_METADATA missing: client hints still say mobile"
        }
        SpikeLog.add(target.section, "desktop user agent (Chrome/$major), $hints")
    }

    /** The page reports through window.multicordSpike, which exists only in frames of the target origin. */
    private fun installListener() {
        if (!Features.isSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) {
            SpikeLog.add(target.section, "WEB_MESSAGE_LISTENER missing: no reports from the page")
            return
        }
        WebViewCompat.addWebMessageListener(webView, LISTENER, setOf(target.origin)) { _, message, sourceOrigin, isMainFrame, _ ->
            // The rules already restrict the origin; check again, and treat the text as untrusted.
            if (sameOrigin(sourceOrigin, target.origin)) {
                val text = message.data
                SpikeLog.add(target.section, "page: ${text ?: "(non-text message)"}")
                // A new document with the USB camera patch: hand it a fresh channel.
                if (text == USB_HELLO && isMainFrame && usbCamera) connectUsbCamera()
            }
        }
    }

    private fun installScripts() {
        if (!Features.isSupported(WebViewFeature.DOCUMENT_START_SCRIPT)) {
            SpikeLog.add(target.section, "DOCUMENT_START_SCRIPT missing: no document-start scripts")
            return
        }
        val origins = setOf(target.origin)
        WebViewCompat.addDocumentStartJavaScript(webView, asset("web/report-start.js"), origins)
        val testCamera = intent.getBooleanExtra(EXTRA_TEST_CAMERA, false)
        if (testCamera || usbCamera) {
            val config = JSONObject().put("testCamera", testCamera).put("usbCamera", usbCamera).toString()
            val script = CONFIG.replace(asset("web/fakecam.js")) { "/*MULTICORD_CONFIG*/$config/*END_MULTICORD_CONFIG*/" }
            WebViewCompat.addDocumentStartJavaScript(webView, script, origins)
            SpikeLog.add(target.section, "virtual camera patch registered for ${target.origin} (test camera $testCamera, USB camera $usbCamera)")
        }
    }

    /**
     * Spike 0.5's transport: a MessageChannel per document. One port stays here; the other is posted to the
     * main frame, only if it is on the target origin. Frames go as ArrayBuffers, and only while the page has
     * a USB camera track open ("want"); status changes go as JSON text.
     */
    private fun connectUsbCamera() {
        disconnectUsbCamera()
        val missing = listOf(
            WebViewFeature.CREATE_WEB_MESSAGE_CHANNEL, WebViewFeature.POST_WEB_MESSAGE, WebViewFeature.WEB_MESSAGE_ARRAY_BUFFER,
        ).filter { !Features.isSupported(it) }
        if (missing.isNotEmpty()) {
            SpikeLog.add(target.section, "USB camera unavailable, WebView lacks $missing")
            return
        }
        val (mine, theirs) = WebViewCompat.createWebMessageChannel(webView)
        val sink = PortSink(mine)
        mine.setWebMessageCallback(main, object : WebMessagePortCompat.WebMessageCallbackCompat() {
            override fun onMessage(port: WebMessagePortCompat, message: WebMessageCompat?) {
                // Only two words are understood; anything else from the page is ignored.
                when (if (message?.type == WebMessageCompat.TYPE_STRING) message.data else null) {
                    "want" -> sink.wanted = true
                    "idle" -> sink.wanted = false
                }
            }
        })
        WebViewCompat.postWebMessage(webView, WebMessageCompat(USB_PORT_MESSAGE, arrayOf(theirs)), Uri.parse(target.origin))
        usbSink = sink
        UsbCamera.addSink(sink)
        SpikeLog.add(target.section, "USB camera channel handed to ${target.origin}")
    }

    private fun disconnectUsbCamera() {
        val sink = usbSink ?: return
        usbSink = null
        UsbCamera.removeSink(sink)
        sink.close()
    }

    /** Posts the stream to one page's port, on the main thread, never more than two frames behind. */
    private inner class PortSink(private val port: WebMessagePortCompat) : UsbCamera.Sink {
        @Volatile var wanted = false
        @Volatile private var closed = false
        private val queued = AtomicInteger()

        override fun onStatus(status: UsbCamera.Status?) {
            if (closed) return
            val json = JSONObject().put("type", "status").put("streaming", status != null)
            if (status != null) json.put("name", status.name.take(100)).put("width", status.width).put("height", status.height).put("fps", status.fps)
            port.postMessage(WebMessageCompat(json.toString()))
        }

        override fun onFrame(jpeg: ByteArray) {
            if (closed || !wanted || jpeg.size > UvcNative.MAX_FRAME_BYTES) return
            if (queued.get() >= 2) {
                UsbCamera.countPageDrop()
                return
            }
            queued.incrementAndGet()
            main.post {
                queued.decrementAndGet()
                if (!closed) port.postMessage(WebMessageCompat(jpeg))
            }
        }

        fun close() {
            closed = true
            port.close()
        }
    }

    private fun asset(path: String): String = assets.open(path).bufferedReader().use { it.readText() }

    private inner class Client : WebViewClient() {
        override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? {
            if (!target.servesAssets) return null
            // Our pages load nothing from the network: anything the loader does not serve is a 404.
            return assetLoader.shouldInterceptRequest(request.url)
                ?: WebResourceResponse("text/plain", "utf-8", 404, "Not Found", emptyMap(), null)
        }

        override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
            val url = request.url
            if (url.scheme == "https" && hostAllowed(url.host)) return false
            if (url.scheme == "https" && request.isForMainFrame) {
                SpikeLog.add(target.section, "opening ${url.host} in the browser")
                try {
                    startActivity(Intent(Intent.ACTION_VIEW, url).addCategory(Intent.CATEGORY_BROWSABLE))
                } catch (_: ActivityNotFoundException) {
                    SpikeLog.add(target.section, "no browser for ${url.host}")
                }
            } else {
                SpikeLog.add(target.section, "blocked navigation to a ${url.scheme} URL")
            }
            return true
        }

        override fun onPageFinished(view: WebView, url: String) {
            // Origin and first path segment only: enough to see a redirect, nothing about the user.
            val uri = Uri.parse(url)
            val first = uri.pathSegments.firstOrNull()?.let { "/$it" } ?: "/"
            SpikeLog.add(target.section, "loaded ${uri.scheme}://${uri.host}$first")
        }

        override fun onRenderProcessGone(view: WebView, detail: RenderProcessGoneDetail): Boolean {
            SpikeLog.add(target.section, "renderer gone (crash: ${detail.didCrash()}); closing")
            finish()
            return true
        }
    }

    private fun hostAllowed(host: String?): Boolean =
        host != null && target.navigableHosts.any { host == it || host.endsWith(".$it") }

    private inner class Chrome : WebChromeClient() {
        override fun onConsoleMessage(message: ConsoleMessage): Boolean {
            // Only our own pages' console: Discord's is noise and none of our business.
            if (!target.servesAssets) return false
            SpikeLog.add(target.section, "console ${message.messageLevel()}: ${message.message()}")
            return true
        }

        override fun onPermissionRequest(request: PermissionRequest) {
            val asked = request.resources.toList()
            if (!sameOrigin(request.origin, target.origin)) {
                SpikeLog.add(target.section, "denied $asked to ${request.origin}")
                request.deny()
                return
            }
            val wanted = asked.filter { it in GRANTABLE }
            val refused = asked - wanted.toSet()
            if (refused.isNotEmpty()) SpikeLog.add(target.section, "not granting $refused")
            if (wanted.isEmpty()) {
                request.deny()
                return
            }
            val missing = wanted.map { GRANTABLE.getValue(it) }.filter { !held(it) }
            if (missing.isEmpty()) {
                grant(request)
            } else {
                pendingPermission?.deny()
                pendingPermission = request
                requestPermissions(missing.toTypedArray(), REQUEST_MEDIA)
            }
        }

        override fun onPermissionRequestCanceled(request: PermissionRequest) {
            if (pendingPermission == request) pendingPermission = null
        }
    }

    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
        if (requestCode != REQUEST_MEDIA) return
        val request = pendingPermission ?: return
        pendingPermission = null
        grant(request)
    }

    /** Grants only camera/microphone, and only those the app itself holds. */
    private fun grant(request: PermissionRequest) {
        val granted = request.resources.filter { resource -> GRANTABLE[resource]?.let { held(it) } == true }
        if (granted.isEmpty()) {
            SpikeLog.add(target.section, "camera/microphone permission refused")
            request.deny()
        } else {
            SpikeLog.add(target.section, "granted ${granted.map { it.substringAfterLast('.') }} to ${target.origin}")
            request.grant(granted.toTypedArray())
        }
    }

    private fun held(permission: String): Boolean =
        checkSelfPermission(permission) == PackageManager.PERMISSION_GRANTED

    companion object {
        private const val LISTENER = "multicordSpike"
        private const val REQUEST_MEDIA = 1
        private const val EXTRA_TARGET = "target"
        private const val EXTRA_DESKTOP_UA = "desktopUa"
        private const val EXTRA_PAGE = "page"
        private const val EXTRA_TEST_CAMERA = "testCamera"
        private const val EXTRA_USB_CAMERA = "usbCamera"
        /** What the patch says when it starts, and what the app's port handover carries (fakecam.js). */
        private const val USB_HELLO = "usb-camera:hello"
        private const val USB_PORT_MESSAGE = "multicord-usb-camera"
        private val CONFIG = Regex("/\\*MULTICORD_CONFIG\\*/.*?/\\*END_MULTICORD_CONFIG\\*/")
        private const val TARGET_DISCORD = "discord"
        private const val TARGET_PAGE = "page"
        private const val DISCORD_ORIGIN = "https://discord.com"
        private const val PAGE_ORIGIN = "https://" + WebViewAssetLoader.DEFAULT_DOMAIN

        private val GRANTABLE = mapOf(
            PermissionRequest.RESOURCE_VIDEO_CAPTURE to Manifest.permission.CAMERA,
            PermissionRequest.RESOURCE_AUDIO_CAPTURE to Manifest.permission.RECORD_AUDIO,
        )

        fun discord(context: Context, desktopUa: Boolean, testCamera: Boolean, usbCamera: Boolean): Intent =
            Intent(context, WebActivity::class.java)
                .putExtra(EXTRA_TARGET, TARGET_DISCORD)
                .putExtra(EXTRA_DESKTOP_UA, desktopUa)
                .putExtra(EXTRA_TEST_CAMERA, testCamera)
                .putExtra(EXTRA_USB_CAMERA, usbCamera)

        /** A bundled test page from assets/web, served on an https origin (a secure context). */
        fun page(context: Context, page: String, testCamera: Boolean = false, usbCamera: Boolean = false): Intent =
            Intent(context, WebActivity::class.java)
                .putExtra(EXTRA_TARGET, TARGET_PAGE)
                .putExtra(EXTRA_PAGE, page)
                .putExtra(EXTRA_TEST_CAMERA, testCamera)
                .putExtra(EXTRA_USB_CAMERA, usbCamera)

        private fun targetFrom(intent: Intent): Target =
            if (intent.getStringExtra(EXTRA_TARGET) == TARGET_DISCORD) {
                Target(
                    section = "discord",
                    origin = DISCORD_ORIGIN,
                    profile = "spike-discord",
                    startUrl = "$DISCORD_ORIGIN/app",
                    navigableHosts = setOf("discord.com", "discord.gg", "discordapp.com", "hcaptcha.com"),
                    servesAssets = false,
                )
            } else {
                // Only plain file names from our own assets/web folder.
                val page = intent.getStringExtra(EXTRA_PAGE)?.takeIf { it.matches(Regex("[a-z0-9-]+\\.html")) } ?: "camera.html"
                Target(
                    section = page.removeSuffix(".html"),
                    origin = PAGE_ORIGIN,
                    profile = "spike-pages",
                    startUrl = "$PAGE_ORIGIN/assets/web/$page",
                    navigableHosts = setOf(WebViewAssetLoader.DEFAULT_DOMAIN),
                    servesAssets = true,
                )
            }

        /** Exact https origin match on the default port. */
        fun sameOrigin(uri: Uri, origin: String): Boolean {
            val expected = Uri.parse(origin)
            return uri.scheme == "https" && uri.host == expected.host && (uri.port == -1 || uri.port == 443)
        }
    }
}
