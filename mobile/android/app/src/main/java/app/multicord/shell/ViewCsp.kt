// Multicord for Android. Copyright (C) 2026 Multicord contributors. AGPL-3.0-or-later, see LICENSE at the repo root.
package app.multicord.shell

/**
 * The chat view's Content-Security-Policy header, added to native.html's own policy (both apply). Our own
 * scripts only, with WebAssembly (RNNoise's noise suppression) but no eval; workers from the view's own
 * origin only (LiveKit's end-to-end encryption worker for Matrix calls, served as livekit-e2ee-worker.js, and
 * RNNoise's audio worklet); pictures and media over https or inline. Network connections go only where the
 * view's engine may reach, as on the desktop (engineHost.ts, the view's request filter): a call's voice
 * server over https (LiveKit asks it over HTTP when a connection fails, and whether the network is back
 * before it reconnects). These fetches also pass ChatView's shouldInterceptRequest, which refuses private
 * addresses. No WebSockets at all: a WebView shows them to no request hook, so the view's calls get theirs
 * from native code (ViewSockets), checked as an engine's are, with the engine's hosts as they are when each
 * opens. A call's media is WebRTC (UDP through ICE, or TURN), which neither CSP nor this covers.
 */
object ViewCsp {
    /** A host pattern as NetPolicy has them: a name, or "*." and a name. Anything else is left out. */
    private val HOST = Regex("^(\\*\\.)?[a-z0-9]([a-z0-9-]*[a-z0-9])?(\\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$")

    /** The policy for a view whose engine may reach `hosts` (null: any public host). */
    fun of(hosts: List<String>?): String {
        val network = if (hosts == null) {
            listOf("https:")
        } else {
            hosts.map { it.lowercase() }.filter { it.length <= 253 && HOST.matches(it) }.flatMap { host ->
                // NetPolicy's "*.example.com" covers example.com itself; CSP's does not.
                val names = if (host.startsWith("*.")) listOf(host.removePrefix("*."), host) else listOf(host)
                names.map { "https://$it" }
            }.distinct()
        }
        return listOf(
            "default-src 'self'",
            "script-src 'self' 'wasm-unsafe-eval'",
            "style-src 'self'",
            "img-src 'self' https: data: blob:",
            "media-src 'self' https: data: blob: mediastream:",
            (listOf("connect-src 'self' data: blob:") + network).joinToString(" "),
            "worker-src 'self'",
            "object-src 'none'",
            "frame-src 'none'",
            "base-uri 'none'",
            "form-action 'none'",
            "frame-ancestors 'none'",
        ).joinToString("; ")
    }
}
