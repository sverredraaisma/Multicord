// Multicord for Android. Copyright (C) 2026 Multicord contributors. AGPL-3.0-or-later, see LICENSE at the repo root.
package app.multicord.call

import android.content.Context
import android.media.AudioAttributes
import android.media.AudioDeviceCallback
import android.media.AudioDeviceInfo
import android.media.AudioFocusRequest
import android.media.AudioManager
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.PowerManager
import android.util.Log

/**
 * A call's sound on the phone, while one is in progress: audio focus and the communication mode (so the
 * call is a call to the system: echo cancellation, the voice-call volume), where it plays (earpiece,
 * loudspeaker, a wired or Bluetooth headset, through the communication device API from Android 12 and the
 * speakerphone and Bluetooth SCO switches before), following headsets as they come and go, and the screen
 * going dark at the ear (the proximity sensor) while a voice call plays through the earpiece.
 * Main thread only. [onRoutes] hears the route in use and those available whenever either changes.
 */
class CallAudio(context: Context, private val onRoutes: (current: AudioRoute, available: Set<AudioRoute>) -> Unit) {
    private val audio = context.getSystemService(AudioManager::class.java)
    private val power = context.getSystemService(PowerManager::class.java)
    private val main = Handler(Looper.getMainLooper())
    private var call: Call? = null
    private var chosen: AudioRoute? = null
    private var current: AudioRoute? = null
    private var focus: AudioFocusRequest? = null
    private var proximity: PowerManager.WakeLock? = null

    private val devices = object : AudioDeviceCallback() {
        override fun onAudioDevicesAdded(added: Array<out AudioDeviceInfo>) = route()

        override fun onAudioDevicesRemoved(removed: Array<out AudioDeviceInfo>) = route()
    }

    /** The call in progress now (null: none); a call that starts takes the audio, one that ends gives it back. */
    fun update(next: Call?) {
        val was = call
        call = next
        when {
            was == null && next != null -> start()
            was != null && next == null -> stop()
            next != null -> route()
        }
    }

    /** The user's choice of route, from the call's view; only a route available now is taken. */
    fun choose(route: AudioRoute) {
        if (call == null || route !in available()) return
        chosen = route
        route()
    }

    private fun start() {
        val request = AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN_TRANSIENT)
            .setAudioAttributes(AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_VOICE_COMMUNICATION).setContentType(AudioAttributes.CONTENT_TYPE_SPEECH).build())
            .build()
        focus = request
        audio.requestAudioFocus(request)
        audio.mode = AudioManager.MODE_IN_COMMUNICATION
        audio.registerAudioDeviceCallback(devices, main)
        chosen = null
        route()
    }

    private fun stop() {
        audio.unregisterAudioDeviceCallback(devices)
        if (Build.VERSION.SDK_INT >= 31) {
            audio.clearCommunicationDevice()
        } else {
            @Suppress("DEPRECATION")
            run {
                if (audio.isBluetoothScoOn) audio.stopBluetoothSco()
                audio.isBluetoothScoOn = false
                audio.isSpeakerphoneOn = false
            }
        }
        audio.mode = AudioManager.MODE_NORMAL
        focus?.let(audio::abandonAudioFocusRequest)
        focus = null
        chosen = null
        current = null
        proximity(false)
    }

    /** Applies the route the call should use now and tells the view. */
    private fun route() {
        val call = call ?: return
        val available = available()
        val route = AudioRoute.pick(available, chosen, call.video) ?: return
        if (route != current) {
            apply(route)
            current = route
            Log.i(TAG, "[call ${call.instance}] audio through the ${route.wire}")
        }
        proximity(route == AudioRoute.EARPIECE && !call.video)
        onRoutes(route, available)
    }

    private fun available(): Set<AudioRoute> =
        if (Build.VERSION.SDK_INT >= 31) audio.availableCommunicationDevices.mapNotNull { routeOf(it.type) }.toSet()
        else audio.getDevices(AudioManager.GET_DEVICES_OUTPUTS).mapNotNull { routeOf(it.type) }.toSet()

    private fun apply(route: AudioRoute) {
        if (Build.VERSION.SDK_INT >= 31) {
            val device = audio.availableCommunicationDevices.firstOrNull { routeOf(it.type) == route } ?: return
            if (!audio.setCommunicationDevice(device)) Log.w(TAG, "The ${route.wire} could not take the call's audio")
            return
        }
        @Suppress("DEPRECATION")
        run {
            if (route == AudioRoute.BLUETOOTH) {
                audio.isSpeakerphoneOn = false
                audio.startBluetoothSco()
                audio.isBluetoothScoOn = true
            } else {
                if (audio.isBluetoothScoOn) audio.stopBluetoothSco()
                audio.isBluetoothScoOn = false
                audio.isSpeakerphoneOn = route == AudioRoute.SPEAKER
            }
        }
    }

    /** The screen goes dark while the phone is at the ear, and on again when it is taken away. */
    private fun proximity(on: Boolean) {
        if (on) {
            if (proximity == null && power.isWakeLockLevelSupported(PowerManager.PROXIMITY_SCREEN_OFF_WAKE_LOCK)) {
                proximity = power.newWakeLock(PowerManager.PROXIMITY_SCREEN_OFF_WAKE_LOCK, "multicord:call").apply {
                    setReferenceCounted(false)
                    acquire(MAX_CALL_MS)
                }
            }
        } else {
            proximity?.let { if (it.isHeld) it.release(PowerManager.RELEASE_FLAG_WAIT_FOR_NO_PROXIMITY) }
            proximity = null
        }
    }

    companion object {
        private const val TAG = "Multicord"
        /** A safety limit on the proximity lock; a call this long gets it again when the route next changes. */
        private const val MAX_CALL_MS = 4 * 60 * 60 * 1000L

        /** The route an audio device stands for, or null for one a call does not play through. */
        fun routeOf(type: Int): AudioRoute? = when (type) {
            AudioDeviceInfo.TYPE_BUILTIN_EARPIECE -> AudioRoute.EARPIECE
            AudioDeviceInfo.TYPE_BUILTIN_SPEAKER -> AudioRoute.SPEAKER
            AudioDeviceInfo.TYPE_WIRED_HEADSET, AudioDeviceInfo.TYPE_WIRED_HEADPHONES, AudioDeviceInfo.TYPE_USB_HEADSET -> AudioRoute.WIRED
            AudioDeviceInfo.TYPE_BLUETOOTH_SCO, AudioDeviceInfo.TYPE_BLE_HEADSET -> AudioRoute.BLUETOOTH
            else -> null
        }
    }
}
