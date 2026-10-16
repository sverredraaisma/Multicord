// Multicord for Android. Copyright (C) 2026 Multicord contributors. AGPL-3.0-or-later, see LICENSE at the repo root.
package app.multicord.engine

/**
 * When an engine whose renderer went away starts again: core's restart policy (src/core/engineAdapter.ts,
 * MAX_CRASHES, STABLE_MS, restartDelay, crashesInARow), which the desktop's EngineHub follows too. Crashes
 * in a row back off (2 s, doubling, at most 30 s); past MAX_CRASHES the engine is left stopped until the
 * user restarts it (Settings, Restart), which starts a fresh count. A run of STABLE_MS also does.
 */
class RestartPolicy {
    /** Crashes in a row so far. */
    var crashes = 0
        private set

    /**
     * The engine's renderer went away after it had been running `ranForMs` (null: it never got as far
     * as running). The delay before starting it again, or null when it is to stay stopped.
     */
    fun crashed(ranForMs: Long?): Long? {
        crashes = if (ranForMs != null && ranForMs >= STABLE_MS) 1 else crashes + 1
        return if (crashes > MAX_CRASHES) null else delay(crashes)
    }

    /** The user restarted the engine: it gets its full number of tries again. */
    fun reset() {
        crashes = 0
    }

    companion object {
        const val MAX_CRASHES = 5
        const val STABLE_MS = 60_000L

        /** The wait after the nth crash in a row: 2 s, doubling, at most 30 s. */
        fun delay(crashes: Int): Long = minOf(2000L shl (crashes - 1).coerceIn(0, 5), 30_000L)
    }
}
