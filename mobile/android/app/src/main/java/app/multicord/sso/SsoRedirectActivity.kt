// Multicord for Android. Copyright (C) 2026 Multicord contributors. AGPL-3.0-or-later, see LICENSE at the repo root.
package app.multicord.sso

import android.app.Activity
import android.content.Intent
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.util.Log
import app.multicord.BuildConfig
import app.multicord.MainActivity

/** The one SsoBroker of the app, on the main thread; its scheme is "<applicationId>.sso" (the manifest's filter). */
object Sso {
    val scheme = "${BuildConfig.APPLICATION_ID}.sso"
    private val main = Handler(Looper.getMainLooper())
    val broker = SsoBroker(scheme, { delay, action -> main.postDelayed(action, delay) })
}

/**
 * Where the browser comes back after single sign-on: `<applicationId>.sso:/<path>?loginToken=…`. It shows
 * nothing; it hands the address to the broker, which ends the waiting request only when the path is that
 * request's, and then brings Multicord back over the browser tab. Only the address is read, never extras.
 */
class SsoRedirectActivity : Activity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val address = intent?.data?.toString()
        val ended = address != null && intent?.action == Intent.ACTION_VIEW && Sso.broker.receive(address)
        if (ended) {
            // Back to the app, closing the browser tab above it.
            startActivity(Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP))
        } else {
            Log.w("Multicord", "[sso] ignored a redirect that is not the waiting sign-in's")
        }
        finish()
    }
}
