// Multicord for Android. Copyright (C) 2026 Multicord contributors. AGPL-3.0-or-later, see LICENSE at the repo root.
package app.multicord.shell

import android.annotation.SuppressLint
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.util.Log
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import androidx.webkit.WebSettingsCompat
import androidx.webkit.WebViewFeature
import app.multicord.net.NetPolicy
import app.multicord.net.UrlPolicy
import java.io.InputStream
import java.net.InetAddress

/** What the shell page and the chat views have in common: our own pages, served from assets, in WebViews that hold nothing. */
internal object Pages {
    const val TAG = "Multicord"

    /** A page's settings: scripts, its own web storage, nothing from files or other apps, no windows. */
    @SuppressLint("SetJavaScriptEnabled")
    fun configure(view: WebView) {
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
        // Our pages draw their own light and dark themes, as the theme setting says (data-theme, prefers-color-scheme).
        noAlgorithmicDarkening(view)
    }

    /**
     * The WebView never darkens a page itself (algorithmic darkening; off by default for apps that target
     * Android 13 and later, said here so a change of theme or target cannot turn it on): pages keep their own themes.
     */
    fun noAlgorithmicDarkening(view: WebView) {
        if (WebViewFeature.isFeatureSupported(WebViewFeature.ALGORITHMIC_DARKENING)) WebSettingsCompat.setAlgorithmicDarkeningAllowed(view.settings, false)
    }

    /**
     * Serves one of our files, or refuses: `files` maps a path on the page's origin to (asset under
     * web/shell, type). Only GET, only the default port.
     */
    fun serve(context: Context, files: Map<String, Pair<String, String>>, url: Uri, method: String, csp: String): WebResourceResponse {
        val file = files[url.path ?: ""]
        if (file == null || method != "GET" || url.port != -1) return notFound(csp)
        return respond(file.second, context.assets.open("web/shell/${file.first}"), csp)
    }

    /**
     * Whether a page may load a picture or media from the network: https, a public host the hosts allow
     * (null: any public host), resolving to public addresses. The WebView resolves the name again itself.
     */
    fun mayLoad(url: Uri, hosts: List<String>?): Boolean =
        NetPolicy.checkUrl(url.toString(), UrlPolicy(listOf("https:"), hosts)) == null && resolvesPublicly(url.host)

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

    /** A link the user tapped opens in their browser, https only; the page itself never navigates. */
    fun openOutside(context: Context, request: WebResourceRequest) {
        val url = request.url
        if (url.scheme != "https" || !request.hasGesture()) return
        try {
            context.startActivity(Intent(Intent.ACTION_VIEW, url).addCategory(Intent.CATEGORY_BROWSABLE).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        } catch (error: Exception) {
            Log.w(TAG, "No browser for a link: ${error.message}")
        }
    }

    fun respond(type: String, data: InputStream, csp: String, status: Int = 200, reason: String = "OK") =
        WebResourceResponse(type, "utf-8", status, reason, mapOf("Content-Security-Policy" to csp, "X-Content-Type-Options" to "nosniff"), data)

    fun notFound(csp: String) = respond("text/plain", ByteArray(0).inputStream(), csp, 404, "Not Found")

    fun blocked(csp: String) = respond("text/plain", ByteArray(0).inputStream(), csp, 403, "Forbidden")
}
