// Multicord for Android. Copyright (C) 2026 Multicord contributors. AGPL-3.0-or-later, see LICENSE at the repo root.
package app.multicord.discord

import android.annotation.SuppressLint
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.util.Log
import android.webkit.ConsoleMessage
import android.webkit.GeolocationPermissions
import android.webkit.PermissionRequest
import android.webkit.RenderProcessGoneDetail
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.webkit.JavaScriptReplyProxy
import androidx.webkit.ProfileStore
import androidx.webkit.UserAgentMetadata
import androidx.webkit.WebMessageCompat
import androidx.webkit.WebSettingsCompat
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import app.multicord.BuildConfig
import app.multicord.bridge.BridgeScripts
import app.multicord.camera.CameraLink
import app.multicord.camera.UsbCamera
import app.multicord.shell.Pages
import app.multicord.shell.WebClientView
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

/**
 * One Discord instance: Discord's own web app (https://discord.com/app) in a WebView with the desktop's hooks
 * ported (docs/mobile.md, section 3). Its storage (cookies, IndexedDB, service workers) is in a Profile of its
 * own, "discord-<instance>"; third-party cookies are off. It navigates only on Discord's pages (DiscordPolicy),
 * gets the camera and microphone only for https://discord.com and only with Android's permission, and has no
 * file access; the app has no cleartext traffic.
 *
 * Two document-start scripts, both restricted to https://discord.com and both acting only in the top frame
 * (src/mobile/discordView.ts): discord-page.js in the page's main world (the desktop's store bridge and
 * Notification relay, and a watch on the page's own camera and microphone tracks), and discord-relay.js, the
 * desktop preload's isolated half, with the message listener, in an isolated world where the WebView has
 * JS_INJECTION_IN_FRAME_AND_WORLD (the page's world otherwise). Every message is bound to this WebView, its
 * top frame and Discord's origin, and checked with the desktop's validators (DiscordValidators) before the
 * shell page hears of it. The page never gets a channel to the shell page, an engine or another view.
 *
 * As on the desktop, nothing here calls Discord's APIs or automates its client: the page is read (its hidden
 * guild bar, its stores, its notifications) and driven only as the desktop drives it (its own links and
 * guild bar items, its own notification click handlers).
 */
class DiscordView(
    private val context: Context,
    val instanceId: String,
    /** Discord's address (https://discord.com/app; platforms.json fixes it). */
    private val url: String,
    /** The module's settings native code applies (the desktop site), from the start command. */
    settings: JsonObject?,
    private val listener: Listener,
    private val ui: WebClientView.Ui,
    /** The phone's USB camera, made when first needed. */
    camera: () -> UsbCamera,
) {
    /** What the view reports, each already checked. */
    interface Listener {
        /** What the page reports (isDiscordState). */
        fun onState(state: JsonObject)

        /** A notification Discord's page wanted to show (isRelayedNotification). */
        fun onNotification(notification: JsonObject)

        /** Whether the page holds a live microphone or camera track (a call); both false when the page goes. */
        fun onMedia(audio: Boolean, video: Boolean)
    }

    var webView: WebView? = null
        private set
    private var proxy: JavaScriptReplyProxy? = null
    private var desktopSite = DiscordPolicy.desktopSite(settings)
    /** "USB camera in calls": the camera offered in Discord's device list (usb-camera.js, CameraPort). */
    private val usbCamera = CameraLink(DiscordPolicy.ORIGIN, camera).also { it.setEnabled(DiscordPolicy.usbCamera(settings), null) }
    private var mediaLive = false
    private var ownMetadata: UserAgentMetadata? = null

    @SuppressLint("SetJavaScriptEnabled")
    fun start() {
        val view = WebView(context)
        val name = profileName(instanceId)
        val profile = ProfileStore.getInstance().getOrCreateProfile(name)
        WebViewCompat.setProfile(view, name)
        // Discord keeps its sign-in in its own storage and cookies; only first-party ones.
        profile.cookieManager.setAcceptCookie(true)
        profile.cookieManager.setAcceptThirdPartyCookies(view, false)
        view.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            allowFileAccess = false
            allowContentAccess = false
            setGeolocationEnabled(false)
            // Popups and target=_blank load in this view, where navigation() decides about them.
            setSupportMultipleWindows(false)
            javaScriptCanOpenWindowsAutomatically = false
            // A call's sound plays without a tap of its own: joining it was the tap.
            mediaPlaybackRequiresUserGesture = false
            safeBrowsingEnabled = false
        }
        // Discord's own themes: the WebView does not darken the page itself.
        Pages.noAlgorithmicDarkening(view)
        userAgent(view)
        view.webViewClient = Client()
        view.webChromeClient = Chrome()
        // Keeps running while not shown, so its badge, DMs and notifications stay current, and a call goes on.
        view.setRendererPriorityPolicy(WebView.RENDERER_PRIORITY_IMPORTANT, false)
        webView = view
        install(view)
        Log.i(TAG, "[discord $instanceId] loading Discord (${if (desktopSite) "desktop" else "mobile"} site)")
        view.loadUrl(url)
    }

    /** The desktop site (a desktop user agent and client hints, and a wide viewport), or the WebView's own. */
    private fun userAgent(view: WebView) {
        val settings = view.settings
        // null: the WebView's own user agent.
        settings.userAgentString = null
        if (desktopSite) settings.userAgentString = DiscordPolicy.desktopUserAgent(settings.userAgentString)
        settings.useWideViewPort = desktopSite
        settings.loadWithOverviewMode = desktopSite
        if (WebViewFeature.isFeatureSupported(WebViewFeature.USER_AGENT_METADATA)) {
            // The WebView's own client hints, kept before any change, to go back to.
            val own = ownMetadata ?: WebSettingsCompat.getUserAgentMetadata(settings).also { ownMetadata = it }
            WebSettingsCompat.setUserAgentMetadata(settings, if (desktopSite) UserAgentMetadata.Builder(own).setMobile(false).setPlatform("Linux").setModel("").build() else own)
        } else if (desktopSite) {
            Log.i(TAG, "[discord $instanceId] no USER_AGENT_METADATA: client hints still say mobile")
        }
    }

    /** The two scripts and the listener, for Discord's origin only. */
    private fun install(view: WebView) {
        val origins = setOf(DiscordPolicy.ORIGIN)
        WebViewCompat.addDocumentStartJavaScript(view, asset("web/mobile/discord-page.js"), origins)
        usbCamera.install(context, view)
        val world = BridgeScripts.installRelay(view, LISTENER, asset("web/mobile/discord-relay.js"), origins) { source, message, sourceOrigin, isMainFrame, replyProxy ->
            if (source !== webView || !isMainFrame || sourceOrigin.toString().trimEnd('/') != DiscordPolicy.ORIGIN) return@installRelay
            if (message.type != WebMessageCompat.TYPE_STRING) return@installRelay
            val text = message.data ?: return@installRelay
            if (text.length > MAX_MESSAGE) return@installRelay
            proxy = replyProxy
            onMessage(text)
        }
        Log.i(TAG, "[discord $instanceId] relay in the $world")
    }

    private fun onMessage(text: String) {
        val parsed = try {
            Json.parseToJsonElement(text) as? JsonObject
        } catch (_: Exception) {
            null
        } ?: return
        val body = parsed["body"]
        when ((parsed["k"] as? JsonPrimitive)?.takeIf { it.isString }?.content) {
            "state" -> if (DiscordValidators.isDiscordState(body)) listener.onState(body as JsonObject) else Log.w(TAG, "[discord $instanceId] dropped a malformed state")
            "notification" -> if (DiscordValidators.isRelayedNotification(body)) listener.onNotification(body as JsonObject) else Log.w(TAG, "[discord $instanceId] dropped a malformed notification")
            "media" -> {
                val use = body as? JsonObject ?: return
                val audio = (use["audio"] as? JsonPrimitive)?.takeIf { !it.isString }?.content
                val video = (use["video"] as? JsonPrimitive)?.takeIf { !it.isString }?.content
                if (use.size != 2 || audio !in BOOLEANS || video !in BOOLEANS) return
                media(audio == "true", video == "true")
            }
        }
    }

    private fun media(audio: Boolean, video: Boolean) {
        mediaLive = audio || video
        listener.onMedia(audio, video)
    }

    /** Navigation the shell page asked for, checked again (isDiscordTarget). */
    fun navigate(target: String) {
        if (!DiscordValidators.isDiscordTarget(JsonPrimitive(target))) return
        send(JsonObject(mapOf("k" to JsonPrimitive("navigate"), "target" to JsonPrimitive(target))))
    }

    /** The user opened a notification the page relayed: its own click handler runs. */
    fun clickNotification(id: String) {
        send(JsonObject(mapOf("k" to JsonPrimitive("notificationClick"), "id" to JsonPrimitive(id))))
    }

    private fun send(message: JsonObject) {
        proxy?.postMessage(message.toString())
    }

    /** The module's settings native code applies: the USB camera, and the desktop site, which loads the page again when it changes. */
    fun applySettings(settings: JsonObject) {
        usbCamera.setEnabled(DiscordPolicy.usbCamera(settings), webView)
        val desktop = DiscordPolicy.desktopSite(settings)
        if (desktop == desktopSite) return
        desktopSite = desktop
        val view = webView ?: return
        userAgent(view)
        Log.i(TAG, "[discord $instanceId] ${if (desktop) "desktop" else "mobile"} site; loading again")
        view.loadUrl(url)
    }

    /** Back within Discord's own history; false when it has nothing to go back to. */
    fun back(): Boolean {
        val view = webView ?: return false
        if (!view.canGoBack()) return false
        view.goBack()
        return true
    }

    /** The user's Restart: Discord loads again from its address. */
    fun restart() {
        webView?.loadUrl(url) ?: start()
    }

    fun destroy() {
        webView?.let {
            (it.parent as? android.view.ViewGroup)?.removeView(it)
            it.destroy()
        }
        webView = null
        proxy = null
        usbCamera.close()
        if (mediaLive) media(audio = false, video = false)
    }

    private fun openInBrowser(target: Uri) {
        try {
            context.startActivity(Intent(Intent.ACTION_VIEW, target).addCategory(Intent.CATEGORY_BROWSABLE).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        } catch (error: Exception) {
            Log.w(TAG, "No browser for a link: ${error.message}")
        }
    }

    private fun asset(name: String) = context.assets.open(name).bufferedReader().use { it.readText() }

    private inner class Client : WebViewClient() {
        override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
            if (!request.isForMainFrame) return false
            return when (DiscordPolicy.navigation(request.url.toString(), request.hasGesture())) {
                DiscordPolicy.Navigation.LOAD -> false
                DiscordPolicy.Navigation.BROWSER -> {
                    openInBrowser(request.url)
                    true
                }
                DiscordPolicy.Navigation.DROP -> {
                    Log.i(TAG, "[discord $instanceId] dropped a navigation away from Discord")
                    true
                }
            }
        }

        override fun onPageStarted(view: WebView, url: String?, favicon: android.graphics.Bitmap?) {
            if (view !== webView) return
            // A new document: the old one's reply channel and its camera and microphone are gone.
            proxy = null
            if (mediaLive) media(audio = false, video = false)
        }

        // A loaded document of Discord's gets its own USB camera channel, if the camera is on.
        override fun onPageFinished(view: WebView, url: String?) {
            if (view === webView && DiscordValidators.isDiscordPage(url)) usbCamera.pageLoaded(view)
        }

        override fun onRenderProcessGone(view: WebView, detail: RenderProcessGoneDetail): Boolean {
            if (view !== webView) return true
            Log.w(TAG, "[discord $instanceId] renderer gone (crash: ${detail.didCrash()}); loading again")
            val parent = view.parent as? android.view.ViewGroup
            val at = parent?.indexOfChild(view) ?: -1
            val params = view.layoutParams
            destroy()
            start()
            if (parent != null) parent.addView(webView, at, params)
            return true
        }
    }

    private inner class Chrome : WebChromeClient() {
        override fun onPermissionRequest(request: PermissionRequest) {
            val wanted = DiscordPolicy.grantable(request.resources.toList(), request.origin?.toString())
            if (wanted.isEmpty()) {
                Log.i(TAG, "[discord $instanceId] refused ${request.resources.joinToString()} for ${request.origin}")
                return request.deny()
            }
            val needed = wanted.mapNotNull { DiscordPolicy.ANDROID_PERMISSIONS[it] }.distinct()
            val asked = ui.requestPermissions(needed) { granted ->
                val ok = wanted.filter { DiscordPolicy.ANDROID_PERMISSIONS[it] in granted }
                if (ok.isEmpty()) request.deny() else request.grant(ok.toTypedArray())
            }
            if (!asked) request.deny()
        }

        override fun onGeolocationPermissionsShowPrompt(origin: String?, callback: GeolocationPermissions.Callback) {
            callback.invoke(origin, false, false)
        }

        override fun onShowFileChooser(webView: WebView, filePathCallback: ValueCallback<Array<Uri>>, params: FileChooserParams): Boolean {
            val multiple = params.mode == FileChooserParams.MODE_OPEN_MULTIPLE
            val opened = ui.pickDocuments { picked ->
                val uris = picked.map(Uri::parse).let { if (multiple) it else it.take(1) }
                filePathCallback.onReceiveValue(if (uris.isEmpty()) null else uris.toTypedArray())
            }
            if (!opened) filePathCallback.onReceiveValue(null)
            return true
        }

        override fun onConsoleMessage(message: ConsoleMessage): Boolean {
            if (BuildConfig.DEBUG) Log.d(TAG, "[discord $instanceId] ${message.messageLevel()} ${message.message().take(200)}")
            return true
        }
    }

    companion object {
        private const val TAG = "Multicord"
        /** The listener's name (src/mobile/discordView.ts, DISCORD_LISTENER). */
        private const val LISTENER = "multicordDiscord"
        /** The largest message taken from the page: a full state (1000 guilds, 200 DMs) is well under it. */
        private const val MAX_MESSAGE = 4 * 1024 * 1024
        private val BOOLEANS = setOf("true", "false")

        /** The Profile a Discord instance keeps its cookies and storage in. */
        fun profileName(instanceId: String) = "discord-$instanceId"
    }
}
