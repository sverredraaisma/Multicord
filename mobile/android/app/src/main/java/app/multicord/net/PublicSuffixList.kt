// Multicord for Android. Copyright (C) 2026 Multicord contributors. AGPL-3.0-or-later, see LICENSE at the repo root.
package app.multicord.net

import java.net.IDN

/**
 * The Public Suffix List's rules, ported from src/core/publicSuffix.ts and tested against the same cases
 * (tests/fixtures/netpolicy-cases.json: registrableDomain, voiceHost). It reads the very list the desktop
 * bundles (src/core/publicsuffix/public_suffix_list.dat, Mozilla Public License 2.0, its licence beside it),
 * which the build puts in the app's assets as web/mobile/public_suffix_list.dat.
 */
class PublicSuffixList(text: String) {
    private val rules = HashSet<String>()
    /** For `*.x`, x. */
    private val wildcards = HashSet<String>()
    private val exceptions = HashSet<String>()

    init {
        for (line in text.lineSequence()) {
            val rule = line.trim().split(WHITESPACE)[0].lowercase()
            if (rule.isEmpty() || rule.startsWith("//")) continue
            when {
                rule.startsWith("!") -> exceptions.add(ascii(rule.substring(1)))
                rule.startsWith("*.") -> wildcards.add(ascii(rule.substring(2)))
                else -> rules.add(ascii(rule))
            }
        }
    }

    /** A rule in the form host names come in: punycode for a label with other than ASCII. */
    private fun ascii(rule: String): String =
        rule.split(".").joinToString(".") { label -> if (label.all { it.code < 0x80 }) label else IDN.toASCII(label, IDN.ALLOW_UNASSIGNED).lowercase() }

    /** How many labels at the end are the public suffix: the longest rule that matches, an exception's minus one, else the last label. */
    private fun suffixLength(labels: List<String>): Int {
        for (i in labels.indices) {
            val name = labels.subList(i, labels.size).joinToString(".")
            if (name in exceptions) return labels.size - i - 1
            if (name in rules) return labels.size - i
            if (i + 1 < labels.size && labels.subList(i + 1, labels.size).joinToString(".") in wildcards) return labels.size - i
        }
        return 1
    }

    /** The registrable domain of a host ("example.co.uk" for "a.b.example.co.uk"); null for a public suffix or what is no DNS name. */
    fun registrableDomain(value: String): String? {
        val host = dnsName(value) ?: return null
        val labels = host.split(".")
        val suffix = suffixLength(labels)
        return if (labels.size > suffix) labels.subList(labels.size - suffix - 1, labels.size).joinToString(".") else null
    }

    /**
     * Whether an engine locked to `locked` may also open sockets to `host`, its one voice host: a DNS name with
     * the registrable domain of a locked host (a wildcard by its base), as voiceHostAllowed() decides it.
     */
    fun voiceHostAllowed(locked: List<String>, host: String): Boolean {
        val domain = registrableDomain(host) ?: return false
        return locked.any { registrableDomain(it.removePrefix("*.")) == domain }
    }

    companion object {
        private val WHITESPACE = Regex("\\s")
        private val LABEL = Regex("^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$")
        private val DIGITS = Regex("^[0-9]+$")

        /** Lower case ASCII labels (punycode for an IDN), at least two, at most 253 characters, no IP address; null otherwise. */
        fun dnsName(value: String): String? {
            if (value.length > 253) return null
            val host = value.lowercase()
            val labels = host.split(".")
            if (labels.size < 2 || !labels.all { LABEL.matches(it) } || DIGITS.matches(labels.last())) return null
            return host
        }
    }
}
