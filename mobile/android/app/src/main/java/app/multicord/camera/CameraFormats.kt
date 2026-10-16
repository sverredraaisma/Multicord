// Multicord for Android. Copyright (C) 2026 Multicord contributors. AGPL-3.0-or-later, see LICENSE at the repo root.
package app.multicord.camera

import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

/** What a USB camera streams, as the pages report it in a track's settings. */
data class CameraFormat(val width: Int, val height: Int, val fps: Int)

/** A camera as the pages see it: its name, and the format it streams (or will, once a page opens it). */
data class CameraStatus(val name: String, val format: CameraFormat, val streaming: Boolean)

/** The pure parts of the USB camera: which format to ask for, and what goes to a page. */
object CameraFormats {
    /** What calls want: 720p at 30 fps, the size webcams and Discord agree on (docs/mobile.md, spike 0.3). */
    val PREFERRED = CameraFormat(1280, 720, 30)
    /** The largest picture asked for: MJPEG at 1080p is up to a few hundred KB a frame. */
    private const val MAX_PIXELS = 1920 * 1080
    private const val MAX_FPS = 30
    private const val MAX_NAME = 100
    private const val NAME_MARKS = " -_.,:;()&+/'#"
    private val MJPEG = Regex("^MJPEG ([0-9]{1,5})x([0-9]{1,5}) fps=([0-9.,-]+)")

    /**
     * The MJPEG format to ask the camera for, from its own list (UvcNative.formats, one line per size:
     * "MJPEG 1280x720 fps=30,24 max=1843200"): 1280x720 when offered, else the largest size up to 1080p
     * (then the smallest above, rather than nothing); 30 fps or the highest rate below it. Null without MJPEG.
     */
    fun choose(formats: String): CameraFormat? {
        val offered = formats.lineSequence().mapNotNull { line ->
            val m = MJPEG.find(line.trim()) ?: return@mapNotNull null
            val text = m.groupValues[3]
            val rates = text.split(',', '-').mapNotNull { it.toDoubleOrNull() }.filter { it >= 1 }
            if (rates.isEmpty()) return@mapNotNull null
            // A continuous range ("5-60") offers every rate in it; a list, only those listed.
            val fps = if ('-' in text) rates.max().coerceAtMost(MAX_FPS.toDouble()) else rates.filter { it <= MAX_FPS + 0.5 }.maxOrNull() ?: rates.min()
            CameraFormat(m.groupValues[1].toInt(), m.groupValues[2].toInt(), Math.round(fps).toInt().coerceIn(1, MAX_FPS))
        }.filter { it.width > 0 && it.height > 0 }.toList()
        if (offered.isEmpty()) return null
        offered.firstOrNull { it.width == PREFERRED.width && it.height == PREFERRED.height }?.let { return it }
        val small = offered.filter { it.width * it.height <= MAX_PIXELS }
        return small.maxByOrNull { it.width * it.height } ?: offered.minBy { it.width * it.height }
    }

    /** A device's name for the pages: printable, short, never empty. */
    fun name(product: String?, vendorId: Int, productId: Int): String {
        // Letters, digits and a few marks only: no control, line-breaking or bidirectional characters.
        val clean = product?.filter { it.isLetterOrDigit() || it in NAME_MARKS }?.trim()?.take(MAX_NAME)
        return if (clean.isNullOrEmpty()) "%04x:%04x".format(vendorId, productId) else clean
    }

    /** The status message a page's port gets (src/mobile/usbCamera.ts, parseStatus): a camera, or none. */
    fun statusMessage(status: CameraStatus?): String {
        if (status == null) return JsonObject(mapOf("type" to JsonPrimitive("status"), "available" to JsonPrimitive(false))).toString()
        return JsonObject(mapOf(
            "type" to JsonPrimitive("status"),
            "available" to JsonPrimitive(true),
            "streaming" to JsonPrimitive(status.streaming),
            "name" to JsonPrimitive(status.name.take(MAX_NAME)),
            "width" to JsonPrimitive(status.format.width),
            "height" to JsonPrimitive(status.format.height),
            "fps" to JsonPrimitive(status.format.fps),
        )).toString()
    }
}

/**
 * The frame channel's caps for one page: frames go only while the page has a USB track open ("want"), each at
 * most [UvcNative.MAX_FRAME_BYTES] and starting as a JPEG does, and never more than [MAX_QUEUED] wait to be
 * posted; a page that falls behind loses frames, not memory. Thread-safe: frames come from the capture thread.
 */
class FrameGate {
    @Volatile var wanted = false
        private set
    private var queued = 0
    private val lock = Any()

    /** What the page said on its port: only "want" and "idle" mean anything. Returns whether it changed. */
    fun onPageMessage(text: String?): Boolean {
        val next = when (text) {
            "want" -> true
            "idle" -> false
            else -> return false
        }
        val changed = next != wanted
        wanted = next
        return changed
    }

    /** Whether to queue this frame for the page; [posted] must follow each true. */
    fun admit(jpeg: ByteArray): Boolean {
        if (!wanted || jpeg.size < 2 || jpeg.size > UvcNative.MAX_FRAME_BYTES) return false
        if (jpeg[0] != 0xff.toByte() || jpeg[1] != 0xd8.toByte()) return false
        synchronized(lock) {
            if (queued >= MAX_QUEUED) return false
            queued++
            return true
        }
    }

    /** One admitted frame left the queue (posted, or dropped because the port closed). */
    fun posted() {
        synchronized(lock) { if (queued > 0) queued-- }
    }

    companion object {
        const val MAX_QUEUED = 2
    }
}
