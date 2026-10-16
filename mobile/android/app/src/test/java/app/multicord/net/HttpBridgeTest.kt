// Multicord for Android. Copyright (C) 2026 Multicord contributors. AGPL-3.0-or-later, see LICENSE at the repo root.
package app.multicord.net

import app.multicord.bridge.Limits
import java.io.ByteArrayInputStream
import java.io.IOException
import java.io.InputStream
import java.net.InetAddress
import java.net.UnknownHostException
import okhttp3.Dns
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

/** The HTTP bridge with a scripted network, as tests/main/netPolicy.test.ts tests performHttp. */
class HttpBridgeTest {
    private class Call(val url: String, val method: String, val headers: Map<String, String>, val body: Body?)

    private class Script(vararg responses: TransportResponse) : HttpTransport {
        val queue = ArrayDeque(responses.toList())
        val calls = ArrayList<Call>()
        override fun fetch(url: WebUrl, method: String, headers: Map<String, String>, body: Body?): TransportResponse {
            calls.add(Call(url.href, method, headers, body))
            return queue.removeFirst()
        }
    }

    private fun ok(text: String = "ok", headers: List<Pair<String, String>> = emptyList(), length: Long = -1, body: InputStream? = null) =
        TransportResponse(200, headers, length, body ?: ByteArrayInputStream(text.toByteArray()))

    private fun redirect(status: Int, to: String) = TransportResponse(status, listOf("location" to to), 0, ByteArrayInputStream(ByteArray(0)))

    private val policy = UrlPolicy(listOf("https:"))
    private fun request(url: String = "https://api.example.com/a", method: String = "GET", headers: Map<String, String> = emptyMap(), body: Body? = null) =
        HttpRequest(url, method, headers, body)

    @Test
    fun returnsStatusHeadersAndBody() {
        val net = Script(ok("hello", listOf("content-type" to "text/plain", "set-cookie" to "a=b", "x-a" to "1", "x-a" to "2", "set-cookie2" to "c")))
        val response = HttpBridge.perform(net, request(headers = mapOf("Cookie" to "x", "Authorization" to "t")), policy)
        assertEquals(200, response.status)
        assertEquals(mapOf("content-type" to "text/plain", "x-a" to "1, 2"), response.headers)
        assertArrayEquals("hello".toByteArray(), response.body)
        assertEquals(mapOf("Authorization" to "t"), net.calls[0].headers)
    }

    @Test
    fun refusesBeforeSending() {
        val net = Script()
        for (url in listOf("http://api.example.com/", "https://127.0.0.1/", "https://2130706433/", "https://a:b@api.example.com/", "nope")) {
            val error = assertThrows(IOException::class.java) { HttpBridge.perform(net, request(url), policy) }
            assertTrue(error.message!!, error.message!!.startsWith("Request blocked"))
        }
        assertThrows(IOException::class.java) { HttpBridge.perform(net, request("https://other.example/"), UrlPolicy(listOf("https:"), listOf("*.example.com"))) }
        assertTrue(net.calls.isEmpty())
    }

    @Test
    fun checksEveryRedirect() {
        val net = Script(redirect(302, "https://[::1]/x"))
        val error = assertThrows(IOException::class.java) { HttpBridge.perform(net, request(), policy) }
        assertTrue(error.message!!.contains("local or private"))
        assertEquals(1, net.calls.size)
        val locked = Script(redirect(301, "https://evil.example/"))
        assertThrows(IOException::class.java) { HttpBridge.perform(locked, request(), UrlPolicy(listOf("https:"), listOf("api.example.com"))) }
    }

    @Test
    fun followsRelativeRedirectsAndChangesTheMethod() {
        val net = Script(redirect(303, "/b?x=1"), redirect(307, "c"), ok())
        HttpBridge.perform(net, request(method = "POST", body = Body.Text("x")), policy)
        assertEquals(listOf("https://api.example.com/a", "https://api.example.com/b?x=1", "https://api.example.com/c"), net.calls.map { it.url })
        assertEquals(listOf("POST", "GET", "GET"), net.calls.map { it.method })
        assertNull(net.calls[1].body)
        val keep = Script(redirect(307, "/n"), ok())
        HttpBridge.perform(keep, request(method = "PUT", body = Body.Text("x")), policy)
        assertEquals("x", (keep.calls[1].body as Body.Text).text)
    }

    @Test
    fun allowsMaxRedirectsButNotMore() {
        val hops = Array(NetPolicy.MAX_REDIRECTS) { redirect(302, "/n") }
        assertEquals(200, HttpBridge.perform(Script(*hops, ok()), request(), policy).status)
        val tooMany = Array(NetPolicy.MAX_REDIRECTS + 1) { redirect(302, "/n") }
        val error = assertThrows(IOException::class.java) { HttpBridge.perform(Script(*tooMany), request(), policy) }
        assertEquals("Too many redirects", error.message)
    }

    @Test
    fun capsResponses() {
        val announced = Script(ok(length = Limits.MAX_HTTP_BODY + 1L))
        assertEquals("Response too large", assertThrows(IOException::class.java) { HttpBridge.perform(announced, request(), policy) }.message)
        // A body without (or lying about) its length is cut off as it arrives.
        var served = 0L
        val endless = object : InputStream() {
            override fun read(): Int = 0
            override fun read(b: ByteArray, off: Int, len: Int): Int {
                served += len
                return len
            }
        }
        val unannounced = Script(ok(body = endless))
        assertEquals("Response too large", assertThrows(IOException::class.java) { HttpBridge.perform(unannounced, request(), policy) }.message)
        assertTrue(served <= Limits.MAX_HTTP_BODY + 64 * 1024)
    }

    @Test
    fun publicDnsRefusesNamesThatResolvePrivately() {
        fun dns(vararg addresses: String) = PublicDns(object : Dns {
            override fun lookup(hostname: String): List<InetAddress> = addresses.map { InetAddress.getByName(it) }
        })
        assertEquals(2, dns("93.184.216.34", "2606:2800:220:1::1").lookup("example.com").size)
        for (address in listOf("192.168.1.10", "127.0.0.1", "::1", "fe80::1", "100.64.0.1")) {
            assertThrows(UnknownHostException::class.java) { dns("93.184.216.34", address).lookup("rebind.example") }
        }
    }

    @Test
    fun okHttpGetsTheHostThePolicyJudged() {
        assertEquals("api.example.com", EngineNet.toHttpUrl(WebUrl.parse("https://API.example.com/x?y#z")!!)!!.host)
        assertEquals("https://gateway.example.com/?v=1", EngineNet.toHttpUrl(WebUrl.parse("wss://gateway.example.com/?v=1")!!).toString())
        assertEquals("2001:db8::1", EngineNet.toHttpUrl(WebUrl.parse("https://[2001:db8::1]/")!!)!!.host)
        assertNull(EngineNet.toHttpUrl(WebUrl.parse("javascript:x")!!))
    }
}
