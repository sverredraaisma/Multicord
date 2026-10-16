// Multicord for Android. Copyright (C) 2026 Multicord contributors. AGPL-3.0-or-later, see LICENSE at the repo root.
package app.multicord.background

import android.Manifest
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import app.multicord.MainActivity
import app.multicord.call.Call

/** What a tapped notification opens: one instance's conversation, as the shell page named it. */
data class NotificationTarget(val instance: String, val target: String, val railKey: String?) {
    fun into(intent: Intent): Intent = intent
        .putExtra(EXTRA_INSTANCE, instance)
        .putExtra(EXTRA_TARGET, target)
        .apply { if (railKey != null) putExtra(EXTRA_RAIL_KEY, railKey) }

    companion object {
        private const val EXTRA_INSTANCE = "app.multicord.instance"
        private const val EXTRA_TARGET = "app.multicord.target"
        private const val EXTRA_RAIL_KEY = "app.multicord.railKey"
        private val INSTANCE = Regex("^[a-z0-9][a-z0-9-]{0,31}$")
        private const val MAX_KEY = 200

        /**
         * The target an intent carries, checked again: the PendingIntent is ours and immutable, but the
         * activity is exported (it is the launcher's), so anything could send it these extras.
         */
        fun from(intent: Intent?): NotificationTarget? {
            val instance = intent?.getStringExtra(EXTRA_INSTANCE) ?: return null
            return of(instance, intent.getStringExtra(EXTRA_TARGET), intent.getStringExtra(EXTRA_RAIL_KEY))
        }

        /** A target from its parts, when they have the shapes the shell page gives them. */
        fun of(instance: String, target: String?, railKey: String?): NotificationTarget? {
            if (!INSTANCE.matches(instance) || target.isNullOrEmpty() || target.length > MAX_KEY) return null
            if (railKey != null && (railKey.isEmpty() || railKey.length > MAX_KEY)) return null
            return NotificationTarget(instance, target, railKey)
        }
    }
}

/**
 * The app's notifications: messages and calls the shell page decided to show (it has applied the
 * notification settings, per service too, and streamer mode), and the persistent "connected" one of the
 * background service, on a channel of its own the user can silence or hide in the system's settings.
 * The launcher badge comes from the message notifications' number.
 */
class Notifier(private val context: Context) {
    private val manager = context.getSystemService(NotificationManager::class.java)

    init {
        manager.createNotificationChannels(listOf(
            NotificationChannel(CONNECTION, "Connection", NotificationManager.IMPORTANCE_MIN).apply {
                description = "Shown while Multicord keeps your services connected in the background. Turn it off here to hide it."
                setShowBadge(false)
            },
            NotificationChannel(MESSAGES, "Messages", NotificationManager.IMPORTANCE_HIGH).apply {
                description = "New messages and mentions from your services."
                setShowBadge(true)
            },
            NotificationChannel(CALLS, "Calls", NotificationManager.IMPORTANCE_HIGH).apply {
                description = "Someone is calling you."
                setShowBadge(true)
            },
            NotificationChannel(ONGOING, "Ongoing calls", NotificationManager.IMPORTANCE_LOW).apply {
                description = "Shown while you are in a call, with a button to hang up."
                setShowBadge(false)
            },
        ))
    }

    /** Whether the user lets the app post notifications (Android 13 asks at run time). */
    fun allowed(): Boolean =
        Build.VERSION.SDK_INT < 33 || context.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED

    fun message(target: NotificationTarget, title: String, body: String, urgent: Boolean, badge: Int) {
        if (!allowed()) return
        val open = PendingIntent.getActivity(
            context,
            idOf(target),
            target.into(Intent(context, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP)),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        val notification = Notification.Builder(context, if (urgent) CALLS else MESSAGES)
            .setSmallIcon(android.R.drawable.stat_notify_chat)
            .setContentTitle(title)
            .setContentText(body)
            .setStyle(Notification.BigTextStyle().bigText(body))
            .setContentIntent(open)
            .setAutoCancel(true)
            .setNumber(badge)
            .setCategory(if (urgent) Notification.CATEGORY_CALL else Notification.CATEGORY_MESSAGE)
            .setGroup(target.instance)
            .build()
        manager.notify(target.instance, idOf(target), notification)
    }

    /** Nothing is unread any more: the message notifications go, and the badge with them. */
    fun clearMessages() {
        for (shown in manager.activeNotifications) if (shown.id != CONNECTED_ID) manager.cancel(shown.tag, shown.id)
    }

    /** The background service's notification: which services stay connected, and a way to quit. */
    fun connected(services: Int, quit: PendingIntent, open: PendingIntent): Notification =
        Notification.Builder(context, CONNECTION)
            .setSmallIcon(android.R.drawable.stat_notify_sync_noanim)
            .setContentTitle("Multicord is connected")
            .setContentText(if (services == 1) "Keeping 1 service connected" else "Keeping $services services connected")
            .setContentIntent(open)
            .setOngoing(true)
            .setShowWhen(false)
            .addAction(Notification.Action.Builder(null, "Quit", quit).build())
            .build()

    /**
     * The background service's notification while the user is in a call (it then also holds the microphone,
     * and the camera with video): where, since when, and Hang up.
     */
    fun inCall(call: Call, since: Long, hangUp: PendingIntent, open: PendingIntent): Notification =
        Notification.Builder(context, ONGOING)
            .setSmallIcon(android.R.drawable.stat_sys_phone_call)
            .setContentTitle(if (call.video) "In a video call" else "In a call")
            .setContentText(call.channelName)
            .setContentIntent(open)
            .setOngoing(true)
            .setCategory(Notification.CATEGORY_CALL)
            .setWhen(since)
            .setShowWhen(true)
            .setUsesChronometer(true)
            .addAction(Notification.Action.Builder(null, "Hang up", hangUp).build())
            .build()

    fun update(notification: Notification) {
        if (allowed()) manager.notify(CONNECTED_ID, notification)
    }

    private fun idOf(target: NotificationTarget) = (target.target.hashCode() and 0x7fffffff).let { if (it == CONNECTED_ID) it + 1 else it }

    companion object {
        const val CONNECTION = "connection"
        const val MESSAGES = "messages"
        const val CALLS = "calls"
        const val ONGOING = "ongoing-calls"
        const val CONNECTED_ID = 1
    }
}
