// Multicord for Android. Copyright (C) 2026 Multicord contributors. AGPL-3.0-or-later, see LICENSE at the repo root.
package app.multicord

import android.app.Application
import android.util.Log
import androidx.webkit.WebViewFeature

class MulticordApp : Application() {
    private var hub: Hub? = null

    override fun onCreate() {
        super.onCreate()
        // A crash is logged under the app's own tag too, so it can be read without the system's logs.
        val previous = Thread.getDefaultUncaughtExceptionHandler()
        Thread.setDefaultUncaughtExceptionHandler { thread, error ->
            Log.e("Multicord", "Crashed on ${thread.name}", error)
            previous?.uncaughtException(thread, error)
        }
    }

    /** The services and their WebViews, made the first time something needs them. The caller has checked the WebView. */
    fun hub(): Hub = hub ?: Hub(this).also {
        hub = it
        it.start()
    }

    /** The Hub, when this phone's WebView can run it; null otherwise. */
    fun hubIfSupported(): Hub? = if (REQUIRED_FEATURES.all(WebViewFeature::isFeatureSupported)) hub() else null

    fun hubIfStarted(): Hub? = hub

    /** Quit from the connected notification: everything stops until the user opens Multicord again. */
    fun quit() {
        hub?.quit()
        hub = null
    }

    companion object {
        val REQUIRED_FEATURES = listOf(WebViewFeature.MULTI_PROFILE, WebViewFeature.WEB_MESSAGE_LISTENER, WebViewFeature.DOCUMENT_START_SCRIPT)
    }
}
