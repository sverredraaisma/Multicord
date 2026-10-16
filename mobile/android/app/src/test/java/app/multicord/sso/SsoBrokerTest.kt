// Multicord for Android. Copyright (C) 2026 Multicord contributors. AGPL-3.0-or-later, see LICENSE at the repo root.
package app.multicord.sso

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class SsoBrokerTest {
    private val sso = "https://hs.x.org/_matrix/client/v3/login/sso/redirect"
    private val path = "0123456789abcdef0123456789abcdef0123456789abcdef"
    private val timers = ArrayList<Pair<Long, () -> Unit>>()
    private val broker = SsoBroker("app.multicord.sso", { delay, action -> timers += delay to action }, { path })
    private val results = ArrayList<Result<String>>()
    private val owner = Any()

    private fun begin(url: String = sso, who: Any = owner) = broker.begin(url, who) { results += it }

    @Test
    fun ssoAddresses() {
        assertTrue(SsoBroker.isSsoUrl(sso))
        assertTrue(SsoBroker.isSsoUrl("https://hs.x.org/_matrix/client/r0/login/sso/redirect/oidc-github"))
        assertTrue(SsoBroker.isSsoUrl("$sso?"))
        for (bad in listOf(
            "http://hs.x.org/_matrix/client/v3/login/sso/redirect", "$sso?redirectUrl=https://evil.example", "$sso#x",
            "https://user:pw@hs.x.org/_matrix/client/v3/login/sso/redirect", "https://hs.x.org/_matrix/client/v3/login",
            "https://hs.x.org/_matrix/client/v3/login/sso/redirect/a/b", "not a url",
        )) {
            assertFalse(bad, SsoBroker.isSsoUrl(bad))
        }
        assertTrue(SsoBroker.LOGIN_TOKEN.matches("syl_abc123_DEF+/="))
        assertFalse(SsoBroker.LOGIN_TOKEN.matches("a b"))
        assertEquals(48, SsoBroker.randomHex().length)
        assertTrue(SsoBroker.randomHex().all { it in "0123456789abcdef" })
    }

    @Test
    fun theBrowserComesBackWithAToken() {
        assertEquals("$sso?redirectUrl=app.multicord.sso%3A%2F$path", begin())
        assertEquals(SsoBroker.SSO_TIMEOUT_MS, timers.single().first)
        assertTrue(broker.waiting)
        // Not this request's address: nothing changes.
        for (other in listOf("app.multicord.sso:/other?loginToken=t", "evil.sso:/$path?loginToken=t", "app.multicord.sso://$path?loginToken=t",
            "app.multicord.sso://host/$path?loginToken=t", "app.multicord.sso:/$path/x?loginToken=t", "%%")) {
            assertFalse(other, broker.receive(other))
        }
        assertTrue(results.isEmpty())
        assertTrue(broker.receive("APP.multicord.sso:/$path?x=1&loginToken=syl_ab%2Bc%3D&loginToken=second"))
        assertEquals("syl_ab+c=", results.single().getOrThrow())
        assertFalse(broker.waiting)
        // Once only, and the timer no longer matters.
        assertFalse(broker.receive("app.multicord.sso:/$path?loginToken=again"))
        timers.single().second()
        assertEquals(1, results.size)
    }

    @Test
    fun unusableTokensEndTheRequest() {
        for (query in listOf("", "?loginToken=", "?loginToken=a+b", "?loginToken=%zz", "?other=1", "?loginToken=" + "a".repeat(1025))) {
            results.clear()
            begin()
            assertTrue(query, broker.receive("app.multicord.sso:/$path$query"))
            assertTrue(query, results.single().isFailure)
        }
    }

    @Test
    fun timeoutsCancelsAndRefusals() {
        assertNull(begin("https://hs.x.org/_matrix/client/v3/login"))
        assertTrue(timers.isEmpty())
        begin()
        timers.last().second()
        assertEquals("Single sign-on timed out", results.single().exceptionOrNull()!!.message)
        // A new request cancels the one waiting.
        results.clear()
        begin()
        begin()
        assertEquals("Single sign-on was cancelled", results.single().exceptionOrNull()!!.message)
        // Another owner cannot cancel it; its own can.
        broker.cancel(Any())
        assertTrue(broker.waiting)
        broker.cancel(owner, "gone")
        assertEquals("gone", results.last().exceptionOrNull()!!.message)
        assertFalse(broker.waiting)
    }
}
