// Multicord for Android. Copyright (C) 2026 Multicord contributors. AGPL-3.0-or-later, see LICENSE at the repo root.
package app.multicord.shell

import android.webkit.PermissionRequest
import app.multicord.shell.WebClientPolicy.Navigation
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** The cases of isPlatformPage in tests/main/small.test.ts, and what the phone adds. */
class WebClientPolicyTest {
    private val element = "https://app.element.io"

    @Test
    fun ownPagesAreTheAppsHostItsSubdomainsAndSiblings() {
        assertTrue(WebClientPolicy.isOwnPage("https://app.element.io/#/room", element))
        assertTrue(WebClientPolicy.isOwnPage("https://x.app.element.io/", element))
        assertTrue(WebClientPolicy.isOwnPage("https://call.element.io/room", element))
        assertTrue(WebClientPolicy.isOwnPage("https://APP.Element.IO/", element))
        assertTrue(WebClientPolicy.isOwnPage("https://stoat.chat/app", "https://stoat.chat/app"))
        assertTrue(WebClientPolicy.isOwnPage("https://api.stoat.chat/", "https://stoat.chat/app"))
    }

    @Test
    fun otherPagesAreNot() {
        assertFalse(WebClientPolicy.isOwnPage("http://app.element.io/", element))
        assertFalse(WebClientPolicy.isOwnPage("https://element.io.evil.com/", element))
        assertFalse(WebClientPolicy.isOwnPage("https://evil.io/", element))
        assertFalse(WebClientPolicy.isOwnPage("https://notelement.io/", element))
        assertFalse(WebClientPolicy.isOwnPage(null, element))
        assertFalse(WebClientPolicy.isOwnPage("not a url", element))
        assertFalse(WebClientPolicy.isOwnPage("https://app.element.io/", "nope"))
        // Siblings only under a parent that is one site: never across shared hosting.
        assertFalse(WebClientPolicy.isOwnPage("https://other.github.io/", "https://me.github.io/"))
        assertFalse(WebClientPolicy.isOwnPage("https://other.co.uk/", "https://chat.co.uk/"))
        // A two-label host has no siblings.
        assertFalse(WebClientPolicy.isOwnPage("https://x.chat/", "https://stoat.chat/"))
    }

    @Test
    fun navigatesOnlyWithinTheAppAndSendsTappedLinksToTheBrowser() {
        assertEquals(Navigation.LOAD, WebClientPolicy.navigation("https://app.element.io/#/login", element, false))
        assertEquals(Navigation.LOAD, WebClientPolicy.navigation("https://call.element.io/x", element, true))
        assertEquals(Navigation.BROWSER, WebClientPolicy.navigation("https://matrix.org/docs", element, true))
        assertEquals(Navigation.BROWSER, WebClientPolicy.navigation("http://example.org/", element, true))
        // A jump away nobody tapped stays out; so do other schemes.
        assertEquals(Navigation.DROP, WebClientPolicy.navigation("https://matrix.org/docs", element, false))
        assertEquals(Navigation.DROP, WebClientPolicy.navigation("intent://x#Intent;end", element, true))
        assertEquals(Navigation.DROP, WebClientPolicy.navigation("javascript:alert(1)", element, true))
        assertEquals(Navigation.DROP, WebClientPolicy.navigation("file:///sdcard/x", element, true))
    }

    @Test
    fun grantsCameraAndMicrophoneToTheAppsOwnPagesOnly() {
        val all = listOf(PermissionRequest.RESOURCE_AUDIO_CAPTURE, PermissionRequest.RESOURCE_VIDEO_CAPTURE, PermissionRequest.RESOURCE_PROTECTED_MEDIA_ID, PermissionRequest.RESOURCE_MIDI_SYSEX)
        assertEquals(all.take(2), WebClientPolicy.grantable(all, "https://app.element.io/", element))
        assertEquals(all.take(2), WebClientPolicy.grantable(all, "https://call.element.io", element))
        assertEquals(emptyList<String>(), WebClientPolicy.grantable(all, "https://evil.io/", element))
        assertEquals(emptyList<String>(), WebClientPolicy.grantable(all, null, element))
        assertEquals(emptyList<String>(), WebClientPolicy.grantable(all.drop(2), "https://app.element.io/", element))
    }
}
