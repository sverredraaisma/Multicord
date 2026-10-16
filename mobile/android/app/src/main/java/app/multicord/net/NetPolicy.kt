// Multicord for Android. Copyright (C) 2026 Multicord contributors. AGPL-3.0-or-later, see LICENSE at the repo root.
package app.multicord.net

import java.net.Inet4Address
import java.net.Inet6Address
import java.net.InetAddress

/** What an engine may contact: these schemes ("https:", "wss:") and, when set, only these hosts. */
data class UrlPolicy(val schemes: List<String>, val hosts: List<String>? = null)

/** Why a URL was refused: `kind` is one of invalid, scheme, credentials, private, host (as in the shared fixture). */
data class Refusal(val kind: String, val message: String)

/**
 * The network policy for module engines, ported from src/main/netPolicy.ts and tested against the same
 * cases (tests/fixtures/netpolicy-cases.json). On Android the native side is the policy point: engines have
 * no network of their own (their page's CSP is connect-src 'none'), and every request and socket they ask
 * for is checked here, per redirect, and by what the name resolves to when the connection is made.
 */
object NetPolicy {
    private val PRIVATE_SUFFIXES = listOf(".localhost", ".local", ".internal", ".lan", ".home.arpa", ".onion")
    private val OCTET = Regex("^[0-9]{1,3}$")

    /** Redirect statuses that are followed, and how many hops at most. */
    private val REDIRECTS = setOf(301, 302, 303, 307, 308)
    const val MAX_REDIRECTS = 5

    private fun ipv4(host: String): IntArray? {
        val parts = host.split(".")
        if (parts.size != 4 || !parts.all { OCTET.matches(it) }) return null
        val octets = parts.map { it.toInt() }
        return if (octets.all { it <= 255 }) octets.toIntArray() else null
    }

    /** Loopback, private, link-local, carrier-grade NAT, benchmarking, multicast and reserved IPv4 ranges. */
    private fun isPrivateIpv4(a: Int, b: Int): Boolean =
        a == 0 || a == 10 || a == 127 ||
            (a == 100 && b in 64..127) ||
            (a == 169 && b == 254) ||
            (a == 172 && b in 16..31) ||
            (a == 192 && b == 168) ||
            (a == 198 && (b == 18 || b == 19)) ||
            a >= 224

    /** Only global unicast IPv6 (2000::/3) is public. */
    private fun isPublicIpv6FirstPiece(first: Int): Boolean = first in 0x2000..0x3fff

    /**
     * Whether a host (a URL's hostname: name, dotted IPv4, or bracketed IPv6) is on this device or a private
     * network. Names that resolve to private addresses are caught when they resolve (see [PublicDns]).
     */
    fun isPrivateHost(hostname: String): Boolean {
        val host = hostname.lowercase().removeSuffix(".")
        if (host == "localhost" || PRIVATE_SUFFIXES.any { host.endsWith(it) }) return true
        if (host.startsWith("[")) {
            // As parseInt(…, 16) reads it: the leading hex digits of the first piece; none at all is 0.
            val piece = host.substring(1).substringBefore(':')
            val digits = piece.takeWhile { Character.digit(it, 16) >= 0 && it.code < 0x80 }
            if (piece.isEmpty()) return !isPublicIpv6FirstPiece(0)
            if (digits.isEmpty() || digits.length > 8) return true
            return !isPublicIpv6FirstPiece(digits.toLong(16).coerceAtMost(Int.MAX_VALUE.toLong()).toInt())
        }
        val octets = ipv4(host) ?: return false
        return isPrivateIpv4(octets[0], octets[1])
    }

    /** "example.com" matches only itself; "*.example.com" matches it and its subdomains. */
    fun hostMatches(host: String, pattern: String): Boolean {
        val h = host.lowercase()
        val p = pattern.lowercase()
        if (!p.startsWith("*.")) return h == p
        val base = p.substring(2)
        return h == base || h.endsWith(".$base")
    }

    /** Whether every host `pattern` covers is also covered by `allowed`. */
    fun patternWithin(pattern: String, allowed: String): Boolean {
        if (!pattern.startsWith("*.")) return hostMatches(pattern, allowed)
        return allowed.startsWith("*.") && hostMatches(pattern.substring(2), allowed)
    }

    /**
     * The hosts an engine may reach after it asks to lock itself to `requested`: the request when it stays
     * within what is allowed now, else null. Locks only narrow.
     */
    fun narrowHosts(current: List<String>?, requested: List<String>): List<String>? {
        val hosts = requested.map { it.lowercase() }
        if (hosts.any { isPrivateHost(it.removePrefix("*.")) }) return null
        if (current != null && !hosts.all { h -> current.any { c -> patternWithin(h, c) } }) return null
        return hosts
    }

    /** Why an engine may not contact `url`, or null when it may. */
    fun checkUrl(url: String, policy: UrlPolicy): Refusal? {
        val parsed = WebUrl.parse(url) ?: return Refusal("invalid", "not a valid URL")
        return check(parsed, policy)
    }

    /** As [checkUrl], for a URL already parsed. */
    fun check(parsed: WebUrl, policy: UrlPolicy): Refusal? {
        if (parsed.protocol !in policy.schemes) return Refusal("scheme", "${parsed.protocol} is not allowed")
        if (parsed.username.isNotEmpty() || parsed.password.isNotEmpty()) return Refusal("credentials", "credentials in URLs are not allowed")
        if (isPrivateHost(parsed.hostname)) return Refusal("private", "${parsed.hostname} is a local or private address")
        val hosts = policy.hosts
        if (hosts != null && hosts.none { hostMatches(parsed.hostname, it) }) return Refusal("host", "${parsed.hostname} is not one of this module's hosts")
        return null
    }

    /** Whether every address a name resolved to (as text: "93.184.216.34", "2606:2800::1") is public. */
    fun addressesArePublic(addresses: List<String>): Boolean =
        addresses.none { isPrivateHost(if (':' in it) "[$it]" else it) }

    /** Whether one resolved address is public; the native resolver's answers are judged this way. */
    fun isPublicAddress(address: InetAddress): Boolean {
        val bytes = address.address
        return when (address) {
            is Inet4Address -> !isPrivateIpv4(bytes[0].toInt() and 0xff, bytes[1].toInt() and 0xff)
            is Inet6Address -> isPublicIpv6FirstPiece(((bytes[0].toInt() and 0xff) shl 8) or (bytes[1].toInt() and 0xff))
            else -> false
        }
    }

    /** Headers the bridge never forwards: the network stack sets them, or they would let a module pose as someone else. */
    private val FORBIDDEN_REQUEST_HEADERS = setOf(
        "cookie", "cookie2", "host", "connection", "content-length", "transfer-encoding", "keep-alive", "upgrade",
        "te", "trailer", "expect", "via", "proxy-authorization", "proxy-connection",
    )

    /** The request headers an engine's HTTP request goes out with. */
    fun forwardedHeaders(headers: Map<String, String>): Map<String, String> =
        headers.filterKeys { name ->
            val lower = name.lowercase()
            lower !in FORBIDDEN_REQUEST_HEADERS && !lower.startsWith("sec-") && !lower.startsWith("proxy-")
        }

    fun isRedirect(status: Int): Boolean = status in REDIRECTS

    /** The method after a redirect with this status, and whether the body goes along. */
    fun afterRedirect(status: Int, method: String): Pair<String, Boolean> =
        if (status == 303 || ((status == 301 || status == 302) && method == "POST")) "GET" to false else method to true
}
