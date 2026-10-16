// Multicord for Android. Copyright (C) 2026 Multicord contributors. AGPL-3.0-or-later, see LICENSE at the repo root.
package app.multicord

import android.content.Context
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature

/**
 * Whether this phone's WebView can run Multicord, checked before anything starts: the desktop build's
 * bundles need Chromium 140 (`Uint8Array.fromBase64`, among others), and the app needs Profiles,
 * document-start scripts and origin-restricted message listeners. Below that nothing starts and the
 * screen says what to update (docs/mobile.md, section 8, risk 3).
 */
object WebViewSupport {
    /** The lowest WebView major version the bundles run on. */
    const val MIN_MAJOR = 140

    /** The androidx.webkit features the app cannot run without. */
    val REQUIRED_FEATURES = listOf(WebViewFeature.MULTI_PROFILE, WebViewFeature.DOCUMENT_START_SCRIPT, WebViewFeature.WEB_MESSAGE_LISTENER)

    /** Why the WebView cannot run Multicord, for the screen; null when it can. */
    sealed class Problem(val message: String) {
        object NoWebView : Problem("Multicord needs Android System WebView, and this phone has none enabled. Install or enable Android System WebView $MIN_MAJOR or newer from your app store.")
        class TooOld(val version: String) : Problem("Multicord needs Android System WebView $MIN_MAJOR or newer; this phone has $version. Update it in your app store, then open Multicord again.")
        class MissingFeatures(val features: List<String>) : Problem("This phone's Android System WebView lacks what Multicord needs (${features.joinToString()}). Update Android System WebView in your app store, then open Multicord again.")
    }

    /** The major version in a WebView package's version name ("154.0.8037.106" is 154); null when it has none. */
    fun majorOf(versionName: String?): Int? = versionName?.let { Regex("^(\\d{1,4})(\\.|$)").find(it.trim())?.groupValues?.get(1)?.toIntOrNull() }

    /**
     * The check itself, apart from Android: the WebView package's version name (null when there is no
     * WebView) and which features it has.
     */
    fun problem(versionName: String?, supported: (String) -> Boolean): Problem? {
        if (versionName == null) return Problem.NoWebView
        val major = majorOf(versionName)
        if (major == null || major < MIN_MAJOR) return Problem.TooOld(versionName)
        val missing = REQUIRED_FEATURES.filterNot(supported)
        return if (missing.isEmpty()) null else Problem.MissingFeatures(missing)
    }

    /** This phone's WebView, checked. */
    fun problem(context: Context): Problem? {
        val version = try {
            WebViewCompat.getCurrentWebViewPackage(context)?.versionName
        } catch (_: Exception) {
            null
        }
        // Features are asked only of a WebView that is there and new enough; asking loads it.
        return problem(version) { feature -> WebViewFeature.isFeatureSupported(feature) }
    }
}
