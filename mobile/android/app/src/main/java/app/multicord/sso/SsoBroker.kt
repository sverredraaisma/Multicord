// Multicord for Android. Copyright (C) 2026 Multicord contributors. AGPL-3.0-or-later, see LICENSE at the repo root.
package app.multicord.sso

import app.multicord.net.WebUrl
import java.net.URLDecoder
import java.net.URLEncoder
import java.security.SecureRandom

/**
 * Single sign-on for engines (Matrix's m.login.sso), as src/main/ssoLoopback.ts does it on the desktop, with
 * an app-private redirect in place of the loopback server: the homeserver's sign-in page runs in the
 * browser, which comes back to `<scheme>:/<random path>?loginToken=…`; SsoRedirectActivity hands that
 * address here. One request at a time, for SSO_TIMEOUT_MS; a random 48-hex path per request; the first
 * address with that path ends it, with the token (checked with LOGIN_TOKEN) or as a failure. Anything else
 * changes nothing. The token goes only to the caller that began the request (the engine that asked).
 *
 * Any app may register the same scheme, so an address can reach the wrong app; that is why the path is
 * random and single-use, only one request waits at a time, and the token's form is checked. Matrix login
 * tokens are short-lived and single-use themselves. Runs on one thread (the main thread).
 */
class SsoBroker(
    /** The redirect scheme: "<applicationId>.sso". */
    private val scheme: String,
    /** Runs `action` after `delayMs`, for the timeout. */
    private val schedule: (delayMs: Long, action: () -> Unit) -> Unit,
    private val randomPath: () -> String = ::randomHex,
) {
    private class Pending(val path: String, val owner: Any, val done: (Result<String>) -> Unit)

    private var pending: Pending? = null

    /** Whether a request is waiting for the browser. */
    val waiting: Boolean get() = pending != null

    /**
     * Starts a request for `owner` and returns the address to open in the browser: `ssoUrl` (checked with
     * isSsoUrl; null when it is not one) with this request's redirect address. A request still waiting is
     * cancelled first. `done` is called once: with the login token, or with the failure.
     */
    fun begin(ssoUrl: String, owner: Any, done: (Result<String>) -> Unit): String? {
        val url = ssoAddress(ssoUrl) ?: return null
        pending?.let { finish(it, Result.failure(IllegalStateException("Single sign-on was cancelled"))) }
        val request = Pending("/" + randomPath(), owner, done)
        pending = request
        schedule(SSO_TIMEOUT_MS) { if (pending === request) finish(request, Result.failure(IllegalStateException("Single sign-on timed out"))) }
        return url + "?redirectUrl=" + URLEncoder.encode("$scheme:${request.path}", "UTF-8")
    }

    /**
     * An address the browser came back with. True when it ended the waiting request (with a token or as a
     * failure); false when it is not this request's address, which changes nothing.
     */
    fun receive(address: String): Boolean {
        val request = pending ?: return false
        // <scheme>:<path>[?<query>][#<fragment>], read as it comes (a malformed escape elsewhere still ends the request).
        val colon = address.indexOf(':')
        if (colon < 0 || !scheme.equals(address.substring(0, colon), ignoreCase = true)) return false
        val rest = address.substring(colon + 1).substringBefore('#')
        val path = rest.substringBefore('?')
        if (path != request.path) return false
        val token = queryParameter(if (rest.length > path.length) rest.substring(path.length + 1) else null, "loginToken")
        val result = if (token != null && LOGIN_TOKEN.matches(token)) Result.success(token) else Result.failure(IllegalStateException("The sign-in page sent back no usable login token"))
        finish(request, result)
        return true
    }

    /** Cancels `owner`'s waiting request, if it has one (its engine stopped). */
    fun cancel(owner: Any, reason: String = "Single sign-on was cancelled") {
        val request = pending ?: return
        if (request.owner === owner) finish(request, Result.failure(IllegalStateException(reason)))
    }

    private fun finish(request: Pending, result: Result<String>) {
        if (pending !== request) return
        pending = null
        request.done(result)
    }

    companion object {
        /** How long the browser has to come back with a token (ssoLoopback.ts). */
        const val SSO_TIMEOUT_MS = 5 * 60_000L
        /** Login tokens are opaque; these are the characters homeservers use (ssoLoopback.ts). */
        val LOGIN_TOKEN = Regex("^[A-Za-z0-9._~+/=-]{1,1024}$")
        /** A homeserver's SSO redirect, generic or for one identity provider (ssoLoopback.ts). */
        private val SSO_PATH = Regex("^/_matrix/client/(?:v3|r0)/login/sso/redirect(?:/[A-Za-z0-9._~-]{1,255})?$")
        private val random = SecureRandom()

        /** Whether an engine may start single sign-on at this address: https, no credentials, query or fragment, an SSO path. */
        fun isSsoUrl(value: String): Boolean = ssoAddress(value) != null

        /** The SSO address, normalised as the URL parser reads it, without the empty query or fragment; null when it is none. */
        private fun ssoAddress(value: String): String? {
            val url = WebUrl.parse(value) ?: return null
            if (url.protocol != "https:" || url.username.isNotEmpty() || url.password.isNotEmpty()) return null
            // As URL.search and URL.hash read them: a lone "?" or "#" is empty.
            if (url.query.length > 1 || url.fragment.length > 1 || !SSO_PATH.matches(url.path)) return null
            return "https://" + url.hostname + (if (url.port.isEmpty()) "" else ":${url.port}") + url.path
        }

        /** The first value of `name` in a query, decoded as URLSearchParams decodes it; null when absent or malformed. */
        fun queryParameter(rawQuery: String?, name: String): String? {
            if (rawQuery == null) return null
            for (pair in rawQuery.split('&')) {
                val eq = pair.indexOf('=')
                val key = if (eq >= 0) pair.substring(0, eq) else pair
                val value = if (eq >= 0) pair.substring(eq + 1) else ""
                try {
                    if (URLDecoder.decode(key, "UTF-8") == name) return URLDecoder.decode(value, "UTF-8")
                } catch (_: IllegalArgumentException) {
                    return null
                }
            }
            return null
        }

        /** 24 random bytes as 48 hex digits. */
        fun randomHex(): String {
            val bytes = ByteArray(24)
            random.nextBytes(bytes)
            return bytes.joinToString("") { "%02x".format(it) }
        }
    }
}
