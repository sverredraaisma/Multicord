// Multicord for Android. Copyright (C) 2026 Multicord contributors. AGPL-3.0-or-later, see LICENSE at the repo root.
package app.multicord.shell

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class ViewCspTest {
    private fun directive(csp: String, name: String) = csp.split("; ").first { it.startsWith("$name ") }

    @Test
    fun ownScriptsWithWebAssemblyAndWorkersFromTheViewsOriginForEncryptedCalls() {
        val csp = ViewCsp.of(null)
        // RNNoise's WebAssembly; never eval.
        assertEquals("script-src 'self' 'wasm-unsafe-eval'", directive(csp, "script-src"))
        // LiveKit's end-to-end encryption worker (livekit-e2ee-worker.js) and RNNoise's worklet: the view's own files only.
        assertEquals("worker-src 'self'", directive(csp, "worker-src"))
        assertFalse(csp.contains("unsafe-inline"))
        assertFalse(csp.contains("'unsafe-eval'"))
        assertTrue(csp.contains("frame-ancestors 'none'"))
        assertTrue(directive(csp, "media-src").contains("mediastream:"))
    }

    @Test
    fun aCallsServerOverHttpsOnlyWhereTheEngineMayReachAndNoWebSockets() {
        assertEquals("connect-src 'self' data: blob: https:", directive(ViewCsp.of(null), "connect-src"))
        assertEquals(
            "connect-src 'self' data: blob: https://web.fluxer.app https://fluxer.media https://*.fluxer.media",
            directive(ViewCsp.of(listOf("web.fluxer.app", "*.fluxer.media")), "connect-src"),
        )
        assertEquals("connect-src 'self' data: blob:", directive(ViewCsp.of(emptyList()), "connect-src"))
    }

    @Test
    fun leavesOutAnythingThatIsNoHostPattern() {
        val csp = ViewCsp.of(listOf("ok.example", "a.com; script-src *", "https://x.example", "*", "*.*.example", "bad host", "x.example:443", "-x.example", "OK2.Example"))
        assertEquals("connect-src 'self' data: blob: https://ok.example https://ok2.example", directive(csp, "connect-src"))
        assertFalse(csp.contains("wss:") || csp.contains("ws:"))
        assertEquals(1, csp.split("script-src").size - 1)
    }
}
