// Multicord for Android. Copyright (C) 2026 Multicord contributors. AGPL-3.0-or-later, see LICENSE at the repo root.
package app.multicord.net

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/** The URL parser against what `new URL()` gives in a browser (values checked in Chromium). */
class WebUrlTest {
    private fun host(url: String): String? = WebUrl.parse(url)?.hostname

    @Test
    fun normalisesNumericIpv4Forms() {
        assertEquals("127.0.0.1", host("https://2130706433/"))
        assertEquals("127.0.0.1", host("https://0x7f.1/"))
        assertEquals("127.0.0.1", host("https://017700000001/"))
        assertEquals("127.0.0.1", host("https://127.1/"))
        assertEquals("127.0.0.1", host("https://127.0.0.1./"))
        assertEquals("10.0.0.255", host("https://10.0.0.0xff/"))
        assertEquals("0.0.0.0", host("https://0/"))
        // A name that ends in a number must be a valid address.
        assertNull(host("https://1.2.3.4.5/"))
        assertNull(host("https://1.2.3.256/"))
        assertNull(host("https://foo.0x/"))
        assertNull(host("https://4294967296/"))
        assertEquals("1234.1.1.a", host("https://1234.1.1.a/"))
    }

    @Test
    fun normalisesIpv6() {
        assertEquals("[::1]", host("https://[0:0:0:0:0:0:0:1]/"))
        assertEquals("[::ffff:7f00:1]", host("https://[::ffff:127.0.0.1]/"))
        assertEquals("[2001:db8::1]", host("https://[2001:DB8:0:0::1]:8443/"))
        assertEquals("[::]", host("https://[::]/"))
        assertEquals("[1::1:0:0:1]", host("https://[1:0:0:0:1:0:0:1]/"))
        assertNull(host("https://[::1/"))
        assertNull(host("https://[1:2:3:4:5:6:7:8:9]/"))
        assertNull(host("https://[::1]x/"))
    }

    @Test
    fun lowercasesAndDecodesNames() {
        assertEquals("example.com", host("HTTPS://EXAMPLE.com/"))
        assertEquals("example.com", host("https://ex%61mple.com/"))
        // Full-width digits and dots are mapped before the address check, as browsers do.
        val fullWidth = String(intArrayOf(0xff11, 0xff12, 0xff17, 0xff0e, 0xff10, 0xff0e, 0xff10, 0xff0e, 0xff11), 0, 9)
        assertEquals("127.0.0.1", host("https://$fullWidth/"))
        assertEquals("xn--caf-dma.example", host("https://caf" + String(intArrayOf(0xe9), 0, 1) + ".example/"))
        assertNull(host("https://exa mple.com/"))
        assertNull(host("https://a%2fb.com/"))
        assertNull(host("https:///"))
    }

    @Test
    fun readsCredentialsPortsAndPaths() {
        val url = WebUrl.parse("  https://user:pw@example.com:443/a/./b/../c?q=1#f ")!!
        assertEquals("user", url.username)
        assertEquals("pw", url.password)
        assertEquals("", url.port)
        assertEquals("/a/c", url.path)
        assertEquals("?q=1", url.query)
        assertEquals("https://user:pw@example.com/a/c?q=1#f", url.href)
        assertEquals("8080", WebUrl.parse("wss://x.example:08080")!!.port)
        assertNull(WebUrl.parse("https://x.example:65536/"))
        assertNull(WebUrl.parse("https://x.example:1a/"))
        assertEquals("evil.example", host("https:\\\\evil.example\\x"))
        assertEquals("b.example", host("https://a.example@b.example/"))
        assertNull(WebUrl.parse("nope"))
        assertEquals("javascript:", WebUrl.parse("javascript:alert(1)")!!.protocol)
    }

    @Test
    fun resolvesRedirectTargets() {
        val base = WebUrl.parse("https://a.example/x/y?q#f")!!
        assertEquals("https://a.example/x/z", WebUrl.parse("z", base)!!.href)
        assertEquals("https://a.example/z", WebUrl.parse("/z", base)!!.href)
        assertEquals("https://b.example/", WebUrl.parse("//b.example", base)!!.href)
        assertEquals("https://a.example/x/y?r", WebUrl.parse("?r", base)!!.href)
        assertEquals("https://a.example/x/z", WebUrl.parse("https:z", base)!!.href)
        assertEquals("http://b.example/", WebUrl.parse("http:b.example", base)!!.href)
        assertEquals("127.0.0.1", WebUrl.parse("//2130706433/", base)!!.hostname)
        assertEquals("https://a.example/", WebUrl.parse("../../..", base)!!.href)
    }
}
