// Multicord Android spike (phase 0). Copyright (C) 2026 Multicord contributors.
// AGPL-3.0-or-later, see LICENSE at the repo root.
package app.multicord.spike

import android.os.Handler
import android.os.Looper
import android.util.Log

/**
 * The results the user copies and sends back: one in-memory log for the whole process, mirrored to logcat
 * under the tag "MulticordSpike". Lines from web pages are untrusted text; they are cut to a fixed length.
 */
object SpikeLog {
    private const val TAG = "MulticordSpike"
    private const val MAX_LINE = 2000
    private const val MAX_LINES = 2000

    private val lines = ArrayDeque<String>()
    private val listeners = mutableListOf<() -> Unit>()
    private val main = Handler(Looper.getMainLooper())

    fun add(section: String, message: String) {
        val text = message.take(MAX_LINE).replace('\r', ' ')
        val line = "[$section] $text"
        Log.i(TAG, line)
        synchronized(lines) {
            lines.addLast(line)
            while (lines.size > MAX_LINES) lines.removeFirst()
        }
        main.post { listeners.toList().forEach { it() } }
    }

    fun text(): String = synchronized(lines) { lines.joinToString("\n") }

    fun tail(count: Int): String = synchronized(lines) { lines.takeLast(count).joinToString("\n") }

    fun clear() {
        synchronized(lines) { lines.clear() }
        main.post { listeners.toList().forEach { it() } }
    }

    /** Listeners run on the main thread; remove them in onDestroy. */
    fun listen(listener: () -> Unit) {
        listeners.add(listener)
    }

    fun unlisten(listener: () -> Unit) {
        listeners.remove(listener)
    }
}
