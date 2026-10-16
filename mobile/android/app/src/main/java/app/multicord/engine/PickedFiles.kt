// Multicord for Android. Copyright (C) 2026 Multicord contributors. AGPL-3.0-or-later, see LICENSE at the repo root.
package app.multicord.engine

import java.util.UUID
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

/** A file the user picked for an engine, as src/shared/engine.ts's PickedFile: read through its handle. */
data class PickedFile(val handle: String, val name: String, val size: Long, val type: String) {
    fun toJson() = JsonObject(mapOf("handle" to JsonPrimitive(handle), "name" to JsonPrimitive(name), "size" to JsonPrimitive(size), "type" to JsonPrimitive(type)))
}

/** Where picked documents are read from (the ContentResolver on a phone); documents are named by their URI. */
interface DocumentSource {
    /** The document's display name, size in bytes and media type (null when unknown); null when it cannot be read or its size is unknown. */
    fun describe(document: String): Triple<String, Long, String?>?

    /** Up to `length` bytes from `start`; fewer at the end of the document. */
    fun read(document: String, start: Long, length: Int): ByteArray
}

/**
 * The files the user picked for one engine, by handle, as src/main/engineHost.ts keeps them: a random handle
 * per file, the oldest forgotten past MAX_FILE_HANDLES, reads clipped to the file's size. Handles are this
 * engine's alone; another engine's handle is just unknown here. Safe to use from several threads.
 */
class PickedFiles(private val source: DocumentSource, private val newHandle: () -> String = { UUID.randomUUID().toString() }) {
    private class Entry(val document: String, val size: Long)

    private val files = LinkedHashMap<String, Entry>()

    /** Describes and adds the picked documents; one that cannot be read, or whose size is unknown, is left out. */
    fun add(documents: List<String>): List<PickedFile> = documents.mapNotNull { document ->
        val (rawName, size, providerType) = source.describe(document) ?: return@mapNotNull null
        if (size < 0) return@mapNotNull null
        val name = displayName(rawName)
        val handle = newHandle()
        synchronized(files) {
            files[handle] = Entry(document, size)
            while (files.size > MAX_FILE_HANDLES) files.remove(files.keys.first())
        }
        PickedFile(handle, name, size, contentTypeFor(name, providerType))
    }

    /** Bytes [start, end) of a picked file, clipped to its size; the range is checked by isEngineRequest (at most MAX_READ). */
    fun read(handle: String, start: Long, end: Long): ByteArray {
        val entry = synchronized(files) { files[handle] } ?: throw IllegalArgumentException("Unknown file")
        val stop = minOf(end, entry.size)
        if (start >= stop) return ByteArray(0)
        return source.read(entry.document, start, (stop - start).toInt())
    }

    fun clear() = synchronized(files) { files.clear() }

    companion object {
        /** Picked-file handles kept per engine; the oldest are forgotten first (engineHost.ts). */
        const val MAX_FILE_HANDLES = 200
        private const val MAX_NAME = 255

        /** src/main/files.ts's types by extension. */
        private val CONTENT_TYPES = mapOf(
            ".png" to "image/png", ".jpg" to "image/jpeg", ".jpeg" to "image/jpeg", ".gif" to "image/gif", ".webp" to "image/webp",
            ".avif" to "image/avif", ".svg" to "image/svg+xml", ".mp4" to "video/mp4", ".webm" to "video/webm", ".mov" to "video/quicktime",
            ".mp3" to "audio/mpeg", ".ogg" to "audio/ogg", ".wav" to "audio/wav", ".txt" to "text/plain", ".md" to "text/markdown",
            ".json" to "application/json", ".pdf" to "application/pdf", ".zip" to "application/zip",
        )
        private val MEDIA_TYPE = Regex("^[a-z]+/[a-z0-9.+-]{1,100}$")

        /** A best guess from the extension as the desktop makes it, else the provider's type when it is a plain one. */
        fun contentTypeFor(name: String, providerType: String? = null): String {
            val dot = name.lastIndexOf('.')
            val ext = if (dot > 0) name.substring(dot).lowercase() else ""
            return CONTENT_TYPES[ext] ?: providerType?.takeIf(MEDIA_TYPE::matches) ?: "application/octet-stream"
        }

        /** The provider's display name as a plain file name: no path, no control characters, not too long. */
        fun displayName(raw: String): String {
            val base = raw.substringAfterLast('/').filterNot { it.isISOControl() }.trim()
            val name = if (base.isEmpty() || base == "." || base == "..") "file" else base
            if (name.length <= MAX_NAME) return name
            // Never half a surrogate pair.
            return name.take(if (name[MAX_NAME - 1].isHighSurrogate()) MAX_NAME - 1 else MAX_NAME)
        }
    }
}
