// Multicord for Android. Copyright (C) 2026 Multicord contributors. AGPL-3.0-or-later, see LICENSE at the repo root.
package app.multicord.camera

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class CameraFormatsTest {
    private val streamCam = """
        MJPEG 1920x1080 fps=60,30,24 max=4147200
        MJPEG 1280x720 fps=60,30,24 max=1843200
        MJPEG 640x480 fps=30 max=614400
        YUY2 640x480 fps=30,15 max=614400
    """.trimIndent()

    @Test
    fun choosesSevenTwentyAtThirtyWhenOffered() {
        assertEquals(CameraFormat(1280, 720, 30), CameraFormats.choose(streamCam))
    }

    @Test
    fun otherwiseTheLargestUpToTenEighty() {
        assertEquals(CameraFormat(1920, 1080, 30), CameraFormats.choose("MJPEG 1920x1080 fps=30 max=1\nMJPEG 640x480 fps=30 max=1"))
        assertEquals(CameraFormat(800, 600, 24), CameraFormats.choose("MJPEG 3840x2160 fps=30\nMJPEG 800x600 fps=24,15"))
        // Only bigger sizes: the smallest of them, rather than nothing.
        assertEquals(CameraFormat(2560, 1440, 30), CameraFormats.choose("MJPEG 3840x2160 fps=30\nMJPEG 2560x1440 fps=30"))
        // Only faster rates: the slowest, capped at 30.
        assertEquals(CameraFormat(640, 480, 30), CameraFormats.choose("MJPEG 640x480 fps=60,120"))
        // A range of rates.
        assertEquals(CameraFormat(1280, 720, 30), CameraFormats.choose("MJPEG 1280x720 fps=5-60 max=1"))
        assertEquals(CameraFormat(1280, 720, 15), CameraFormats.choose("MJPEG 1280x720 fps=7.5,15 max=1"))
    }

    @Test
    fun nothingWithoutMjpeg() {
        assertNull(CameraFormats.choose("YUY2 640x480 fps=30 max=1"))
        assertNull(CameraFormats.choose(""))
        assertNull(CameraFormats.choose("MJPEG 0x480 fps=30\nMJPEG 640x480 fps=\nMJPEG axb fps=30"))
    }

    @Test
    fun namesDevicesPrintably() {
        assertEquals("Logitech StreamCam", CameraFormats.name(" Logitech StreamCam ", 0x046d, 0x0893))
        assertEquals("046d:0893", CameraFormats.name(null, 0x046d, 0x0893))
        assertEquals("046d:0893", CameraFormats.name("  ", 0x046d, 0x0893))
        assertEquals("Cam", CameraFormats.name("C" + Char(7) + "am" + Char(0x202e), 1, 2))
        assertEquals(100, CameraFormats.name("x".repeat(300), 1, 2).length)
    }

    @Test
    fun tellsPagesWhatThereIs() {
        val none = Json.parseToJsonElement(CameraFormats.statusMessage(null)).jsonObject
        assertEquals("""{"type":"status","available":false}""", none.toString())
        val cam = CameraFormats.statusMessage(CameraStatus("StreamCam", CameraFormat(1280, 720, 30), streaming = true))
        assertEquals("""{"type":"status","available":true,"streaming":true,"name":"StreamCam","width":1280,"height":720,"fps":30}""", cam)
    }

    private fun jpeg(size: Int) = ByteArray(size).also {
        it[0] = 0xff.toByte()
        it[1] = 0xd8.toByte()
    }

    @Test
    fun gatesFramesToWhatThePageWantsAndCanTake() {
        val gate = FrameGate()
        assertFalse(gate.admit(jpeg(100)))
        assertTrue(gate.onPageMessage("want"))
        assertFalse(gate.onPageMessage("want"))
        assertFalse(gate.onPageMessage("something else"))
        assertFalse(gate.onPageMessage(null))
        assertTrue(gate.wanted)
        assertTrue(gate.admit(jpeg(100)))
        assertTrue(gate.admit(jpeg(100)))
        // Two wait already: the page is behind.
        assertFalse(gate.admit(jpeg(100)))
        gate.posted()
        assertTrue(gate.admit(jpeg(100)))
        gate.posted()
        gate.posted()
        gate.posted()
        // Not a JPEG, or too large.
        assertFalse(gate.admit(ByteArray(100)))
        assertFalse(gate.admit(jpeg(UvcNative.MAX_FRAME_BYTES + 1)))
        assertFalse(gate.admit(ByteArray(1)))
        assertTrue(gate.onPageMessage("idle"))
        assertFalse(gate.admit(jpeg(100)))
    }
}
