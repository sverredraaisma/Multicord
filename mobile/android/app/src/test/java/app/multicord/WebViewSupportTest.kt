// Multicord for Android. Copyright (C) 2026 Multicord contributors. AGPL-3.0-or-later, see LICENSE at the repo root.
package app.multicord

import androidx.webkit.WebViewFeature
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class WebViewSupportTest {
    private val all: (String) -> Boolean = { true }

    @Test
    fun readsTheMajorVersion() {
        assertEquals(154, WebViewSupport.majorOf("154.0.8037.106"))
        assertEquals(140, WebViewSupport.majorOf("140"))
        assertEquals(134, WebViewSupport.majorOf(" 134.0.6998.135 "))
        assertNull(WebViewSupport.majorOf(null))
        assertNull(WebViewSupport.majorOf(""))
        assertNull(WebViewSupport.majorOf("beta-154"))
        assertNull(WebViewSupport.majorOf("154x.1"))
    }

    @Test
    fun takesWebView140AndNewerWithEveryFeature() {
        assertNull(WebViewSupport.problem("140.0.7339.0", all))
        assertNull(WebViewSupport.problem("154.0.8037.106", all))
    }

    @Test
    fun refusesAnOlderOrUnknownWebView() {
        val old = WebViewSupport.problem("134.0.6998.135", all)
        assertTrue(old is WebViewSupport.Problem.TooOld)
        assertTrue(old!!.message, old.message.contains("WebView 140 or newer") && old.message.contains("134.0.6998.135") && old.message.contains("store"))
        assertTrue(WebViewSupport.problem("139.9", all) is WebViewSupport.Problem.TooOld)
        assertTrue(WebViewSupport.problem("unknown", all) is WebViewSupport.Problem.TooOld)
        assertTrue(WebViewSupport.problem(null, all) is WebViewSupport.Problem.NoWebView)
    }

    @Test
    fun namesTheFeaturesItLacks() {
        val problem = WebViewSupport.problem("154.0") { it != WebViewFeature.MULTI_PROFILE && it != WebViewFeature.DOCUMENT_START_SCRIPT }
        assertTrue(problem is WebViewSupport.Problem.MissingFeatures)
        assertEquals(listOf(WebViewFeature.MULTI_PROFILE, WebViewFeature.DOCUMENT_START_SCRIPT), (problem as WebViewSupport.Problem.MissingFeatures).features)
        assertTrue(WebViewSupport.problem("154.0") { it != WebViewFeature.WEB_MESSAGE_LISTENER } is WebViewSupport.Problem.MissingFeatures)
    }
}
