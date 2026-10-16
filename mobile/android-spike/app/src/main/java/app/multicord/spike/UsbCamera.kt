// Multicord Android spike (phase 0). Copyright (C) 2026 Multicord contributors.
// AGPL-3.0-or-later, see LICENSE at the repo root.
package app.multicord.spike

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
import java.nio.ByteBuffer
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicLong

/**
 * Spike 0.5 (Tier B, docs/mobile.md section 4.2): a UVC camera through Android's USB host API and libuvc.
 * The user allows each device once (Android's own prompt); the app opens it, hands only its file descriptor
 * to native code, streams MJPEG, and passes each complete JPEG to the sinks (the pages' virtual camera).
 * Everything that blocks runs on one worker thread; frames come in on a capture thread of their own.
 */
object UsbCamera {
    private const val SECTION = "uvc"
    private const val ACTION_PERMISSION = "app.multicord.spike.USB_PERMISSION"

    /** What a streaming camera delivers; pages report these as the track's settings. */
    data class Status(val name: String, val width: Int, val height: Int, val fps: Int)

    /** The sizes offered in the UI. 1280x720 first: the size webcams and Discord agree on. */
    val choices = listOf(Status("", 1280, 720, 30), Status("", 1920, 1080, 30), Status("", 640, 480, 30))

    /** A consumer of the stream: the transport to a page. */
    interface Sink {
        /** On the main thread, when a stream starts (status) or stops (null), and right after adding. */
        fun onStatus(status: Status?)

        /** On the capture thread: one complete JPEG, which the sink may keep. */
        fun onFrame(jpeg: ByteArray)
    }

    /** Live numbers for the main screen, per second. */
    data class Rates(val fps: Double, val sentFps: Double, val dropped: Long, val bytesPerSecond: Long, val pageDrops: Long)

    private class Session(
        val device: UsbDevice,
        val connection: UsbDeviceConnection,
        val handle: Long,
        val status: Status,
    ) {
        @Volatile var capture: Thread? = null
        var closed = false
        val stats = LongArray(UvcNative.STAT_COUNT)
        val previous = LongArray(UvcNative.STAT_COUNT)
        var previousAt = System.nanoTime()
        var sent = 0L
        var previousSent = 0L
        var ticks = 0
        val started = System.nanoTime()
    }

    /** Spike 0.4's bundled JPEGs played as if a camera sent them: checks transport and page without one. */
    private class Replay(val status: Status, val frames: List<ByteArray>) {
        @Volatile var running = true
        var thread: Thread? = null
        @Volatile var sent = 0L
        @Volatile var bytes = 0L
        var previousSent = 0L
        var previousBytes = 0L
        var previousAt = System.nanoTime()
    }

    private val main = Handler(Looper.getMainLooper())
    private val worker = Executors.newSingleThreadScheduledExecutor { r -> Thread(r, "uvc-worker") }
    private val sinks = CopyOnWriteArrayList<Sink>()
    private val listeners = mutableListOf<() -> Unit>()
    private val lock = Any()
    private val pageDrops = AtomicLong()

    @Volatile private var session: Session? = null
    @Volatile private var replay: Replay? = null
    @Volatile var rates: Rates? = null
        private set
    private var app: Context? = null

    private val receiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context, intent: Intent) {
            when (intent.action) {
                UsbManager.ACTION_USB_DEVICE_ATTACHED -> device(intent)?.let { onAttached(it) }
                UsbManager.ACTION_USB_DEVICE_DETACHED -> device(intent)?.let { onDetached(it) }
                // The PendingIntent is immutable, so the system adds no extras: check every device again.
                ACTION_PERMISSION -> {
                    for (d in uvcDevices()) SpikeLog.add(SECTION, "${label(d)}: USB permission ${if (hasPermission(d)) "granted" else "not granted"}")
                    changed()
                }
            }
        }
    }

    /** Registers the attach/detach and permission receivers once, on the application context. */
    fun init(context: Context) {
        if (app != null) return
        val appContext = context.applicationContext
        app = appContext
        val filter = IntentFilter().apply {
            addAction(UsbManager.ACTION_USB_DEVICE_ATTACHED)
            addAction(UsbManager.ACTION_USB_DEVICE_DETACHED)
            addAction(ACTION_PERMISSION)
        }
        // Not exported: the system's attach/detach broadcasts still arrive, other apps' broadcasts do not.
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            appContext.registerReceiver(receiver, filter, Context.RECEIVER_NOT_EXPORTED)
        } else {
            appContext.registerReceiver(receiver, filter)
        }
        worker.scheduleWithFixedDelay({ tick() }, 1, 1, TimeUnit.SECONDS)
    }

    /** Listeners run on the main thread whenever devices, permissions or the stream change. */
    fun listen(listener: () -> Unit) {
        listeners.add(listener)
    }

    fun unlisten(listener: () -> Unit) {
        listeners.remove(listener)
    }

    private fun changed() {
        main.post { listeners.toList().forEach { it() } }
    }

    fun addSink(sink: Sink) {
        sinks.add(sink)
        val current = status
        main.post { sink.onStatus(current) }
    }

    fun removeSink(sink: Sink) {
        sinks.remove(sink)
    }

    /** A sink dropped a frame because its page was still busy with the previous ones. */
    fun countPageDrop() {
        pageDrops.incrementAndGet()
    }

    val status: Status? get() = session?.status ?: replay?.status

    private fun manager(): UsbManager? = app?.getSystemService(UsbManager::class.java)

    @Suppress("DEPRECATION")
    private fun device(intent: Intent): UsbDevice? =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            intent.getParcelableExtra(UsbManager.EXTRA_DEVICE, UsbDevice::class.java)
        } else {
            intent.getParcelableExtra(UsbManager.EXTRA_DEVICE)
        }

    /** Devices with a video interface (class 14): UVC cameras, whatever their device class says. */
    fun uvcDevices(): List<UsbDevice> =
        manager()?.deviceList?.values.orEmpty().filter { isUvc(it) }.sortedBy { it.deviceName }

    private fun isUvc(d: UsbDevice): Boolean =
        (0 until d.interfaceCount).any { d.getInterface(it).interfaceClass == UsbConstants.USB_CLASS_VIDEO }

    fun hasPermission(d: UsbDevice): Boolean = manager()?.hasPermission(d) == true

    /** "Logitech StreamCam (046d:0893)"; names need the permission on Android 10+. */
    fun label(d: UsbDevice): String {
        val name = try {
            listOfNotNull(d.manufacturerName, d.productName).joinToString(" ")
        } catch (_: SecurityException) {
            ""
        }
        return "${name.ifEmpty { "USB camera" }} (%04x:%04x)".format(d.vendorId, d.productId)
    }

    private fun productName(d: UsbDevice): String =
        try {
            d.productName?.takeIf { it.isNotBlank() }
        } catch (_: SecurityException) {
            null
        } ?: "%04x:%04x".format(d.vendorId, d.productId)

    /** One line per UVC device for the main screen. */
    fun summary(d: UsbDevice): String {
        val video = (0 until d.interfaceCount).count { d.getInterface(it).interfaceClass == UsbConstants.USB_CLASS_VIDEO }
        val power = (0 until d.configurationCount).joinToString { "${d.getConfiguration(it).maxPower} mA" }
        return "${label(d)}: class ${d.deviceClass}, ${d.interfaceCount} interfaces ($video video), " +
            "power $power, permission ${if (hasPermission(d)) "yes" else "no"}"
    }

    /**
     * The [usb] dump: every attached device with its configurations (power), interfaces and endpoints.
     * Shows whether the phone sees the camera at all, and how it powers it.
     */
    fun dump() {
        val devices = manager()?.deviceList?.values.orEmpty().sortedBy { it.deviceName }
        SpikeLog.add("usb", "${devices.size} USB device(s) attached; native code: ${UvcNative.loadError ?: "loaded"}")
        for (d in devices) {
            SpikeLog.add("usb", "${d.deviceName}: ${label(d)}, class %d/%d/%d, USB version %s, %d configuration(s), %d interface(s)%s, permission %s".format(
                d.deviceClass, d.deviceSubclass, d.deviceProtocol, d.version, d.configurationCount, d.interfaceCount,
                if (isUvc(d)) " = UVC" else "", if (hasPermission(d)) "yes" else "no",
            ))
            for (c in 0 until d.configurationCount) {
                val config = d.getConfiguration(c)
                SpikeLog.add("usb", "  configuration ${config.id}: max power ${config.maxPower} mA, " +
                    "self-powered ${config.isSelfPowered}, remote wakeup ${config.isRemoteWakeup}, ${config.interfaceCount} interface(s)")
            }
            for (i in 0 until d.interfaceCount) {
                val intf = d.getInterface(i)
                val endpoints = (0 until intf.endpointCount).joinToString { e ->
                    val ep = intf.getEndpoint(e)
                    val type = when (ep.type) {
                        UsbConstants.USB_ENDPOINT_XFER_ISOC -> "iso"
                        UsbConstants.USB_ENDPOINT_XFER_BULK -> "bulk"
                        UsbConstants.USB_ENDPOINT_XFER_INT -> "int"
                        else -> "control"
                    }
                    "%02x %s %s %d B".format(ep.address, if (ep.direction == UsbConstants.USB_DIR_IN) "in" else "out", type, ep.maxPacketSize)
                }
                SpikeLog.add("usb", "  interface ${intf.id} alt ${intf.alternateSetting}: class ${intf.interfaceClass}/" +
                    "${intf.interfaceSubclass}/${intf.interfaceProtocol}${if (endpoints.isEmpty()) "" else ", endpoints $endpoints"}")
            }
        }
    }

    /** Android's own prompt; the answer arrives as ACTION_PERMISSION. */
    fun requestPermission(d: UsbDevice) {
        val context = app ?: return
        val manager = manager() ?: return
        if (manager.hasPermission(d)) {
            SpikeLog.add(SECTION, "${label(d)}: permission already granted")
            return
        }
        // Explicit (this package only) and immutable: nothing outside the app can redirect or alter it.
        val intent = Intent(ACTION_PERMISSION).setPackage(context.packageName)
        val pending = PendingIntent.getBroadcast(context, 0, intent, PendingIntent.FLAG_IMMUTABLE)
        SpikeLog.add(SECTION, "asking USB permission for ${label(d)}")
        manager.requestPermission(d, pending)
    }

    private fun onAttached(d: UsbDevice) {
        SpikeLog.add(SECTION, "attached ${d.deviceName}: ${if (isUvc(d)) summary(d) else "not a video device"}")
        changed()
    }

    private fun onDetached(d: UsbDevice) {
        SpikeLog.add(SECTION, "detached ${d.deviceName} (%04x:%04x)".format(d.vendorId, d.productId))
        if (session?.device?.deviceName == d.deviceName) stop("camera unplugged")
        changed()
    }

    /** Opens the device and streams MJPEG at the chosen size; stops any stream first. */
    fun start(d: UsbDevice, choice: Status) {
        worker.execute {
            closeSession("restarting")
            closeReplay()
            UvcNative.loadError?.let {
                SpikeLog.add(SECTION, "native libraries missing: $it")
                return@execute
            }
            val manager = manager() ?: return@execute
            if (!manager.hasPermission(d)) {
                SpikeLog.add(SECTION, "${label(d)}: no USB permission yet; press Allow first")
                return@execute
            }
            val connection = manager.openDevice(d)
            if (connection == null) {
                SpikeLog.add(SECTION, "${label(d)}: openDevice failed")
                return@execute
            }
            val handle = UvcNative.open(connection.fileDescriptor)
            drainNativeLog()
            if (handle <= 0) {
                SpikeLog.add(SECTION, "${label(d)}: libuvc could not open it: ${UvcNative.errorName(handle.toInt())}")
                connection.close()
                return@execute
            }
            SpikeLog.add(SECTION, "${label(d)} formats:")
            UvcNative.formats(handle).lineSequence().filter { it.isNotBlank() }.forEach { SpikeLog.add(SECTION, "  $it") }
            val result = UvcNative.start(handle, choice.width, choice.height, choice.fps)
            drainNativeLog()
            if (result != 0) {
                SpikeLog.add(SECTION, "MJPEG ${choice.width}x${choice.height} @ ${choice.fps} failed: ${UvcNative.errorName(result)}")
                UvcNative.close(handle)
                connection.close()
                drainNativeLog()
                return@execute
            }
            val status = Status(productName(d), choice.width, choice.height, choice.fps)
            val s = Session(d, connection, handle, status)
            pageDrops.set(0)
            s.capture = Thread({ capture(s) }, "uvc-capture").apply { start() }
            session = s
            SpikeLog.add(SECTION, "streaming ${label(d)} at ${choice.width}x${choice.height} @ ${choice.fps}")
            main.post { sinks.forEach { it.onStatus(status) } }
            changed()
        }
    }

    fun stop(reason: String = "stopped") {
        worker.execute {
            closeSession(reason)
            closeReplay()
        }
    }

    /** Plays the 30 bundled 720p test JPEGs at 30 fps through the same sinks, as "test frames (replay)". */
    fun startReplay() {
        worker.execute {
            closeSession("replay instead")
            closeReplay()
            val context = app ?: return@execute
            val frames = (0 until 30).map { i -> context.assets.open("web/frames/frame%02d.jpg".format(i)).use { it.readBytes() } }
            val r = Replay(Status("test frames (replay)", 1280, 720, 30), frames)
            r.thread = Thread({
                var i = 0
                var next = System.nanoTime()
                while (r.running) {
                    val jpeg = r.frames[i++ % r.frames.size]
                    if (sinks.isNotEmpty()) {
                        for (sink in sinks) sink.onFrame(jpeg)
                        r.sent++
                        r.bytes += jpeg.size
                    }
                    next += 1_000_000_000L / 30
                    val wait = (next - System.nanoTime()) / 1_000_000
                    if (wait > 0) Thread.sleep(wait) else next = System.nanoTime()
                }
            }, "uvc-replay").apply { start() }
            replay = r
            pageDrops.set(0)
            SpikeLog.add(SECTION, "replaying ${frames.size} test frames at 1280x720 @ 30 as a USB camera")
            main.post { sinks.forEach { it.onStatus(r.status) } }
            changed()
        }
    }

    /** On the worker. */
    private fun closeReplay() {
        val r = replay ?: return
        replay = null
        r.running = false
        r.thread?.join(1000)
        rates = null
        SpikeLog.add(SECTION, "replay ended after ${r.sent} frames to pages, ${pageDrops.get()} page drops")
        main.post { sinks.forEach { it.onStatus(null) } }
        changed()
    }

    /** The capture thread: native ring to one reused direct buffer, then a copy per frame for the pages. */
    private fun capture(s: Session) {
        val buffer = ByteBuffer.allocateDirect(UvcNative.MAX_FRAME_BYTES)
        while (true) {
            val length = UvcNative.nextFrame(s.handle, buffer, 500)
            if (length < 0) break
            if (length == 0 || sinks.isEmpty()) continue
            if (length > UvcNative.MAX_FRAME_BYTES) continue
            // A WebMessage keeps the array it is given, so each frame needs its own.
            val jpeg = ByteArray(length)
            buffer.position(0)
            buffer.get(jpeg, 0, length)
            synchronized(lock) { s.sent++ }
            for (sink in sinks) sink.onFrame(jpeg)
        }
    }

    /** On the worker. Ends the capture thread first, then frees native state, then closes the descriptor. */
    private fun closeSession(reason: String) {
        val s = session ?: return
        session = null
        UvcNative.interrupt(s.handle)
        s.capture?.join(3000)
        synchronized(lock) {
            s.closed = true
            UvcNative.close(s.handle)
        }
        s.connection.close()
        rates = null
        val seconds = (System.nanoTime() - s.started) / 1e9
        SpikeLog.add(SECTION, "stream ended ($reason) after %.1f s, %d frames to pages, %d page drops".format(seconds, s.sent, pageDrops.get()))
        drainNativeLog()
        main.post { sinks.forEach { it.onStatus(null) } }
        changed()
    }

    private fun drainNativeLog() {
        if (UvcNative.loadError != null) return
        UvcNative.drainLog()?.lineSequence()?.forEach { SpikeLog.add(SECTION, it) }
    }

    /** Every second on the worker: rates for the screen, native log lines, and a log line every 10 s. */
    private fun tick() {
        val s = session
        if (s == null) {
            replay?.let { r ->
                val now = System.nanoTime()
                val seconds = (now - r.previousAt) / 1e9
                val sent = r.sent
                val bytes = r.bytes
                rates = Rates((sent - r.previousSent) / seconds, (sent - r.previousSent) / seconds, 0, ((bytes - r.previousBytes) / seconds).toLong(), pageDrops.get())
                r.previousSent = sent
                r.previousBytes = bytes
                r.previousAt = now
                changed()
            }
            if (app != null && UvcNative.loadError == null) drainNativeLog()
            return
        }
        val now = System.nanoTime()
        val r = synchronized(lock) {
            if (s.closed) return
            UvcNative.stats(s.handle, s.stats)
            val seconds = (now - s.previousAt) / 1e9
            val received = s.stats[UvcNative.STAT_RECEIVED] - s.previous[UvcNative.STAT_RECEIVED]
            val bytes = s.stats[UvcNative.STAT_BYTES] - s.previous[UvcNative.STAT_BYTES]
            val sent = s.sent - s.previousSent
            s.stats.copyInto(s.previous)
            s.previousSent = s.sent
            s.previousAt = now
            Rates(received / seconds, sent / seconds, s.stats[UvcNative.STAT_DROPPED], (bytes / seconds).toLong(), pageDrops.get())
        }
        rates = r
        drainNativeLog()
        if (++s.ticks % 10 == 0) {
            val st = s.stats
            SpikeLog.add(SECTION, "%.1f fps from the camera, %.1f to pages, %.0f KB/s, last frame %d B; total %d frames, %d dropped (ring), %d invalid, %d oversize, %d without EOI, %d page drops".format(
                r.fps, r.sentFps, r.bytesPerSecond / 1024.0, st[UvcNative.STAT_LAST_BYTES], st[UvcNative.STAT_RECEIVED],
                st[UvcNative.STAT_DROPPED], st[UvcNative.STAT_INVALID], st[UvcNative.STAT_OVERSIZE], st[UvcNative.STAT_NO_EOI], r.pageDrops,
            ))
        }
        changed()
    }
}
