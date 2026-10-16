// Multicord Android spike (phase 0). Copyright (C) 2026 Multicord contributors.
// AGPL-3.0-or-later, see LICENSE at the repo root.
package app.multicord.spike

import java.nio.ByteBuffer

/**
 * Spike 0.5: the JNI layer over libuvc and libusb (app/src/main/cpp/uvc_jni.c). It only ever gets the file
 * descriptor of a device the user allowed through UsbManager; libusb does not scan the bus.
 */
object UvcNative {
    /** The largest JPEG passed on (native and page enforce it too). */
    const val MAX_FRAME_BYTES = 4 * 1024 * 1024

    // Indexes into the array stats() fills.
    const val STAT_RECEIVED = 0
    const val STAT_TAKEN = 1
    const val STAT_DROPPED = 2
    const val STAT_INVALID = 3
    const val STAT_OVERSIZE = 4
    const val STAT_BYTES = 5
    const val STAT_NO_EOI = 6
    const val STAT_LAST_BYTES = 7
    const val STAT_COUNT = 8

    /** Null when the native libraries loaded, else why not. */
    val loadError: String? by lazy {
        try {
            System.loadLibrary("multicord_uvc")
            null
        } catch (e: UnsatisfiedLinkError) {
            e.message ?: "UnsatisfiedLinkError"
        }
    }

    /** A handle (> 0), or a negative libuvc error code. */
    @JvmStatic external fun open(fd: Int): Long

    /** One line per format and size: "MJPEG 1280x720 fps=30,24 max=1843200". */
    @JvmStatic external fun formats(handle: Long): String

    /** 0, or a negative libuvc error code. */
    @JvmStatic external fun start(handle: Long, width: Int, height: Int, fps: Int): Int

    /** Copies the next frame into [dst] (direct): its length, 0 on timeout, -1 once stopped. */
    @JvmStatic external fun nextFrame(handle: Long, dst: ByteBuffer, timeoutMs: Int): Int

    @JvmStatic external fun stats(handle: Long, out: LongArray)

    /** Makes a waiting nextFrame return -1; safe from any thread. */
    @JvmStatic external fun interrupt(handle: Long)

    /** Stops streaming; call after the nextFrame thread has finished. */
    @JvmStatic external fun stop(handle: Long)

    /** Stops, releases the interfaces and frees the handle. The caller closes the descriptor afterwards. */
    @JvmStatic external fun close(handle: Long)

    @JvmStatic external fun errorName(code: Int): String

    /** Native log lines since the last call, or null. */
    @JvmStatic external fun drainLog(): String?
}
