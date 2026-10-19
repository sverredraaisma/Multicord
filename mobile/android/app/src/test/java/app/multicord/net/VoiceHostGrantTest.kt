// Multicord for Android. Copyright (C) 2026 Multicord contributors. AGPL-3.0-or-later, see LICENSE at the repo root.
package app.multicord.net

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/** The voice-host grant, as tests/main/engineHost.test.ts checks EngineHub.addVoiceHost. */
class VoiceHostGrantTest {
    private val list = PublicSuffixList("io\ngithub.io\ncom\n")
    private val suffixes = { list }
    private val locked = listOf("api.rory.server.demo.com", "gateway.rory.server.demo.com")

    private fun message(result: Result<String>): String? = result.exceptionOrNull()?.message

    @Test
    fun grantsOneHostOnTheLockedDomainOnceSignedIn() {
        val grant = VoiceHostGrant(declared = true)
        assertEquals("A voice host is added only while signed in", message(grant.add(locked, false, "voice.rory.server.demo.com", suffixes)))
        assertEquals("voice.other.com is not on the domain of this service's hosts", message(grant.add(locked, true, "voice.other.com", suffixes)))
        assertEquals(locked, grant.socketHosts(locked))
        assertEquals("voice.rory.server.demo.com", grant.add(locked, true, "voice.rory.server.demo.com", suffixes).getOrNull())
        assertEquals("voice.rory.server.demo.com", grant.add(locked, true, "voice.rory.server.demo.com", suffixes).getOrNull())
        assertEquals("This service has added its voice host already", message(grant.add(locked, true, "voice2.rory.server.demo.com", suffixes)))
        assertEquals(locked + "voice.rory.server.demo.com", grant.socketHosts(locked))
        // A narrower lock on the same domain keeps it; one off it drops it.
        grant.narrowed(listOf("api.rory.server.demo.com"), suffixes)
        assertEquals("voice.rory.server.demo.com", grant.host)
        grant.narrowed(listOf("other.com"), suffixes)
        assertNull(grant.host)
    }

    @Test
    fun refusesUndeclaredPrivateAndPublicSuffixSiblings() {
        assertEquals("This module adds no voice host", message(VoiceHostGrant(declared = false).add(locked, true, "voice.rory.server.demo.com", suffixes)))
        assertEquals("voice.demo.internal is not on the domain of this service's hosts", message(VoiceHostGrant(true).add(listOf("api.demo.internal"), true, "voice.demo.internal", suffixes)))
        assertEquals("bar.github.io is not on the domain of this service's hosts", message(VoiceHostGrant(true).add(listOf("foo.github.io"), true, "bar.github.io", suffixes)))
    }

    @Test
    fun needsNoGrantWhereTheEngineIsNotLocked() {
        val grant = VoiceHostGrant(declared = true)
        assertEquals("voice.anywhere.com", grant.add(null, true, "voice.anywhere.com", suffixes).getOrNull())
        assertNull(grant.host)
        assertNull(grant.socketHosts(null))
    }
}
