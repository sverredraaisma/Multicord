// Multicord for Android. Copyright (C) 2026 Multicord contributors. AGPL-3.0-or-later, see LICENSE at the repo root.
package app.multicord.engine

import android.content.ContentResolver
import android.net.Uri
import android.provider.OpenableColumns
import java.io.FileInputStream
import java.io.InputStream

/**
 * Documents the user picked with the system's picker (ACTION_OPEN_DOCUMENT), read through the
 * ContentResolver with the read grant the picker gave this app. Nothing else is reachable through it: the
 * engine only ever names a handle, and PickedFiles maps handles to the URIs the picker returned.
 */
class ContentDocuments(private val resolver: ContentResolver) : DocumentSource {
    override fun describe(document: String): Triple<String, Long, String?>? {
        val uri = Uri.parse(document)
        if (uri.scheme != ContentResolver.SCHEME_CONTENT) return null
        return try {
            var name: String? = null
            var size: Long? = null
            resolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE), null, null, null)?.use { cursor ->
                if (cursor.moveToFirst()) {
                    val n = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME)
                    val s = cursor.getColumnIndex(OpenableColumns.SIZE)
                    if (n >= 0 && !cursor.isNull(n)) name = cursor.getString(n)
                    if (s >= 0 && !cursor.isNull(s)) size = cursor.getLong(s)
                }
            }
            // A provider that does not say: the descriptor may know.
            val known = size ?: resolver.openAssetFileDescriptor(uri, "r")?.use { it.length }?.takeIf { it >= 0 } ?: return null
            Triple(name ?: "file", known, resolver.getType(uri))
        } catch (_: Exception) {
            null
        }
    }

    override fun read(document: String, start: Long, length: Int): ByteArray {
        val uri = Uri.parse(document)
        val buffer = ByteArray(length)
        var filled = 0
        val pfd = resolver.openFileDescriptor(uri, "r") ?: throw IllegalStateException("The file cannot be read")
        pfd.use {
            FileInputStream(it.fileDescriptor).use { input ->
                val seeked = try {
                    input.channel.position(start)
                    true
                } catch (_: Exception) {
                    false
                }
                if (seeked) {
                    filled = fill(input, buffer)
                } else {
                    // A pipe, not a file: read from the start, as the stream gives it.
                    resolver.openInputStream(uri)?.use { stream ->
                        skipFully(stream, start)
                        filled = fill(stream, buffer)
                    } ?: throw IllegalStateException("The file cannot be read")
                }
            }
        }
        return if (filled == length) buffer else buffer.copyOf(filled)
    }

    private fun fill(input: InputStream, buffer: ByteArray): Int {
        var filled = 0
        while (filled < buffer.size) {
            val n = input.read(buffer, filled, buffer.size - filled)
            if (n < 0) break
            filled += n
        }
        return filled
    }

    private fun skipFully(input: InputStream, count: Long) {
        var left = count
        while (left > 0) {
            val skipped = input.skip(left)
            if (skipped > 0) {
                left -= skipped
            } else if (input.read() < 0) {
                return
            } else {
                left--
            }
        }
    }
}
