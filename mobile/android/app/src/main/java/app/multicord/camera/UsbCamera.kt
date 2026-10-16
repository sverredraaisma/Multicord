// Multicord for Android. Copyright (C) 2026 Multicord contributors. AGPL-3.0-or-later, see LICENSE at the repo root.
package app.multicord.camera

import android.annotation.SuppressLint
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.hardware.usb.UsbConstants
import android.hardware.usb.UsbDevice
import android.hardware.usb.UsbDeviceConnection
import android.hardware.usb.UsbManager
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.util.Log
import java.nio.ByteBuffer
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

/**
 * A UVC camera through Android's USB host API and libuvc (docs/mobile.md, section 4.2, Tier B), for phones whose
 * camera service does not list USB cameras. It offers the first attached video device (class 14) to the pages
 * (Sink) and streams it only while a page has its track open: then it asks Android's own per-device permission
 * if the user has not given it yet (an explicit, immutable PendingIntent), opens the device, hands only its file
 * descriptor to native code (libusb does not scan the bus), negotiates MJPEG (CameraFormats.choose) and passes
 * each complete JPEG to the sinks. A few seconds after the last page lets go it stops and closes the device.
 *
 * Main thread for everything but the work that blocks (one worker thread) and the capture (a thread of its own).
 */
class UsbCamera(context: Context) {
    /** A page's end of the frame channel (CameraPort). */
    interface Sink {
        /** On the main thread: the camera there is (streaming or not), or none; also right after adding. */
        fun onStatus(status: CameraStatus?)

        /** On the capture thread: one complete JPEG, which the sink may keep. */
        fun onFrame(jpeg: ByteArray)

        /** Whether this page has a USB track open now. */
        val wanted: Boolean
    }

    private class Session(val device: UsbDevice, val connection: UsbDeviceConnection, val handle: Long, val format: CameraFormat) {
        @Volatile var capture: Thread? = null
    }

    private val app = context.applicationContext
    private val manager: UsbManager? = app.getSystemService(UsbManager::class.java)
    private val main = Handler(Looper.getMainLooper())
    private val worker = Executors.newSingleThreadScheduledExecutor { r -> Thread(r, "uvc-worker") }
    private val sinks = CopyOnWriteArrayList<Sink>()
    @Volatile private var session: Session? = null
    /** The device offered to the pages, and what they are told about it (main thread). */
    private var device: UsbDevice? = null
    private var status: CameraStatus? = null
    /** A device whose permission was asked for since it was attached: asked once per attach. */
    private var asked: String? = null
    private var starting = false
    private var registered = false
    private val stopLater = Runnable { worker.execute { close("no page uses it") } }

    private val receiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context, intent: Intent) {
            when (intent.action) {
                UsbManager.ACTION_USB_DEVICE_ATTACHED, UsbManager.ACTION_USB_DEVICE_DETACHED -> refresh()
                // The PendingIntent is immutable, so the system adds no extras: look at the device again.
                ACTION_PERMISSION -> {
                    Log.i(TAG, "[camera] USB permission ${if (device?.let { manager?.hasPermission(it) } == true) "granted" else "not granted"}")
                    demand()
                }
            }
        }
    }

    /** A page's channel joins: it hears of the camera there is now, and of every change. */
    fun addSink(sink: Sink) {
        if (!registered) register()
        sinks.add(sink)
        sink.onStatus(status)
    }

    fun removeSink(sink: Sink) {
        sinks.remove(sink)
        demand()
    }

    /** A page opened or closed its USB track: stream while any page wants it. */
    fun demand() {
        val wanted = sinks.any { it.wanted }
        val current = device
        if (!wanted || current == null) {
            if (session != null || starting) {
                main.removeCallbacks(stopLater)
                main.postDelayed(stopLater, STOP_AFTER_MS)
            }
            return
        }
        main.removeCallbacks(stopLater)
        if (session != null || starting) return
        val usb = manager ?: return
        if (!usb.hasPermission(current)) {
            if (asked == current.deviceName) return
            asked = current.deviceName
            // Android's own prompt for this device; explicit (this package only) and immutable.
            val pending = PendingIntent.getBroadcast(app, 0, Intent(ACTION_PERMISSION).setPackage(app.packageName), PendingIntent.FLAG_IMMUTABLE)
            Log.i(TAG, "[camera] asking USB permission for ${describe(current)}")
            usb.requestPermission(current, pending)
            return
        }
        starting = true
        worker.execute { open(current) }
    }

    private fun register() {
        registered = true
        val filter = IntentFilter().apply {
            addAction(UsbManager.ACTION_USB_DEVICE_ATTACHED)
            addAction(UsbManager.ACTION_USB_DEVICE_DETACHED)
            addAction(ACTION_PERMISSION)
        }
        // Not exported: the system's attach and detach broadcasts still arrive; other apps' broadcasts do not.
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) app.registerReceiver(receiver, filter, Context.RECEIVER_NOT_EXPORTED) else registerBefore33(filter)
        refresh()
    }

    /**
     * Before Android 13 a receiver cannot be registered as not exported. Another app could then send the
     * permission action, which only makes this look at the device again; the attach and detach broadcasts are
     * protected, so only the system sends them.
     */
    @SuppressLint("UnspecifiedRegisterReceiverFlag")
    private fun registerBefore33(filter: IntentFilter) {
        app.registerReceiver(receiver, filter)
    }

    /** Which device the pages are offered: the first video device attached; its going ends the stream. */
    private fun refresh() {
        val found = manager?.deviceList?.values.orEmpty().filter(::isUvc).minByOrNull { it.deviceName }
        if (found?.deviceName != device?.deviceName) {
            device = found
            asked = null
            Log.i(TAG, "[camera] ${if (found == null) "no USB camera" else "USB camera ${describe(found)}"}")
            if (session != null) worker.execute { close("camera unplugged or replaced") }
            publish(found?.let { CameraStatus(name(it), CameraFormats.PREFERRED, streaming = false) })
        }
        demand()
    }

    private fun publish(next: CameraStatus?) {
        status = next
        for (sink in sinks) sink.onStatus(next)
    }

    private fun isUvc(d: UsbDevice): Boolean = (0 until d.interfaceCount).any { d.getInterface(it).interfaceClass == UsbConstants.USB_CLASS_VIDEO }

    /** The product's name for the pages; Android shows it only once the device is allowed. */
    private fun name(d: UsbDevice): String {
        val product = try {
            d.productName
        } catch (_: SecurityException) {
            null
        }
        return CameraFormats.name(product, d.vendorId, d.productId)
    }

    private fun describe(d: UsbDevice) = "%04x:%04x".format(d.vendorId, d.productId)

    /** On the worker: opens the device and streams; the pages hear of the format it streams. */
    private fun open(d: UsbDevice) {
        try {
            val error = UvcNative.loadError
            if (error != null) {
                Log.w(TAG, "[camera] native libraries missing: $error")
                return
            }
            val connection = manager?.openDevice(d)
            if (connection == null) {
                Log.w(TAG, "[camera] could not open ${describe(d)}")
                return
            }
            val handle = UvcNative.open(connection.fileDescriptor)
            drainLog()
            if (handle <= 0) {
                Log.w(TAG, "[camera] libuvc could not open ${describe(d)}: ${UvcNative.errorName(handle.toInt())}")
                connection.close()
                return
            }
            val format = CameraFormats.choose(UvcNative.formats(handle))
            val result = if (format == null) -1 else UvcNative.start(handle, format.width, format.height, format.fps)
            drainLog()
            if (format == null || result != 0) {
                Log.w(TAG, "[camera] ${describe(d)}: no MJPEG stream (${if (format == null) "none offered" else UvcNative.errorName(result)})")
                UvcNative.close(handle)
                connection.close()
                return
            }
            val s = Session(d, connection, handle, format)
            s.capture = Thread({ capture(s) }, "uvc-capture").apply { start() }
            session = s
            Log.i(TAG, "[camera] streaming ${describe(d)} at ${format.width}x${format.height} @ ${format.fps}")
            val name = name(d)
            main.post { if (device?.deviceName == d.deviceName) publish(CameraStatus(name, format, streaming = true)) }
        } finally {
            main.post {
                starting = false
                // Whatever changed while it opened (a page let go, the camera went) applies now.
                demand()
            }
        }
    }

    /** The capture thread: native ring to one reused direct buffer, then a copy per frame (a WebMessage keeps its array). */
    private fun capture(s: Session) {
        val buffer = ByteBuffer.allocateDirect(UvcNative.MAX_FRAME_BYTES)
        while (true) {
            val length = UvcNative.nextFrame(s.handle, buffer, 500)
            if (length < 0) break
            if (length == 0 || length > UvcNative.MAX_FRAME_BYTES || sinks.none { it.wanted }) continue
            val jpeg = ByteArray(length)
            buffer.position(0)
            buffer.get(jpeg, 0, length)
            for (sink in sinks) sink.onFrame(jpeg)
        }
    }

    /** On the worker: ends the capture thread, frees native state, then closes the descriptor. */
    private fun close(reason: String) {
        val s = session ?: return
        session = null
        UvcNative.interrupt(s.handle)
        s.capture?.join(3000)
        UvcNative.close(s.handle)
        s.connection.close()
        drainLog()
        Log.i(TAG, "[camera] stream ended ($reason)")
        main.post { if (device?.deviceName == s.device.deviceName) publish(status?.copy(streaming = false)) }
    }

    private fun drainLog() {
        if (UvcNative.loadError == null) UvcNative.drainLog()?.lineSequence()?.filter { it.isNotBlank() }?.forEach { Log.i(TAG, "[camera] $it") }
    }

    /** Stops streaming and listening; the pages hear there is no camera. */
    fun shutdown() {
        main.removeCallbacks(stopLater)
        if (registered) {
            registered = false
            app.unregisterReceiver(receiver)
        }
        publish(null)
        sinks.clear()
        worker.execute { close("shut down") }
        worker.schedule({ worker.shutdown() }, 5, TimeUnit.SECONDS)
    }

    companion object {
        private const val TAG = "Multicord"
        private const val ACTION_PERMISSION = "app.multicord.action.USB_PERMISSION"
        /** How long the stream outlives the last page that used it (a camera switched off and on again in a call). */
        private const val STOP_AFTER_MS = 3000L
    }
}
