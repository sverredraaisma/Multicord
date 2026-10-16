// Multicord for Android. Copyright (C) 2026 Multicord contributors. AGPL-3.0-or-later, see LICENSE at the repo root.
package app.multicord.net

import java.math.BigInteger
import java.net.IDN

/**
 * A URL as the WHATWG URL standard parses it, which is what `new URL()` does in the desktop app's network
 * policy (src/main/netPolicy.ts). Only the parts that decide where a request goes are parsed to the letter:
 * the scheme, the credentials, and the host, with every numeric IPv4 form ("2130706433", "0x7f.1", "127.1")
 * turned into its dotted address and IPv6 addresses normalised. The rest (path, query) is carried along.
 *
 * The policy checks a URL in this form, and the request goes out to [href], so the host the policy judged
 * is the host the network stack connects to.
 */
class WebUrl private constructor(
    /** The scheme with its colon, lowercase: "https:". */
    val protocol: String,
    val username: String,
    val password: String,
    /** Lowercase name, dotted IPv4 address or bracketed IPv6 address; "" for non-special schemes. */
    val hostname: String,
    /** "" for the scheme's default port. */
    val port: String,
    val path: String,
    /** "" or "?…". */
    val query: String,
    /** "" or "#…". */
    val fragment: String,
    private val special: Boolean,
) {
    val href: String
        get() {
            if (!special) return protocol + path
            val credentials = if (username.isEmpty() && password.isEmpty()) "" else username + (if (password.isEmpty()) "" else ":$password") + "@"
            return protocol + "//" + credentials + hostname + (if (port.isEmpty()) "" else ":$port") + path + query + fragment
        }

    override fun toString(): String = href

    companion object {
        private val DEFAULT_PORTS = mapOf("http:" to "80", "https:" to "443", "ws:" to "80", "wss:" to "443", "ftp:" to "21", "file:" to "")
        private val SCHEME = Regex("^[A-Za-z][A-Za-z0-9+.-]*:")

        /** Parses `input`, relative to `base` when it has no scheme of its own; null when `new URL()` would throw. */
        fun parse(input: String, base: WebUrl? = null): WebUrl? {
            val text = clean(input)
            val scheme = SCHEME.find(text)
            if (scheme != null) {
                val protocol = scheme.value.lowercase()
                val rest = text.substring(scheme.value.length)
                if (protocol !in DEFAULT_PORTS) return WebUrl(protocol, "", "", "", "", rest, "", "", false)
                // "https:x" against an https base is relative, as in browsers.
                if (base != null && base.special && base.protocol == protocol && !startsWithSlash(rest)) return relative(rest, base)
                return absolute(protocol, rest)
            }
            if (base == null || !base.special) return null
            return relative(text, base)
        }

        /** Leading and trailing C0 controls and spaces go, and tabs and newlines anywhere. */
        private fun clean(input: String): String =
            input.trim { it <= ' ' }.filter { it != '\t' && it != '\n' && it != '\r' }

        private fun startsWithSlash(s: String): Boolean = s.startsWith("/") || s.startsWith("\\")

        private fun absolute(protocol: String, rest: String): WebUrl? {
            // Special URLs ignore any number of slashes (either kind) before the authority.
            var i = 0
            while (i < rest.length && (rest[i] == '/' || rest[i] == '\\')) i++
            val after = rest.substring(i)
            var end = after.indexOfFirst { it == '/' || it == '\\' || it == '?' || it == '#' }
            if (end < 0) end = after.length
            val authority = after.substring(0, end)
            val at = authority.lastIndexOf('@')
            val userinfo = if (at >= 0) authority.substring(0, at) else ""
            val hostPort = if (at >= 0) authority.substring(at + 1) else authority
            val colon = userinfo.indexOf(':')
            val username = if (colon >= 0) userinfo.substring(0, colon) else userinfo
            val password = if (colon >= 0) userinfo.substring(colon + 1) else ""

            val rawHost: String
            val rawPort: String
            if (hostPort.startsWith("[")) {
                val close = hostPort.indexOf(']')
                if (close < 0) return null
                rawHost = hostPort.substring(0, close + 1)
                val tail = hostPort.substring(close + 1)
                if (tail.isNotEmpty() && !tail.startsWith(":")) return null
                rawPort = if (tail.isEmpty()) "" else tail.substring(1)
            } else {
                val portColon = hostPort.indexOf(':')
                rawHost = if (portColon >= 0) hostPort.substring(0, portColon) else hostPort
                rawPort = if (portColon >= 0) hostPort.substring(portColon + 1) else ""
            }
            if (rawHost.isEmpty()) return null
            val hostname = parseHost(rawHost) ?: return null
            val port = parsePort(rawPort, protocol) ?: return null
            return build(protocol, username, password, hostname, port, after.substring(end))
        }

        private fun relative(text: String, base: WebUrl): WebUrl? {
            val b = base
            return when {
                text.length >= 2 && startsWithSlash(text) && (text[1] == '/' || text[1] == '\\') -> absolute(b.protocol, text)
                startsWithSlash(text) -> build(b.protocol, b.username, b.password, b.hostname, b.port, text)
                text.isEmpty() -> build(b.protocol, b.username, b.password, b.hostname, b.port, b.path + b.query)
                text.startsWith("?") -> build(b.protocol, b.username, b.password, b.hostname, b.port, b.path + text)
                text.startsWith("#") -> build(b.protocol, b.username, b.password, b.hostname, b.port, b.path + b.query + text)
                else -> build(b.protocol, b.username, b.password, b.hostname, b.port, b.path.substring(0, b.path.lastIndexOf('/') + 1) + text)
            }
        }

        private fun build(protocol: String, username: String, password: String, hostname: String, port: String, tail: String): WebUrl {
            var rest = tail
            var fragment = ""
            val hash = rest.indexOf('#')
            if (hash >= 0) {
                fragment = rest.substring(hash)
                rest = rest.substring(0, hash)
            }
            var query = ""
            val mark = rest.indexOf('?')
            if (mark >= 0) {
                query = rest.substring(mark)
                rest = rest.substring(0, mark)
            }
            return WebUrl(protocol, username, password, hostname, port, normalisePath(rest.replace('\\', '/')), query, fragment, true)
        }

        /** Resolves "." and ".." segments; an empty path is "/". */
        private fun normalisePath(path: String): String {
            if (path.isEmpty()) return "/"
            val out = ArrayList<String>()
            val segments = path.removePrefix("/").split("/")
            for ((index, segment) in segments.withIndex()) {
                val last = index == segments.size - 1
                when (segment.lowercase()) {
                    ".", "%2e" -> if (last) out.add("")
                    "..", ".%2e", "%2e.", "%2e%2e" -> {
                        if (out.isNotEmpty()) out.removeAt(out.size - 1)
                        if (last) out.add("")
                    }
                    else -> out.add(segment)
                }
            }
            return "/" + out.joinToString("/")
        }

        private fun parsePort(raw: String, protocol: String): String? {
            if (raw.isEmpty()) return ""
            if (!raw.all { it in '0'..'9' }) return null
            val value = raw.trimStart('0').ifEmpty { "0" }
            if (value.length > 5 || value.toInt() > 65535) return null
            return if (value == DEFAULT_PORTS[protocol]) "" else value
        }

        // Hosts --------------------------------------------------------------------------------------------

        private fun isForbiddenDomainChar(c: Char): Boolean =
            c <= ' ' || c == '#' || c == '/' || c == ':' || c == '<' || c == '>' || c == '?' || c == '@' ||
                c == '[' || c == '\\' || c == ']' || c == '^' || c == '|' || c == '%' || c.code == 0x7f

        /** A special URL's host: a bracketed IPv6 address, an IPv4 address in any form, or a lowercase domain. */
        internal fun parseHost(input: String): String? {
            if (input.startsWith("[")) {
                if (!input.endsWith("]")) return null
                val pieces = parseIpv6(input.substring(1, input.length - 1)) ?: return null
                return "[" + serializeIpv6(pieces) + "]"
            }
            val ascii = domainToAscii(percentDecode(input)) ?: return null
            if (ascii.isEmpty() || ascii.any(::isForbiddenDomainChar)) return null
            if (endsInNumber(ascii)) return parseIpv4(ascii)?.let(::serializeIpv4)
            return ascii
        }

        private fun percentDecode(input: String): String {
            if ('%' !in input) return input
            val bytes = input.toByteArray(Charsets.UTF_8)
            val out = java.io.ByteArrayOutputStream(bytes.size)
            var i = 0
            while (i < bytes.size) {
                val b = bytes[i]
                if (b == '%'.code.toByte() && i + 2 < bytes.size && isHex(bytes[i + 1]) && isHex(bytes[i + 2])) {
                    out.write(Character.digit(bytes[i + 1].toInt(), 16) * 16 + Character.digit(bytes[i + 2].toInt(), 16))
                    i += 3
                } else {
                    out.write(b.toInt())
                    i++
                }
            }
            return String(out.toByteArray(), Charsets.UTF_8)
        }

        private fun isHex(b: Byte): Boolean = b.toInt().toChar().let { it in '0'..'9' || it in 'a'..'f' || it in 'A'..'F' }

        private fun domainToAscii(domain: String): String? {
            if (domain.all { it.code < 0x80 }) return domain.lowercase()
            return try {
                IDN.toASCII(domain, IDN.ALLOW_UNASSIGNED).lowercase()
            } catch (_: IllegalArgumentException) {
                null
            }
        }

        private fun endsInNumber(host: String): Boolean {
            val parts = host.split(".").toMutableList()
            if (parts.last().isEmpty()) {
                if (parts.size == 1) return false
                parts.removeAt(parts.size - 1)
            }
            val last = parts.last()
            if (last.isNotEmpty() && last.all { it in '0'..'9' }) return true
            return parseIpv4Number(last) != null
        }

        private fun parseIpv4Number(input: String): BigInteger? {
            if (input.isEmpty()) return null
            var text = input
            var radix = 10
            if (text.length >= 2 && (text.startsWith("0x") || text.startsWith("0X"))) {
                radix = 16
                text = text.substring(2)
            } else if (text.length >= 2 && text.startsWith("0")) {
                radix = 8
                text = text.substring(1)
            }
            if (text.isEmpty()) return BigInteger.ZERO
            if (!text.all { Character.digit(it, radix) >= 0 && it.code < 0x80 }) return null
            return BigInteger(text, radix)
        }

        /** The WHATWG IPv4 parser: 1 to 4 numbers, decimal, octal or hex, the last filling the remaining bytes. */
        internal fun parseIpv4(input: String): Long? {
            val parts = input.split(".").toMutableList()
            if (parts.last().isEmpty() && parts.size > 1) parts.removeAt(parts.size - 1)
            if (parts.size > 4) return null
            val numbers = parts.map { parseIpv4Number(it) ?: return null }
            val byte = BigInteger.valueOf(255)
            if (numbers.dropLast(1).any { it > byte }) return null
            if (numbers.last() >= BigInteger.valueOf(256).pow(5 - numbers.size)) return null
            var address = numbers.last().toLong()
            for ((i, n) in numbers.dropLast(1).withIndex()) address += n.toLong() shl (8 * (3 - i))
            return address
        }

        private fun serializeIpv4(address: Long): String =
            (3 downTo 0).joinToString(".") { ((address shr (8 * it)) and 0xff).toString() }

        /** The WHATWG IPv6 parser, embedded IPv4 included: eight 16-bit pieces, or null. */
        internal fun parseIpv6(input: String): IntArray? {
            val address = IntArray(8)
            var pieceIndex = 0
            var compress = -1
            var p = 0
            fun c(at: Int = p): Char? = if (at < input.length) input[at] else null
            if (c() == ':') {
                if (c(p + 1) != ':') return null
                p += 2
                pieceIndex++
                compress = pieceIndex
            }
            while (c() != null) {
                if (pieceIndex == 8) return null
                if (c() == ':') {
                    if (compress != -1) return null
                    p++
                    pieceIndex++
                    compress = pieceIndex
                    continue
                }
                var value = 0
                var length = 0
                while (length < 4 && c()?.let { Character.digit(it, 16) >= 0 && it.code < 0x80 } == true) {
                    value = value * 16 + Character.digit(c()!!, 16)
                    p++
                    length++
                }
                if (c() == '.') {
                    if (length == 0) return null
                    p -= length
                    if (pieceIndex > 6) return null
                    var numbersSeen = 0
                    while (c() != null) {
                        var piece = -1
                        if (numbersSeen > 0) {
                            if (c() == '.' && numbersSeen < 4) p++ else return null
                        }
                        if (c()?.let { it in '0'..'9' } != true) return null
                        while (c()?.let { it in '0'..'9' } == true) {
                            val number = c()!! - '0'
                            piece = when (piece) {
                                -1 -> number
                                0 -> return null
                                else -> piece * 10 + number
                            }
                            if (piece > 255) return null
                            p++
                        }
                        address[pieceIndex] = address[pieceIndex] * 0x100 + piece
                        numbersSeen++
                        if (numbersSeen == 2 || numbersSeen == 4) pieceIndex++
                    }
                    if (numbersSeen != 4) return null
                    break
                } else if (c() == ':') {
                    p++
                    if (c() == null) return null
                } else if (c() != null) {
                    return null
                }
                address[pieceIndex] = value
                pieceIndex++
            }
            if (compress != -1) {
                var swaps = pieceIndex - compress
                pieceIndex = 7
                while (pieceIndex != 0 && swaps > 0) {
                    val other = compress + swaps - 1
                    val t = address[pieceIndex]
                    address[pieceIndex] = address[other]
                    address[other] = t
                    pieceIndex--
                    swaps--
                }
            } else if (pieceIndex != 8) {
                return null
            }
            return address
        }

        /** As the URL standard writes it: lowercase hex, the first longest run of two or more zero pieces as "::". */
        internal fun serializeIpv6(address: IntArray): String {
            var bestStart = -1
            var bestLength = 1
            var i = 0
            while (i < 8) {
                if (address[i] == 0) {
                    var j = i
                    while (j < 8 && address[j] == 0) j++
                    if (j - i > bestLength) {
                        bestStart = i
                        bestLength = j - i
                    }
                    i = j
                } else {
                    i++
                }
            }
            val out = StringBuilder()
            var ignore0 = false
            for (index in 0 until 8) {
                if (ignore0 && address[index] == 0) continue
                ignore0 = false
                if (index == bestStart) {
                    out.append(if (index == 0) "::" else ":")
                    ignore0 = true
                    continue
                }
                out.append(Integer.toHexString(address[index]))
                if (index != 7) out.append(':')
            }
            return out.toString()
        }
    }
}
