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

    /** The services and their WebViews, made the first time something needs them (the WebView must be recent enough). */
    fun hub(): Hub = hub ?: Hub(this).also {
        hub = it
        it.start()
    }
}
