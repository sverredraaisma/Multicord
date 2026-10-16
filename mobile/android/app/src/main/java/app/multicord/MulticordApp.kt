// Multicord for Android. Copyright (C) 2026 Multicord contributors. AGPL-3.0-or-later, see LICENSE at the repo root.
package app.multicord

import android.app.Application
import android.util.Log

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

    /** Why this phone's WebView cannot run Multicord (checked once per process); null when it can. */
    val webViewProblem: WebViewSupport.Problem? by lazy { WebViewSupport.problem(this) }

    /** The Hub, when this phone's WebView can run it; null otherwise (nothing starts). */
    fun hubIfSupported(): Hub? = if (webViewProblem == null) hub() else null

    fun hubIfStarted(): Hub? = hub

    /** Quit from the connected notification: everything stops until the user opens Multicord again. */
    fun quit() {
        hub?.quit()
        hub = null
    }
}
