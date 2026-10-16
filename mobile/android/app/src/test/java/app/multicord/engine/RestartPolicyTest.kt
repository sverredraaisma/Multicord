// Multicord for Android. Copyright (C) 2026 Multicord contributors. AGPL-3.0-or-later, see LICENSE at the repo root.
package app.multicord.engine

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/** The same numbers as tests/core/engineAdapter.test.ts: core's restart policy. */
class RestartPolicyTest {
    @Test
    fun backsOffLikeCore() {
        assertEquals(listOf(2000L, 4000L, 8000L, 16000L, 30000L, 30000L), (1..6).map(RestartPolicy::delay))
        assertEquals(30_000L, RestartPolicy.delay(40))
    }

    @Test
    fun leavesAnEngineStoppedAfterFiveCrashesInARow() {
        val policy = RestartPolicy()
        assertEquals(listOf(2000L, 4000L, 8000L, 16000L, 30000L), (1..5).map { policy.crashed(1_000) })
        assertNull(policy.crashed(1_000))
        assertNull(policy.crashed(null))
        assertEquals(7, policy.crashes)
    }

    @Test
    fun countsAfreshAfterAStableRun() {
        val policy = RestartPolicy()
        repeat(4) { policy.crashed(null) }
        assertEquals(2000L, policy.crashed(RestartPolicy.STABLE_MS))
        assertEquals(1, policy.crashes)
        assertEquals(4000L, policy.crashed(RestartPolicy.STABLE_MS - 1))
    }

    @Test
    fun theUsersRestartGivesEveryTryBack() {
        val policy = RestartPolicy()
        repeat(6) { policy.crashed(null) }
        policy.reset()
        assertEquals(0, policy.crashes)
        assertEquals(2000L, policy.crashed(null))
    }
}
