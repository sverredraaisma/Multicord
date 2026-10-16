// Multicord for Android. Copyright (C) 2026 Multicord contributors. AGPL-3.0-or-later, see LICENSE at the repo root.
package app.multicord.background

import android.app.PendingIntent
import android.app.Service
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import android.util.Log
import app.multicord.MainActivity
import app.multicord.MulticordApp

/**
 * Keeps the app's process, and with it the Hub (the shell page with core, the engines and their native
 * sockets), running while no activity is on screen, so messages keep arriving and notifications keep
 * coming. A foreground service of type specialUse (see the manifest's justification and
 * mobile/android/README.md): its notification says the services are connected and has Quit; the user can
 * hide it through its channel ("Connection") in the system's settings. Started by the Hub, stopped by Quit.
 */
class ConnectionService : Service() {
    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val app = application as MulticordApp
        if (intent?.action == ACTION_QUIT) {
            app.quit()
            return START_NOT_STICKY
        }
        // Started again by the system after it stopped the process: the Hub comes back without a screen.
        val hub = app.hubIfSupported()
        if (hub == null) {
            stopSelf()
            return START_NOT_STICKY
        }
        val notification = hub.notifier.connected(hub.running, quitIntent(), openIntent())
        try {
            if (Build.VERSION.SDK_INT >= 34) startForeground(Notifier.CONNECTED_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE)
            else startForeground(Notifier.CONNECTED_ID, notification)
        } catch (error: Exception) {
            // Android 12 and later refuse a foreground start from the background; the app then runs while it is on screen.
            Log.w(TAG, "Could not run in the background: ${error.message}")
            stopSelf()
            return START_NOT_STICKY
        }
        hub.onRunningChanged = { count -> hub.notifier.update(hub.notifier.connected(count, quitIntent(), openIntent())) }
        return START_STICKY
    }

    override fun onDestroy() {
        (application as MulticordApp).hubIfStarted()?.onRunningChanged = null
        super.onDestroy()
    }

    private fun quitIntent() = PendingIntent.getService(this, 0, Intent(this, ConnectionService::class.java).setAction(ACTION_QUIT), PendingIntent.FLAG_IMMUTABLE)

    private fun openIntent() = PendingIntent.getActivity(this, 0, Intent(this, MainActivity::class.java), PendingIntent.FLAG_IMMUTABLE)

    companion object {
        private const val TAG = "Multicord"
        const val ACTION_QUIT = "app.multicord.action.QUIT"
    }
}
