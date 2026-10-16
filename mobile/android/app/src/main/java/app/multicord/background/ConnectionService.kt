// Multicord for Android. Copyright (C) 2026 Multicord contributors. AGPL-3.0-or-later, see LICENSE at the repo root.
package app.multicord.background

import android.Manifest
import android.app.PendingIntent
import android.app.Service
import android.content.Intent
import android.content.pm.PackageManager
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import android.util.Log
import app.multicord.Hub
import app.multicord.MainActivity
import app.multicord.MulticordApp
import app.multicord.call.CallPolicy

/**
 * Keeps the app's process, and with it the Hub (the shell page with core, the engines and their native
 * sockets), running while no activity is on screen, so messages keep arriving and notifications keep
 * coming. A foreground service of type specialUse (see the manifest's justification and
 * mobile/android/README.md): its notification says the services are connected and has Quit; the user can
 * hide it through its channel ("Connection") in the system's settings. Started by the Hub, stopped by Quit.
 *
 * While the user is in a call it is also of type microphone (and camera, with video), so the call keeps
 * its microphone and camera with the screen off or another app in front; its notification then says so,
 * on a channel of its own, with Hang up.
 */
class ConnectionService : Service() {
    override fun onBind(intent: Intent?): IBinder? = null

    /** Since when the current call has been shown; 0 while there is none. */
    private var callSince = 0L

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val app = application as MulticordApp
        if (intent?.action == ACTION_QUIT) {
            app.quit()
            return START_NOT_STICKY
        }
        if (intent?.action == ACTION_HANG_UP) {
            app.hubIfStarted()?.hangUp()
            return START_STICKY
        }
        // Started again by the system after it stopped the process: the Hub comes back without a screen.
        val hub = app.hubIfSupported()
        if (hub == null) {
            stopSelf()
            return START_NOT_STICKY
        }
        if (!foreground(hub)) {
            stopSelf()
            return START_NOT_STICKY
        }
        hub.onRunningChanged = { if (hub.calls.isEmpty()) hub.notifier.update(hub.notifier.connected(it, quitIntent(), openIntent())) }
        hub.onCallsChanged = { foreground(hub) }
        return START_STICKY
    }

    /** Runs in the foreground with the notification and types the calls in progress call for; false if refused. */
    private fun foreground(hub: Hub): Boolean {
        val call = hub.calls.firstOrNull()
        if (call == null) callSince = 0L else if (callSince == 0L) callSince = System.currentTimeMillis()
        val notification = if (call == null) hub.notifier.connected(hub.running, quitIntent(), openIntent()) else hub.notifier.inCall(call, callSince, hangUpIntent(), openIntent())
        // Before Android 14 a service starts without types (the manifest's apply).
        if (Build.VERSION.SDK_INT < 34) return try {
            startForeground(Notifier.CONNECTED_ID, notification)
            true
        } catch (error: Exception) {
            // Android 12 and later refuse a foreground start from the background; the app then runs while it is on screen.
            Log.w(TAG, "Could not run in the background: ${error.message}")
            false
        }
        val types = CallPolicy.serviceTypes(hub.calls, held(Manifest.permission.RECORD_AUDIO), held(Manifest.permission.CAMERA))
        return try {
            startForeground(Notifier.CONNECTED_ID, notification, types)
            true
        } catch (error: Exception) {
            if (types == ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE) {
                Log.w(TAG, "Could not run in the background: ${error.message}")
                return false
            }
            // A call's types may be refused (say, the app was not in front): the connections keep running, the call may lose its sound when the screen goes off.
            Log.w(TAG, "Could not hold the microphone or camera in the background: ${error.message}")
            try {
                startForeground(Notifier.CONNECTED_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE)
                true
            } catch (again: Exception) {
                Log.w(TAG, "Could not run in the background: ${again.message}")
                false
            }
        }
    }

    private fun held(permission: String) = checkSelfPermission(permission) == PackageManager.PERMISSION_GRANTED

    override fun onDestroy() {
        (application as MulticordApp).hubIfStarted()?.let {
            it.onRunningChanged = null
            it.onCallsChanged = null
        }
        super.onDestroy()
    }

    private fun quitIntent() = PendingIntent.getService(this, 0, Intent(this, ConnectionService::class.java).setAction(ACTION_QUIT), PendingIntent.FLAG_IMMUTABLE)

    private fun hangUpIntent() = PendingIntent.getService(this, 1, Intent(this, ConnectionService::class.java).setAction(ACTION_HANG_UP), PendingIntent.FLAG_IMMUTABLE)

    private fun openIntent() = PendingIntent.getActivity(this, 0, Intent(this, MainActivity::class.java), PendingIntent.FLAG_IMMUTABLE)

    companion object {
        private const val TAG = "Multicord"
        const val ACTION_QUIT = "app.multicord.action.QUIT"
        /** From the call notification: leaves every call in progress. The service is not exported, so only this app sends it. */
        const val ACTION_HANG_UP = "app.multicord.action.HANG_UP"
    }
}
