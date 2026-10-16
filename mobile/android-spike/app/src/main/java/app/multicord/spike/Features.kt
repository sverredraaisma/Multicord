// Multicord Android spike (phase 0). Copyright (C) 2026 Multicord contributors.
// AGPL-3.0-or-later, see LICENSE at the repo root.
package app.multicord.spike

import android.content.Context
import android.os.Build
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature

/** What the device's WebView supports, the first thing the user sends back (docs/mobile.md, risk 3). */
object Features {
    /** The androidx.webkit features the mobile design rests on (docs/mobile.md, section 2). */
    private val watched = listOf(
        WebViewFeature.MULTI_PROFILE,
        WebViewFeature.DOCUMENT_START_SCRIPT,
        WebViewFeature.WEB_MESSAGE_LISTENER,
        WebViewFeature.WEB_MESSAGE_ARRAY_BUFFER,
        WebViewFeature.CREATE_WEB_MESSAGE_CHANNEL,
        WebViewFeature.POST_WEB_MESSAGE,
        WebViewFeature.JS_INJECTION_IN_FRAME_AND_WORLD,
    )

    fun isSupported(feature: String): Boolean = WebViewFeature.isFeatureSupported(feature)

    fun report(context: Context) {
        SpikeLog.add("device", "${Build.MANUFACTURER} ${Build.MODEL}, Android ${Build.VERSION.RELEASE} (API ${Build.VERSION.SDK_INT})")
        val pkg = WebViewCompat.getCurrentWebViewPackage(context)
        SpikeLog.add("webview", if (pkg == null) "no WebView package" else "${pkg.packageName} ${pkg.versionName}")
        for (feature in watched) {
            SpikeLog.add("feature", "$feature: ${if (isSupported(feature)) "yes" else "NO"}")
        }
    }
}
