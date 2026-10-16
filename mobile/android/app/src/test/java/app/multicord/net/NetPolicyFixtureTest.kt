// Multicord for Android. Copyright (C) 2026 Multicord contributors. AGPL-3.0-or-later, see LICENSE at the repo root.
package app.multicord.net

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.boolean
import kotlinx.serialization.json.int
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Every case of tests/fixtures/netpolicy-cases.json, the file the desktop's tests/main/netPolicy.test.ts
 * runs too (copied in at build time by app/build.gradle.kts). A case that fails is named in the message.
 */
class NetPolicyFixtureTest {
    private val cases: JsonObject by lazy {
        val stream = javaClass.classLoader!!.getResourceAsStream("fixtures/netpolicy-cases.json")
            ?: error("netpolicy-cases.json is missing: the copyFixtures task copies it from tests/fixtures")
        Json.parseToJsonElement(stream.bufferedReader().readText()).jsonObject
    }

    private fun section(name: String): JsonArray = cases[name]!!.jsonArray
    private fun strings(value: Any?): List<String> = (value as JsonArray).map { it.jsonPrimitive.content }
    private fun JsonObject.text(key: String): String = this[key]!!.jsonPrimitive.content

    /** Runs `check` on each case and fails once, naming every case that did not hold. */
    private fun <T> each(items: List<T>, check: (T) -> Boolean) {
        val failed = items.filterNot(check)
        assertTrue("failed: $failed", failed.isEmpty())
        ran += items.size
    }

    @Test
    fun privateHosts() = each(strings(section("privateHosts"))) { NetPolicy.isPrivateHost(it) }

    @Test
    fun publicHosts() = each(strings(section("publicHosts"))) { !NetPolicy.isPrivateHost(it) }

    @Test
    fun numericHosts() = each(section("numericHosts").map { it.jsonObject }) { c ->
        val parsed = WebUrl.parse(c.text("url"))
        parsed != null && parsed.hostname == c.text("hostname") && NetPolicy.isPrivateHost(parsed.hostname)
    }

    @Test
    fun hostMatches() = each(section("hostMatches").map { it.jsonObject }) { c ->
        NetPolicy.hostMatches(c.text("host"), c.text("pattern")) == c["matches"]!!.jsonPrimitive.boolean
    }

    @Test
    fun checkUrl() = each(section("checkUrl").map { it.jsonObject }) { c ->
        val policy = UrlPolicy(strings(c["schemes"]), c["hosts"]?.let { strings(it) })
        val refusal = NetPolicy.checkUrl(c.text("url"), policy)
        val expected = c["refused"]?.jsonPrimitive?.content
        refusal?.kind == expected && (refusal == null || REFUSALS[refusal.kind]!!.matches(refusal.message))
    }

    @Test
    fun patternWithin() = each(section("patternWithin").map { it.jsonObject }) { c ->
        NetPolicy.patternWithin(c.text("pattern"), c.text("allowed")) == c["within"]!!.jsonPrimitive.boolean
    }

    @Test
    fun narrowHosts() = each(section("narrowHosts").map { it.jsonObject }) { c ->
        val current = c["current"].let { if (it == null || it is JsonNull) null else strings(it) }
        val result = c["result"].let { if (it == null || it is JsonNull) null else strings(it) }
        NetPolicy.narrowHosts(current, strings(c["requested"])) == result
    }

    @Test
    fun resolvedAddresses() = each(section("resolvedAddresses").map { it.jsonObject }) { c ->
        val addresses = strings(c["addresses"])
        val open = c["public"]!!.jsonPrimitive.boolean
        // As text, as the desktop judges them, and as the resolver hands them over.
        NetPolicy.addressesArePublic(addresses) == open &&
            addresses.all { java.net.InetAddress.getByName(it).let(NetPolicy::isPublicAddress) } == open
    }

    @Test
    fun requestHeaders() {
        val headers = cases["requestHeaders"]!!.jsonObject
        val sent = headers["sent"]!!.jsonObject.mapValues { it.value.jsonPrimitive.content }
        val forwarded = headers["forwarded"]!!.jsonObject.mapValues { it.value.jsonPrimitive.content }
        assertEquals(forwarded, NetPolicy.forwardedHeaders(sent))
        ran += 1
    }

    @Test
    fun redirects() = each(section("redirects").map { it.jsonObject }) { c ->
        val status = c["status"]!!.jsonPrimitive.int
        NetPolicy.isRedirect(status) &&
            NetPolicy.afterRedirect(status, c.text("method")) == (c.text("nextMethod") to c["keepsBody"]!!.jsonPrimitive.boolean)
    }

    @Test
    fun maxRedirects() {
        assertEquals(cases["maxRedirects"]!!.jsonPrimitive.int, NetPolicy.MAX_REDIRECTS)
        ran += 1
    }

    companion object {
        /** How each kind of refusal reads, as tests/main/netPolicy.test.ts expects it. */
        private val REFUSALS = mapOf(
            "invalid" to Regex("^not a valid URL$"),
            "scheme" to Regex("^[a-z]+: is not allowed$"),
            "credentials" to Regex("^credentials in URLs are not allowed$"),
            "private" to Regex("^.+ is a local or private address$"),
            "host" to Regex("^.+ is not one of this module's hosts$"),
        )

        /** Cases run, across the tests in this class. */
        var ran = 0
    }
}
