// Multicord for Android. Copyright (C) 2026 Multicord contributors. AGPL-3.0-or-later, see LICENSE at the repo root.
package app.multicord.engine

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

class PickedFilesTest {
    /** Documents in memory: name -> bytes; "unknown-size" has no size, "gone" cannot be read. */
    private class Memory(val docs: Map<String, ByteArray>) : DocumentSource {
        val reads = ArrayList<Triple<String, Long, Int>>()

        override fun describe(document: String) = when (document) {
            "gone" -> null
            "unknown-size" -> Triple("x", -1L, null)
            else -> docs[document]?.let { Triple(document, it.size.toLong(), "image/heic") }
        }

        override fun read(document: String, start: Long, length: Int): ByteArray {
            reads += Triple(document, start, length)
            val bytes = docs.getValue(document)
            return bytes.copyOfRange(start.toInt(), minOf(bytes.size, start.toInt() + length))
        }
    }

    private val bytes = ByteArray(100) { it.toByte() }

    @Test
    fun picksAndReadsRangesClippedToTheSize() {
        val files = PickedFiles(Memory(mapOf("photo.JPG" to bytes, "notes" to ByteArray(0))))
        val picked = files.add(listOf("photo.JPG", "gone", "unknown-size", "notes"))
        assertEquals(listOf("photo.JPG", "notes"), picked.map { it.name })
        assertEquals(100L, picked[0].size)
        assertEquals("image/jpeg", picked[0].type)
        // No extension: the provider's type.
        assertEquals("image/heic", picked[1].type)
        assertNotEquals(picked[0].handle, picked[1].handle)
        val handle = picked[0].handle
        assertArrayEquals(bytes.copyOfRange(10, 20), files.read(handle, 10, 20))
        assertArrayEquals(bytes.copyOfRange(90, 100), files.read(handle, 90, 1000))
        assertEquals(0, files.read(handle, 100, 200).size)
        assertEquals(0, files.read(handle, 5, 5).size)
        assertEquals(0, files.read(picked[1].handle, 0, 10).size)
    }

    @Test
    fun unknownHandlesAndForgottenOnes() {
        var n = 0
        val files = PickedFiles(Memory(mapOf("a.png" to bytes)), newHandle = { "h${n++}" })
        assertThrows(IllegalArgumentException::class.java) { files.read("nope", 0, 1) }
        repeat(PickedFiles.MAX_FILE_HANDLES + 1) { files.add(listOf("a.png")) }
        // The oldest is forgotten first.
        assertThrows(IllegalArgumentException::class.java) { files.read("h0", 0, 1) }
        assertEquals(1, files.read("h1", 0, 1).size)
        files.clear()
        assertThrows(IllegalArgumentException::class.java) { files.read("h1", 0, 1) }
    }

    @Test
    fun typesAndNames() {
        assertEquals("application/pdf", PickedFiles.contentTypeFor("a.PDF"))
        assertEquals("application/octet-stream", PickedFiles.contentTypeFor("a.exe"))
        assertEquals("application/octet-stream", PickedFiles.contentTypeFor(".png"))
        assertEquals("video/3gpp", PickedFiles.contentTypeFor("clip.3gp", "video/3gpp"))
        assertEquals("application/octet-stream", PickedFiles.contentTypeFor("x", "text/html; charset=utf-8"))
        assertEquals("b.txt", PickedFiles.displayName("a/b.txt"))
        assertEquals("ab.txt", PickedFiles.displayName("a" + String(Character.toChars(7)) + "b.txt"))
        assertEquals("file", PickedFiles.displayName(".."))
        assertEquals("file", PickedFiles.displayName("  "))
        assertEquals(255, PickedFiles.displayName("x".repeat(300)).length)
        val emoji = String(Character.toChars(0x1f600))
        val cut = PickedFiles.displayName("x".repeat(254) + emoji + "y")
        assertEquals(254, cut.length)
        assertTrue(cut.none { it.isSurrogate() })
    }
}
