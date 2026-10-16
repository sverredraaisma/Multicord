// Multicord for Android. Copyright (C) 2026 Multicord contributors. AGPL-3.0-or-later, see LICENSE at the repo root.
package app.multicord.discord

import android.webkit.PermissionRequest
import app.multicord.discord.DiscordPolicy.Navigation
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class DiscordPolicyTest {
    @Test
    fun navigatesOnlyOnDiscordsPages() {
        for (url in listOf("https://discord.com/app", "https://discord.com/channels/@me/1", "https://ptb.discord.com/app", "https://discord.gg/abc")) {
            assertEquals(url, Navigation.LOAD, DiscordPolicy.navigation(url, userGesture = false))
        }
        // Links elsewhere open in the browser when the user tapped them, and are dropped otherwise.
        for (url in listOf("https://example.com/", "http://discord.com/app", "https://discord.com.evil.example/", "https://evildiscord.com/")) {
            assertEquals(url, Navigation.BROWSER, DiscordPolicy.navigation(url, userGesture = true))
            assertEquals(url, Navigation.DROP, DiscordPolicy.navigation(url, userGesture = false))
        }
        for (url in listOf("file:///sdcard/x", "intent://x#Intent;end", "javascript:alert(1)", "http://discord.gg/abc".replace("http:", "ftp:"), "not a url")) {
            assertEquals(url, Navigation.DROP, DiscordPolicy.navigation(url, userGesture = true))
        }
    }

    @Test
    fun grantsCameraAndMicrophoneToDiscordOnly() {
        val both = listOf(PermissionRequest.RESOURCE_AUDIO_CAPTURE, PermissionRequest.RESOURCE_VIDEO_CAPTURE)
        assertEquals(both, DiscordPolicy.grantable(both, "https://discord.com"))
        assertEquals(both, DiscordPolicy.grantable(both + both, "https://discord.com/"))
        assertEquals(listOf(PermissionRequest.RESOURCE_AUDIO_CAPTURE), DiscordPolicy.grantable(listOf(PermissionRequest.RESOURCE_AUDIO_CAPTURE, PermissionRequest.RESOURCE_MIDI_SYSEX, PermissionRequest.RESOURCE_PROTECTED_MEDIA_ID), "https://discord.com"))
        for (origin in listOf("https://ptb.discord.com", "https://hcaptcha.com", "http://discord.com", "https://discord.com.evil.example", null)) {
            assertEquals("$origin", emptyList<String>(), DiscordPolicy.grantable(both, origin))
        }
    }

    @Test
    fun presentsADesktopBrowserWithTheWebViewsChromeVersion() {
        val own = "Mozilla/5.0 (Linux; Android 14; CPH2663 Build/UP1A; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/154.0.8037.106 Mobile Safari/537.36"
        assertEquals("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36", DiscordPolicy.desktopUserAgent(own))
        assertTrue(DiscordPolicy.desktopUserAgent("odd").contains("Chrome/140.0.0.0"))
    }

    @Test
    fun desktopSiteIsOnUnlessTurnedOff() {
        assertTrue(DiscordPolicy.desktopSite(null))
        assertTrue(DiscordPolicy.desktopSite(JsonObject(emptyMap())))
        assertTrue(DiscordPolicy.desktopSite(JsonObject(mapOf("desktopSite" to JsonPrimitive(true)))))
        assertTrue(DiscordPolicy.desktopSite(JsonObject(mapOf("desktopSite" to JsonPrimitive("false")))))
        assertFalse(DiscordPolicy.desktopSite(JsonObject(mapOf("desktopSite" to JsonPrimitive(false)))))
    }
}
