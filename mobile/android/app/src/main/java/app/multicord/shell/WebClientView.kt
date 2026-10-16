// Multicord for Android. Copyright (C) 2026 Multicord contributors. AGPL-3.0-or-later, see LICENSE at the repo root.
package app.multicord.shell

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
import androidx.webkit.ProfileStore
import androidx.webkit.WebViewCompat
import app.multicord.BuildConfig
import app.multicord.bridge.Limits

/**
 * One web-client instance: the service's own web app (Element, Stoat, Fluxer, Spacebar, Nerimity, or any
 * web app the user adds) in a plain WebView, as the desktop shows it in a sandboxed view with no preload.
 * It gets nothing of Multicord's: no bridge, no message listener, no document-start script, no request
 * interception. Its storage (cookies, IndexedDB, service workers) is in a Profile of its own,
 * "web-<instance>", which no other instance, engine or view shares; third-party cookies are off.
 *
 * Navigation stays on the app's own pages (WebClientPolicy); links elsewhere open in the browser.
 * Camera and microphone go to the app's own pages only, and only when the user grants Android's
 * permission too; nothing else is granted (no location, no DRM ids, no MIDI). Its unread count is read
 * from the page title (onReceivedTitle), as the desktop reads page-title-updated.
 */
class WebClientView(
    private val context: Context,
    val instanceId: String,
    /** The web app's address (https, from platforms.json, checked by ShellCommands). */
    private val url: String,
    /** The page's title, clipped, for the shell page (its unread count). */
    private val onTitle: (String) -> Unit,
    private val ui: Ui,
) {
    /** What the view needs from the screen: the document picker for uploads, and Android's runtime permissions. */
    interface Ui {
        fun pickDocuments(done: (List<String>) -> Unit): Boolean

        /** Asks for Android permissions (those already held are not asked again); `done` gets the ones granted. False without a screen. */
        fun requestPermissions(permissions: List<String>, done: (Set<String>) -> Unit): Boolean
    }

    var webView: WebView? = null
        private set

    @SuppressLint("SetJavaScriptEnabled")
    fun start() {
        val view = WebView(context)
        val name = profileName(instanceId)
        val profile = ProfileStore.getInstance().getOrCreateProfile(name)
        WebViewCompat.setProfile(view, name)
        // Web apps keep their sign-in in cookies; only their own (first-party) ones.
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
            mediaPlaybackRequiresUserGesture = true
            // No URL lookups with a third party; the desktop's views have none either.
            safeBrowsingEnabled = false
        }
        // The service's own themes, as on the desktop: the WebView does not darken the page itself.
        Pages.noAlgorithmicDarkening(view)
        view.webViewClient = Client()
        view.webChromeClient = Chrome()
        // Keeps running while not shown, so its title (unread count) stays current, as on the desktop.
        view.setRendererPriorityPolicy(WebView.RENDERER_PRIORITY_IMPORTANT, false)
        webView = view
        Log.i(TAG, "[web $instanceId] loading its web app")
        view.loadUrl(url)
    }

    /** Back within the web app; false when it has nothing to go back to. */
    fun back(): Boolean {
        val view = webView ?: return false
        if (!view.canGoBack()) return false
        view.goBack()
        return true
    }

    /** The user's Restart: the web app loads again from its address. */
    fun restart() {
        webView?.loadUrl(url) ?: start()
    }

    fun destroy() {
        webView?.let {
            (it.parent as? android.view.ViewGroup)?.removeView(it)
            it.destroy()
        }
        webView = null
    }

    private fun openInBrowser(target: Uri) {
        try {
            context.startActivity(Intent(Intent.ACTION_VIEW, target).addCategory(Intent.CATEGORY_BROWSABLE).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        } catch (error: Exception) {
            Log.w(TAG, "No browser for a link: ${error.message}")
        }
    }

    private inner class Client : WebViewClient() {
        override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
            if (!request.isForMainFrame) return false
            return when (WebClientPolicy.navigation(request.url.toString(), url, request.hasGesture())) {
                WebClientPolicy.Navigation.LOAD -> false
                WebClientPolicy.Navigation.BROWSER -> {
                    openInBrowser(request.url)
                    true
                }
                WebClientPolicy.Navigation.DROP -> {
                    Log.i(TAG, "[web $instanceId] dropped a navigation away from the app")
                    true
                }
            }
        }

        override fun onRenderProcessGone(view: WebView, detail: RenderProcessGoneDetail): Boolean {
            if (view !== webView) return true
            Log.w(TAG, "[web $instanceId] renderer gone (crash: ${detail.didCrash()}); loading again")
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
        override fun onReceivedTitle(view: WebView, title: String?) {
            if (view === webView && title != null) onTitle(title.take(Limits.MAX_TEXT))
        }

        override fun onPermissionRequest(request: PermissionRequest) {
            val wanted = WebClientPolicy.grantable(request.resources.toList(), request.origin?.toString(), url)
            if (wanted.isEmpty()) return request.deny()
            val needed = wanted.mapNotNull { WebClientPolicy.ANDROID_PERMISSIONS[it] }.distinct()
            val asked = ui.requestPermissions(needed) { granted ->
                val ok = wanted.filter { WebClientPolicy.ANDROID_PERMISSIONS[it] in granted }
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
            if (BuildConfig.DEBUG) Log.d(TAG, "[web $instanceId] ${message.messageLevel()} ${message.message().take(200)}")
            return true
        }
    }

    companion object {
        private const val TAG = "Multicord"

        /** The Profile a web-client instance keeps its cookies and storage in. */
        fun profileName(instanceId: String) = "web-$instanceId"
    }
}
